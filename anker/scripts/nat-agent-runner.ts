import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createAgentTaskPort,
  type AgentTaskResultUnion,
} from '../src/agent-tasks/index.js';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { nowUtcIso } from '../src/db/time.js';
import { accounts, agentRuns, users } from '../src/db/schema.js';
import {
  createSyntheticRegressionRegistry,
  type SyntheticAgentFixture,
  type SyntheticRegressionCaseId,
} from './agent-eval/fixture-registry.js';
import {
  errorContract,
  errorWithCode,
  parseCaseId,
} from './agent-eval/nat-runner-contract.js';
import { createSyntheticBackendValidator } from './agent-eval/backend-validator.js';
import { evaluateSyntheticSemantics } from './agent-eval/semantic-evaluators.js';
import { adaptNatEvaluationSafely } from '../src/observability/adapters/nat-adapter.js';

const RESULT_PREFIX = 'LIFE_INTERVIEW_NAT_RESULT ';
const DEFAULT_OWNER_ID = 'nat-agent-eval-owner';

interface AgentTrace {
  runId: string;
  agentType: string;
  taskType: string;
  mode: string | null;
  runtime: string;
  provider: string | null;
  model: string | null;
  resourceType: string;
  resourceId: string;
  skill: string | null;
  resourceVersion: string | null;
  contextVersion: string | null;
  schemaVersion: string | null;
  attemptCount: number;
  repairCount: number;
  toolCallCount: number;
  scriptCallCount: number;
  formatRepairUsed: boolean;
  latencyMs: number | null;
  errorCode: string | null;
  inputHash: string | null;
  outputHash: string | null;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { input += chunk; });
    process.stdin.once('end', () => resolve(input));
    process.stdin.once('error', reject);
  });
}

function readTracing(databasePath: string): AgentTrace[] {
  const database = createDatabase(databasePath);
  try {
    return database.db.select().from(agentRuns).all().map((run) => ({
      runId: run.runId,
      agentType: run.agentType,
      taskType: run.taskType,
      mode: run.mode,
      runtime: run.runtime,
      provider: run.provider,
      model: run.model,
      resourceType: run.resourceType,
      resourceId: run.resourceId,
      skill: run.skill,
      resourceVersion: run.resourceVersion,
      contextVersion: run.contextVersion,
      schemaVersion: run.schemaVersion,
      attemptCount: run.attemptCount,
      repairCount: run.repairCount,
      toolCallCount: run.toolCallCount,
      scriptCallCount: run.scriptCallCount,
      formatRepairUsed: run.formatRepairUsed,
      latencyMs: run.latencyMs,
      errorCode: run.errorCode,
      inputHash: run.inputHash,
      outputHash: run.outputHash,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    }));
  } finally {
    database.close();
  }
}

function tryReadTracing(databasePath: string | undefined): AgentTrace[] {
  if (!databasePath) return [];
  try {
    return readTracing(databasePath);
  } catch {
    return [];
  }
}

function readRuntimeTimings(runtimeTimingPath: string): unknown[] {
  try {
    const content = readFileSync(runtimeTimingPath, 'utf8').trim();
    return content ? content.split('\n').map((line) => JSON.parse(line)) : [];
  } catch {
    return [];
  }
}

