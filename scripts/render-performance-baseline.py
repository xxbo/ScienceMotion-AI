"""Compare production snapshot renders in isolated Linux process trees."""
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
ENGINE_FIXTURE = ROOT / "examples/water-motion-baseline.json"
INTERVAL = 0.1
MIB = 1024 ** 2
COMPARISONS = {"execution": ("in-process", "worker"), "bundle": ("worker", "worker-prepared"),
               "engine": ("in-process",), "engine-pair": ("in-process", "svg-ffmpeg")}
PREVIEWS = ("cold-preview", "repeat-preview", "recovery-preview")
ENGINE_MEDIA = ("cold-preview.png", "repeat-preview.png", "first-video.mp4", "repeat-video.mp4")
ENGINE_NAMES = {"in-process": "Remotion", "svg-ffmpeg": "SVG + FFmpeg"}
ENGINE_IDENTITIES = {"in-process": "remotion.project-graph", "svg-ffmpeg": "svg-ffmpeg-project-graph"}


def command(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True, timeout=20).strip()


def installed_environment():
    packages = ("remotion", "@remotion/bundler", "@remotion/renderer", "tsx")
    installed = {name: json.loads((ROOT / "node_modules" / name / "package.json").read_text())["version"]
                 for name in packages}
    # Resolve the executable through Remotion because its browser cache layout can change.
    browser = Path(command("node", "--input-type=module", "-e", """
        import { ensureBrowser } from "@remotion/renderer";
        const status = await ensureBrowser({ logLevel: "silent" });
        if (!status.path) throw new Error("Remotion did not select a browser");
        process.stdout.write(status.path);
    """))
    if not browser.is_file() or not os.access(browser, os.X_OK):
        raise RuntimeError("Remotion did not select an executable browser")
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
            "browser": command(str(browser), "--version"),
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


