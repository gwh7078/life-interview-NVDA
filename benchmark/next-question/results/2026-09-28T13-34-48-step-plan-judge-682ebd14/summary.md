# Controlled Next-Question Benchmark Results

- Run ID: `2026-09-28T13-34-48-step-plan-judge-682ebd14`
- Commit: `38c3802b525ab45bde69e847ad57ec3d417481fe`
- Benchmark status: **INCOMPLETE**; READY_FOR_COMPETITION_REPORT = NO
- Judge: `step-5-preview`, temperature 0, one independent absolute score per candidate
- Judge endpoint: `https://api.stepfun.com/step_plan/v1/chat/completions`; concurrency: 2
- Judge code commit: `71847bbec6847dc730785646fd5aab449ac6f02e`
- Explicit Judge retry rounds: schema_invalid_round_1: 45 attempted, 21 scored, 24 failed; remaining_failures_round_2: 24 attempted, 3 scored, 21 failed
- Audio: 10 frozen canonical WAV files; see [audio manifest](../../audio/manifest.json)
- Samples: 90/90 completed; 90 provider attempts; 69 judged; 41 primary-score eligible
- ASR excluded: 36; Judge failures or missing results: 21 (JUDGE_RESPONSE_SCHEMA_INVALID=13, JUDGE_OUTPUT_TOKEN_LIMIT=8)
- Runtime parity: 30/30 complete Case × run groups passed shared-input and profile checks; failures: 0
- Standard deviation uses sample standard deviation (n−1). Score and latency are reported separately.
- The scores below are a partial, non-representative subset because some Judge outputs failed; do not treat these contrasts as a completed benchmark result.

## Overall scores

| Variant | Valid N | Mean | Median | Std Dev |
|---|---:|---:|---:|---:|
| A | 16 | 47.25 | 50.5 | 27.62 |
| B | 12 | 49.25 | 53.5 | 25.36 |
| C | 13 | 42.15 | 32 | 25.16 |

## Score dimensions

| Dimension | A | B | C |
|---|---:|---:|---:|
| Information Gain | 13.31 | 14.58 | 12.46 |
| Context Use / Non-Repetition | 12.44 | 12.75 | 10.23 |
| Story Value | 9 | 9.17 | 7.54 |
| Depth | 6 | 6.17 | 4.92 |
| Non-Leading | 6.5 | 6.58 | 7 |

## Controlled contrasts

| Contrast | Total score delta | Information Gain | Context Use | Story Value | Depth | Non-Leading |
|---|---:|---:|---:|---:|---:|---:|
| A → B (Coach) | +9.18 (n=11) | +3.82 (n=11) | +2.27 (n=11) | +1.45 (n=11) | +1.27 (n=11) | +0.36 (n=11) |
| B → C (Memory + Era) | -12.27 (n=11) | -3.55 (n=11) | -3.82 (n=11) | -2.82 (n=11) | -2.09 (n=11) | 0 (n=11) |
| A → C | -5.75 (n=12) | -1 (n=12) | -2.17 (n=12) | -1.75 (n=12) | -1.08 (n=12) | +0.25 (n=12) |

**Q1 — Coach (partial only):** C01–C04 A→B paired mean total-score delta +50.67 (n=3); the available subset is too small for a benchmark conclusion.
**Q2 — Memory Retrieval + Era:** B→C overall paired mean total-score delta -12.27 (n=11); Retrieval C05–C08 -9.75 (n=4), Era C09–C10 -20.75 (n=4). These sparse pairs are non-representative and do not support a completed conclusion. C made no Memory or Era requests, so this contrast does not measure either capability.
**Q3 — Source of change:** no complete conclusion is available; dimension contrasts below are from the partial judged subset only.

## Case groups

| Group | Variant | Valid N | Mean | Median | Std Dev |
|---|---|---:|---:|---:|---:|
| Coach Cases C01–C04 | A | 6 | 37.17 | 31.5 | 34.15 |
| Coach Cases C01–C04 | B | 3 | 71.67 | 77 | 11.02 |
| Coach Cases C01–C04 | C | 5 | 68 | 75 | 18.67 |
| Retrieval Cases C05–C08 | A | 5 | 47 | 49 | 12.14 |
| Retrieval Cases C05–C08 | B | 4 | 41.75 | 48 | 22.05 |
| Retrieval Cases C05–C08 | C | 4 | 32 | 30.5 | 4.97 |
| Era Cases C09–C10 | A | 5 | 59.6 | 73 | 30.2 |
| Era Cases C09–C10 | B | 5 | 41.8 | 46 | 28.99 |
| Era Cases C09–C10 | C | 4 | 20 | 20.5 | 11.69 |

