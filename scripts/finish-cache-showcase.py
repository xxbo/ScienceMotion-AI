"""Optional narration/MP4 finishing outside the current Project Graph audio API."""
import asyncio
import json
import hashlib
import os
import subprocess
import wave
from pathlib import Path
import edge_tts

# Trust the environment's installed CA chain as well as certifi; keep TLS verification enabled.
edge_tts.communicate._SSL_CTX.load_default_certs()

ROOT = Path(__file__).resolve().parents[1] / "out" / "cache-showcase"

def run(args):
    subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

def duration(path):
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)]))

async def main():
    config = json.loads((ROOT / "narration.json").read_text())
    evidence = []
    for shot in config["shots"]:
        mp3 = ROOT / (shot["id"] + ".mp3")
        fingerprint = hashlib.sha256(json.dumps([shot["narration"], config["voice"], config["rate"]], ensure_ascii=False).encode()).hexdigest()
        cache_key = mp3.with_suffix(".tts-key")
        if not mp3.exists() or mp3.stat().st_size == 0 or not cache_key.exists() or cache_key.read_text() != fingerprint:
            await edge_tts.Communicate(shot["narration"], config["voice"], rate=config["rate"],
                                      proxy=os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")).save(str(mp3))
            cache_key.write_text(fingerprint)
        original = duration(mp3)
        target = shot["frames"] / config["fps"]
        speed = max(1.0, original / (target - 0.65))
        if speed > 1.20:
            raise RuntimeError(f"Narration for {shot['id']} is too long ({original:.2f}s); shorten the script")
        samples = round(target * 48000)
        filters = (f"atempo={speed:.6f},loudnorm=I=-17:TP=-1.5:LRA=8,aresample=48000,asetpts=N/SR/TB,"
                   f"adelay=12000S:all=1,apad=whole_len={samples},atrim=end_sample={samples},asetpts=N/SR/TB")
        wav = ROOT / (shot["id"] + ".wav")
        run(["ffmpeg", "-y", "-v", "error", "-i", str(mp3), "-af", filters, "-ar", "48000", "-ac", "1", str(wav)])
        with wave.open(str(wav)) as audio:
            assert audio.getnframes() == samples and audio.getframerate() == 48000, "Scene audio must match its exact frame duration"
        evidence.append({"scene":shot["id"],"text":shot["narration"],"ttsSeconds":original,
                         "tempoFactor":speed,"timelineStartSeconds":shot["start"]/config["fps"]+0.25,
                         "spokenEndSeconds":shot["start"]/config["fps"]+0.25+original/speed,
                         "sceneEndSeconds":(shot["start"]+shot["frames"])/config["fps"],
                         "paddedSamples":samples,"sampleRate":48000})
        print(f"Narration {shot['id']}: {original:.2f}s, tempo {speed:.3f}, fits {target:.0f}s scene", flush=True)
    for kind, suffix in [("audio","wav"),("video","mp4")]:
        (ROOT/(kind+"-concat.txt")).write_text("".join(f"file '{shot['id']}.{suffix}'\n" for shot in config["shots"]))
    run(["ffmpeg","-y","-v","error","-f","concat","-safe","0","-i",str(ROOT/"audio-concat.txt"),"-c:a","pcm_s16le",str(ROOT/"narration.wav")])
    run(["ffmpeg","-y","-v","error","-f","concat","-safe","0","-i",str(ROOT/"video-concat.txt"),"-c","copy","-movflags","+faststart",str(ROOT/"cpu-cache-silent.mp4")])
    run(["ffmpeg","-y","-v","error","-i",str(ROOT/"cpu-cache-silent.mp4"),"-i",str(ROOT/"narration.wav"),"-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","aac","-b:a","160k","-t","30","-movflags","+faststart",str(ROOT/"cpu-cache-30s.mp4")])
    (ROOT/"audio-evidence.json").write_text(json.dumps({"voice":config["voice"],"rate":config["rate"],"shots":evidence},ensure_ascii=False,indent=2)+"\n")

if __name__ == "__main__":
    asyncio.run(main())
