import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RetrieverClient,
  RetrieverClientError,
} from '../src/retriever/client.js';
import type { RetrieverIndexInput } from '../src/retriever/types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const indexInput: RetrieverIndexInput = {
  userId: 'user-1',
  sessionId: 'session-1',
  storyId: 'story-1',
  stageId: null,
  sessionType: 'story',
  sourceType: 'subject',
  endedAt: '2026-09-22T10:00:00Z',
  transcriptText: '# transcript\n[segment_id=segment-1][user] 记忆内容',
  contentHash: 'hash-1',
};

test('Retriever index creates a job, uploads one multipart Session document, and normalizes ids', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    jsonResponse({ job_id: 'job-1', status: 'pending' }),
    jsonResponse({ job_id: 'job-1', document_id: 'document-1', status: 'accepted' }, 202),
  ];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return responses.shift() ?? jsonResponse({ error: 'unexpected request' }, 500);
  };
  const client = new RetrieverClient({
    endpoint: 'http://retriever.test/',
    collection: 'life-interview-transcripts',
    fetch: fetchMock,
  });

  const result = await client.indexSessionTranscript(indexInput, { timeoutMs: 2_000 });

  assert.deepEqual(result, {
    jobId: 'job-1',
    documentId: 'document-1',
    status: 'accepted',
  });
  assert.equal(calls[0]?.url, 'http://retriever.test/v1/ingest/job');
  assert.equal(calls[0]?.init?.method, 'POST');
  const createBody = JSON.parse(String(calls[0]?.init?.body)) as Record<string, any>;
  assert.equal(createBody.expected_documents, 1);
  assert.equal(createBody.label, 'session:session-1');
  assert.deepEqual(createBody.metadata, {
    collection_name: 'life-interview-transcripts',
    user_id: 'user-1',
    session_id: 'session-1',
    story_id: 'story-1',
    stage_id: null,
    session_type: 'story',
    source_type: 'subject',
    ended_at: '2026-09-22T10:00:00Z',
    content_hash: 'hash-1',
  });
  assert.equal(calls[1]?.url, 'http://retriever.test/v1/ingest/job/job-1/document');
  assert.equal(calls[1]?.init?.method, 'POST');
  assert.ok(calls[1]?.init?.body instanceof FormData);
  const form = calls[1]?.init?.body as FormData;
  const file = form.get('file');
  assert.ok(file instanceof Blob);
  assert.equal(await file.text(), indexInput.transcriptText);
  assert.deepEqual(JSON.parse(String(form.get('metadata'))), {
    ...createBody.metadata,
    filename: 'session-transcript-session-1.md',
    content_type: 'text/markdown',
  });
  assert.ok(calls[0]?.init?.signal instanceof AbortSignal);
  assert.ok(calls[1]?.init?.signal instanceof AbortSignal);
});

test('Retriever health and search send the configured collection and return traceable evidence', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) return jsonResponse({ status: 'ok', version: 'test' });
    return jsonResponse({ hits: [{
      text: '原始片段',
      score: 0.82,
      metadata: {
        user_id: 'user-1',
        story_id: 'story-1',
        session_id: 'session-1',
        source_type: 'subject',
        message_ids: ['message-1'],
        segment_ids: ['segment-1'],
      },
    }] });
  };
  const client = new RetrieverClient({
    endpoint: 'http://retriever.test',
    collection: 'life-interview-transcripts',
    fetch: fetchMock,
  });

  assert.deepEqual(await client.health(), { status: 'ok', version: 'test' });
  const evidence = await client.searchTranscript({
    ownerId: 'user-1',
    storyId: 'story-1',
    sessionId: 'session-1',
    sourceType: 'subject',
    query: '第一次创业',
    topK: 5,
  });

  assert.deepEqual(evidence, [{
    text: '原始片段',
    score: 0.82,
    ownerId: 'user-1',
    storyId: 'story-1',
    sourceType: 'subject',
    sessionId: 'session-1',
    messageIds: ['message-1'],
    segmentIds: ['segment-1'],
  }]);
  assert.equal(calls[0]?.url, 'http://retriever.test/v1/health');
  assert.equal(calls[1]?.url, 'http://retriever.test/v1/query');
  const queryBody = JSON.parse(String(calls[1]?.init?.body)) as Record<string, any>;
  assert.deepEqual(queryBody, {
    collection_name: 'life-interview-transcripts',
    query: '第一次创业',
    top_k: 5,
    metadata_filter: {
      user_id: 'user-1',
      story_id: 'story-1',
      session_id: 'session-1',
      source_type: 'subject',
    },
  });
});

