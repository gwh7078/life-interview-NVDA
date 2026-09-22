import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EraContextClient } from '../../src/era-context/client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const record = {
  start_year: 1999,
  end_year: 2002,
  category: '互联网' as const,
  title: '网吧和QQ逐渐普及',
  summary: '网吧和即时通信逐渐进入年轻人的日常生活。',
};

test('era context search sends range filter and removes non-overlapping hits locally', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const client = new EraContextClient({
    endpoint: 'http://retriever.test',
    collection: 'life-interview-era-context-v1',
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ hits: [
        { text: JSON.stringify(record), score: 0.88, metadata: record },
        {
          text: JSON.stringify({ ...record, start_year: 2005, end_year: 2006, title: '不应命中' }),
          score: 0.99,
          metadata: { ...record, start_year: 2005, end_year: 2006, title: '不应命中' },
        },
      ] });
    },
  });

  const result = await client.search({
    query: '刚参加工作时的娱乐生活',
    start_year: 1998,
    end_year: 2002,
  });

  assert.deepEqual(result, [{ ...record, score: 0.88 }]);
  assert.deepEqual(requestBody, {
    collection_name: 'life-interview-era-context-v1',
    query: '刚参加工作时的娱乐生活',
    top_k: 50,
    rerank: true,
    metadata_filter: {
      start_year: { $lte: 2002 },
      end_year: { $gte: 1998 },
    },
  });
});

test('era context search prefers Retriever rerank score over distance', async () => {
  const client = new EraContextClient({
    endpoint: 'http://retriever.test',
    collection: 'life-interview-era-context-v1',
    fetch: async () => jsonResponse({ hits: [
      { text: JSON.stringify(record), metadata: record, _rerank_score: 0.95, distance: 0.1 },
      { text: JSON.stringify({ ...record, title: '距离更近但语义更弱' }), metadata: { ...record, title: '距离更近但语义更弱' }, _rerank_score: 0.7, distance: 0.01 },
    ] }),
  });

  const result = await client.search({ query: '工作娱乐', start_year: 1998, end_year: 2002, top_k: 2 });

  assert.equal(result[0]?.title, record.title);
  assert.equal(result[0]?.score, 0.95);
  assert.equal(result[1]?.score, 0.7);
});

test('era context index uploads the five-field record with protected metadata', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new EraContextClient({
    endpoint: 'http://retriever.test',
    collection: 'life-interview-era-context-v1',
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) return jsonResponse({ name: 'life-interview-era-context-v1', status: 'active' });
      if (calls.length === 2) return jsonResponse({ job_id: 'job-era-1', status: 'pending' });
      return jsonResponse({ document_id: 'document-era-1', status: 'accepted' }, 202);
    },
  });

  const result = await client.indexRecords([record]);

  assert.equal(result.jobId, 'job-era-1');
  assert.deepEqual(result.documentIds, ['document-era-1']);
  const createBody = JSON.parse(String(calls[1]?.init?.body)) as Record<string, any>;
  assert.equal(createBody.collection_name, 'life-interview-era-context-v1');
  assert.equal(createBody.operation, 'append');
  assert.equal(createBody.expected_documents, 1);
  const form = calls[2]?.init?.body as FormData;
  assert.ok(form instanceof FormData);
  const uploadedMetadata = JSON.parse(String(form.get('metadata'))).metadata as Record<string, unknown>;
  assert.equal(uploadedMetadata.collection_name, 'life-interview-era-context-v1');
  assert.equal(uploadedMetadata.dataset, 'era-context');
  assert.equal(uploadedMetadata.start_year, record.start_year);
  assert.equal(uploadedMetadata.end_year, record.end_year);
  assert.equal(uploadedMetadata.category, record.category);
  assert.equal(uploadedMetadata.title, record.title);
  assert.equal(uploadedMetadata.summary, record.summary);
  assert.match(String(uploadedMetadata.record_id), /^[a-f0-9]{64}$/u);
});
