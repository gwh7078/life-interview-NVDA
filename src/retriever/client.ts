import type {
  RetrieverAdapter,
  RetrieverEvidence,
  RetrieverIndexInput,
  RetrieverIndexResult,
  RetrieverIndexStatus,
  RetrieverRequestOptions,
  RetrieverSearchInput,
} from './types.js';

export type { RetrieverAdapter } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_DOCUMENT_NAME = 'session-transcript.md';
const DEFAULT_DOCUMENT_TYPE = 'text/markdown';

type JsonRecord = Record<string, unknown>;
type FetchLike = typeof fetch;

export interface RetrieverClientConfig {
  endpoint: string;
  collection: string;
  timeoutMs?: number;
  headers?: HeadersInit;
  fetch?: FetchLike;
}

export type RetrieverClientErrorCode =
  | 'RETRIEVER_CONFIG_INVALID'
  | 'RETRIEVER_INPUT_INVALID'
  | 'RETRIEVER_ABORTED'
  | 'RETRIEVER_TIMEOUT'
  | 'RETRIEVER_NETWORK_ERROR'
  | 'RETRIEVER_HTTP_ERROR'
  | 'RETRIEVER_RESPONSE_INVALID';

export class RetrieverClientError extends Error {
  constructor(
    message: string,
    readonly code: RetrieverClientErrorCode,
    readonly statusCode?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'RetrieverClientError';
  }
}

interface SessionReference {
  jobId?: string;
  documentId?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordsFor(value: unknown): JsonRecord[] {
  if (!isRecord(value)) return [];
  const records = [value];
  for (const key of ['data', 'result', 'response', 'job', 'document']) {
    const nested = value[key];
    if (isRecord(nested)) records.push(nested);
  }
  return records;
}

function firstValue(value: unknown, keys: string[]): unknown {
  for (const record of recordsFor(value)) {
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null) return record[key];
    }
  }
  return undefined;
}

function stringValue(value: unknown, keys: string[]): string | undefined {
  const candidate = firstValue(value, keys);
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function identifier(value: unknown, keys: string[]): string | undefined {
  return stringValue(value, keys);
}

function statusValue(value: unknown, fallback = 'unknown'): string {
  return stringValue(value, ['status', 'state']) ?? fallback;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? [value] : [];
}

function transcriptIds(text: string, kind: 'message' | 'segment'): string[] {
  const ids = new Set<string>();
  const bracketPattern = new RegExp(`\\[${kind}_id=([^\\]]+)\\]`, 'g');
  for (const match of text.matchAll(bracketPattern)) {
    if (match[1]?.trim()) ids.add(match[1].trim());
  }
  const linePattern = new RegExp(`(?:^|\\s)${kind}_id:\\s*([^\\s\\]]+)`, 'gm');
  for (const match of text.matchAll(linePattern)) {
    if (match[1]?.trim()) ids.add(match[1].trim());
  }
  return [...ids];
}

const EVIDENCE_GROUP_KEYS = ['evidence', 'hits', 'matches', 'results', 'data'] as const;

function flattenEvidence(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(flattenEvidence);
  if (!isRecord(value)) return [];
  for (const key of EVIDENCE_GROUP_KEYS) {
    if (Array.isArray(value[key])) return value[key].flatMap(flattenEvidence);
  }
  return [value];
}

function evidenceRows(value: unknown): unknown[] {
  return flattenEvidence(value);
}

function evidenceFrom(value: unknown, input: RetrieverSearchInput): RetrieverEvidence {
  const record = isRecord(value) ? value : {};
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  const read = (keys: string[]): unknown => {
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null) return record[key];
      if (metadata[key] !== undefined && metadata[key] !== null) return metadata[key];
    }
    return undefined;
  };
  const scoreValue = read(['score', 'distance']);
  const score = typeof scoreValue === 'number' && Number.isFinite(scoreValue) ? scoreValue : 0;
  const ownerIdValue = read(['user_id', 'userId', 'owner_id', 'ownerId']);
  const sessionId = typeof read(['session_id', 'sessionId']) === 'string'
    ? read(['session_id', 'sessionId']) as string
    : input.sessionId ?? '';
  const storyIdValue = read(['story_id', 'storyId']);
  const sourceTypeValue = read(['source_type', 'sourceType']);
  const messageIdValue = read(['message_ids', 'messageIds', 'message_id', 'messageId']);
  const segmentIdValue = read(['segment_ids', 'segmentIds', 'segment_id', 'segmentId']);
  const text = read(['text', 'content', 'chunk_text']);
  const normalizedText = typeof text === 'string' ? text : '';
  const messageIds = stringArray(messageIdValue);
  const segmentIds = stringArray(segmentIdValue);

  return {
    text: normalizedText,
    score,
    ownerId: typeof ownerIdValue === 'string' ? ownerIdValue : null,
    storyId: typeof storyIdValue === 'string' ? storyIdValue : null,
    sourceType: sourceTypeValue === 'subject' || sourceTypeValue === 'external_contributor'
      ? sourceTypeValue
      : null,
    sessionId,
    // NeMo may preserve document metadata or return only the chunk text. The
    // indexer writes both ids into the controlled transcript format, so keep
    // provenance traceable in either response shape.
    messageIds: messageIds.length > 0 ? messageIds : transcriptIds(normalizedText, 'message'),
    segmentIds: segmentIds.length > 0 ? segmentIds : transcriptIds(normalizedText, 'segment'),
  };
}

