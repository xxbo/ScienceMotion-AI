"""Linux job guardian: reap the renderer and orphaned/detached Chromium descendants.

Only owned direct children and the optional per-render cgroup are signalled.
PR_SET_CHILD_SUBREAPER makes escaped process groups return here after their
parent exits. The guardian itself stays outside the renderer's resource limits.
"""
import ctypes
import json
import os
import shutil
import signal
import sys
import time

sys.dont_write_bytecode = True
from render_worker_cgroup import RenderCgroup, ResourceError, check_support, fork_in_group
from render_worker_storage import check_storage, lease_volume


def direct_children():
    # /proc/<pid>/task/<tid>/children is absent on some Linux kernels/containers.
    # Direct children retain their PIDs until this single-threaded guardian reaps them.
    own_pid = os.getpid()
    owned = []
    for entry in os.scandir("/proc"):
        if not entry.name.isdigit():
            continue
        try:
            with open(entry.path + "/status", encoding="utf8", errors="replace") as status:
                parent = next((line for line in status if line.startswith("PPid:")), None)
            if parent is not None and int(parent.split()[1]) == own_pid:
                owned.append(int(entry.name))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    return owned


def main():
    node, script, directory, heap_mb, grace_ms, expected_parent, *resource = sys.argv[1:]
    config = json.loads(resource[0]) if resource else {}
    stopping_at = None
    force = False

    def stop(_signum, _frame):
        nonlocal stopping_at
        if stopping_at is None:
            stopping_at = time.monotonic()

    def terminate(signum, frame):
        nonlocal force
        stop(signum, frame)
        force = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGUSR1, terminate)
    libc = ctypes.CDLL(None, use_errno=True)
    for option, value in [(36, 1), (1, signal.SIGTERM)]:  # CHILD_SUBREAPER, PDEATHSIG
        if libc.prctl(option, value, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "Could not configure Linux worker guardian")
    group = None
    storage = None
    failure = None
    usage = None
    result = None

    def sample_resources():
        counters = group.sample() if group else {}
        if storage:
            counters.update(storage.sample())
        return counters

    def check_resources(counters, final=False):
        if group:
            group.check(counters)
        if storage:
            storage.check(final)

    def exec_renderer():
        # Keep the guardian's final accounting report off the renderer's IPC
        # channel and out of reach of its stdout and inherited descendants.
        if resource:
            null = os.open(os.devnull, os.O_WRONLY)
            os.dup2(null, 1)
            os.close(null)
        args = [node, "--max-old-space-size=" + heap_mb, "--import", "tsx", script]
        if storage:
            os.execve(node, [*args, storage.directory], storage.environment())
        os.execv(node, [*args, directory])

    def supervise():
        nonlocal force
        channel = int(os.environ["NODE_CHANNEL_FD"])
        os.set_inheritable(channel, True)
        group_killed = False
        try:
            try:
                if group:
                    renderer = fork_in_group(group, exec_renderer)
                else:
                    renderer = os.fork()
                    if renderer == 0:
                        try:
                            exec_renderer()
                        finally:
                            os._exit(70)
            finally:
                os.close(channel)  # Only the Node renderer owns the IPC endpoint.
            node_result = None
            signalled = set()
            while True:
                # Reap before enumerating children. Never signal a PID after reaping it.
                while True:
                    try:
                        pid, status = os.waitpid(-1, os.WNOHANG)
                    except ChildProcessError:
                        pid = 0
                    if pid == 0:
                        break
                    signalled.discard(pid)
                    if pid == renderer:
                        node_result = os.waitstatus_to_exitcode(status)
                        stop(None, None)
                        force = True
                owned = direct_children()
                if resource and stopping_at is None:
                    check_resources(sample_resources())
                if node_result is not None and not owned:
                    return node_result if node_result >= 0 else 128 - node_result
                if stopping_at is not None:
                    hard = force or time.monotonic() - stopping_at >= int(grace_ms) / 1000
                    if hard and group and not group_killed:
                        group.kill()
                        group_killed = True
                    for pid in owned:
                        if hard or pid not in signalled:
                            try:
                                os.kill(pid, signal.SIGKILL if hard else signal.SIGTERM)
                                signalled.add(pid)
                            except ProcessLookupError:
                                pass
                time.sleep(0.01)
        finally:
            try:
                if group and not group_killed:
                    group.kill()
            finally:
                reap_children()

    try:
        if os.getppid() != int(expected_parent) or stopping_at is not None:
            return 1  # Parent died or requested stop during startup.
        direct_children()  # Verify procfs access before forking any work.
        if config.get("temporaryVolumes"):
            storage = lease_volume(config["temporaryVolumes"], config["resourceBudget"]["temporaryBytes"])
            storage.stage(os.path.join(directory, "request.json"))
        if config.get("cgroupParent"):
            group = RenderCgroup(config["cgroupParent"], config["resourceBudget"])
        if stopping_at is not None:
            return 1
        result = supervise()
        return result
    except ResourceError as error:
        failure = error
        return 70
    finally:
        if group or storage:
            try:
                usage = sample_resources()
                if failure is None:
                    check_resources(usage, final=True)
                    if storage and result == 0 and os.getppid() == int(expected_parent):
                        storage.copy_output(os.path.join(directory, "output.bin"), config["maxOutputBytes"])
            except ResourceError as error:
                failure = failure or error
            finally:
                for owned in (group, storage):
                    if owned:
                        try:
                            owned.close()
                        except ResourceError as error:
                            failure = error  # Uncertain cleanup takes precedence over a render error.
        if resource:
            report = {}
            if usage is not None:
                report["usage"] = usage
            if failure is not None:
                report["failure"] = {"code": failure.code, "message": str(failure)[:512]}
            print(json.dumps(report, ensure_ascii=False, separators=(",", ":")), flush=True)


def reap_children():
    # Ordinary exceptions must also drain children, including later-adopted ones.
    while True:
        for pid in direct_children():
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            return
        time.sleep(0.01)


if __name__ == "__main__":
    if sys.argv[1] == "--check-resources":
        try:
            config = json.loads(sys.argv[2])
            budget = config["resourceBudget"]
            if config.get("cgroupParent"):
                check_support(config["cgroupParent"], budget)
            if config.get("temporaryVolumes"):
                check_storage(config["temporaryVolumes"], budget["temporaryBytes"])
        except (ResourceError, OSError) as error:
            print(str(error)[:512], file=sys.stderr)
            sys.exit(1)
        sys.exit(0)
    try:
        sys.exit(main())
    finally:
        # A dead host cannot run its normal output-read / temporary-cleanup path.
        # main() has drained all descendants before this point. Keep the output
        # intact while the original parent lives; it still needs to verify it.
        # getppid() changes on reparenting, independent of stale/reused PIDs.
        if os.getppid() != int(sys.argv[6]):
            shutil.rmtree(sys.argv[3])
