import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRetrieverClientFromEnv } from '../src/retriever/client.js';

type GateStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';

interface GateResult {
  id: string;
  name: string;
  status: GateStatus;
  durationMs: number;
  summary: string;
  evidence?: Record<string, unknown>;
  command?: string;
}

interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  output: string;
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = process.env.PHASE3_REPORT_PATH?.trim()
  || path.join(projectRoot, 'docs/07-reports/testing/PHASE3_AB_INTEGRATION_REAL_E2E_REPORT_v1.0.md');
const diagnosticsDirectory = path.join(projectRoot, 'runtime/diagnostics');
const logPath = path.join(diagnosticsDirectory, 'phase3-ab-integration.log');
const retrieverWaitMs = integerEnv('PHASE3_RETRIEVER_WAIT_MS', 30_000);
const commandOutputLimit = 120_000;

function integerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function redact(value: string): string {
  return value
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer <redacted>')
    .replace(/(API_KEY|TOKEN|PASSWORD|SECRET)=([^\s&]+)/gi, '$1=<redacted>');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retrieverUnavailable(error: unknown): boolean {
  return /\b503\b|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|before receiving a response|did not complete within|timed out/i.test(errorMessage(error));
}

function commandLine(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: Buffer): void => {
      if (output.length < commandOutputLimit) output += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => {
      output += `\n${errorMessage(error)}\n`;
      resolve({ exitCode: null, signal: null, output });
    });
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal, output }));
  });
}

function tail(value: string, limit = 1_500): string {
  const safe = redact(value).trim();
  return safe.length <= limit ? safe : `…${safe.slice(-limit)}`;
}

function addGate(gates: GateResult[], result: GateResult): void {
  gates.push(result);
  process.stdout.write(`[${result.status}] ${result.id} ${result.summary}\n`);
}

async function commandGate(
  gates: GateResult[],
  id: string,
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
  const started = Date.now();
  const result = await runCommand(command, args, env);
  const output = redact(result.output);
  const status: GateStatus = result.exitCode === 0 ? 'PASS' : 'FAIL';
  addGate(gates, {
    id,
    name,
    status,
    durationMs: Date.now() - started,
    summary: status === 'PASS' ? '命令通过。' : `命令失败（exit=${result.exitCode ?? 'spawn-error'}）。`,
    command: commandLine(command, args),
    evidence: {
      exitCode: result.exitCode,
      signal: result.signal,
      outputTail: tail(output),
    },
  });
  return result;
}

async function runRetrieverSmoke(): Promise<{ status: GateStatus; summary: string; evidence: Record<string, unknown> }> {
  const ownerId = `phase3-gate-owner-${randomUUID()}`;
  const storyId = `phase3-gate-story-${randomUUID()}`;
  const sessionId = `phase3-gate-session-${randomUUID()}`;
  const messageId = `phase3-gate-message-${randomUUID()}`;
  const marker = `phase3-retriever-marker-${randomUUID()}`;
  const client = createRetrieverClientFromEnv(process.env);
  let reference: { jobId?: string; documentId?: string } | undefined;
  let cleanup = 'not-needed';

  try {
    const health = await client.health({ timeoutMs: 5_000 });
    const indexed = await client.indexSessionTranscript({
      userId: ownerId,
      sessionId,
      storyId,
      stageId: 'phase3-gate-stage',
      sessionType: 'story',
      sourceType: 'subject',
      endedAt: new Date().toISOString(),
      contentHash: randomUUID(),
      transcriptText: [
        `message_id: ${messageId}`,
        `phase3 integration smoke marker: ${marker}`,
        '这是用于验证 ingest、状态查询、scoped query 和消息追溯的临时事实。',
      ].join('\n'),
    });
    reference = { jobId: indexed.jobId, documentId: indexed.documentId };

    const deadline = Date.now() + retrieverWaitMs;
    let indexStatus = indexed.status;
    while (Date.now() < deadline) {
      const status = await client.getIndexStatus(sessionId);
      indexStatus = status.status;
      if (/^(indexed|completed|complete|ready|succeeded|success)$/i.test(indexStatus)) break;
      if (/^(failed|error|cancelled|canceled)$/i.test(indexStatus)) {
        throw new Error(`Retriever indexing failed with status ${indexStatus}.`);
      }
      await sleep(500);
    }
    if (!/^(indexed|completed|complete|ready|succeeded|success)$/i.test(indexStatus)) {
      throw new Error(`Retriever indexing did not complete within ${retrieverWaitMs}ms (status=${indexStatus}).`);
    }

    const evidence = await client.searchTranscript({
      ownerId,
      storyId,
      sourceType: 'subject',
      query: marker,
      topK: 5,
    });
    const matched = evidence.some((item) => item.ownerId === ownerId
      && item.storyId === storyId
      && item.sourceType === 'subject'
      && item.sessionId === sessionId
      && item.messageIds.includes(messageId)
      && item.text.includes(marker));

    return {
      status: matched ? 'PASS' : 'FAIL',
      summary: matched ? '真实 health、ingest、状态查询和 scoped query 通过。' : '查询返回结果，但未能完成 owner/story/session/message 追溯校验。',
      evidence: {
        health,
        jobId: indexed.jobId ?? null,
        documentId: indexed.documentId ?? null,
        indexStatus,
        evidenceCount: evidence.length,
        matched,
        evidencePreview: evidence.map((item) => ({
          ownerId: item.ownerId,
          storyId: item.storyId,
          sourceType: item.sourceType,
          sessionId: item.sessionId,
          messageIds: item.messageIds,
          segmentIds: item.segmentIds,
          textPreview: item.text.slice(0, 300),
        })),
        ownerId,
        storyId,
        sessionId,
        messageId,
      },
    };
  } catch (error) {
    return {
      status: retrieverUnavailable(error) ? 'BLOCKED' : 'FAIL',
      summary: retrieverUnavailable(error)
        ? `真实 Retriever 服务当前不可用：${errorMessage(error)}`
        : `真实 Retriever smoke 失败：${errorMessage(error)}`,
      evidence: {
        ownerId,
        storyId,
        sessionId,
        messageId,
        error: errorMessage(error),
      },
    };
  } finally {
    if (reference?.documentId) {
      try {
        await client.deleteSessionTranscript(sessionId, { reference });
        cleanup = 'deleted';
      } catch (error) {
        cleanup = `warning: ${errorMessage(error)}`;
      }
    }
    if (cleanup !== 'not-needed') process.stdout.write(`[INFO] Retriever smoke cleanup: ${cleanup}\n`);
  }
}

