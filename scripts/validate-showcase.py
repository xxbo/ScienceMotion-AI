"""Validate the small, checked-in review video, independently of online TTS."""
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

path = Path(sys.argv[1] if len(sys.argv) > 1 else "docs/showcase/cpu-cache-30s.mp4")
metadata = json.loads(subprocess.check_output([
    "ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(path)
]))
video = [s for s in metadata["streams"] if s["codec_type"] == "video"]
audio = [s for s in metadata["streams"] if s["codec_type"] == "audio"]
assert len(video) == len(audio) == 1, "Expected one video stream and one narration stream"
v, a = video[0], audio[0]
assert (v["codec_name"], v["width"], v["height"], v["r_frame_rate"], int(v["nb_read_frames"])) == ("h264", 1280, 720, "30/1", 900)
assert a["codec_name"] == "aac" and int(a["sample_rate"]) == 48000
assert all(abs(float(item["duration"]) - 30) < 0.05 for item in [v, a, metadata["format"]]), "Both streams must span 30 seconds"
decoded = subprocess.run(["ffmpeg", "-hide_banner", "-xerror", "-i", str(path),
                          "-af", "volumedetect", "-vf", "blackdetect=d=0.1:pic_th=0.98:pix_th=0.03",
                          "-f", "null", "-"], capture_output=True, text=True)
assert decoded.returncode == 0, decoded.stderr
volume = re.search(r"mean_volume: (-?[0-9.]+) dB", decoded.stderr)
assert volume and -40 < float(volume.group(1)) < -6, "Narration must contain an audible signal"
assert "black_start:" not in decoded.stderr, "Unexpected black interval in the sample"
evidence = path.parent / "evidence.json"
if evidence.exists():
    recorded = json.loads(evidence.read_text())
    assert hashlib.sha256(path.read_bytes()).hexdigest() == recorded["videoSha256"], "Published sample differs from its recorded evidence"
print("PASS showcase: 900 decodable frames, 1280x720, 30 fps, H.264 + audible AAC track, both streams 30 seconds")
