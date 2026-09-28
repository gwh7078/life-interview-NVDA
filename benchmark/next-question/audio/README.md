# Canonical audio fixtures

The initial supported cases are `C06.wav` and `C07.wav`. Create each from its frozen `userAnswer` in `../cases.ts` exactly once. Use one canonical PCM16 mono 16 kHz WAV for all A/B/C variants and every repetition of that Case.

The Runner reads the WAV header and audio data, records the whole-file SHA-256, then converts the PCM to the current StepFun adapter's 24 kHz input format. It does not record, synthesize, or rewrite fixtures. Once a Case has been used, keep that WAV unchanged; replacing it creates a different benchmark input and hash.
