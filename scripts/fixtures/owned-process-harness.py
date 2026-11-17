"""Run a bounded Linux acceptance script and reap its orphaned guardians.

The tested host is deliberately killed. A subreaper outside that host models a
proper service supervisor even in containers whose PID 1 does not reap children.
Only direct children owned by this harness are ever signalled.
"""
import ctypes
import os
import signal
import sys
import time


def children():
    found = []
    for entry in os.scandir("/proc"):
        if not entry.name.isdigit():
            continue
        try:
            with open(entry.path + "/status", encoding="utf8") as source:
                parent = next(line for line in source if line.startswith("PPid:"))
            if int(parent.split()[1]) == os.getpid():
                found.append(int(entry.name))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass
    return found


def main():
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "Acceptance harness needs Linux subreaper support")
    stopping = None

    def stop(_signal, _frame):
        nonlocal stopping
        if stopping is None:
            stopping = time.monotonic()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    child = os.fork()
    if child == 0:
        os.environ["SCIENCEMOTION_OWNED_HARNESS"] = str(os.getppid())
        os.execvp(sys.argv[1], sys.argv[1:])
        os._exit(70)
    deadline, result = time.monotonic() + 300, None
    while True:
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return result if result is not None else 1
            if not pid:
                break
            if pid == child:
                result = os.waitstatus_to_exitcode(status)
                if result < 0:
                    result = 128 - result
                stop(None, None)
        if time.monotonic() >= deadline and stopping is None:
            print("Owned-process acceptance exceeded 300 seconds", file=sys.stderr)
            result = 124
            stop(None, None)
        if stopping is not None:
            for pid in children():
                try:
                    os.kill(pid, signal.SIGKILL if time.monotonic() - stopping > 2 else signal.SIGTERM)
                except ProcessLookupError:
                    pass
        time.sleep(0.01)


if __name__ == "__main__":
    sys.exit(main())
