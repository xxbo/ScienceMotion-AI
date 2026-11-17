"""Linux job guardian: reap the renderer and orphaned/detached Chromium descendants.

Only direct children are signalled. Their PIDs cannot be reused until this process
reaps them. PR_SET_CHILD_SUBREAPER makes escaped process groups return here after
their parent exits. This is lifecycle control, not a security or memory sandbox.
"""
import ctypes
import os
import shutil
import signal
import sys
import time


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
    node, script, directory, heap_mb, grace_ms, expected_parent = sys.argv[1:]
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
    if os.getppid() != int(expected_parent) or stopping_at is not None:
        return 1  # Parent died during startup; do not create work.
    direct_children()  # Verify procfs access before forking any work.
    channel = int(os.environ["NODE_CHANNEL_FD"])
    os.set_inheritable(channel, True)
    renderer = os.fork()
    if renderer == 0:
        try:
            os.execv(node, [node, "--max-old-space-size=" + heap_mb, "--import", "tsx", script, directory])
        finally:
            os._exit(70)
    os.close(channel)  # Only the Node renderer owns the existing Node IPC endpoint.
    node_result = None
    signalled = set()
    try:
        while True:
            # Reap before enumerating direct children; never retain a PID after reaping it.
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
                    force = True  # Successful and crashed jobs both clean up remaining descendants.
            owned = direct_children()
            if node_result is not None and not owned:
                return node_result if node_result >= 0 else 128 - node_result
            if stopping_at is not None:
                hard = force or time.monotonic() - stopping_at >= int(grace_ms) / 1000
                for pid in owned:
                    if hard or pid not in signalled:
                        try:
                            os.kill(pid, signal.SIGKILL if hard else signal.SIGTERM)
                            signalled.add(pid)
                        except ProcessLookupError:
                            pass  # Still ours to reap on the next iteration.
            time.sleep(0.01)
    finally:
        # Ordinary Python exceptions must also drain children, including later-adopted ones.
        while True:
            owned = direct_children()
            for pid in owned:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            try:
                while os.waitpid(-1, os.WNOHANG)[0]:
                    pass
            except ChildProcessError:
                break
            time.sleep(0.01)


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        # A dead host cannot run its normal output-read / temporary-cleanup path.
        # main() has drained all descendants before this point. Keep the output
        # intact while the original parent lives; it still needs to verify it.
        # getppid() changes on reparenting, independent of stale/reused PIDs.
        if os.getppid() != int(sys.argv[6]):
            shutil.rmtree(sys.argv[3])
