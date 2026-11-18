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
    failure = None
    usage = None

    def exec_renderer():
        # Keep the guardian's final accounting report off the renderer's IPC
        # channel and out of reach of its stdout and inherited descendants.
        if group:
            null = os.open(os.devnull, os.O_WRONLY)
            os.dup2(null, 1)
            os.close(null)
        os.execv(node, [node, "--max-old-space-size=" + heap_mb, "--import", "tsx", script, directory])

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
                if group and stopping_at is None:
                    group.check(group.sample())
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
        if resource:
            group = RenderCgroup(resource[0], json.loads(resource[1]))
        if stopping_at is not None:
            return 1
        return supervise()
    except ResourceError as error:
        failure = error
        return 70
    finally:
        if group:
            try:
                try:
                    usage = group.sample()
                    if failure is None:
                        group.check(usage)
                finally:
                    group.close()
            except ResourceError as error:
                if failure is None or error.code == "RENDER_WORKER_CLEANUP":
                    failure = error
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
    if sys.argv[1] == "--check-cgroup":
        try:
            check_support(sys.argv[2], json.loads(sys.argv[3]))
        except ResourceError as error:
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
