# Controlled Next-Question Benchmark Results

- Run ID: `2026-09-28T11-54-23-404Z-27c55a4d`
- Commit: `8bd75fe37640a83e536e9f72849605a8916dd933`
- Benchmark status: **INCOMPLETE**; READY_FOR_COMPETITION_REPORT = NO
- Judge: `step-5-preview`, temperature 0, one independent absolute score per candidate
- Audio: 10 frozen canonical WAV files; see [audio manifest](../../audio/manifest.json)
- Samples: 90/90 completed; 90 provider attempts; 28 judged; 18 primary-score eligible
- ASR excluded: 36; Judge failures or missing results: 62 (JUDGE_RESPONSE_SCHEMA_INVALID=27, JUDGE_HTTP_ERROR_HTTP_402=35)
- Runtime parity: 30/30 complete Case × run groups passed shared-input and profile checks; failures: 0
- Standard deviation uses sample standard deviation (n−1). Score and latency are reported separately.
- The scores below are a partial, non-representative subset because some Judge outputs failed; do not treat these contrasts as a completed benchmark result.

## Overall scores

| Variant | Valid N | Mean | Median | Std Dev |
|---|---:|---:|---:|---:|
| A | 6 | 40.83 | 46.5 | 29.24 |
| B | 4 | 42.25 | 35 | 34.31 |
| C | 8 | 40.63 | 39 | 14.26 |

## Score dimensions

| Dimension | A | B | C |
|---|---:|---:|---:|
| Information Gain | 11.5 | 12.25 | 11.88 |
| Context Use / Non-Repetition | 10.17 | 11.25 | 10.38 |
| Story Value | 7.67 | 7 | 7.38 |
| Depth | 5.17 | 5 | 4.5 |
| Non-Leading | 6.33 | 6.75 | 6.5 |

## Controlled contrasts

| Contrast | Total score delta | Information Gain | Context Use | Story Value | Depth | Non-Leading |
|---|---:|---:|---:|---:|---:|---:|
| A → B (Coach) | +30.5 (n=2) | +8.5 (n=2) | +10 (n=2) | +5.5 (n=2) | +4 (n=2) | +2.5 (n=2) |
| B → C (Memory + Era) | n/a (0 paired samples) | n/a (0 paired samples) | n/a (0 paired samples) | n/a (0 paired samples) | n/a (0 paired samples) | n/a (0 paired samples) |
| A → C | -9 (n=1) | -5 (n=1) | 0 (n=1) | -5 (n=1) | -4 (n=1) | +5 (n=1) |

**Q1 — Coach (partial only):** C01–C04 A→B paired mean total-score delta +89 (n=1); the available subset is too small for a benchmark conclusion.
**Q2 — Memory Retrieval + Era:** B→C overall paired mean total-score delta n/a (0 paired samples); Retrieval C05–C08 n/a (0 paired samples), Era C09–C10 n/a (0 paired samples). The current Judge results provide no paired B→C evidence.
**Q3 — Source of change:** no complete conclusion is available; dimension contrasts below are from the partial judged subset only.

## Case groups

| Group | Variant | Valid N | Mean | Median | Std Dev |
|---|---|---:|---:|---:|---:|
| Coach Cases C01–C04 | A | 2 | 6.5 | 6.5 | 9.19 |
| Coach Cases C01–C04 | B | 2 | 67 | 67 | 31.11 |
| Coach Cases C01–C04 | C | 3 | 44 | 42 | 5.29 |
| Retrieval Cases C05–C08 | A | 2 | 46.5 | 46.5 | 9.19 |
| Retrieval Cases C05–C08 | B | 2 | 17.5 | 17.5 | 10.61 |
| Retrieval Cases C05–C08 | C | 3 | 32 | 31 | 5.57 |
| Era Cases C09–C10 | A | 2 | 69.5 | 69.5 | 6.36 |
| Era Cases C09–C10 | B | 0 | n/a | n/a | n/a |
| Era Cases C09–C10 | C | 2 | 48.5 | 48.5 | 30.41 |

## Case-by-case

| Case | A mean | B mean | C mean | Main capability |
|---|---:|---:|---:|---|
| C01 | n/a | n/a | n/a | Coach |
| C02 | 6.5 | 67 | n/a | Coach |
| C03 | n/a | n/a | 44 | Coach |
| C04 | n/a | n/a | n/a | Coach |
| C05 | 53 | 25 | 27 | Memory Retrieval |
| C06 | 40 | 10 | 34.5 | Memory Retrieval |
| C07 | n/a | n/a | n/a | Memory Retrieval |
| C08 | n/a | n/a | n/a | Memory Retrieval |
| C09 | 69.5 | n/a | n/a | Era |
| C10 | n/a | n/a | 48.5 | Era |

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
- Judge errors or missing results: JUDGE_RESPONSE_SCHEMA_INVALID=27, JUDGE_HTTP_ERROR_HTTP_402=35
- Negative case-level paired deltas: C05 (A→B -28, B→C n/a)
- All completed candidates and technical traces remain in the result directory; the primary score excludes only ASR-mismatch samples and failed Judge records.
- Completion blockers: JUDGE_COVERAGE_INCOMPLETE
