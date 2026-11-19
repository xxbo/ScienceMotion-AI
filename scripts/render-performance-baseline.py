"""Compare both production snapshot renderers in isolated Linux process trees."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import shutil
import signal
import stat
import statistics
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
CASE = ROOT / "scripts/fixtures/render-performance-case.ts"
INTERVAL = 0.1
MIB = 1024 ** 2
MODES = ("in-process", "worker")
PREVIEWS = ("cold-preview", "repeat-preview", "recovery-preview")


def command(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True, timeout=20).strip()


def installed_environment():
    packages = ("remotion", "@remotion/bundler", "@remotion/renderer", "tsx")
    installed = {name: json.loads((ROOT / "node_modules" / name / "package.json").read_text())["version"]
                 for name in packages}
    browser = ROOT / "node_modules/.remotion/chrome-headless-shell"
    version = browser / "VERSION"
    if not version.is_file() or not any(path.is_file() and os.access(path, os.X_OK) for path in browser.rglob("chrome-headless-shell")):
        raise RuntimeError("Prepare the browser with npx remotion browser ensure")
    cgroup = next((line[3:] for line in Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::")), "/")
    cgroup_path = Path("/sys/fs/cgroup") / cgroup.lstrip("/")
    controls = {name: (cgroup_path / name).read_text().strip() for name in ("cpu.max", "memory.max")
                if (cgroup_path / name).is_file()}
    model = next((line.split(":", 1)[1].strip() for line in Path("/proc/cpuinfo").read_text().splitlines()
                  if line.startswith("model name")), platform.machine())
    return {"commit": command("git", "rev-parse", "HEAD"), "dirty": bool(command("git", "status", "--porcelain")),
            "os": platform.freedesktop_os_release()["PRETTY_NAME"], "kernel": platform.release(), "arch": platform.machine(),
            "cpuModel": model, "affinityCpuCount": len(os.sched_getaffinity(0)), "accountingCgroupControls": controls,
            "node": command("node", "--version"), "python": platform.python_version(), "packages": installed,
            "browser": version.read_text().strip(),
            "chineseFont": command("fc-match", "-f", "%{family}", "sans-serif:lang=zh") if shutil.which("fc-match") else None,
            "ciRun": os.environ.get("GITHUB_RUN_ID"), "ciAttempt": os.environ.get("GITHUB_RUN_ATTEMPT")}


def stage_workspace(workspace):
    """Give Remotion its own project root and a fresh node_modules/.cache."""
    modules = workspace / "node_modules"
    modules.mkdir(parents=True)
    for name in ("src", "episodes", "examples", "schemas", "public"):
        source = ROOT / name
        if source.is_dir():
            shutil.copytree(source, workspace / name, symlinks=True)
    for name in ("package.json", "tsconfig.json"):
        shutil.copy2(ROOT / name, workspace / name)
    for package in (ROOT / "node_modules").iterdir():
        if package.name != ".cache":
            (modules / package.name).symlink_to(package, target_is_directory=package.is_dir())
    return modules / ".cache"


def process_tree():
    by_parent = {}
    page_bytes = os.sysconf("SC_PAGE_SIZE")
    for path in Path("/proc").iterdir():
        if not path.name.isdigit():
            continue
        try:
            fields = (path / "stat").read_text(errors="replace").rsplit(")", 1)[1].split()
            by_parent.setdefault(int(fields[1]), []).append((int(path.name), max(0, int(fields[21])) * page_bytes))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    direct = by_parent.get(os.getpid(), [])
    tree = direct[:]
    for pid, _rss in tree:
        tree.extend(by_parent.get(pid, []))
    return direct, tree


def reap(child):
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return False
        if pid == 0:
            return True
        if pid == child.pid:
            child.returncode = os.waitstatus_to_exitcode(status)


def signal_direct(direct, how):
    for pid, _rss in direct:
        try:
            os.kill(pid, how)
        except ProcessLookupError:
            pass  # The PID remains ours until waitpid reaps it.


def allocated_bytes(root):
    pending, seen, size = [root], set(), 0
    while pending:
        path = pending.pop()
        try:
            info = path.lstat()
            key = (info.st_dev, info.st_ino)
            if stat.S_ISLNK(info.st_mode) or key in seen:
                continue
            seen.add(key)
            size += info.st_blocks * 512
            if stat.S_ISDIR(info.st_mode):
                pending.extend(path.iterdir())
        except (FileNotFoundError, NotADirectoryError):
            continue
    return size


def measure(mode, case):
    workspace, scratch, results = (case / name for name in ("workspace", "temporary", "results"))
    cache = stage_workspace(workspace)
    scratch.mkdir()
    results.mkdir()
    env = dict(os.environ, TMPDIR=str(scratch), TMP=str(scratch), TEMP=str(scratch))
    env.pop("SCIENCEMOTION_BOUNDED_TEMPORARY", None)
    ready_at = shutdown_at = exited_at = None
    peak_rss = peak_processes = peak_temp = peak_cache = samples = 0
    retained = {}
    drain_signalled = False
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = time.monotonic()
    log = case / "renderer.log"
    with log.open("wb") as stream:
        child = subprocess.Popen(["node", "--import", "tsx", str(CASE), mode, str(results)], cwd=workspace,
                                 env=env, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        while reap(child):
            now = time.monotonic()
            if now - started >= 180:
                raise TimeoutError(f"{mode} exceeded the 180-second sample deadline")
            direct, tree = process_tree()
            temp_bytes, cache_bytes = allocated_bytes(scratch), allocated_bytes(cache)
            peak_rss = max(peak_rss, sum(rss for _pid, rss in tree))
            peak_processes = max(peak_processes, len(tree))
            peak_temp, peak_cache = max(peak_temp, temp_bytes), max(peak_cache, cache_bytes)
            samples += 1
            if ready_at is None and (results / "ready").exists():
                ready_at = now
            if shutdown_at is None and child.returncode is None and (results / "calls.json").exists():
                retained = {"temporaryBytes": temp_bytes, "bundleCacheBytes": cache_bytes}
                shutdown_at = time.monotonic()
                (results / "shutdown").touch(exist_ok=False)
            if child.returncode is not None:
                exited_at = exited_at if exited_at is not None else now
                if now - exited_at >= 0.5 and direct:
                    drain_signalled = True
                    signal_direct(direct, signal.SIGKILL if now - exited_at >= 2 else signal.SIGTERM)
            time.sleep(max(0, INTERVAL - (time.monotonic() - now)))
    finally:
        # Reap or stop only direct children of the dedicated subreaper, then
        # repeat for any descendants adopted during shutdown.
        while reap(child):
            signal_direct(process_tree()[0], signal.SIGKILL)
            time.sleep(0.02)
    drained = time.monotonic()
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    if child.returncode != 0 or ready_at is None or shutdown_at is None:
        raise RuntimeError(f"{mode} exited {child.returncode}. Renderer log:\n{log.read_text(errors='replace')[-6000:]}")
    reclaim_started = time.monotonic()
    shutil.rmtree(scratch)
    if cache.exists():
        shutil.rmtree(cache)
    row = json.loads((results / "calls.json").read_text())
    row.update({"hostStartupObservedMs": round((ready_at - started) * 1000, 1),
                "shutdownToReapedObservedMs": round((drained - shutdown_at) * 1000, 1),
                "scratchReclaimMs": round((time.monotonic() - reclaim_started) * 1000, 1),
                "hostWallMs": round((drained - started) * 1000, 1), "drainSignalsUsed": drain_signalled,
                "cpuSeconds": {"user": round(usage.ru_utime - before.ru_utime, 4), "system": round(usage.ru_stime - before.ru_stime, 4)},
                "sampleCount": samples, "peakProcessTreeRssBytes": peak_rss, "peakProcesses": peak_processes,
                "peakTemporaryBytes": peak_temp, "peakBundleCacheBytes": peak_cache, "beforeShutdown": retained})
    return row, results


def fingerprint(row, results, ffprobe, ffmpeg):
    fixture = row["fixture"]
    for name in (*PREVIEWS, "video"):
        path = results / (name + (".mp4" if name == "video" else ".png"))
        stream = json.loads(command(str(ffprobe), "-v", "error", "-select_streams", "v:0", "-show_entries",
                                    "stream=codec_name,width,height,r_frame_rate,nb_frames", "-of", "json", str(path)))["streams"][0]
        profile = fixture["profile"]
        if (stream["width"], stream["height"]) != (profile["width"], profile["height"]):
            raise ValueError(f"Unexpected dimensions for {path.name}")
        if name == "video":
            if (stream["codec_name"] != "h264" or int(stream["nb_frames"]) != fixture["videoFrames"]
                    or stream["r_frame_rate"] != f"{profile['fps']}/1"):
                raise ValueError("The video differs from the expected codec, frame count or frame rate")
        elif stream["codec_name"] != "png":
            raise ValueError(f"Expected a PNG for {path.name}")
    video = results / "video.mp4"
    decoded = subprocess.check_output(
        [str(ffmpeg), "-v", "error", "-threads", "1", "-i", str(video), "-map", "0:v:0", "-an",
         "-threads", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"], timeout=40)
    if not decoded.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("The video decoder did not return PNG frames")
    preview_hashes = {name: hashlib.sha256((results / (name + ".png")).read_bytes()).hexdigest() for name in PREVIEWS}
    if len(set(preview_hashes.values())) != 1:
        raise ValueError("The repeat and recovery previews must match the cold preview")
    if (results / "cancel-video.mp4").exists():
        raise ValueError("The cancelled video returned output")
    layout = json.loads((results / "layout.json").read_text())
    return {"fixture": fixture, "previewsSha256": preview_hashes, "decodedVideoPngSequenceSha256": hashlib.sha256(decoded).hexdigest(),
            "layoutSha256": hashlib.sha256(json.dumps(layout, sort_keys=True).encode()).hexdigest()}


def span(values):
    return f"{statistics.median(values):.1f} [{min(values):.1f}–{max(values):.1f}]"


def summary(report):
    environment, runs = report["environment"], report["runs"]
    checkout = " with local changes" if environment["dirty"] else ""
    lines = ["# Render performance baseline", "",
             f"Commit `{environment['commit']}`{checkout} · {environment['os']} · Node {environment['node']} · {report['pairs']} paired repetitions", "",
             "Times are milliseconds. Values show the median and observed range. Raw fields are in `baseline.json`.", "",
             "| Operation | Mode | Total | Request to bundle | Bundle stage | Composition selection | Render to settlement |",
             "| --- | --- | ---: | ---: | ---: | ---: | ---: |"]
    for name in (call["name"] for call in runs[0]["calls"]):
        for mode in MODES:
            calls = [call for run in runs if run["mode"] == mode for call in run["calls"] if call["name"] == name]
            fields = ("totalMs", "startupMs", "bundleMs", "selectionMs", "renderToSettleMs")
            lines.append(f"| {name} | {mode} | " + " | ".join(span([call[key] for call in calls]) for key in fields) + " |")
    lines += ["", "| Mode | Cancel to rejection | Cancel to reaping confirmation | Host startup | Shutdown to reaping | Scratch reclamation |",
              "| --- | ---: | ---: | ---: | ---: | ---: |"]
    for mode in MODES:
        own = [run for run in runs if run["mode"] == mode]
        cancelled = [call for run in own for call in run["calls"] if call["status"] == "cancelled"]
        spans = [span([call[field] for call in cancelled]) for field in ("abortToRejectionMs", "abortToReapConfirmationMs")]
        spans += [span([run[field] for run in own]) for field in ("hostStartupObservedMs", "shutdownToReapedObservedMs", "scratchReclaimMs")]
        lines.append(f"| {mode} | " + " | ".join(spans) + " |")
    lines += ["", "| Mode | Process tree CPU (s) | Peak tree RSS (MiB) | Peak temporary space (MiB) | Peak workspace cache (MiB) |",
              "| --- | ---: | ---: | ---: | ---: |"]
    for mode in MODES:
        own = [run for run in runs if run["mode"] == mode]
        spans = [span([sum(run["cpuSeconds"].values()) for run in own])]
        spans += [span([run[field] / MIB for run in own]) for field in
                  ("peakProcessTreeRssBytes", "peakTemporaryBytes", "peakBundleCacheBytes")]
        lines.append(f"| {mode} | " + " | ".join(spans) + " |")
    lines += ["", "Preview bytes, decoded video frames and layout measurements matched across all runs. Every cancelled video",
              "rejected after live frame progress and its observed processes were reaped before the recovery preview.", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=3, help="paired repetitions")
    parser.add_argument("--output", type=Path, default=ROOT / "out/render-performance")
    args = parser.parse_args()
    if args.samples < 1 or sys.platform != "linux":
        parser.error("Run on Linux and specify at least one paired repetition")
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "The benchmark needs Linux subreaper support")

    def interrupt(_signum, _frame):
        raise InterruptedError("The performance baseline was stopped")

    signal.signal(signal.SIGTERM, interrupt)
    args.output.mkdir(parents=True, exist_ok=True)
    report = {"schemaVersion": "1.0.0", "status": "running", "pairs": args.samples, "sampleIntervalMs": INTERVAL * 1000, "runs": []}
    try:
        report["environment"] = installed_environment()
        arch = {"x86_64": "x64", "aarch64": "arm64"}[platform.machine()]
        binaries = ROOT / "node_modules/@remotion" / f"compositor-linux-{arch}-gnu"
        ffprobe, ffmpeg = binaries / "ffprobe", binaries / "ffmpeg"
        report["environment"]["ffmpeg"] = command(str(ffmpeg), "-version").splitlines()[0]
        reference = None
        for index in range(args.samples):
            for mode in (MODES if index % 2 == 0 else reversed(MODES)):
                with tempfile.TemporaryDirectory(prefix="sm-e1-") as directory:
                    row, results = measure(mode, Path(directory))
                    row["pair"] = index + 1
                    row["outputVerification"] = fingerprint(row, results, ffprobe, ffmpeg)
                    report["runs"].append(row)
                    reference = reference if reference is not None else row["outputVerification"]
                    if row["outputVerification"] != reference:
                        raise ValueError(f"Output mismatch in pair {index + 1}, {mode}")
                    print(f"Pair {index + 1}/{args.samples} {mode}: {row['hostWallMs'] / 1000:.1f}s", flush=True)
        report["status"] = "passed"
        (args.output / "summary.md").write_text(summary(report), encoding="utf8")
    except (Exception, KeyboardInterrupt) as error:
        report.update(status="failed", failure=str(error))
        (args.output / "summary.md").write_text(
            "# Render performance baseline\n\nThe benchmark failed. See `baseline.json` for the failure and completed samples.\n",
            encoding="utf8")
        raise
    finally:
        (args.output / "baseline.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")


if __name__ == "__main__":
    main()