function markdownValue(value: unknown): string {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function reportMarkdown(gates: GateResult[], generatedAt: string): string {
  const overall: GateStatus = gates.some((gate) => gate.status === 'FAIL')
    ? 'FAIL'
    : gates.some((gate) => gate.status === 'BLOCKED' || gate.status === 'NOT_RUN')
      ? 'BLOCKED'
      : 'PASS';
  const lines = [
    '# Phase 3 A+B Integration Gate Report',
    '',
    `- Generated at: ${generatedAt}`,
    `- Overall status: **${overall}**`,
    '- Scope: Phase 3A Retriever boundary, Phase 3B realtime Tool/HOLD/Resume boundary, Agent runtime safety, and live-provider preflight.',
    '- Credential values and bearer tokens are omitted from this report.',
    '',
    '## Gate results',
    '',
    '| Gate | Name | Status | Duration | Summary |',
    '|---|---|---|---:|---|',
    ...gates.map((gate) => `| ${gate.id} | ${gate.name} | **${gate.status}** | ${gate.durationMs} ms | ${markdownValue(gate.summary)} |`),
    '',
    '## Evidence',
    '',
    ...gates.map((gate) => {
      const evidence = gate.evidence
        ? ` ${JSON.stringify(gate.evidence).replaceAll('`', '\\`')}`
        : '';
      const command = gate.command ? ` Command: \`${gate.command}\`.` : '';
      return `- **${gate.id}**: ${gate.summary}${command}${evidence}`;
    }),
    '',
    '## Interpretation',
    '',
    '- `PASS` means the named automated check completed and its assertions passed.',
    '- `BLOCKED` means an external dependency or missing live acceptance path prevented a valid conclusion.',
    '- The real Retriever smoke must be rerun after the current HTTP 503 is fixed; a local wiring test does not replace it.',
    '- Real human voice experience acceptance remains a manual final step after all automated gates pass.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  mkdirSync(diagnosticsDirectory, { recursive: true });
  const gates: GateResult[] = [];
  const startedAt = new Date().toISOString();
  const logHeader = `\n=== Phase 3 A+B Gate ${startedAt} ===\n`;
  appendFileSync(logPath, logHeader, { mode: 0o600 });

  const preflight = await commandGate(
    gates,
    'G0',
    'AI environment preflight',
    'bash',
    ['scripts/check-ai-env.sh'],
  );
  if (preflight.exitCode !== 0) {
    const current = gates.at(-1);
    if (current && /Retriever.*503|VectorDB.*503/i.test(current.evidence?.outputTail as string || '')) {
      current.status = 'BLOCKED';
      current.summary = 'NeMo Retriever/VectorDB 当前返回 HTTP 503，等待外部修复。';
    }
  }

  const deterministic = await commandGate(
    gates,
    'G1',
    'Deterministic local regression',
    'bash',
    ['scripts/codex-verify.sh'],
  );
  if (deterministic.output) appendFileSync(logPath, redact(deterministic.output), { mode: 0o600 });

  const retrieverStarted = Date.now();
  const retriever = await runRetrieverSmoke();
  addGate(gates, {
    id: 'G2',
    name: 'Real NeMo Retriever ingest/query smoke',
    status: retriever.status,
    durationMs: Date.now() - retrieverStarted,
    summary: retriever.summary,
    evidence: retriever.evidence,
    command: 'RetrieverClient: GET /v1/health; POST /v1/ingest/job; POST /v1/ingest/job/{id}/document; GET status; POST /v1/query',
  });

  if (process.env.PHASE3_SKIP_AGENT_REAL === 'true') {
    addGate(gates, {
      id: 'G3',
      name: 'Real Agent runtime acceptance',
      status: 'NOT_RUN',
      durationMs: 0,
      summary: 'PHASE3_SKIP_AGENT_REAL=true，未执行真实 Agent。',
    });
  } else if (!process.env.NEMOCLAW_SANDBOX?.trim()) {
    addGate(gates, {
      id: 'G3',
      name: 'Real Agent runtime acceptance',
      status: 'NOT_RUN',
      durationMs: 0,
      summary: 'NEMOCLAW_SANDBOX 未配置，未执行真实 Agent。',
    });
  } else {
    const agent = await commandGate(
      gates,
      'G3',
      'Real Agent runtime acceptance',
      'bash',
      ['scripts/codex-node.sh', 'npm', 'run', 'test:agent:real'],
    );
    if (agent.output) appendFileSync(logPath, redact(agent.output), { mode: 0o600 });
  }

  if (process.env.PHASE3_SKIP_LIVE === 'true') {
    addGate(gates, {
      id: 'G4',
      name: 'Real Step-Audio Tool/HOLD smoke',
      status: 'NOT_RUN',
      durationMs: 0,
      summary: 'PHASE3_SKIP_LIVE=true，未执行真实 Step-Audio。',
    });
  } else if (!process.env.STEPFUN_API_KEY?.trim()) {
    addGate(gates, {
      id: 'G4',
      name: 'Real Step-Audio Tool/HOLD smoke',
      status: 'NOT_RUN',
      durationMs: 0,
      summary: 'STEPFUN_API_KEY 未配置，未执行真实 Step-Audio。',
    });
  } else {
    const stepfunReport = path.join(diagnosticsDirectory, 'phase3-stepfun-positive.json');
    const stepfun = await commandGate(
      gates,
      'G4',
      'Real Step-Audio Tool/HOLD smoke',
      'bash',
      ['scripts/codex-node.sh', 'node', 'scripts/stepfun-realtime-smoke.js'],
      { STEPFUN_TOOL_TEST_MODE: 'positive', STEPFUN_REPORT_PATH: stepfunReport },
    );
    if (stepfun.output) appendFileSync(logPath, redact(stepfun.output), { mode: 0o600 });
  }

  addGate(gates, {
    id: 'G5',
    name: 'Real backend A+B session acceptance',
    status: 'BLOCKED',
    durationMs: 0,
    summary: gates.find((gate) => gate.id === 'G2')?.status === 'PASS'
      ? '当前仓库已有本地 backend wiring test，但真实 Retriever + backend + Step-Audio 联合 runner 尚未提供。'
      : '等待 G2 真实 Retriever ingest/query 恢复后，再执行 backend + Step-Audio 联合验收。',
    evidence: { deterministicWiringTest: 'test/realtime-retriever-wiring.test.ts' },
  });
  addGate(gates, {
    id: 'G6',
    name: 'Concurrency and isolation acceptance',
    status: 'BLOCKED',
    durationMs: 0,
    summary: '等待 G5 真实会话 runner；当前仅有 owner/story/source 过滤的确定性覆盖。',
  });
  addGate(gates, {
    id: 'G7',
    name: 'Latency and slow-path budget acceptance',
    status: 'BLOCKED',
    durationMs: 0,
    summary: '等待 G5/G6 真实数据；不能用本地 fake 或 HTTP 503 推导线上延迟。',
  });
  addGate(gates, {
    id: 'G8',
    name: 'Persisted DB and trace final-state acceptance',
    status: 'BLOCKED',
    durationMs: 0,
    summary: '等待真实会话完成后检查 SQLite authoritative rows、index state 和 trace counters。',
  });

  const generatedAt = new Date().toISOString();
  writeFileSync(reportPath, reportMarkdown(gates, generatedAt), { mode: 0o600 });
  appendFileSync(logPath, `${reportMarkdown(gates, generatedAt)}\n`, { mode: 0o600 });
  const overall = gates.some((gate) => gate.status === 'FAIL')
    ? 'FAIL'
    : gates.some((gate) => gate.status === 'BLOCKED' || gate.status === 'NOT_RUN')
      ? 'BLOCKED'
      : 'PASS';
  process.stdout.write(`PHASE3_AB_GATE_STATUS=${overall}\nREPORT_PATH=${reportPath}\nLOG_PATH=${logPath}\n`);
  if (overall !== 'PASS') process.exitCode = 1;
}

void main().catch((error) => {
  process.stderr.write(`PHASE3_AB_GATE_ERROR=${errorMessage(error)}\n`);
  process.exitCode = 1;
});
