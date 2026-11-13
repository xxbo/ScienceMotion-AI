# CPU Cache Episode — Audio Pipeline

## Current implementation

- Provider adapter: Edge TTS, isolated behind `scripts/voice/generate_narration.py`.
- Voice: `zh-CN-YunxiNeural` by default.
- Input: `docs/episodes/cpu-cache/narration.json`.
- Output: `public/episodes/cpu-cache/narration.mp3` (generated build asset, not committed).
- Remotion places the narration track at frame 0.

The provider and voice are configurable through `SCIENCEMOTION_TTS_VOICE` and `SCIENCEMOTION_TTS_RATE`. The generated audio is a build artifact; never commit credentials or generated audio to the source tree.

## Local setup

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements-voice.txt
npm install
npm run render
```

On Windows, activate the virtual environment with `.venv\\Scripts\\activate` and run the same npm scripts.

## Current limitation

The current cut uses a single continuous narration track and scene-level caption blocks. It is a first audio integration, not yet word-level forced alignment. Fine-grained subtitle timing, pauses, music ducking, and per-shot retakes are planned follow-ups.

## Provider note

Edge TTS uses Microsoft's online speech service. It requires network access and may be subject to service availability and provider terms. Keep the adapter replaceable so a local or commercial TTS provider can be added without changing Remotion scenes.
