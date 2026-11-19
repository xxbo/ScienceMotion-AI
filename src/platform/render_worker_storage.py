"""Lease and reclaim a dedicated, operator-mounted ext4 loop filesystem."""
import errno
import fcntl
import os
import re
import shutil
import stat
import tempfile
import time

from render_worker_cgroup import ResourceError


def mount_capacity(path, fd, limit):
    info = os.fstat(fd)
    if info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError("The temporary volume root must be owned and writable only by the worker user")
    device = f"{os.major(info.st_dev)}:{os.minor(info.st_dev)}"
    with open("/proc/self/mountinfo", encoding="utf8") as mounts:
        for line in mounts:
            entry, filesystem = line.rstrip().split(" - ", 1)
            fields = entry.split()
            mount_path = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), fields[4])
            if fields[2:4] == [device, "/"] and mount_path == path:
                fs_type, source, _options = filesystem.split(" ", 2)
                if fs_type != "ext4" or not re.fullmatch(r"/dev/loop\d+", source):
                    break
                with open(f"/sys/dev/block/{device}/size", encoding="ascii") as size:
                    capacity = int(size.read()) * 512
                if not 0 < capacity <= limit:
                    raise ValueError(f"Temporary volume has {capacity} bytes, exceeding temporaryBytes={limit}")
                return capacity
    raise ValueError("Temporary storage requires the root of a dedicated ext4 loop mount")


class StorageSlot:
    def __init__(self, path, limit):
        self.path = os.path.realpath(path)
        self.root = None
        self.directory = None
        self.full_since = None
        self.fd = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.capacity = mount_capacity(self.path, self.fd, limit)
            self.before = os.fstatvfs(self.fd)
            self.minimum_bytes = self.before.f_bavail * self.before.f_frsize
            self.minimum_inodes = self.before.f_favail
            if self.before.f_flag & os.ST_RDONLY or not self.minimum_bytes or not self.minimum_inodes:
                raise ValueError("Temporary volume has no writable space")
            if set(os.listdir(self.fd)) - {"lost+found"}:
                raise ValueError("Temporary volume must be empty before leasing it")
        except BaseException:
            os.close(self.fd)
            raise

    def stage(self, request):
        try:
            self.root = tempfile.mkdtemp(prefix="sciencemotion-disk-", dir=self.path)
            self.directory = os.path.join(self.root, "work")
            os.mkdir(self.directory, 0o700)
            shutil.copyfile(request, os.path.join(self.directory, "request.json"))
        except OSError as error:
            if error.errno == errno.ENOSPC:
                raise ResourceError("RENDER_WORKER_TEMPORARY_LIMIT", "The temporary volume filled while staging the render input") from error
            raise ResourceError("RENDER_WORKER_RESOURCE_UNAVAILABLE", str(error)) from error

    def environment(self):
        # Set these before exec so the renderer, its loaders and native children
        # use the same job-private filesystem for temporary files and caches.
        return dict(os.environ, TMPDIR=self.directory, TMP=self.directory, TEMP=self.directory,
                    HOME=self.directory, XDG_CACHE_HOME=self.directory, XDG_CONFIG_HOME=self.directory,
                    XDG_DATA_HOME=self.directory, XDG_STATE_HOME=self.directory,
                    XDG_RUNTIME_DIR=self.directory, SCIENCEMOTION_BOUNDED_TEMPORARY="1")

    def sample(self):
        try:
            space = os.fstatvfs(self.fd)
        except OSError as error:
            raise ResourceError("RENDER_WORKER_RESOURCE_ACCOUNTING", str(error)) from error
        self.minimum_bytes = min(self.minimum_bytes, space.f_bavail * space.f_frsize)
        self.minimum_inodes = min(self.minimum_inodes, space.f_favail)
        if self.full_since is None and (not self.minimum_bytes or not self.minimum_inodes):
            self.full_since = time.monotonic()
        return {
            "temporaryCapacityBytes": str(self.capacity),
            "temporaryMinimumAvailableBytes": str(self.minimum_bytes),
            "temporaryMinimumAvailableInodes": str(self.minimum_inodes),
        }

    def check(self, final=False):
        # Give a writer a short interval to report the kernel error before
        # terminating a job that keeps running with the filesystem exhausted.
        if self.full_since is not None and (final or time.monotonic() - self.full_since >= 0.1):
            raise ResourceError("RENDER_WORKER_TEMPORARY_LIMIT",
                                f"Render temporary volume exhausted ({self.capacity} bytes; "
                                f"available bytes={self.minimum_bytes}, inodes={self.minimum_inodes})")

    def copy_output(self, target, maximum):
        path = os.path.join(self.directory, "output.bin")
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return  # The host still requires a valid renderer receipt and file.
        except OSError as error:
            raise ResourceError("RENDER_WORKER_OUTPUT_INVALID", str(error)) from error
        try:
            with os.fdopen(fd, "rb") as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= maximum:
                    raise ValueError("Render output is not a bounded, single-link regular file")
                with open(target, "xb") as output:
                    remaining = info.st_size
                    while remaining:
                        data = source.read(min(remaining, 1024 * 1024))
                        if not data:
                            raise ValueError("Render output was truncated")
                        output.write(data)
                        remaining -= len(data)
                    if source.read(1):
                        raise ValueError("Render output grew during transfer")
        except (OSError, ValueError) as error:
            raise ResourceError("RENDER_WORKER_OUTPUT_INVALID", str(error)) from error

    def close(self):
        try:
            if self.root is not None:
                shutil.rmtree(self.root)
            after = os.fstatvfs(self.fd)
            if (after.f_bavail < self.before.f_bavail or after.f_favail < self.before.f_favail
                    or set(os.listdir(self.fd)) - {"lost+found"}):
                raise ValueError("Temporary volume space was not reclaimed")
        except (OSError, ValueError) as error:
            raise ResourceError("RENDER_WORKER_CLEANUP", str(error)) from error
        finally:
            os.close(self.fd)


def lease_volume(paths, limit):
    for path in paths:
        try:
            return StorageSlot(path, limit)
        except BlockingIOError:
            continue
        except (OSError, ValueError) as error:
            raise ResourceError("RENDER_WORKER_RESOURCE_UNAVAILABLE", str(error)) from error
    raise ResourceError("RENDER_WORKER_BUSY", "Every render temporary volume is leased")


def check_storage(paths, limit):
    devices = set()
    for path in paths:
        with tempfile.TemporaryDirectory(prefix="sciencemotion-volume-check-") as request:
            probe = os.path.join(request, "request.json")
            with open(probe, "xb") as file:
                file.write(b"1")
            slot = lease_volume([path], limit)
            try:
                device = os.fstat(slot.fd).st_dev
                if device in devices:
                    raise ResourceError("RENDER_WORKER_RESOURCE_UNAVAILABLE", "Temporary volumes must have distinct loop devices")
                devices.add(device)
                slot.stage(probe)
                with open(os.path.join(slot.directory, "request.json"), "rb") as file:
                    os.fsync(file.fileno())
            finally:
                slot.close()
