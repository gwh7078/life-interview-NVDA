import { createHash, randomUUID } from 'node:crypto';
import { RetrieverClient } from '../src/retriever/client.js';
import { EraContextClient } from '../src/era-context/client.js';

const endpoint = process.env.NEMO_RETRIEVER_BASE_URL || 'http://127.0.0.1:7670';
const token = process.env.NEMO_RETRIEVER_API_TOKEN?.trim();
const headers = token ? { authorization: `Bearer ${token}` } : undefined;
const iterations = Math.max(3, Number(process.env.SPARK_BENCH_ITERATIONS || 5));
const privateCollection = process.env.SPARK_BENCH_PRIVATE_COLLECTION || 'life-interview-benchmark-private-v1';
const eraCollection = process.env.SPARK_BENCH_ERA_COLLECTION || 'life-interview-benchmark-era-v1';
const privateClient = new RetrieverClient({ endpoint, collection: privateCollection, ...(headers ? { headers } : {}) });
const eraClient = new EraContextClient({ endpoint, collection: eraCollection, ...(headers ? { headers } : {}) });

function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!);
}

async function ensureCollection(name: string, description: string): Promise<void> {
  const current = await fetch(`${endpoint}/v1/collections/${encodeURIComponent(name)}`, { headers });
  if (current.ok) return;
  if (current.status !== 404) throw new Error(`collection lookup HTTP ${current.status}`);
  const created = await fetch(`${endpoint}/v1/collections`, {
    method: 'POST',
    headers: { ...(headers ?? {}), 'content-type': 'application/json' },
    body: JSON.stringify({ name, description }),
  });
  if (!created.ok && created.status !== 409) throw new Error(`collection create HTTP ${created.status}`);
}

async function waitPrivate(sessionId: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const value = await privateClient.getIndexStatus(sessionId);
    if (/^(indexed|completed|complete|ready|succeeded|success)$/iu.test(value.status)) return;
    if (/^(failed|error|cancelled|canceled)$/iu.test(value.status)) throw new Error(`private index failed: ${value.status}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('private index timeout');
}

await ensureCollection(privateCollection, 'Synthetic DGX Spark benchmark private collection.');
const tag = `spark-private-${randomUUID()}`;
const rows = [
  { ownerId: `${tag}-owner-a`, sessionId: `${tag}-a`, storyId: `${tag}-story-a`, sourceType: 'subject', text: `${tag} alpha bicycle childhood memory` },
  { ownerId: `${tag}-owner-a`, sessionId: `${tag}-contributor`, storyId: `${tag}-story-a`, sourceType: 'external_contributor', text: `${tag} beta contributor school memory` },
  { ownerId: `${tag}-owner-b`, sessionId: `${tag}-b`, storyId: `${tag}-story-b`, sourceType: 'subject', text: `${tag} gamma unrelated owner memory` },
] as const;

const ingestMs: number[] = [];
try {
  for (const row of rows) {
    const started = performance.now();
    await privateClient.indexSessionTranscript({
      userId: row.ownerId,
      sessionId: row.sessionId,
      storyId: row.storyId,
      stageId: null,
      sessionType: 'story_continue',
      sourceType: row.sourceType,
      endedAt: new Date().toISOString(),
      transcriptText: `[message_id=${row.sessionId}-m1] [segment_id=${row.sessionId}-s1] ${row.text}`,
      contentHash: createHash('sha256').update(row.text).digest('hex'),
    });
    await waitPrivate(row.sessionId);
    ingestMs.push(Math.round(performance.now() - started));
  }

  const queryMs: number[] = [];
  let privateRecall = false;
  let scopeCorrect = true;
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    const hits = await privateClient.searchTranscript({
      ownerId: rows[0].ownerId,
      storyId: rows[0].storyId,
      sourceType: 'subject',
      query: `${tag} alpha bicycle`,
      topK: 5,
    });
    queryMs.push(Math.round(performance.now() - started));
    privateRecall ||= hits.some((hit) => hit.text.includes(tag) && hit.sessionId === rows[0].sessionId);
    scopeCorrect &&= hits.every((hit) =>
      hit.ownerId === rows[0].ownerId
      && hit.storyId === rows[0].storyId
      && hit.sourceType === 'subject'
      && hit.sessionId === rows[0].sessionId
    );
  }

  const publicMarker = 'spark-bench-era-public-v1';
  const eraStarted = performance.now();
  await eraClient.indexRecords([{
    start_year: 2008,
    end_year: 2008,
    category: 'technology',
    title: '2008 年互联网与移动通信背景',
    summary: `${publicMarker}：3G 与移动互联网基础设施持续发展，网络使用场景扩大。`,
  }]);
  const eraIngestMs = Math.round(performance.now() - eraStarted);
  let eraRecall = false;
  const eraQueryMs: number[] = [];
  const eraDeadline = Date.now() + 120_000;
  while (Date.now() < eraDeadline && !eraRecall) {
    const started = performance.now();
    const hits = await eraClient.search({ query: '2008 移动互联网 通信', start_year: 2008, end_year: 2008, top_k: 5 });
    eraQueryMs.push(Math.round(performance.now() - started));
    eraRecall = hits.some((hit) => hit.summary.includes(publicMarker));
    if (!eraRecall) await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const privateCross = await privateClient.searchTranscript({
    ownerId: rows[0].ownerId,
    storyId: rows[0].storyId,
    sourceType: 'subject',
    query: publicMarker,
    topK: 5,
  });
  const publicCross = await eraClient.search({
    query: tag,
    start_year: 2008,
    end_year: 2008,
    top_k: 5,
  });
  const privatePublicIsolation =
    privateCross.every((hit) => !hit.text.includes(publicMarker))
    && publicCross.every((hit) => !hit.summary.includes(tag));

  const status = privateRecall && eraRecall && scopeCorrect && privatePublicIsolation ? 'PASS' : 'FAIL';
  process.stdout.write(`${JSON.stringify({
    status,
    private_collection: privateCollection,
    era_collection: eraCollection,
    ingest: { samples_ms: ingestMs, p50_ms: percentile(ingestMs, 0.50), p95_ms: percentile(ingestMs, 0.95) },
    query: { samples_ms: queryMs, p50_ms: percentile(queryMs, 0.50), p95_ms: percentile(queryMs, 0.95) },
    recall: { private: privateRecall, era: eraRecall },
    scope_correctness: scopeCorrect,
    private_public_isolation: privatePublicIsolation,
    era: { ingest_ms: eraIngestMs, query_samples_ms: eraQueryMs, query_p95_ms: percentile(eraQueryMs, 0.95) },
  })}\n`);
  if (status !== 'PASS') process.exitCode = 1;
} finally {
  for (const row of rows) {
    try { await privateClient.deleteSessionTranscript(row.sessionId); } catch { /* derived benchmark cleanup */ }
  }
}
