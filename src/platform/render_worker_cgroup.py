"""Per-render cgroup v2 controls for an operator-delegated Linux subtree."""
import os
import tempfile


class ResourceError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class RenderCgroup:
    def __init__(self, parent, budget):
        self.budget = budget
        try:
            self.path = tempfile.mkdtemp(prefix="sciencemotion-render-", dir=parent)
        except OSError as error:
            raise ResourceError("RENDER_WORKER_RESOURCE_UNAVAILABLE", str(error)) from error
        try:
            # Exercise the kill interface on our empty group before allowing work.
            self.write("cgroup.kill", "1")
            if "cpuMillicores" in budget:
                cpu_max = f"{budget['cpuMillicores'] * 100} 100000"
                self.write("cpu.max", cpu_max)
                if self.read("cpu.max") != cpu_max:
                    raise ValueError("cpu.max did not retain the requested bandwidth")
            if "memoryBytes" in budget:
                self.write("memory.max", str(budget["memoryBytes"]))
                self.write("memory.swap.max", "0")
                self.write("memory.oom.group", "1")
                if (int(self.read("memory.max")) > budget["memoryBytes"]
                        or self.read("memory.swap.max") != "0" or self.read("memory.oom.group") != "1"):
                    raise ValueError("Memory limit, zero swap or group OOM setting did not take effect")
            self.usage()
        except (OSError, ValueError, KeyError) as error:
            self.close()
            raise ResourceError("RENDER_WORKER_RESOURCE_UNAVAILABLE", str(error)) from error

    def read(self, name):
        with open(os.path.join(self.path, name), encoding="ascii") as control:
            return control.read().strip()

    def write(self, name, value):
        fd = os.open(os.path.join(self.path, name), os.O_WRONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "w", encoding="ascii") as control:
            control.write(value + "\n")

    def attach(self, pid):
        # The child is blocked on a pipe and cannot exec or fork until migrated.
        try:
            self.write("cgroup.procs", str(pid))
        except OSError as error:
            raise ResourceError("RENDER_WORKER_RESOURCE_UNAVAILABLE", str(error)) from error

    def kill(self):
        try:
            self.write("cgroup.kill", "1")
        except OSError as error:
            raise ResourceError("RENDER_WORKER_CLEANUP", str(error)) from error

    def close(self):
        try:
            os.rmdir(self.path)
        except OSError as error:
            raise ResourceError("RENDER_WORKER_CLEANUP", str(error)) from error

    def counters(self, file):
        return dict(line.split() for line in self.read(file).splitlines())

    def usage(self):
        values = {}
        if "cpuMillicores" in self.budget or "cpuTimeMs" in self.budget:
            cpu = self.counters("cpu.stat")
            values["cpuUsageUsec"] = str(int(cpu["usage_usec"]))
            if "cpuMillicores" in self.budget:
                values["cpuThrottledPeriods"] = str(int(cpu["nr_throttled"]))
        if "memoryBytes" in self.budget:
            memory = self.counters("memory.events")
            values["memoryOomEvents"] = str(int(memory["oom"]))
            values["memoryOomKills"] = str(int(memory["oom_kill"]))
        return values

    def sample(self):
        try:
            return self.usage()
        except (OSError, ValueError, KeyError) as error:
            raise ResourceError("RENDER_WORKER_RESOURCE_ACCOUNTING", str(error)) from error

    def check(self, usage):
        if int(usage.get("memoryOomEvents", 0)) or int(usage.get("memoryOomKills", 0)):
            raise ResourceError("RENDER_WORKER_MEMORY_LIMIT",
                                f"Render cgroup reported OOM with memoryBytes={self.budget['memoryBytes']} "
                                f"(oom={usage['memoryOomEvents']}, oom_kill={usage['memoryOomKills']})")
        cpu_budget = self.budget.get("cpuTimeMs")
        if cpu_budget is not None and int(usage["cpuUsageUsec"]) >= cpu_budget * 1000:
            raise ResourceError("RENDER_WORKER_CPU_TIME_LIMIT",
                                f"Render cgroup consumed {usage['cpuUsageUsec']} CPU microseconds "
                                f"against a {cpu_budget * 1000} microsecond budget")


def fork_in_group(group, work):
    read_gate, write_gate = os.pipe()
    try:
        child = os.fork()
    except OSError:
        os.close(read_gate)
        os.close(write_gate)
        raise
    if child == 0:
        os.close(write_gate)
        try:
            if os.read(read_gate, 1) != b"1":
                os._exit(70)
            os.close(read_gate)
            work()
        finally:
            os._exit(70)
    os.close(read_gate)
    try:
        group.attach(child)
        try:
            os.write(write_gate, b"1")
        except BrokenPipeError:
            # The kernel can kill a child during migration under memory pressure.
            # Leave attribution to the cgroup counters after reaping it.
            pass
    finally:
        os.close(write_gate)
    return child


def check_support(parent, budget):
    group = RenderCgroup(parent, budget)
    try:
        try:
            child = fork_in_group(group, lambda: os._exit(0))
            os.waitpid(child, 0)
        finally:
            # Setting a tiny limit during preflight can kill the probe child. It
            # still proves membership and control support, not job feasibility.
            try:
                group.kill()
            finally:
                while True:
                    try:
                        os.waitpid(-1, 0)
                    except ChildProcessError:
                        break
    finally:
        group.close()