def measure(mode, case, engine=False):
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
        args = ["node", "--import", "tsx", str(CASE), mode, str(results)]
        if engine:
            args.append("engine")
        child = subprocess.Popen(args, cwd=workspace,
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


def engine_fingerprint(row, results, ffprobe, ffmpeg):
    fixture = row["fixture"]
    profile, workload = fixture["profile"], fixture["workload"]
    width, height, fps = (profile[key] for key in ("width", "height", "fps"))
    start = workload["video"]["startFrame"]
    video_frames = workload["video"]["durationFrames"]
    swatches = workload["swatches"]
    background = next(swatch["rgb"] for swatch in swatches if swatch["name"] == "background")
    digests = {}

    for name in ENGINE_MEDIA:
        path = results / name
        is_video = path.suffix == ".mp4"
        info = json.loads(command(str(ffprobe), "-v", "error", "-show_entries",
                                  "stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration", "-of", "json", str(path)))
        streams = info["streams"]
        if len(streams) != 1 or streams[0]["codec_type"] != "video":
            raise ValueError(f"Expected a single visual stream in {name}")
        stream = streams[0]
        if (stream["width"], stream["height"], stream["codec_name"]) != (width, height, "h264" if is_video else "png"):
            raise ValueError(f"Unexpected media profile in {name}")
        if is_video and (stream["avg_frame_rate"] != f"{fps}/1" or abs(float(info["format"]["duration"]) - video_frames / fps) > 0.001):
            raise ValueError(f"Unexpected frame rate or duration in {name}")

        channels = 3 if is_video else 4
        frame_bytes = width * height * channels
        decoded = subprocess.check_output(
            [str(ffmpeg), "-v", "error", "-xerror", "-threads", "1", "-i", str(path), "-map", "0:v:0",
             "-threads", "1", "-c:v", "rawvideo", "-pix_fmt", "rgb24" if is_video else "rgba",
             "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1"], timeout=40)
        if len(decoded) != frame_bytes * (video_frames if is_video else 1):
            raise ValueError(f"Decoded frame count mismatch in {name}")

        tolerance = workload["videoColorTolerance"] if is_video else 0
        for sample in workload["markerSamples"]:
            if not is_video and sample["frame"] != workload["previewFrame"]:
                continue
            frame = sample["frame"] - start if is_video else 0
            interior_samples = [*swatches, {**sample, "name": "marker", "rgb": workload["markerRgb"]}]
            interior_samples.extend({**other, "name": "absent marker", "rgb": background}
                                    for other in workload["markerSamples"] if other["frame"] != sample["frame"])
            for point in interior_samples:
                offset = frame * frame_bytes + (point["y"] * width + point["x"]) * channels
                expected = point["rgb"] if is_video else [*point["rgb"], 255]
                pixel = decoded[offset:offset + channels]
                if len(pixel) != len(expected) or any(abs(actual - target) > tolerance for actual, target in zip(pixel, expected)):
                    raise ValueError(f"{name} frame {sample['frame']} {point['name']}: {list(pixel)} differs from {expected}")
        digests[name] = hashlib.sha256(decoded).hexdigest()

    cold, repeat, first_video, repeat_video = ENGINE_MEDIA
    if digests[cold] != digests[repeat] or digests[first_video] != digests[repeat_video]:
        raise ValueError("First and repeat renders differ after decoding")
    return {"fixture": fixture, "decodedSha256": digests}


def span(values):
    return f"{statistics.median(values):.1f} [{min(values):.1f}–{max(values):.1f}]"


def phase_span(calls, key):
    values = [call[key] for call in calls if call[key] is not None]
    return span(values) if values else "—"


def summary(report, modes):
    environment, runs = report["environment"], report["runs"]
    checkout = " with local changes" if environment["dirty"] else ""
    comparison = report["comparison"]
    paired = comparison == "engine-pair"
    engine = comparison in ("engine", "engine-pair")
    mode_name = ENGINE_NAMES.__getitem__ if paired else str
    title = {"execution": "Render performance baseline", "bundle": "Render bundle reuse comparison",
             "engine": "Remotion baseline for the shared engine workload", "engine-pair": "Paired render engine comparison"}[comparison]
    count = report["samples"] if comparison == "engine" else report["pairs"]
    repetitions = f"{count} {'paired ' if comparison != 'engine' else ''}repetition{'s' if count != 1 else ''}"
    startup = "Request to first phase" if paired else "Request to bundle"
    selection = "Selection or preflight" if paired else "Composition selection"
    lines = [f"# {title}", "",
             f"Commit `{environment['commit']}`{checkout} · {environment['os']} · Node {environment['node']} · {repetitions}", "",
             "Times are milliseconds. Values show the median and observed range. Raw fields are in `baseline.json`.", "",
             f"| Operation | Mode | Total | {startup} | Bundle stage | {selection} | Render to settlement |",
             "| --- | --- | ---: | ---: | ---: | ---: | ---: |"]
    for name in (call["name"] for call in runs[0]["calls"]):
        for mode in modes:
            calls = [call for run in runs if run["mode"] == mode for call in run["calls"] if call["name"] == name]
            fields = ("totalMs", "startupMs", "bundleMs", "selectionMs", "renderToSettleMs")
            lines.append(f"| {name} | {mode_name(mode)} | " + " | ".join(phase_span(calls, key) for key in fields) + " |")
    if not engine:
        lines += ["", "| Mode | Cancel to rejection | Cancel to reaping confirmation | Host startup | Shutdown to reaping | Scratch reclamation |",
                  "| --- | ---: | ---: | ---: | ---: | ---: |"]
        for mode in modes:
            own = [run for run in runs if run["mode"] == mode]
            cancelled = [call for run in own for call in run["calls"] if call["status"] == "cancelled"]
            spans = [span([call[field] for call in cancelled]) for field in ("abortToRejectionMs", "abortToReapConfirmationMs")]
            spans += [span([run[field] for run in own]) for field in ("hostStartupObservedMs", "shutdownToReapedObservedMs", "scratchReclaimMs")]
            lines.append(f"| {mode} | " + " | ".join(spans) + " |")
    lines += ["", "| Mode | Process tree CPU (s) | Peak tree RSS (MiB) | Peak temporary space (MiB) | Peak workspace cache (MiB) |",
              "| --- | ---: | ---: | ---: | ---: |"]
    for mode in modes:
        own = [run for run in runs if run["mode"] == mode]
        spans = [span([sum(run["cpuSeconds"].values()) for run in own])]
        spans += [span([run[field] / MIB for run in own]) for field in
                  ("peakProcessTreeRssBytes", "peakTemporaryBytes", "peakBundleCacheBytes")]
        lines.append(f"| {mode_name(mode)} | " + " | ".join(spans) + " |")
    if comparison == "bundle":
        prepared = [r for r in runs if r["mode"] == "worker-prepared"]
        build_ms = [r["preparation"]["elapsedMs"] for r in prepared]
        totals = {mode: span([r["hostWallMs"] for r in runs if r["mode"] == mode]) for mode in modes}
        lines += ["", f"Preparation before the first request (ms): {span(build_ms)}.", "",
                  "| Mode | Whole sample including preparation and shutdown (ms) |", "| --- | ---: |",
                  *[f"| {mode} | {totals[mode]} |" for mode in modes]]
    if engine:
        snapshot = runs[0]["fixture"]["snapshotHash"]
        media_location = "reference/<mode>/" if paired else "reference/"
        lines += ["", f"Snapshot SHA-256 `{snapshot}`.", "",
                  "Each sample starts in a fresh process and workspace. Both video calls follow the preview calls in the same renderer.",
                  "All decoded pixels matched within each engine across its first and repeat renders and across repetitions.",
                  "Both engines use the same interior color and motion checks on the shared workload." if paired
                  else "Sampled interior pixels verified the marker motion.",
                  f"The media checks run outside the measured process tree. First samples are in `{media_location}`.", ""]
        if paired:
            lines += ["Pair order alternates on the same runner. Only Remotion bundles and selects a browser composition.",
                      "SVG and FFmpeg use the selecting phase for graph preflight and encode in the rasterization process.",
                      "The elapsed times and sampled resource peaks describe this single shape-only workload. They are not CI speed thresholds.",
                      "Cross-engine equality is checked at the reference interior pixels with the declared tolerance, not at antialiased edges.", ""]
    else:
        lines += ["", "Preview bytes, decoded video frames and layout measurements matched across all runs. Every cancelled video",
                  "rejected after live frame progress and its observed processes were reaped before the recovery preview.", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=3, help="repetitions per mode")
    parser.add_argument("--compare", choices=COMPARISONS, default="execution", help="execution modes, worker bundle reuse or single/paired engines")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.samples < 1 or sys.platform != "linux":
        parser.error("Run on Linux and specify at least one repetition")
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "The benchmark needs Linux subreaper support")

    def interrupt(_signum, _frame):
        raise InterruptedError("The performance baseline was stopped")

    signal.signal(signal.SIGTERM, interrupt)
    paired = args.compare == "engine-pair"
    engine = args.compare in ("engine", "engine-pair")
    output = args.output or ROOT / "out" / {"execution": "render-performance", "bundle": "render-bundle-reuse",
                                           "engine": "render-engine-baseline", "engine-pair": "render-engine-comparison"}[args.compare]
    output.mkdir(parents=True, exist_ok=True)
    modes = COMPARISONS[args.compare]
    repetition_key = "sample" if args.compare == "engine" else "pair"
    report = {"schemaVersion": "1.0.0", "status": "running", "comparison": args.compare, repetition_key + "s": args.samples,
              "sampleIntervalMs": INTERVAL * 1000, "runs": []}
    try:
        if engine:
            command("node", "--import", "tsx", "scripts/fixtures/water-motion-baseline.ts")
        report["environment"] = installed_environment()
        arch = {"x86_64": "x64", "aarch64": "arm64"}[platform.machine()]
        binaries = ROOT / "node_modules/@remotion" / f"compositor-linux-{arch}-gnu"
        ffprobe, ffmpeg = binaries / "ffprobe", binaries / "ffmpeg"
        report["environment"]["ffmpeg"] = command(str(ffmpeg), "-version").splitlines()[0]
        if engine:
            ffprobe, ffmpeg = "ffprobe", "ffmpeg"
            report["environment"]["verificationFfmpeg"] = command(ffmpeg, "-version").splitlines()[0]
            report["environment"]["verificationFfprobe"] = command(ffprobe, "-version").splitlines()[0]
            if paired:
                report["environment"]["svgEncoderFfmpeg"] = report["environment"]["verificationFfmpeg"]
        references = {}
        common_fixture = None
        for index in range(args.samples):
            for mode in (modes if index % 2 == 0 else reversed(modes)):
                with tempfile.TemporaryDirectory(prefix="sm-render-bench-") as directory:
                    row, results = measure(mode, Path(directory), engine)
                    row[repetition_key] = index + 1
                    verify = engine_fingerprint if engine else fingerprint
                    row["outputVerification"] = verify(row, results, ffprobe, ffmpeg)
                    report["runs"].append(row)
                    verification_key = mode if engine else "common"
                    reference = references.setdefault(verification_key, row["outputVerification"])
                    if row["outputVerification"] != reference:
                        raise ValueError(f"Output mismatch in repetition {index + 1}, {mode}")
                    if engine:
                        fixture = {key: value for key, value in row["fixture"].items() if key != "renderer"}
                        if common_fixture is None:
                            common_fixture = fixture
                        if fixture != common_fixture or row["fixture"]["renderer"]["id"] != ENGINE_IDENTITIES[mode]:
                            raise ValueError(f"Engine {mode} did not verify the common workload with the expected adapter")
                    if engine and index == 0:
                        media = output / "reference" / mode if paired else output / "reference"
                        media.mkdir(parents=True, exist_ok=True)
                        for name in ENGINE_MEDIA:
                            shutil.copy2(results / name, media / name)
                        shutil.copy2(ENGINE_FIXTURE, output / "workload.json")
                        hashes = {name: hashlib.sha256((media / name).read_bytes()).hexdigest() for name in ENGINE_MEDIA}
                        if paired:
                            report.setdefault("referenceSha256", {})[mode] = hashes
                        else:
                            report["referenceSha256"] = hashes
                    print(f"{repetition_key.capitalize()} {index + 1}/{args.samples} {mode}: {row['hostWallMs'] / 1000:.1f}s", flush=True)
        report["status"] = "passed"
        (output / "summary.md").write_text(summary(report, modes), encoding="utf8")
    except (Exception, KeyboardInterrupt) as error:
        report.update(status="failed", failure=str(error))
        (output / "summary.md").write_text(
            "# Render performance baseline\n\nThe benchmark failed. See `baseline.json` for the failure and completed samples.\n",
            encoding="utf8")
        raise
    finally:
        (output / "baseline.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")


if __name__ == "__main__":
    main()