function timeoutValue(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RetrieverClientError(
      'Retriever timeout must be a positive integer.',
      'RETRIEVER_CONFIG_INVALID',
    );
  }
  return value;
}

function requiredText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RetrieverClientError(
      `Retriever ${name} is required.`,
      'RETRIEVER_INPUT_INVALID',
    );
  }
  return value;
}

function optionalIdentifier(value: string | null, name: string): string | null {
  if (value !== null && (typeof value !== 'string' || value.trim().length === 0)) {
    throw new RetrieverClientError(
      `Retriever ${name} must be a non-empty string or null.`,
      'RETRIEVER_INPUT_INVALID',
    );
  }
  return value;
}

function encodePath(value: string): string {
  return encodeURIComponent(requiredText(value, 'identifier'));
}

function jsonObject(value: unknown, message: string): JsonRecord {
  if (!isRecord(value)) {
    throw new RetrieverClientError(message, 'RETRIEVER_RESPONSE_INVALID', undefined, true);
  }
  return value;
}

export class RetrieverClient implements RetrieverAdapter {
  readonly endpoint: string;
  readonly collection: string;

  private readonly timeoutMs: number;
  private readonly headers: Headers;
  private readonly fetchImpl?: FetchLike;
  private readonly sessions = new Map<string, SessionReference>();

  constructor(config: RetrieverClientConfig) {
    const endpoint = typeof config.endpoint === 'string' ? config.endpoint.trim() : '';
    const collection = typeof config.collection === 'string' ? config.collection.trim() : '';
    if (!endpoint || !collection) {
      throw new RetrieverClientError(
        'Retriever endpoint and collection are required.',
        'RETRIEVER_CONFIG_INVALID',
      );
    }
    try {
      const url = new URL(endpoint);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:')
        || url.username || url.password || url.search || url.hash) throw new Error('invalid');
      this.endpoint = url.toString().replace(/\/+$/, '');
    } catch {
      throw new RetrieverClientError(
        'Retriever endpoint must be a valid URL without credentials, query, or hash.',
        'RETRIEVER_CONFIG_INVALID',
      );
    }
    this.collection = collection;
    this.timeoutMs = timeoutValue(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.headers = new Headers(config.headers);
    this.fetchImpl = config.fetch;
  }

  async health(options: RetrieverRequestOptions = {}): Promise<JsonRecord> {
    const payload = await this.request('/v1/health', { method: 'GET' }, options);
    return jsonObject(payload, 'Retriever health response must be a JSON object.');
  }