test('Retriever exposes job/document status and deletes the indexed Session document', async () => {
  const calls: string[] = [];
  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/v1/ingest/job')) return jsonResponse({ job_id: 'job-1', status: 'pending' });
    if (url.endsWith('/v1/ingest/job/job-1/document')) {
      return jsonResponse({ document_id: 'document-1', status: 'accepted' }, 202);
    }
    if (url.endsWith('/v1/ingest/job/job-1')) {
      return jsonResponse({ job_id: 'job-1', document_ids: ['document-1'], status: 'processing' });
    }
    if (url.endsWith('/v1/ingest/status/document-1')) {
      return jsonResponse({ document_id: 'document-1', job_id: 'job-1', status: 'completed' });
    }
    return new Response(null, { status: 204 });
  };
  const client = new RetrieverClient({
    endpoint: 'http://retriever.test',
    collection: 'life-interview-transcripts',
    fetch: fetchMock,
  });

  await client.indexSessionTranscript(indexInput);
  assert.deepEqual(await client.getJobStatus('job-1'), {
    jobId: 'job-1',
    documentId: 'document-1',
    status: 'processing',
  });
  assert.deepEqual(await client.getDocumentStatus('document-1'), {
    jobId: 'job-1',
    documentId: 'document-1',
    status: 'completed',
  });
  assert.deepEqual(await client.getIndexStatus('session-1'), {
    jobId: 'job-1',
    documentId: 'document-1',
    status: 'completed',
  });
  assert.deepEqual(await client.deleteSessionTranscript('session-1'), {
    jobId: 'job-1',
    documentId: 'document-1',
    status: 'deleted',
  });
  assert.ok(calls.includes('http://retriever.test/v1/collections/life-interview-transcripts/documents/document-1'));
});

test('Retriever treats an already missing derived document as an idempotent delete', async () => {
  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/ingest/job')) return jsonResponse({ job_id: 'job-1' });
    if (url.endsWith('/v1/ingest/job/job-1/document')) {
      return jsonResponse({ document_id: 'document-1', status: 'accepted' }, 202);
    }
    return jsonResponse({ detail: 'already deleted' }, 404);
  };
  const client = new RetrieverClient({
    endpoint: 'http://retriever.test',
    collection: 'life-interview-transcripts',
    fetch: fetchMock,
  });

  await client.indexSessionTranscript(indexInput);
  assert.deepEqual(await client.deleteSessionTranscript('session-1'), {
    jobId: 'job-1',
    documentId: 'document-1',
    status: 'deleted',
  });
});

test('Retriever request timeout, caller cancellation, and HTTP failures use one error type', async () => {
  const timeoutFetch: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  const timeoutClient = new RetrieverClient({
    endpoint: 'http://retriever.test',
    collection: 'life-interview-transcripts',
    fetch: timeoutFetch,
  });
  await assert.rejects(timeoutClient.health({ timeoutMs: 5 }), (error: unknown) => {
    assert.ok(error instanceof RetrieverClientError);
    assert.equal(error.code, 'RETRIEVER_TIMEOUT');
    return true;
  });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(timeoutClient.health({ signal: controller.signal }), (error: unknown) => {
    assert.ok(error instanceof RetrieverClientError);
    assert.equal(error.code, 'RETRIEVER_ABORTED');
    return true;
  });

  const httpClient = new RetrieverClient({
    endpoint: 'http://retriever.test',
    collection: 'life-interview-transcripts',
    fetch: async () => jsonResponse({ detail: 'private response details' }, 503),
  });
  await assert.rejects(httpClient.health(), (error: unknown) => {
    assert.ok(error instanceof RetrieverClientError);
    assert.equal(error.code, 'RETRIEVER_HTTP_ERROR');
    assert.equal(error.statusCode, 503);
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, /private response details/);
    return true;
  });
});