function traceFor(tracing: AgentTrace[], runId: string | undefined): AgentTrace | undefined {
  return runId ? tracing.find((trace) => trace.runId === runId) : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function metricsFor(
  runtime: AgentTaskResultUnion['runtime'] | undefined,
  trace: AgentTrace | undefined,
  latencyMs: number,
): Record<string, number | boolean> {
  return {
    latency_ms: numberOr(trace?.latencyMs ?? runtime?.latencyMs, latencyMs),
    attempt_count: trace?.attemptCount ?? runtime?.attemptCount ?? 0,
    repair_count: trace?.repairCount ?? runtime?.repairCount ?? 0,
    format_repair_used: trace?.formatRepairUsed ?? runtime?.formatRepairUsed ?? false,
    tool_call_count: trace?.toolCallCount ?? runtime?.execCallCount ?? 0,
    script_call_count: trace?.scriptCallCount ?? runtime?.scriptCallCount ?? 0,
  };
}

function fixtureDetails(fixture: SyntheticAgentFixture | undefined): Record<string, unknown> {
  if (!fixture) return {};
  return {
    run_id: fixture.request.runId,
    task_type: fixture.request.taskType,
    mode: fixture.request.mode ?? null,
  };
}

function writeResult(value: Record<string, unknown>): void {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  let caseId: string | null = null;
  let fixture: SyntheticAgentFixture | undefined;
  let backendValidation: 'not_applicable' | 'not_run' | 'passed' | 'failed' = 'not_applicable';
  let directory: string | undefined;
  let databasePath: string | undefined;
  let runtimeTimingPath: string | undefined;
  const started = Date.now();

  try {
    caseId = parseCaseId(await readStdin());
    const ownerId = process.env.NAT_AGENT_OWNER_ID?.trim() || DEFAULT_OWNER_ID;
    const registry = createSyntheticRegressionRegistry(ownerId);
    fixture = registry.get(caseId as SyntheticRegressionCaseId);
    if (!fixture) throw errorWithCode('NAT_CASE_NOT_FOUND', `Unknown synthetic Agent case: ${caseId}`);

    directory = mkdtempSync(path.join(tmpdir(), 'life-interview-nat-agent-'));
    databasePath = path.join(directory, 'memoir.db');
    runtimeTimingPath = path.join(directory, 'agent-runtime-timing.jsonl');

    const database = createDatabase(databasePath);
    try {
      runMigrations(database);
      const now = nowUtcIso();
      database.db.insert(accounts).values({
        accountId: 'nat-agent-eval-account',
        status: 'legacy',
        createdAt: now,
        updatedAt: now,
      }).run();
      database.db.insert(users).values({
        userId: ownerId,
        accountId: 'nat-agent-eval-account',
        createdAt: now,
        updatedAt: now,
      }).run();
    } finally {
      database.close();
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // NAT-1 must exercise the production Agent runtime. NAT_AGENT_RUNTIME is
      // an explicit local hook for deterministic contract checks with `stub`.
      AI_TASK_RUNTIME: process.env.NAT_AGENT_RUNTIME?.trim() || 'agent',
      DATABASE_PATH: databasePath,
      AGENT_RUNTIME_DIAGNOSTICS_PATH: runtimeTimingPath,
    };
    const tasks = createAgentTaskPort(env, { databasePath });
    if (!tasks) throw errorWithCode('NAT_AGENT_PORT_UNAVAILABLE', 'AgentTaskPort did not resolve.');

    const backendValidator = createSyntheticBackendValidator(fixture.request);
    if (backendValidator) backendValidation = 'not_run';
    const runtimeMode = process.env.NAT_AGENT_RUNTIME?.trim() || 'agent';
    const result = await tasks.run(
      fixture.request,
      backendValidator && runtimeMode !== 'stub'
        ? {
            validateProposal(output) {
              try {
                backendValidator(output);
                backendValidation = 'passed';
              } catch (error) {
                backendValidation = 'failed';
                throw error;
              }
            },
          }
        : undefined,
    );
    if (backendValidator && runtimeMode === 'stub') {
      try {
        backendValidator(result.output);
        backendValidation = 'passed';
      } catch {
        backendValidation = 'failed';
        throw errorWithCode('NAT_BACKEND_VALIDATION_FAILED', 'Synthetic Backend Validator rejected the stub result.');
      }
    }
    const tracing = readTracing(databasePath);
    const trace = traceFor(tracing, result.runId);
    const semanticChecks = process.env.NAT_AGENT_RUNTIME?.trim() === 'stub'
      ? []
      : evaluateSyntheticSemantics(fixture.request, result.output, caseId);
    const validation = {
      contract_valid: true,
      backend_validation: backendValidation,
      semantic_valid: semanticChecks.every((item) => item.passed),
      semantic_checks: semanticChecks,
    };
    writeResult({
      case_id: caseId,
      ...fixtureDetails(fixture),
      status: 'succeeded',
      runtime: result.runtime,
      metrics: metricsFor(result.runtime, trace, Date.now() - started),
      validation,
      observation_events: adaptNatEvaluationSafely({
        trace,
        caseId,
        status: 'succeeded',
        validation,
        latencyMs: numberOr(trace?.latencyMs ?? result.runtime.latencyMs, Date.now() - started),
      }),
      output: result.output,
      tracing,
      runtime_timings: readRuntimeTimings(runtimeTimingPath),
    });
  } catch (error) {
    const tracing = tryReadTracing(databasePath);
    const trace = traceFor(tracing, fixture?.request.runId);
    const contract = errorContract(error);
    const validation = {
      contract_valid: false,
      backend_validation: backendValidation,
      semantic_valid: false,
      semantic_checks: [],
    };
    writeResult({
      case_id: caseId,
      ...fixtureDetails(fixture),
      status: 'failed',
      ...(trace ? {
        runtime: {
          runtime: trace.runtime,
          ...(trace.provider ? { provider: trace.provider } : {}),
          ...(trace.model ? { model: trace.model } : {}),
        },
      } : {}),
      metrics: metricsFor(undefined, trace, Date.now() - started),
      validation,
      observation_events: adaptNatEvaluationSafely({
        trace,
        caseId,
        status: 'failed',
        validation,
        latencyMs: numberOr(trace?.latencyMs, Date.now() - started),
      }),
      error: contract,
      ...(tracing.length ? { tracing } : {}),
      ...(runtimeTimingPath ? { runtime_timings: readRuntimeTimings(runtimeTimingPath) } : {}),
    });
    process.exitCode = 1;
  } finally {
    if (directory) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Temporary evaluation state is best-effort cleanup.
      }
    }
  }
}

void main().catch((error) => {
  writeResult({
    case_id: null,
    status: 'failed',
    validation: {
      contract_valid: false,
      backend_validation: 'not_applicable',
      semantic_valid: false,
      semantic_checks: [],
    },
    error: errorContract(error),
  });
  process.exitCode = 1;
});
