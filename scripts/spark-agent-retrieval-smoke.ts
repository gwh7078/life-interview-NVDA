import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { RetrieverClient } from '../src/retriever/client.js';
import { AgentToolTokenService } from '../agent/tools/token.js';

const endpoint = process.env.NEMO_RETRIEVER_BASE_URL?.trim() || 'http://127.0.0.1:7670';
const collection = process.env.NEMO_RETRIEVER_COLLECTION?.trim() || 'life-interview-transcripts';
const retrieverToken = process.env.NEMO_RETRIEVER_API_TOKEN?.trim();
const headers = retrieverToken ? { authorization: `Bearer ${retrieverToken}` } : undefined;
const client = new RetrieverClient({ endpoint, collection, ...(headers ? { headers } : {}) });
const signingSecret = process.env.AGENT_RETRIEVAL_TOKEN_SECRET?.trim();
if (!signingSecret) throw new Error('AGENT_RETRIEVAL_TOKEN_SECRET is required.');
const tokenService = new AgentToolTokenService(signingSecret);
const sandbox = process.env.NEMOCLAW_SANDBOX?.trim() || 'my-assistant';
const proxyPort = process.env.SPARK_AGENT_RETRIEVAL_PORT?.trim() || '4175';

function hostIp(): string {
  const explicit = process.env.SPARK_AGENT_RETRIEVAL_HOST?.trim();
  if (explicit) return explicit;
  for (const command of [
    "ip route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i==\"src\"){print $(i+1); exit}}'",
    "hostname -I | awk '{print $1}'",
  ]) {
    try {
      const value = execFileSync('sh', ['-lc', command], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (value) return value;
    } catch {
      // Try the next read-only host-address probe.
    }
  }
  throw new Error('Could not determine a private host address for Agent retrieval smoke.');
}

async function ensureCollection(): Promise<void> {
  const auth = retrieverToken ? { authorization: `Bearer ${retrieverToken}` } : {};
  const current = await fetch(`${endpoint}/v1/collections/${encodeURIComponent(collection)}`, { headers: auth });
  if (current.ok) return;
  if (current.status !== 404) throw new Error(`collection lookup failed: HTTP ${current.status}`);
  const created = await fetch(`${endpoint}/v1/collections`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ name: collection, description: 'Life Interview private transcript index.' }),
  });
  if (!created.ok && created.status !== 409) throw new Error(`collection create failed: HTTP ${created.status}`);
}

async function waitIndexed(sessionId: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const status = (await client.getIndexStatus(sessionId)).status.toLowerCase();
    if (['indexed', 'completed', 'complete', 'succeeded', 'success', 'ready'].includes(status)) return;
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) throw new Error(`index failed: ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('index timeout');
}

function runMemorySearch(baseUrl: string, token: string, query: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const shell = [
      'IFS= read -r LIFE_INTERVIEW_RETRIEVAL_TOKEN',
      'export LIFE_INTERVIEW_RETRIEVAL_TOKEN',
      'export LIFE_INTERVIEW_RETRIEVAL_BASE_URL="$1"',
      'exec node /sandbox/.openclaw/workspace/skills/interview-closeout/scripts/memory-search.mjs "$2"',
    ].join('; ');
    const child = spawn('nemoclaw', [
      sandbox,
      'exec',
      '--stdin',
      '--timeout',
      '30',
      '--',
      'sh',
      '-c',
      shell,
      'sh',
      baseUrl,
      query,
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 50_000) stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`sandbox memory-search failed (exit=${code}): ${stderr.trim().split(/\r?\n/u).at(-1) || 'unknown'}`));
        return;
      }
      const line = stdout.trim().split(/\r?\n/u).findLast((value) => value.startsWith('{') && value.endsWith('}'));
      if (!line) {
        reject(new Error('sandbox memory-search returned no JSON result'));
        return;
      }
      try {
        resolve(JSON.parse(line) as Record<string, unknown>);
      } catch {
        reject(new Error('sandbox memory-search returned invalid JSON'));
      }
    });
    // The short-lived token crosses only stdin; it never appears in argv or logs.
    child.stdin.end(`${token}\n`);
  });
}

await ensureCollection();
const tag = `spark-agent-retrieval-${randomUUID()}`;
const userId = `${tag}-owner`;
const storyId = `${tag}-story`;
const sessionId = `${tag}-session`;
const textValue = `${tag} childhood bicycle memory from Tianjin`;
const baseUrl = `http://${hostIp()}:${proxyPort}`;

try {
  await client.indexSessionTranscript({
    userId,
    sessionId,
    storyId,
    stageId: null,
    sessionType: 'story_continue',
    sourceType: 'subject',
    endedAt: new Date().toISOString(),
    transcriptText: `[message_id=${sessionId}-m1] [segment_id=${sessionId}-s1] ${textValue}`,
    contentHash: createHash('sha256').update(textValue).digest('hex'),
  });
  await waitIndexed(sessionId);

  const token = tokenService.issue({
    runId: randomUUID(),
    userId,
    tool: 'memory_search',
    resourceType: 'story',
    resourceId: storyId,
    ttlMs: 120_000,
  });
  const allowed = await runMemorySearch(baseUrl, token, `${tag} bicycle`);
  const allowedMatches = Array.isArray(allowed.matches) ? allowed.matches as Array<Record<string, unknown>> : [];
  assert.ok(allowedMatches.some((match) => String(match.text ?? '').includes(tag)), 'authorized script did not return scoped evidence');

  const wrongScopeToken = tokenService.issue({
    runId: randomUUID(),
    userId,
    tool: 'memory_search',
    resourceType: 'story',
    resourceId: `${tag}-other-story`,
    ttlMs: 120_000,
  });
  const denied = await runMemorySearch(baseUrl, wrongScopeToken, `${tag} bicycle`);
  const deniedMatches = Array.isArray(denied.matches) ? denied.matches : [];
  assert.equal(deniedMatches.length, 0, 'story-scoped token leaked evidence from another Story');

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    sandbox,
    proxy_reachable_from_sandbox: true,
    formal_skill_script: 'memory-search',
    authorized_hits: allowedMatches.length,
    wrong_story_hits: deniedMatches.length,
    token_in_argv: false,
  })}\n`);
} finally {
  try { await client.deleteSessionTranscript(sessionId); } catch { /* derived smoke cleanup */ }
}