## Case-by-case

| Case | A mean | B mean | C mean | Main capability |
|---|---:|---:|---:|---|
| C01 | n/a | n/a | n/a | Coach |
| C02 | 36.33 | 78 | 81 | Coach |
| C03 | 38 | 59 | 48.5 | Coach |
| C04 | n/a | n/a | n/a | Coach |
| C05 | 54 | 29.5 | 35.5 | Memory Retrieval |
| C06 | 36.5 | 54 | 28.5 | Memory Retrieval |
| C07 | n/a | n/a | n/a | Memory Retrieval |
| C08 | n/a | n/a | n/a | Memory Retrieval |
| C09 | 74.5 | 35 | 24 | Era |
| C10 | 49.67 | 52 | 8 | Era |

## Technical behavior

- B Gate intervention rate: 0.0% (0/29)
- C Gate intervention rate: 0.0% (0/28)
- C Memory request rate: 0.0%; retrieval success among requests: n/a; mean evidence/sample: 0
- C Era request rate: 0.0%; retrieval success among requests: n/a
- Coach success: 95.0%; fail-open: 5.0%; timeout: 0.0%
- ASR equivalence: 60.0%; excluded core-content mismatches: 36
- Gate intervention rate denominator: successfully evaluated Coach gates; Retrieval/Era success denominator: Gate-requested retrievals; Coach rates denominator: completed B+C samples; ASR denominator: completed samples.

## Latency (milliseconds; not part of quality score)

| Variant | Stage | P50 | P95 | N |
|---|---|---:|---:|---:|
| A | total_latency_ms | 10393.5 | 14759.08 | 30 |
| B | gate_latency_ms | 1290.975 | 1782.86 | 30 |
| B | coach_latency_ms | 1290.975 | 1782.86 | 30 |
| B | total_latency_ms | 12478.865 | 18544.55 | 30 |
| C | gate_latency_ms | 1326.845 | 2008.53 | 30 |
| C | memory_latency_ms | n/a | n/a | 0 |
| C | era_latency_ms | n/a | n/a | 0 |
| C | resolve_latency_ms | n/a | n/a | 0 |
| C | coach_latency_ms | 1326.845 | 2008.53 | 30 |
| C | total_latency_ms | 11886.125 | 16285.74 | 30 |

## Exclusions and regressions

- ASR mismatch sample IDs: C01-A-run1, C01-A-run2, C01-A-run3, C01-B-run1, C01-B-run2, C01-B-run3, C01-C-run1, C01-C-run2, C01-C-run3, C04-A-run1, C04-A-run2, C04-A-run3, C04-B-run1, C04-B-run2, C04-B-run3, C04-C-run1, C04-C-run2, C04-C-run3, C07-A-run1, C07-A-run2, C07-A-run3, C07-B-run1, C07-B-run2, C07-B-run3, C07-C-run1, C07-C-run2, C07-C-run3, C08-A-run1, C08-A-run2, C08-A-run3, C08-B-run1, C08-B-run2, C08-B-run3, C08-C-run1, C08-C-run2, C08-C-run3
- Judge errors or missing results: JUDGE_RESPONSE_SCHEMA_INVALID=13, JUDGE_OUTPUT_TOKEN_LIMIT=8
- Negative case-level paired deltas: C02 (A→B 66, B→C -1.5); C03 (A→B 20, B→C -10); C05 (A→B -27, B→C 6); C06 (A→B 17.5, B→C -25.5); C09 (A→B -36.5, B→C -11); C10 (A→B 20.5, B→C -50)
- All completed candidates and technical traces remain in the result directory; the primary score excludes only ASR-mismatch samples and failed Judge records.
- Completion blockers: JUDGE_COVERAGE_INCOMPLETE, C_MEMORY_EVIDENCE_MISSING