  async indexSessionTranscript(
    input: RetrieverIndexInput,
    options: RetrieverRequestOptions = {},
  ): Promise<RetrieverIndexResult> {
    const metadata = this.indexMetadata(input);
    const jobPayload = await this.request('/v1/ingest/job', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expected_documents: 1,
        label: `session:${input.sessionId}`,
        metadata,
      }),
    }, options);
    const jobId = identifier(jobPayload, ['job_id', 'jobId', 'id']);
    if (!jobId) {
      throw new RetrieverClientError(
        'Retriever ingest job response did not include a job id.',
        'RETRIEVER_RESPONSE_INVALID',
        undefined,
        true,
      );
    }
    this.sessions.set(input.sessionId, { jobId });

    const form = new FormData();
    const filename = `${DEFAULT_DOCUMENT_NAME.replace('.md', '')}-${input.sessionId}.md`;
    form.append('file', new Blob([input.transcriptText], { type: DEFAULT_DOCUMENT_TYPE }), filename);
    form.append('metadata', JSON.stringify({
      ...metadata,
      filename,
      content_type: DEFAULT_DOCUMENT_TYPE,
    }));
    const documentPayload = await this.request(
      `/v1/ingest/job/${encodePath(jobId)}/document`,
      { method: 'POST', body: form },
      options,
    );
    const documentId = identifier(documentPayload, ['document_id', 'documentId', 'id']);
    if (!documentId) {
      throw new RetrieverClientError(
        'Retriever document response did not include a document id.',
        'RETRIEVER_RESPONSE_INVALID',
        undefined,
        true,
      );
    }
    this.sessions.set(input.sessionId, { jobId, documentId });
    return {
      jobId,
      documentId,
      status: statusValue(documentPayload, 'accepted'),
    };
  }

  async searchTranscript(input: RetrieverSearchInput): Promise<RetrieverEvidence[]> {
    requiredText(input.ownerId, 'ownerId');
    requiredText(input.query, 'query');
    if (!Number.isInteger(input.topK) || input.topK <= 0) {
      throw new RetrieverClientError(
        'Retriever topK must be a positive integer.',
        'RETRIEVER_INPUT_INVALID',
      );
    }
    const metadataFilter: JsonRecord = {
      user_id: input.ownerId,
      ...(input.storyId ? { story_id: input.storyId } : {}),
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(input.sourceType ? { source_type: input.sourceType } : {}),
    };
    const payload = await this.request('/v1/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        collection_name: this.collection,
        query: input.query,
        top_k: input.topK,
        metadata_filter: metadataFilter,
      }),
    }, { signal: input.signal });
    return evidenceRows(payload).map((row) => evidenceFrom(row, input));
  }

  async deleteSessionTranscript(
    sessionId: string,
    options: RetrieverRequestOptions = {},
  ): Promise<RetrieverIndexStatus> {
    requiredText(sessionId, 'sessionId');
    const reference = options.reference ?? this.sessions.get(sessionId);
    const documentId = reference?.documentId;
    if (!documentId) {
      throw new RetrieverClientError(
        'Retriever document reference is required for deletion.',
        'RETRIEVER_INPUT_INVALID',
      );
    }
    let payload: unknown;
    try {
      payload = await this.request(
        `/v1/collections/${encodePath(this.collection)}/documents/${encodePath(documentId)}`,
        { method: 'DELETE' },
        options,
      );
    } catch (error) {
      if (!(error instanceof RetrieverClientError) || error.statusCode !== 404) throw error;
      // A lost delete response or an already removed derived document is
      // idempotent from the product's point of view.
      payload = undefined;
    }
    this.sessions.delete(sessionId);
    return {
      ...(reference?.jobId ? { jobId: reference.jobId } : {}),
      documentId,
      status: statusValue(payload, 'deleted'),
    };
  }

  async getIndexStatus(
    sessionId: string,
    options: RetrieverRequestOptions = {},
  ): Promise<RetrieverIndexStatus> {
    requiredText(sessionId, 'sessionId');
    const reference = options.reference ?? this.sessions.get(sessionId);
    if (!reference?.documentId) {
      if (reference?.jobId) return this.getJobStatus(reference.jobId, options);
      throw new RetrieverClientError(
        'Retriever document reference is required for status lookup.',
        'RETRIEVER_INPUT_INVALID',
      );
    }
    const documentId = reference.documentId;
    return this.getDocumentStatus(documentId, options, reference?.jobId);
  }

  async getJobStatus(jobId: string, options: RetrieverRequestOptions = {}): Promise<RetrieverIndexStatus> {
    requiredText(jobId, 'jobId');
    const payload = await this.request(`/v1/ingest/job/${encodePath(jobId)}`, { method: 'GET' }, options);
    const documentIds = isRecord(payload) && Array.isArray(payload.document_ids)
      ? payload.document_ids.filter((value): value is string => typeof value === 'string')
      : [];
    return {
      jobId: identifier(payload, ['job_id', 'jobId', 'id']) ?? jobId,
      ...(documentIds[0] ? { documentId: documentIds[0] } : {}),
      status: statusValue(payload),
    };
  }

  async getDocumentStatus(
    documentId: string,
    options: RetrieverRequestOptions = {},
    fallbackJobId?: string,
  ): Promise<RetrieverIndexStatus> {
    requiredText(documentId, 'documentId');
    const payload = await this.request(`/v1/ingest/status/${encodePath(documentId)}`, { method: 'GET' }, options);
    return {
      ...(identifier(payload, ['job_id', 'jobId']) ?? fallbackJobId
        ? { jobId: identifier(payload, ['job_id', 'jobId']) ?? fallbackJobId } : {}),
      documentId: identifier(payload, ['document_id', 'documentId', 'id']) ?? documentId,
      status: statusValue(payload),
    };
  }

  private indexMetadata(input: RetrieverIndexInput): JsonRecord {
    requiredText(input.userId, 'userId');
    requiredText(input.sessionId, 'sessionId');
    requiredText(input.sessionType, 'sessionType');
    requiredText(input.sourceType, 'sourceType');
    requiredText(input.transcriptText, 'transcriptText');
    requiredText(input.contentHash, 'contentHash');
    return {
      collection_name: this.collection,
      user_id: input.userId,
      session_id: input.sessionId,
      story_id: optionalIdentifier(input.storyId, 'storyId'),
      stage_id: optionalIdentifier(input.stageId, 'stageId'),
      session_type: input.sessionType,
      source_type: input.sourceType,
      ended_at: input.endedAt,
      content_hash: input.contentHash,
    };
  }

  private async request(
    path: string,
    init: RequestInit,
    options: RetrieverRequestOptions,
  ): Promise<unknown> {
    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new RetrieverClientError(
        'Retriever fetch implementation is unavailable.',
        'RETRIEVER_CONFIG_INVALID',
      );
    }
    const timeoutMs = timeoutValue(options.timeoutMs ?? this.timeoutMs);
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    if (options.signal?.aborted) {
      throw new RetrieverClientError('Retriever request was cancelled.', 'RETRIEVER_ABORTED');
    }
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const headers = new Headers(this.headers);
      for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
      headers.set('accept', 'application/json');
      let response: Response;
      try {
        response = await fetchImpl(`${this.endpoint}${path}`, {
          ...init,
          headers,
          signal: controller.signal,
        });
      } catch {
        if (options.signal?.aborted) {
          throw new RetrieverClientError('Retriever request was cancelled.', 'RETRIEVER_ABORTED');
        }
        if (timedOut) {
          throw new RetrieverClientError('Retriever request timed out.', 'RETRIEVER_TIMEOUT', undefined, true);
        }
        throw new RetrieverClientError(
          'Retriever request failed before receiving a response.',
          'RETRIEVER_NETWORK_ERROR',
          undefined,
          true,
        );
      }
      if (!response.ok) {
        throw new RetrieverClientError(
          `Retriever request failed (HTTP ${response.status}).`,
          'RETRIEVER_HTTP_ERROR',
          response.status,
          response.status === 408 || response.status === 409 || response.status === 425
            || response.status === 429 || response.status >= 500,
        );
      }
      if (response.status === 204) return undefined;
      let body: string;
      try {
        body = await response.text();
      } catch {
        if (options.signal?.aborted) {
          throw new RetrieverClientError('Retriever request was cancelled.', 'RETRIEVER_ABORTED');
        }
        if (timedOut) {
          throw new RetrieverClientError('Retriever request timed out.', 'RETRIEVER_TIMEOUT', undefined, true);
        }
        throw new RetrieverClientError(
          'Retriever response could not be read.',
          'RETRIEVER_RESPONSE_INVALID',
          undefined,
          true,
        );
      }
      if (timedOut) {
        throw new RetrieverClientError('Retriever request timed out.', 'RETRIEVER_TIMEOUT', undefined, true);
      }
      if (!body.trim()) return undefined;
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new RetrieverClientError(
          'Retriever returned invalid JSON.',
          'RETRIEVER_RESPONSE_INVALID',
          response.status,
          true,
        );
      }
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}

export function createRetrieverClient(config: RetrieverClientConfig): RetrieverClient {
  return new RetrieverClient(config);
}

export function createRetrieverClientFromEnv(env: NodeJS.ProcessEnv = process.env): RetrieverClient {
  const endpoint = env.NEMO_RETRIEVER_BASE_URL?.trim() || 'http://127.0.0.1:7670';
  const collection = env.NEMO_RETRIEVER_COLLECTION?.trim() || 'life-interview-transcripts';
  const token = env.NEMO_RETRIEVER_API_TOKEN?.trim();
  const timeoutMs = env.NEMO_RETRIEVER_TIMEOUT_MS?.trim();
  return new RetrieverClient({
    endpoint,
    collection,
    ...(timeoutMs ? { timeoutMs: Number(timeoutMs) } : {}),
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
}
