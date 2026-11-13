#!/usr/bin/env python3
"""Generate the CPU-cache Mandarin narration with Edge TTS.

The voice is configurable in narration.json. The generated MP3 is a build
artifact under public/ and is intentionally not committed to source control.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import edge_tts

ROOT = Path(__file__).resolve().parents[2]
INPUT = ROOT / "docs/episodes/cpu-cache/narration.json"
EPISODE = ROOT / "episodes/cpu-cache/episode.json"
OUTPUT = ROOT / "public/episodes/cpu-cache/narration.mp3"


async def main() -> None:
    config = json.loads(INPUT.read_text(encoding="utf-8"))
    episode = json.loads(EPISODE.read_text(encoding="utf-8"))
    text = " ".join(segment["text"].strip() for segment in episode["narration"] if segment["text"].strip())
    if not text:
        raise ValueError("Narration text is empty")

    voice = os.environ.get("SCIENCEMOTION_TTS_VOICE", config.get("voice", "zh-CN-YunxiNeural"))
    rate = os.environ.get("SCIENCEMOTION_TTS_RATE", config.get("rate", "+0%"))
    volume = config.get("volume", "+0%")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    communicate = edge_tts.Communicate(text, voice, rate=rate, volume=volume)
    await communicate.save(str(OUTPUT))

    if not OUTPUT.exists() or OUTPUT.stat().st_size < 10_000:
        raise RuntimeError("TTS output is missing or unexpectedly small")

    print(f"Generated {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size:,} bytes)")
    print(f"Voice: {voice}; rate: {rate}")


if __name__ == "__main__":
    asyncio.run(main())
