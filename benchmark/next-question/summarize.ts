import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type Row = Record<string, any>;
const DIMENSIONS = ['information_gain', 'context_use', 'story_value', 'depth', 'non_leading'] as const;
const VARIANTS = ['A', 'B', 'C'] as const;
const CASE_GROUPS = {
  coach: { title: 'Coach Cases C01–C04', caseIds: ['C01', 'C02', 'C03', 'C04'], contrast: 'A → B' },
  retrieval: { title: 'Retrieval Cases C05–C08', caseIds: ['C05', 'C06', 'C07', 'C08'], contrast: 'B → C' },
  era: { title: 'Era Cases C09–C10', caseIds: ['C09', 'C10'], contrast: 'B → C' },
} as const;

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name}.`);
  return value;
}

function json(pathname: string): Row {
  return JSON.parse(readFileSync(pathname, 'utf8')) as Row;
}

function jsonl(pathname: string): Row[] {
  return readFileSync(pathname, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Row);
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function standardDeviation(values: number[]): number | null {
  if (!values.length) return null;
  if (values.length === 1) return 0;
  const average = mean(values)!;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function stats(values: number[]): Row {
  return {
    n: values.length,
    mean: mean(values),
    median: median(values),
    std_dev: standardDeviation(values),
  };
}

function p95(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!;
}

function latencyStats(samples: Row[], field: string): Row {
  const values = samples.map((sample) => sample[field]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return { n: values.length, p50: median(values), p95: p95(values) };
}

function round(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(2));
}

function getScore(row: Row): Row | undefined {
  if (row.status !== 'scored') return undefined;
  return row.scores && typeof row.scores === 'object' ? row.scores as Row : row;
}

function pairDeltas(records: Array<{ case_id: string; run: number; variant: string; score: Row }>, left: string, right: string, caseIds?: readonly string[]): Row {
  const allowed = caseIds ? new Set(caseIds) : undefined;
  const index = new Map(records
    .filter((record) => !allowed || allowed.has(record.case_id))
    .map((record) => [`${record.case_id}:${record.run}:${record.variant}`, record.score]));
  const deltas: Record<string, number[]> = { total_score: [] };
  for (const dimension of DIMENSIONS) deltas[dimension] = [];
  const cases = caseIds ?? [...new Set(records.map((record) => record.case_id))];
  for (const caseId of cases) {
    const runs = [...new Set(records.filter((record) => record.case_id === caseId).map((record) => record.run))];
    for (const run of runs) {
      const before = index.get(`${caseId}:${run}:${left}`);
      const after = index.get(`${caseId}:${run}:${right}`);
      if (!before || !after) continue;
      deltas.total_score.push(Number(after.total_score) - Number(before.total_score));
      for (const dimension of DIMENSIONS) deltas[dimension]!.push(Number(after[dimension]) - Number(before[dimension]));
    }
  }
  return Object.fromEntries(Object.entries(deltas).map(([key, values]) => [key, {
    paired_n: values.length,
    mean_delta: round(mean(values)),
    median_delta: round(median(values)),
  }]));
}

function rate(numerator: number, denominator: number): Row {
  return { numerator, denominator, rate: denominator ? numerator / denominator : null };
}

function statsForVariant(samples: Row[], records: Array<{ case_id: string; run: number; variant: string; score: Row }>, variant: string): Row {
  const scored = records.filter((record) => record.variant === variant);
  return {
    total_score: stats(scored.map((record) => Number(record.score.total_score))),
    dimensions: Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, stats(scored.map((record) => Number(record.score[dimension])))])),
    eligible_sample_count: samples.filter((sample) => sample.variant === variant && sample.primary_score_eligible === true).length,
  };
}

function technicalSummary(samples: Row[]): Row {
  const coachSamples = samples.filter((sample) => sample.coach_enabled === true && sample.status === 'completed');
  const cSamples = samples.filter((sample) => sample.variant === 'C' && sample.status === 'completed');
  const gateEvaluated = (variant: string) => samples.filter((sample) => sample.variant === variant
    && sample.status === 'completed' && sample.coach_enabled === true && sample.gate && typeof sample.gate === 'object');
  const intervention = (variant: string) => {
    const gates = gateEvaluated(variant);
    return rate(gates.filter((sample) => sample.gate.action && sample.gate.action !== 'none').length, gates.length);
  };
  const memoryRequests = cSamples.filter((sample) => sample.gate?.retrieve_memory === true);
  const eraRequests = cSamples.filter((sample) => sample.gate?.retrieve_era === true);
  const failOpen = coachSamples.filter((sample) => sample.coach_status === 'failed_open').length;
  const memoryEvidence = cSamples.map((sample) => Number(sample.memory_evidence_count ?? 0)).filter(Number.isFinite);
  const equivalenceTested = samples.filter((sample) => sample.status === 'completed' && ['PASS', 'FAIL'].includes(String(sample.input_equivalence)));
  const equivalencePassed = equivalenceTested.filter((sample) => sample.input_equivalence === 'PASS').length;
  const byVariant = Object.fromEntries(VARIANTS.map((variant) => {
    const variantSamples = samples.filter((sample) => sample.variant === variant && sample.status === 'completed');
    const latencyFields = variant === 'A'
      ? ['total_latency_ms']
      : variant === 'B'
        ? ['gate_latency_ms', 'coach_latency_ms', 'total_latency_ms']
        : ['gate_latency_ms', 'memory_latency_ms', 'era_latency_ms', 'resolve_latency_ms', 'coach_latency_ms', 'total_latency_ms'];
    return [variant, Object.fromEntries(latencyFields.map((field) => [field, latencyStats(variantSamples, field)]))];
  }));
  const timeouts = coachSamples.filter((sample) => (Array.isArray(sample.errors) ? sample.errors as Row[] : [])
    .some((error) => /TIMEOUT/u.test(String(error.code)))).length;
  const memorySuccesses = memoryRequests.filter((sample) => Number(sample.memory_evidence_count ?? 0) > 0).length;
  const eraSuccesses = eraRequests.filter((sample) => Number(sample.era_evidence_count ?? 0) > 0).length;
  return {
    gate: { B_intervention_rate: intervention('B'), C_intervention_rate: intervention('C') },
    memory: {
      C_request_rate: rate(memoryRequests.length, cSamples.length),
      C_retrieval_success_rate_among_requests: rate(memorySuccesses, memoryRequests.length),
      C_mean_evidence_count: mean(memoryEvidence),
      C_requested_samples: memoryRequests.length,
    },
    era: {
      C_request_rate: rate(eraRequests.length, cSamples.length),
      C_retrieval_success_rate_among_requests: rate(eraSuccesses, eraRequests.length),
      C_requested_samples: eraRequests.length,
    },
    coach: {
      success_rate: rate(coachSamples.filter((sample) => ['completed', 'no_op'].includes(String(sample.coach_status))).length, coachSamples.length),
      fail_open_rate: rate(failOpen, coachSamples.length),
      timeout_rate: rate(timeouts, coachSamples.length),
      gate_evaluation_count: gateEvaluated('B').length + gateEvaluated('C').length,
    },
    asr: {
      input_equivalence_pass_rate: rate(equivalencePassed, equivalenceTested.length),
      samples_excluded_for_mismatch: samples.filter((sample) => sample.input_equivalence === 'FAIL').length,
      samples_not_tested: samples.filter((sample) => sample.input_equivalence === 'NOT_TESTED').length,
    },
    latency_ms: byVariant,
    sample_attempts_total: samples.reduce((sum, sample) => sum + Number(sample.attempt_count ?? 1), 0),
  };
}

function verifyRuntimeParity(samples: Row[]): Row {
  const sharedFields = [
    'realtime_model', 'realtime_provider', 'commit_sha', 'previous_question', 'audio_sha256',
    'adapter_pcm_sha256', 'base_prompt_sha256', 'session_setup_sha256', 'case_input_sha256',
    'response_parameters_sha256',
  ];
  const profile: Record<string, { coach_enabled: boolean; memory_enabled: boolean; era_enabled: boolean }> = {
    A: { coach_enabled: false, memory_enabled: false, era_enabled: false },
    B: { coach_enabled: true, memory_enabled: false, era_enabled: false },
    C: { coach_enabled: true, memory_enabled: true, era_enabled: true },
  };
  const groups = new Map<string, Row[]>();
  for (const sample of samples) {
    const key = `${sample.case_id}:${sample.run}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  let completeGroups = 0;
  const failures: Row[] = [];
  for (const [key, group] of groups) {
    const variants = new Map(group.map((sample) => [String(sample.variant), sample]));
    if (!VARIANTS.every((variant) => variants.get(variant)?.status === 'completed')) continue;
    completeGroups += 1;
    const baseline = variants.get('A')!;
    const failedChecks: string[] = [];
    for (const variant of VARIANTS) {
      const sample = variants.get(variant)!;
      for (const field of sharedFields) {
        if (sample[field] !== baseline[field]) failedChecks.push(`${variant}.${field}`);
      }
      for (const [field, value] of Object.entries(profile[variant]!)) {
        if (sample[field] !== value) failedChecks.push(`${variant}.${field}`);
      }
    }
    if (failedChecks.length) {
      const [caseId, run] = key.split(':');
      failures.push({ case_id: caseId, run: Number(run), failed_checks: failedChecks });
    }
  }
  return { completed_case_run_groups: completeGroups, passed: completeGroups - failures.length, failed: failures.length, failures };
}

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function scoreTable(quality: Row): string {
  return ['| Variant | Valid N | Mean | Median | Std Dev |', '|---|---:|---:|---:|---:|',
    ...VARIANTS.map((variant) => {
      const value = quality[variant].total_score;
      return `| ${variant} | ${value.n} | ${round(value.mean) ?? 'n/a'} | ${round(value.median) ?? 'n/a'} | ${round(value.std_dev) ?? 'n/a'} |`;
    })].join('\n');
}

