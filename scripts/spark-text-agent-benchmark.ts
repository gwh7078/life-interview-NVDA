import { spawn } from 'node:child_process';
import { isNatPathPassing } from './spark-benchmark-validation.js';

const baseUrl = (process.env.TEXT_MODEL_BASE_URL || 'http://127.0.0.1:8000/v1').replace(/\/+$/u, '');
const model = process.env.TEXT_MODEL || process.env.SPARK_TEXT_SERVED_MODEL || 'nvidia/Qwen3.6-35B-A3B-NVFP4';
const iterations = Math.max(3, Number(process.env.SPARK_BENCH_ITERATIONS || 5));
const NAT_PREFIX = 'LIFE_INTERVIEW_NAT_RESULT ';
const authHeaders = process.env.TEXT_MODEL_API_KEY?.trim()
  ? { authorization: `Bearer ${process.env.TEXT_MODEL_API_KEY.trim()}` }
  : {};
const cases = [
  'onboarding.closeout',
  'interview.closeout/story_create',
  'interview.closeout/story_continue',
  'interview.closeout/contributor',
  'story.completion',
  'story.generation',
] as const;

function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!);
}

async function streamSample(): Promise<{ first_token_ms: number; total_ms: number }> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0,
      max_tokens: 64,
      messages: [{ role: 'user', content: '用一句中文回答：为什么事实核对对回忆录采访重要？' }],
    }),
  });
  if (!response.ok || !response.body) throw new Error(`text stream HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let firstTokenMs: number | undefined;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload) as any;
        const text = parsed?.choices?.[0]?.delta?.content;
        if (typeof text === 'string' && text.length > 0 && firstTokenMs === undefined) {
          firstTokenMs = performance.now() - started;
        }
      } catch {
        // Ignore incomplete/non-JSON SSE metadata lines.
      }
    }
  }
  if (firstTokenMs === undefined) throw new Error('text stream returned no content token');
  return {
    first_token_ms: Math.round(firstTokenMs),
    total_ms: Math.round(performance.now() - started),
  };
}

async function structuredOutput(): Promise<{ status: string; latency_ms: number }> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 64,
      messages: [{ role: 'user', content: '只返回 JSON：ok 必须为 true。' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'spark_structured_smoke',
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`structured output HTTP ${response.status}`);
  const body = await response.json() as any;
  const content = body?.choices?.[0]?.message?.content;
  const parsed = JSON.parse(String(content || ''));
  if (parsed?.ok !== true || Object.keys(parsed).length !== 1) throw new Error('structured output violated schema');
  return { status: 'PASS', latency_ms: Math.round(performance.now() - started) };
}

function runNat(caseId: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/nat-agent-runner.ts'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const collect = (target: 'out' | 'err', chunk: Buffer): void => {
      const text = chunk.toString();
      if (target === 'out' && stdout.length < 4_000_000) stdout += text;
      if (target === 'err' && stderr.length < 100_000) stderr += text;
    };
    child.stdout.on('data', (chunk: Buffer) => collect('out', chunk));
    child.stderr.on('data', (chunk: Buffer) => collect('err', chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const line = stdout.split(/\r?\n/u).findLast((value) => value.startsWith(NAT_PREFIX));
      if (!line) {
        reject(new Error(`NAT ${caseId} produced no result (exit=${code}; stderr=${stderr.slice(-500)})`));
        return;
      }
      const result = JSON.parse(line.slice(NAT_PREFIX.length)) as Record<string, any>;
      if (code !== 0 || result.status !== 'succeeded') {
        reject(new Error(`NAT ${caseId} failed: ${result?.error?.code || code}`));
        return;
      }
      resolve(result);
    });
    child.stdin.end(`${caseId}\n`);
  });
}

const firstToken: number[] = [];
const totals: number[] = [];
const samples = [];
for (let i = 0; i < iterations; i += 1) {
  const sample = await streamSample();
  samples.push(sample);
  firstToken.push(sample.first_token_ms);
  totals.push(sample.total_ms);
}
const structured = await structuredOutput();

const agentPaths: Record<string, unknown>[] = [];
for (const caseId of cases) {
  const result = await runNat(caseId);
  const validation = result.validation ?? {};
  agentPaths.push({
    case_id: caseId,
    status: result.status,
    latency_ms: result?.metrics?.latency_ms ?? result?.runtime?.latencyMs ?? null,
    attempt_count: result?.metrics?.attempt_count ?? null,
    repair_count: result?.metrics?.repair_count ?? null,
    contract_valid: validation.contract_valid ?? null,
    backend_validation: validation.backend_validation ?? null,
    semantic_valid: validation.semantic_valid ?? null,
    semantic_checks: validation.semantic_checks ?? null,
    validation_passed: isNatPathPassing(result),
  });
}

const report = {
  status: agentPaths.every((row: any) => row.validation_passed === true) ? 'PASS' : 'FAIL',
  model,
  iterations,
  streaming: {
    samples,
    first_token_p50_ms: percentile(firstToken, 0.50),
    first_token_p95_ms: percentile(firstToken, 0.95),
    total_p50_ms: percentile(totals, 0.50),
    total_p95_ms: percentile(totals, 0.95),
  },
  structured_output: structured,
  agent_six_paths: agentPaths,
  task_latency_ms: Object.fromEntries(agentPaths.map((row: any) => [row.case_id, row.latency_ms])),
};
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== 'PASS') process.exitCode = 1;
