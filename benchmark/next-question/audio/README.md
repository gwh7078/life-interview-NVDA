# Canonical audio fixtures

The ten frozen Case answers are synthesized directly from `../cases.ts` once with Apple macOS Speech Synthesis (`say` / `NSSpeechSynthesizer`), voice Tingting (`zh_CN`), 180 words per minute, and the default synthesis volume (1.0, no post-scaling). `afconvert` produces PCM signed 16-bit little-endian, mono, 16 kHz WAV files.

Generate or verify the fixtures with:

```bash
bash scripts/codex-node.sh npm run benchmark:next-question:audio
```

The script never overwrites a canonical WAV. `manifest.json` records the exact source text, TTS settings, duration, format, and whole-file SHA-256. Every A/B/C Sample and retry for a Case reuses its same WAV. The Runner verifies the manifest hash before starting and converts the loaded PCM to the current production adapter input rate without changing production audio parameters.
