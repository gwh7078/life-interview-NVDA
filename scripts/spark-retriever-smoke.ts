import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { RetrieverClient } from '../src/retriever/client.js';

const endpoint = process.env.NEMO_RETRIEVER_BASE_URL?.trim() || 'http://127.0.0.1:7670';
const collection = process.env.NEMO_RETRIEVER_COLLECTION?.trim() || 'life-interview-transcripts';
const token = process.env.NEMO_RETRIEVER_API_TOKEN?.trim();
const headers = token ? { authorization: `Bearer ${token}` } : undefined;
const client = new RetrieverClient({ endpoint, collection, ...(headers ? { headers } : {}) });
const tag = `spark-scope-${randomUUID()}`;
const sessions = [
  { userId: `${tag}-owner-a`, sessionId: `${tag}-a-subject`, storyId: `${tag}-story-a`, sourceType: 'subject', text: `${tag} alpha childhood bicycle memory` },
  { userId: `${tag}-owner-a`, sessionId: `${tag}-a-contributor`, storyId: `${tag}-story-a`, sourceType: 'external_contributor', text: `${tag} beta contributor school memory` },
  { userId: `${tag}-owner-b`, sessionId: `${tag}-b-subject`, storyId: `${tag}-story-b`, sourceType: 'subject', text: `${tag} gamma unrelated owner memory` },
] as const;

async function ensureCollection(): Promise<void> {
  const auth = token ? { authorization: `Bearer ${token}` } : {};
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
    if (['indexed','completed','complete','succeeded','success','ready'].includes(status)) return;
    if (['failed','error','cancelled'].includes(status)) throw new Error(`index failed: ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('index timeout');
}

await ensureCollection();
const started = performance.now();
try {
  for (const row of sessions) {
    await client.indexSessionTranscript({
      userId: row.userId,
      sessionId: row.sessionId,
      storyId: row.storyId,
      stageId: null,
      sessionType: 'story_continue',
      sourceType: row.sourceType,
      endedAt: new Date().toISOString(),
      transcriptText: `[message_id=${row.sessionId}-m1] [segment_id=${row.sessionId}-s1] ${row.text}`,
      contentHash: createHash('sha256').update(row.text).digest('hex'),
    });
  }
  await Promise.all(sessions.map((row) => waitIndexed(row.sessionId)));
  const queryStarted = performance.now();
  const subject = await client.searchTranscript({
    ownerId: sessions[0].userId, storyId: sessions[0].storyId, sourceType: 'subject',
    query: `${tag} alpha bicycle`, topK: 5,
  });
  const contributor = await client.searchTranscript({
    ownerId: sessions[1].userId, storyId: sessions[1].storyId, sourceType: 'external_contributor',
    query: `${tag} beta school`, topK: 5,
  });
  const queryMs = performance.now() - queryStarted;
  assert.ok(subject.length > 0, 'subject scope returned no evidence');
  assert.ok(contributor.length > 0, 'contributor scope returned no evidence');
  assert.ok(subject.every((hit) => hit.ownerId === sessions[0].userId && hit.storyId === sessions[0].storyId && hit.sourceType === 'subject'));
  assert.ok(contributor.every((hit) => hit.ownerId === sessions[1].userId && hit.storyId === sessions[1].storyId && hit.sourceType === 'external_contributor'));
  console.log(JSON.stringify({
    status: 'PASS',
    ingest_and_wait_ms: Math.round((performance.now() - started) - queryMs),
    query_ms: Math.round(queryMs),
    owner_story_source_scope: true,
    subject_hits: subject.length,
    contributor_hits: contributor.length,
  }));
} finally {
  for (const row of sessions) {
    try { await client.deleteSessionTranscript(row.sessionId); } catch { /* derived smoke data cleanup is best-effort */ }
  }
}
