# Controlled Next-Question Benchmark Results

- Run ID: `2026-09-28T13-34-48-step-plan-judge-682ebd14`
- Commit: `38c3802b525ab45bde69e847ad57ec3d417481fe`
- Benchmark status: **INCOMPLETE**; READY_FOR_COMPETITION_REPORT = NO
- Judge: `step-5-preview`, temperature 0, one independent absolute score per candidate
- Judge endpoint: `https://api.stepfun.com/step_plan/v1/chat/completions`; concurrency: 2
- Judge code commit: `71847bbec6847dc730785646fd5aab449ac6f02e`
- Explicit Judge retry rounds: schema_invalid_round_1: 45 attempted, 21 scored, 24 failed; remaining_failures_round_2: 24 attempted, 3 scored, 21 failed; remaining_failures_round_3: 21 attempted, 13 scored, 8 failed; output_length_rule_retry: 8 attempted, 6 scored, 2 failed
- Audio: 10 frozen canonical WAV files; see [audio manifest](../../audio/manifest.json)
- Samples: 90/90 completed; 90 provider attempts; 88 judged; 54 primary-score eligible
- ASR excluded: 36; Judge failures or missing results: 2 (JUDGE_OUTPUT_TOKEN_LIMIT=2)
- Runtime parity: 30/30 complete Case × run groups passed shared-input and profile checks; failures: 0
- Standard deviation uses sample standard deviation (n−1). Score and latency are reported separately.
- The scores below are a partial, non-representative subset because some Judge outputs failed; do not treat these contrasts as a completed benchmark result.

## Overall scores

| Variant | Valid N | Mean | Median | Std Dev |
|---|---:|---:|---:|---:|
| A | 18 | 47 | 48 | 25.96 |
| B | 18 | 47.56 | 51 | 23.11 |
| C | 18 | 44.83 | 38 | 23.87 |

## Score dimensions

| Dimension | A | B | C |
|---|---:|---:|---:|
| Information Gain | 13.22 | 13.94 | 13.5 |
| Context Use / Non-Repetition | 12.28 | 12.44 | 10.89 |
| Story Value | 8.83 | 8.83 | 8.28 |
| Depth | 5.89 | 5.83 | 5.33 |
| Non-Leading | 6.78 | 6.5 | 6.83 |

## Controlled contrasts

| Contrast | Total score delta | Information Gain | Context Use | Story Value | Depth | Non-Leading |
|---|---:|---:|---:|---:|---:|---:|
| A → B (Coach) | +0.56 (n=18) | +0.72 (n=18) | +0.17 (n=18) | 0 (n=18) | -0.06 (n=18) | -0.28 (n=18) |
| B → C (Memory + Era) | -2.72 (n=18) | -0.44 (n=18) | -1.56 (n=18) | -0.56 (n=18) | -0.5 (n=18) | +0.33 (n=18) |
| A → C | -2.17 (n=18) | +0.28 (n=18) | -1.39 (n=18) | -0.56 (n=18) | -0.56 (n=18) | +0.06 (n=18) |

**Q1 — Coach (partial only):** C01–C04 A→B paired mean total-score delta +20.67 (n=6); the available subset is too small for a benchmark conclusion.
**Q2 — Memory Retrieval + Era:** B→C overall paired mean total-score delta -2.72 (n=18); Retrieval C05–C08 -5.5 (n=6), Era C09–C10 -7.67 (n=6). These sparse pairs are non-representative and do not support a completed conclusion. C made no Memory or Era requests, so this contrast does not measure either capability.
**Q3 — Source of change:** no complete conclusion is available; dimension contrasts below are from the partial judged subset only.

## Case groups

| Group | Variant | Valid N | Mean | Median | Std Dev |
|---|---|---:|---:|---:|---:|
| Coach Cases C01–C04 | A | 6 | 37.17 | 31.5 | 34.15 |
| Coach Cases C01–C04 | B | 6 | 57.83 | 56 | 17.42 |
| Coach Cases C01–C04 | C | 6 | 62.83 | 62 | 20.95 |
| Retrieval Cases C05–C08 | A | 6 | 47 | 48 | 10.86 |
| Retrieval Cases C05–C08 | B | 6 | 40.17 | 48 | 24.28 |
| Retrieval Cases C05–C08 | C | 6 | 34.67 | 32 | 7.58 |
| Era Cases C09–C10 | A | 6 | 56.83 | 63 | 27.85 |
| Era Cases C09–C10 | B | 6 | 44.67 | 52 | 26.86 |
| Era Cases C09–C10 | C | 6 | 37 | 30 | 29.22 |

## Case-by-case

| Case | A mean | B mean | C mean | Main capability |
|---|---:|---:|---:|---|
| C01 | n/a | n/a | n/a | Coach |
| C02 | 36.33 | 64.67 | 81 | Coach |
| C03 | 38 | 51 | 44.67 | Coach |
| C04 | n/a | n/a | n/a | Coach |
| C05 | 54 | 41 | 39.67 | Memory Retrieval |
| C06 | 40 | 39.33 | 29.67 | Memory Retrieval |
| C07 | n/a | n/a | n/a | Memory Retrieval |
| C08 | n/a | n/a | n/a | Memory Retrieval |
| C09 | 64 | 35 | 24 | Era |
| C10 | 49.67 | 54.33 | 50 | Era |

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
- Judge errors or missing results: JUDGE_OUTPUT_TOKEN_LIMIT=2
- Negative case-level paired deltas: C03 (A→B 13, B→C -6.33); C05 (A→B -13, B→C -1.33); C06 (A→B -0.67, B→C -9.67); C09 (A→B -29, B→C -11); C10 (A→B 4.67, B→C -4.33)
- All completed candidates and technical traces remain in the result directory; the primary score excludes only ASR-mismatch samples and failed Judge records.
- Completion blockers: JUDGE_COVERAGE_INCOMPLETE, C_MEMORY_EVIDENCE_MISSING
