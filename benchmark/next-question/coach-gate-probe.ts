import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { NEXT_QUESTION_CASES } from './cases.js';
import {
  buildCaseGateInput,
  coachErrorDetails,
  createRealtimeCoach,
  loadNextQuestionFixture,
  makeNextQuestionContext,
  realtimeCoachDiagnostics,
} from './harness.js';

const DEFAULT_GATE_MS = 2_000;
const MAX_GATE_MS = 2_000;
const DEFAULT_TOTAL_MS = 6_000;
const MAX_TOTAL_MS = 6_000;

function timeout(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0 || value > max) throw new Error(`${name}_INVALID`);
  return value;
}

function writePrivate(file: string, content: string): void {
  writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
}

async function main(): Promise<void> {
  const gateTimeoutMs = timeout('REALTIME_COACH_GATE_TIMEOUT_MS', DEFAULT_GATE_MS, MAX_GATE_MS);
  const totalTimeoutMs = timeout('REALTIME_COACH_TOTAL_TIMEOUT_MS', DEFAULT_TOTAL_MS, MAX_TOTAL_MS);
  const diagnostics = realtimeCoachDiagnostics(process.env, gateTimeoutMs, totalTimeoutMs);
  const coach = createRealtimeCoach(process.env);
  const fixture = loadNextQuestionFixture();
  const context = makeNextQuestionContext(fixture.owner_id, fixture.story_id, fixture.database_path);
  const selected = ['C06', 'C07'].map((id) => NEXT_QUESTION_CASES.find((item) => item.id === id)!);
  const runId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`;
  const outputDir = path.resolve('benchmark/next-question/results', `gate-probe-${runId}`);
  mkdirSync(outputDir, { recursive: false, mode: 0o700 });
  const resultsPath = path.join(outputDir, 'gate-results.jsonl');
  writePrivate(path.join(outputDir, 'run.json'), JSON.stringify({
    benchmark: 'controlled-next-question-gate-probe',
    run_id: runId,
    generated_at: new Date().toISOString(),
    repetitions_per_case: 3,
    cases: selected.map((item) => item.id),
    coach: diagnostics,
    temperature: 0,
  }, null, 2));
  writePrivate(resultsPath, '');
  process.stdout.write(`COACH_CONFIG ${JSON.stringify(diagnostics)}\n`);

  let passed = 0;
  let total = 0;
  for (const item of selected) {
    const input = buildCaseGateInput(context, item);
    for (let run = 1; run <= 3; run += 1) {
      total += 1;
      const startedAt = performance.now();
      let row: Record<string, unknown>;
      try {
        const gate = await coach.evaluate(input, { signal: AbortSignal.timeout(gateTimeoutMs) });
        const latencyMs = Number((performance.now() - startedAt).toFixed(2));
        if (latencyMs >= gateTimeoutMs) throw Object.assign(new Error('Coach Gate exceeded its production deadline.'), { code: 'COACH_GATE_TIMEOUT' });
        row = {
          case_id: item.id,
          run,
          status: 'PASS',
          error: null,
          latency_ms: latencyMs,
          parsed_gate_result: gate,
        };
        passed += 1;
      } catch (error) {
        row = {
          case_id: item.id,
          run,
          status: 'FAIL',
          ...coachErrorDetails(error, process.env),
          latency_ms: Number((performance.now() - startedAt).toFixed(2)),
          parsed_gate_result: null,
        };
      }
      writeFileSync(resultsPath, `${JSON.stringify(row)}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 });
      process.stdout.write(`${JSON.stringify(row)}\n`);
    }
  }
  process.stdout.write(`GATE_PROBE ${passed}/${total} PASS; ${outputDir}\n`);
  if (passed !== total) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z0-9_]{1,96}$/u.test(error.message) ? error.message : 'GATE_PROBE_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