function dimensionTable(quality: Row): string {
  const names: Record<string, string> = {
    information_gain: 'Information Gain', context_use: 'Context Use / Non-Repetition',
    story_value: 'Story Value', depth: 'Depth', non_leading: 'Non-Leading',
  };
  return ['| Dimension | A | B | C |', '|---|---:|---:|---:|',
    ...DIMENSIONS.map((dimension) => `| ${names[dimension]} | ${round(quality.A.dimensions[dimension].mean) ?? 'n/a'} | ${round(quality.B.dimensions[dimension].mean) ?? 'n/a'} | ${round(quality.C.dimensions[dimension].mean) ?? 'n/a'} |`)].join('\n');
}

function deltaText(entry: Row | undefined): string {
  if (!entry || entry.paired_n === 0 || typeof entry.mean_delta !== 'number') return 'n/a (0 paired samples)';
  return `${entry.mean_delta > 0 ? '+' : ''}${entry.mean_delta} (n=${entry.paired_n})`;
}

async function main(): Promise<void> {
  const directory = path.resolve(arg('--result-dir'));
  const run = json(path.join(directory, 'run.json'));
  const manifest = json(path.join(directory, 'manifest.json'));
  const samples = jsonl(path.join(directory, 'technical.jsonl'));
  const judges = jsonl(path.join(directory, 'judge-results.jsonl'));
  const mapping = new Map<string, Row>((manifest.samples as Row[]).map((entry) => [entry.candidate_id, entry]));
  const technicalByIndex = new Map(samples.map((sample, index) => [index, sample]));
  const judgedById = new Map<string, Row>();
  for (const row of judges) judgedById.set(String(row.candidate_id), row);
  const latestJudges = [...judgedById.values()];
  const judgeFailures = latestJudges.filter((row) => row.status !== 'scored');
  const missingJudgeIds = [...mapping.keys()].filter((candidateId) => !judgedById.has(candidateId));
  const judgeFailureCount = judgeFailures.length + missingJudgeIds.length;
  const judgeFailureBreakdown: Row = {};
  for (const row of judgeFailures) {
    const label = row.http_status
      ? `${String(row.error_code ?? 'unknown')}_HTTP_${String(row.http_status)}`
      : String(row.error_code ?? 'unknown');
    judgeFailureBreakdown[label] = Number(judgeFailureBreakdown[label] ?? 0) + 1;
  }
  if (missingJudgeIds.length) judgeFailureBreakdown.MISSING_RESULT = missingJudgeIds.length;
  const explicitRetryRound = (reason: string) => {
    const attempts = judges.filter((row) => row.retry_reason === reason);
    return {
      attempted: attempts.length,
      scored: attempts.filter((row) => row.status === 'scored').length,
      failed: attempts.filter((row) => row.status !== 'scored').length,
    };
  };
  const explicitRetryRounds = {
    schema_invalid_round_1: explicitRetryRound('USER_REQUESTED_SCHEMA_RETRY'),
    remaining_failures_round_2: explicitRetryRound('USER_REQUESTED_FAILURE_RETRY_ROUND_2'),
    remaining_failures_round_3: explicitRetryRound('USER_REQUESTED_FAILURE_RETRY_ROUND_3'),
    output_length_rule_retry: explicitRetryRound('USER_REQUESTED_OUTPUT_LENGTH_CAP_RETRY'),
  };
  const records: Array<{ case_id: string; run: number; variant: string; candidate_id: string; score: Row }> = [];
  for (const [candidateId, map] of mapping) {
    const sample = technicalByIndex.get(Number(map.technical_record_index));
    const judge = judgedById.get(candidateId);
    const score = judge ? getScore(judge) : undefined;
    if (sample && score && sample.primary_score_eligible === true) {
      records.push({ case_id: String(sample.case_id), run: Number(sample.run), variant: String(map.variant), candidate_id: candidateId, score });
    }
  }
  const quality = Object.fromEntries(VARIANTS.map((variant) => [variant, statsForVariant(samples, records, variant)]));
  const paired = {
    A_vs_B: pairDeltas(records, 'A', 'B'),
    B_vs_C: pairDeltas(records, 'B', 'C'),
    A_vs_C: pairDeltas(records, 'A', 'C'),
  };
  const caseGroups = Object.fromEntries(Object.entries(CASE_GROUPS).map(([key, group]) => [key, {
    title: group.title,
    case_ids: group.caseIds,
    contrast: group.contrast,
    variants: Object.fromEntries(VARIANTS.map((variant) => [variant, statsForVariant(samples.filter((sample) => group.caseIds.includes(sample.case_id)), records.filter((record) => group.caseIds.includes(record.case_id)), variant)])),
    A_vs_B: pairDeltas(records, 'A', 'B', group.caseIds),
    B_vs_C: pairDeltas(records, 'B', 'C', group.caseIds),
    A_vs_C: pairDeltas(records, 'A', 'C', group.caseIds),
  }]));
  const mainCapability: Record<string, string> = Object.fromEntries([
    ...CASE_GROUPS.coach.caseIds.map((id) => [id, 'Coach']),
    ...CASE_GROUPS.retrieval.caseIds.map((id) => [id, 'Memory Retrieval']),
    ...CASE_GROUPS.era.caseIds.map((id) => [id, 'Era']),
  ]);
  const caseByCase = NEXT_CASE_IDS(samples).map((caseId) => {
    const variants = Object.fromEntries(VARIANTS.map((variant) => {
      const scores = records.filter((record) => record.case_id === caseId && record.variant === variant).map((record) => Number(record.score.total_score));
      return [variant, { valid_n: scores.length, mean: round(mean(scores)) }];
    }));
    return { case_id: caseId, main_capability: mainCapability[caseId] ?? 'Unknown', variants,
      A_vs_B_delta: round(mean(records.filter((record) => record.case_id === caseId && record.variant === 'B').map((b) => {
        const a = records.find((candidate) => candidate.case_id === caseId && candidate.run === b.run && candidate.variant === 'A');
        return a ? Number(b.score.total_score) - Number(a.score.total_score) : NaN;
      }).filter(Number.isFinite))),
      B_vs_C_delta: round(mean(records.filter((record) => record.case_id === caseId && record.variant === 'C').map((c) => {
        const b = records.find((candidate) => candidate.case_id === caseId && candidate.run === c.run && candidate.variant === 'B');
        return b ? Number(c.score.total_score) - Number(b.score.total_score) : NaN;
      }).filter(Number.isFinite))),
    };
  });
  const technical = technicalSummary(samples);
  const runtimeParity = verifyRuntimeParity(samples);
  const completionBlockers = [
    ...(samples.filter((sample) => sample.status === 'completed').length !== Number(run.samples_planned) ? ['SAMPLES_INCOMPLETE'] : []),
    ...(judgeFailureCount > 0 ? ['JUDGE_COVERAGE_INCOMPLETE'] : []),
    ...(Number(technical.memory.C_mean_evidence_count) > 0 ? [] : ['C_MEMORY_EVIDENCE_MISSING']),
    ...(runtimeParity.failed > 0 ? ['RUNTIME_PARITY_FAILED'] : []),
  ];
  const asrMismatch = samples.filter((sample) => sample.input_equivalence === 'FAIL').map((sample) => `${sample.case_id}-${sample.variant}-run${sample.run}`);
  const summary = {
    benchmark: 'controlled-next-question',
    run_id: run.run_id,
    commit_sha: run.commit_sha,
    generated_at: new Date().toISOString(),
    judge_model: 'step-5-preview',
    judge_endpoint: run.judge_endpoint ?? null,
    judge_commit_sha: run.judge_commit_sha ?? null,
    judge_concurrency: Number(run.judge_concurrency ?? 1),
    samples_planned: Number(run.samples_planned),
    samples_attempted: samples.length,
    provider_attempts_total: technical.sample_attempts_total,
    samples_completed: samples.filter((sample) => sample.status === 'completed').length,
    samples_scored: latestJudges.filter((row) => row.status === 'scored').length,
    judge_attempts_total: judges.length,
    judge_candidates_retried: new Set(judges.filter((row) => Number(row.judge_attempt ?? 1) > 1).map((row) => row.candidate_id)).size,
    judge_explicit_retry_rounds: explicitRetryRounds,
    judge_failures: judgeFailureCount,
    judge_failure_breakdown: judgeFailureBreakdown,
    judge_missing_candidates: missingJudgeIds,
    valid_primary_scores: records.length,
    completion_status: completionBlockers.length ? 'INCOMPLETE' : 'COMPLETE',
    ready_for_competition_report: completionBlockers.length === 0,
    completion_blockers: completionBlockers,
    samples_excluded_for_asr_mismatch: asrMismatch.length,
    asr_mismatch_samples: asrMismatch,
    quality,
    paired_deltas: paired,
    case_groups: caseGroups,
    case_by_case: caseByCase,
    technical,
    runtime_parity: runtimeParity,
    unexpected_regressions: caseByCase.filter((row) => Number(row.A_vs_B_delta) < 0 || Number(row.B_vs_C_delta) < 0),
  };
  writeFileSync(path.join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });

  const coachGroup = caseGroups.coach as Row;
  const retrievalGroup = caseGroups.retrieval as Row;
  const eraGroup = caseGroups.era as Row;
  const retryRoundText = Object.entries(explicitRetryRounds).map(([name, result]) => `${name}: ${result.attempted} attempted, ${result.scored} scored, ${result.failed} failed`);
  const q2ExecutionNote = technical.memory.C_requested_samples === 0 && technical.era.C_requested_samples === 0
    ? ' C made no Memory or Era requests, so this contrast does not measure either capability.'
    : '';
  const lineForPair = (label: string, values: Row) => `| ${label} | ${deltaText(values.total_score)} | ${DIMENSIONS.map((dimension) => deltaText(values[dimension])).join(' | ')} |`;
  const caseRows = caseByCase.map((row) => `| ${row.case_id} | ${row.variants.A.mean ?? 'n/a'} | ${row.variants.B.mean ?? 'n/a'} | ${row.variants.C.mean ?? 'n/a'} | ${row.main_capability} |`);
  const latencyRows: string[] = [];
  for (const variant of VARIANTS) {
    for (const [field, value] of Object.entries(technical.latency_ms[variant] as Row)) {
      const stat = value as Row;
      latencyRows.push(`| ${variant} | ${field} | ${stat.p50 ?? 'n/a'} | ${stat.p95 ?? 'n/a'} | ${stat.n} |`);
    }
  }
  const markdown = [
    '# Controlled Next-Question Benchmark Results',
    '',
    `- Run ID: \`${run.run_id}\``,
    `- Commit: \`${run.commit_sha}\``,
    `- Benchmark status: **${completionBlockers.length ? 'INCOMPLETE' : 'COMPLETE'}**; READY_FOR_COMPETITION_REPORT = ${completionBlockers.length ? 'NO' : 'YES'}`,
    `- Judge: \`${summary.judge_model}\`, temperature 0, one independent absolute score per candidate`,
    `- Judge endpoint: \`${summary.judge_endpoint ?? 'not recorded'}\`; concurrency: ${summary.judge_concurrency}`,
    `- Judge code commit: \`${summary.judge_commit_sha ?? 'not recorded'}\``,
    `- Explicit Judge retry rounds: ${retryRoundText.join('; ')}`,
    `- Audio: 10 frozen canonical WAV files; see [audio manifest](../../audio/manifest.json)`,
    `- Samples: ${summary.samples_completed}/${summary.samples_planned} completed; ${summary.provider_attempts_total} provider attempts; ${summary.samples_scored} judged; ${summary.valid_primary_scores} primary-score eligible`,
    `- ASR excluded: ${asrMismatch.length}; Judge failures or missing results: ${judgeFailureCount} (${Object.entries(judgeFailureBreakdown).map(([code, count]) => `${code}=${count}`).join(', ') || 'none'})`,
    `- Runtime parity: ${runtimeParity.passed}/${runtimeParity.completed_case_run_groups} complete Case × run groups passed shared-input and profile checks; failures: ${runtimeParity.failed}`,
    '- Standard deviation uses sample standard deviation (n−1). Score and latency are reported separately.',
    '- The scores below are a partial, non-representative subset because some Judge outputs failed; do not treat these contrasts as a completed benchmark result.',
    '',
    '## Overall scores',
    '',
    scoreTable(quality),
    '',
    '## Score dimensions',
    '',
    dimensionTable(quality),
    '',
    '## Controlled contrasts',
    '',
    '| Contrast | Total score delta | Information Gain | Context Use | Story Value | Depth | Non-Leading |',
    '|---|---:|---:|---:|---:|---:|---:|',
    lineForPair('A → B (Coach)', paired.A_vs_B),
    lineForPair('B → C (Memory + Era)', paired.B_vs_C),
    lineForPair('A → C', paired.A_vs_C),
    '',
    `**Q1 — Coach (partial only):** C01–C04 A→B paired mean total-score delta ${deltaText(coachGroup.A_vs_B.total_score)}; the available subset is too small for a benchmark conclusion.`,
    `**Q2 — Memory Retrieval + Era:** B→C overall paired mean total-score delta ${deltaText(paired.B_vs_C.total_score)}; Retrieval C05–C08 ${deltaText(retrievalGroup.B_vs_C.total_score)}, Era C09–C10 ${deltaText(eraGroup.B_vs_C.total_score)}. These sparse pairs are non-representative and do not support a completed conclusion.${q2ExecutionNote}`,
    '**Q3 — Source of change:** no complete conclusion is available; dimension contrasts below are from the partial judged subset only.',
    '',
    '## Case groups',
    '',
    '| Group | Variant | Valid N | Mean | Median | Std Dev |',
    '|---|---|---:|---:|---:|---:|',
    ...Object.entries(caseGroups).flatMap(([key, group]) => VARIANTS.map((variant) => {
      const value = (group as Row).variants[variant].total_score;
      return `| ${(group as Row).title} | ${variant} | ${value.n} | ${round(value.mean) ?? 'n/a'} | ${round(value.median) ?? 'n/a'} | ${round(value.std_dev) ?? 'n/a'} |`;
    })),
    '',
    '## Case-by-case',
    '',
    '| Case | A mean | B mean | C mean | Main capability |',
    '|---|---:|---:|---:|---|',
    ...caseRows,
    '',
    '## Technical behavior',
    '',
    `- B Gate intervention rate: ${pct(technical.gate.B_intervention_rate.rate)} (${technical.gate.B_intervention_rate.numerator}/${technical.gate.B_intervention_rate.denominator})`,
    `- C Gate intervention rate: ${pct(technical.gate.C_intervention_rate.rate)} (${technical.gate.C_intervention_rate.numerator}/${technical.gate.C_intervention_rate.denominator})`,
    `- C Memory request rate: ${pct(technical.memory.C_request_rate.rate)}; retrieval success among requests: ${pct(technical.memory.C_retrieval_success_rate_among_requests.rate)}; mean evidence/sample: ${round(technical.memory.C_mean_evidence_count) ?? 'n/a'}`,
    `- C Era request rate: ${pct(technical.era.C_request_rate.rate)}; retrieval success among requests: ${pct(technical.era.C_retrieval_success_rate_among_requests.rate)}`,
    `- Coach success: ${pct(technical.coach.success_rate.rate)}; fail-open: ${pct(technical.coach.fail_open_rate.rate)}; timeout: ${pct(technical.coach.timeout_rate.rate)}`,
    `- ASR equivalence: ${pct(technical.asr.input_equivalence_pass_rate.rate)}; excluded core-content mismatches: ${technical.asr.samples_excluded_for_mismatch}`,
    '- Gate intervention rate denominator: successfully evaluated Coach gates; Retrieval/Era success denominator: Gate-requested retrievals; Coach rates denominator: completed B+C samples; ASR denominator: completed samples.',
    '',
    '## Latency (milliseconds; not part of quality score)',
    '',
    '| Variant | Stage | P50 | P95 | N |',
    '|---|---|---:|---:|---:|',
    ...latencyRows,
    '',
    '## Exclusions and regressions',
    '',
    `- ASR mismatch sample IDs: ${asrMismatch.length ? asrMismatch.join(', ') : 'none'}`,
    `- Judge errors or missing results: ${judgeFailureCount ? Object.entries(judgeFailureBreakdown).map(([code, count]) => `${code}=${count}`).join(', ') : 'none'}`,
    `- Negative case-level paired deltas: ${summary.unexpected_regressions.length ? (summary.unexpected_regressions as Row[]).map((row) => `${row.case_id} (A→B ${row.A_vs_B_delta ?? 'n/a'}, B→C ${row.B_vs_C_delta ?? 'n/a'})`).join('; ') : 'none'}`,
    '- All completed candidates and technical traces remain in the result directory; the primary score excludes only ASR-mismatch samples and failed Judge records.',
    `- Completion blockers: ${completionBlockers.join(', ') || 'none'}`,
    '',
  ].join('\n');
  writeFileSync(path.join(directory, 'summary.md'), markdown, { mode: 0o600 });
  process.stdout.write(`Summary written: ${path.join(directory, 'summary.md')}\n`);
}

function NEXT_CASE_IDS(samples: Row[]): string[] {
  return [...new Set(samples.map((sample) => String(sample.case_id)))].sort();
}

void main().catch((error: unknown) => {
  process.stderr.write(`Summary stopped: ${error instanceof Error ? error.message : 'UNKNOWN_ERROR'}\n`);
  process.exitCode = 1;
});
