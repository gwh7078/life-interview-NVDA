import { createHash } from 'node:crypto';
import type {
  EraContextAdapter,
  EraContextMatch,
  EraContextRecord,
  EraContextSearchInput,
} from './types.js';
import { overlapsEraYears, validateEraContextRecord, validateEraContextSearchInput } from './validation.js';

type JsonRecord = Record<string, unknown>;
type FetchLike = typeof fetch;

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_QUERY_TOP_K = 50;

export type EraContextClientErrorCode =
  | 'ERA_CONTEXT_CONFIG_INVALID'
  | 'ERA_CONTEXT_INPUT_INVALID'
  | 'ERA_CONTEXT_ABORTED'
  | 'ERA_CONTEXT_TIMEOUT'
  | 'ERA_CONTEXT_NETWORK_ERROR'
  | 'ERA_CONTEXT_HTTP_ERROR'
  | 'ERA_CONTEXT_RESPONSE_INVALID';

export class EraContextClientError extends Error {
  constructor(
    message: string,
    readonly code: EraContextClientErrorCode,
    readonly statusCode?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'EraContextClientError';
  }
}

export interface EraContextClientConfig {
  endpoint: string;
  collection: string;
  timeoutMs?: number;
  headers?: HeadersInit;
  fetch?: FetchLike;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nestedRecords(value: unknown): JsonRecord[] {
  if (!isRecord(value)) return [];
  const values = [value];
  for (const key of ['data', 'result', 'response', 'job', 'document']) {
    if (isRecord(value[key])) values.push(value[key]);
  }
  return values;
}

function stringValue(value: unknown, keys: string[]): string | undefined {
  for (const record of nestedRecords(value)) {
    for (const key of keys) {
      if (typeof record[key] === 'string' && record[key]) return record[key] as string;
    }
  }
  return undefined;
}

function statusValue(value: unknown): string {
  return stringValue(value, ['status', 'state']) ?? 'unknown';
}

function rows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(rows);
  if (!isRecord(value)) return [];
  for (const key of ['hits', 'matches', 'results', 'evidence', 'data']) {
    if (Array.isArray(value[key])) return value[key].flatMap(rows);
  }
  return [value];
}

function numberValue(value: unknown, keys: string[]): number | undefined {
  for (const record of nestedRecords(value)) {
    for (const key of keys) {
      if (typeof record[key] === 'number' && Number.isFinite(record[key])) return record[key] as number;
    }
  }
  return undefined;
}

function matchScore(value: unknown): number {
  const rerankScore = numberValue(value, ['_rerank_score', 'rerank_score', 'score']);
  if (rerankScore !== undefined) return rerankScore;
  const distance = numberValue(value, ['distance']);
  return distance === undefined ? 0 : -distance;
}

function recordFromRow(value: unknown): { record: EraContextRecord; score: number } | null {
  if (!isRecord(value)) return null;
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const text = typeof value.text === 'string'
    ? value.text
    : typeof value.content === 'string' ? value.content : '';
  let parsed: Record<string, unknown> = {};
  try {
    const candidate = JSON.parse(text) as unknown;
    if (isRecord(candidate)) parsed = candidate;
  } catch {
    // Metadata is the primary response contract; text parsing is only a fallback.
  }
  const source = { ...parsed, ...metadata, ...value };
  try {
    const record = validateEraContextRecord({
      start_year: source.start_year,
      end_year: source.end_year,
      category: source.category,
      title: source.title,
      summary: source.summary,
    });
    return { record, score: matchScore(value) };
  } catch {
    return null;
  }
}

function recordId(record: EraContextRecord): string {
  return createHash('sha256').update(JSON.stringify(record), 'utf8').digest('hex');
}

function positiveTimeout(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new EraContextClientError('Era context timeout must be a positive integer.', 'ERA_CONTEXT_CONFIG_INVALID');
  }
  return value;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

export class EraContextClient implements EraContextAdapter {
  readonly endpoint: string;
  readonly collection: string;
  private readonly timeoutMs: number;
  private readonly headers: Headers;
  private readonly fetchImpl?: FetchLike;

  constructor(config: EraContextClientConfig) {
    const endpoint = typeof config.endpoint === 'string' ? config.endpoint.trim() : '';
    const collection = typeof config.collection === 'string' ? config.collection.trim() : '';
    if (!endpoint || !collection) {
      throw new EraContextClientError(
        'Era context endpoint and collection are required.',
        'ERA_CONTEXT_CONFIG_INVALID',
      );
    }
    try {
      const url = new URL(endpoint);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('invalid endpoint');
      }
      this.endpoint = url.toString().replace(/\/+$/u, '');
    } catch {
      throw new EraContextClientError(
        'Era context endpoint must be a valid URL without credentials, query, or hash.',
        'ERA_CONTEXT_CONFIG_INVALID',
      );
    }
    this.collection = collection;
    this.timeoutMs = positiveTimeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.headers = new Headers(config.headers);
    this.fetchImpl = config.fetch;
  }

  async health(): Promise<JsonRecord> {
    const value = await this.request('/v1/health', { method: 'GET' });
    if (!isRecord(value)) throw new EraContextClientError('Retriever health response is invalid.', 'ERA_CONTEXT_RESPONSE_INVALID', undefined, true);
    return value;
  }

  async search(input: EraContextSearchInput): Promise<EraContextMatch[]> {
    const normalized = validateEraContextSearchInput(input);
    const payload = await this.request('/v1/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        collection_name: this.collection,
        query: normalized.query,
        top_k: Math.max(normalized.top_k, MIN_QUERY_TOP_K),
        rerank: true,
        metadata_filter: {
          start_year: { $lte: normalized.end_year },
          end_year: { $gte: normalized.start_year },
        },
      }),
    }, normalized.signal);
    return rows(payload)
      .map(recordFromRow)
      .filter((item): item is { record: EraContextRecord; score: number } => item !== null)
      .filter(({ record }) => overlapsEraYears(record, normalized.start_year, normalized.end_year))
      .sort((left, right) => right.score - left.score)
      .slice(0, normalized.top_k)
      .map(({ record, score }) => ({ ...record, score }));
  }

  async indexRecords(records: EraContextRecord[], options: { signal?: AbortSignal } = {}): Promise<{ jobId: string; documentIds: string[]; status: string }> {
    if (records.length === 0) throw new EraContextClientError('At least one era record is required.', 'ERA_CONTEXT_INPUT_INVALID');
    await this.ensureCollection(options.signal);
    const normalized = records.map(validateEraContextRecord);
    const manifest = normalized.map((record) => {
      const content = JSON.stringify(record);
      return {
        record,
        content,
        id: recordId(record),
        hash: createHash('sha256').update(content, 'utf8').digest('hex'),
      };
    });
    const job = await this.request('/v1/ingest/job', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expected_documents: manifest.length,
        label: 'era-context:v1',
        collection_name: this.collection,
        operation: 'append',
        idempotency_key: createHash('sha256').update(manifest.map((item) => item.hash).join(''), 'utf8').digest('hex'),
        metadata: { dataset: 'era-context', version: 'v1', record_count: manifest.length },
      }),
    }, options.signal);
    const jobId = stringValue(job, ['job_id', 'jobId', 'id']);
    if (!jobId) throw new EraContextClientError('Retriever ingest response did not include a job id.', 'ERA_CONTEXT_RESPONSE_INVALID', undefined, true);

    const documentIds: string[] = [];
    for (const item of manifest) {
      const form = new FormData();
      const filename = `era-${item.id}.json`;
      form.append('file', new Blob([item.content], { type: 'application/json' }), filename);
      form.append('metadata', JSON.stringify({
        filename,
        content_type: 'application/json',
        metadata: {
          collection_name: this.collection,
          dataset: 'era-context',
          record_id: item.id,
          ...item.record,
        },
      }));
      const uploaded = await this.request(`/v1/ingest/job/${encode(jobId)}/document`, {
        method: 'POST',
        body: form,
      }, options.signal);
      const documentId = stringValue(uploaded, ['document_id', 'documentId', 'id']);
      if (documentId) documentIds.push(documentId);
    }
    return { jobId, documentIds, status: statusValue(job) };
  }

  private async ensureCollection(signal?: AbortSignal): Promise<void> {
    try {
      await this.request(`/v1/collections/${encode(this.collection)}`, { method: 'GET' }, signal);
      return;
    } catch (error) {
      if (!(error instanceof EraContextClientError) || error.statusCode !== 404) throw error;
    }
    try {
      await this.request('/v1/collections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: this.collection,
          description: 'Life Interview public era context index.',
          metadata: { dataset: 'era-context', version: 'v1' },
        }),
      }, signal);
    } catch (error) {
      if (!(error instanceof EraContextClientError) || error.statusCode !== 409) throw error;
    }
  }

  async getJob(jobId: string, signal?: AbortSignal): Promise<JsonRecord> {
    const value = await this.request(`/v1/ingest/job/${encode(jobId)}?include_documents=true`, { method: 'GET' }, signal);
    if (!isRecord(value)) throw new EraContextClientError('Retriever job response is invalid.', 'ERA_CONTEXT_RESPONSE_INVALID', undefined, true);
    return value;
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new EraContextClientError('fetch is unavailable.', 'ERA_CONTEXT_CONFIG_INVALID');
    if (signal?.aborted) throw new EraContextClientError('Era context request was cancelled.', 'ERA_CONTEXT_ABORTED');
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const headers = new Headers(this.headers);
      for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
      headers.set('accept', 'application/json');
      let response: Response;
      try {
        response = await fetchImpl(`${this.endpoint}${path}`, { ...init, headers, signal: controller.signal });
      } catch {
        if (signal?.aborted) throw new EraContextClientError('Era context request was cancelled.', 'ERA_CONTEXT_ABORTED');
        if (timedOut) throw new EraContextClientError('Era context request timed out.', 'ERA_CONTEXT_TIMEOUT', undefined, true);
        throw new EraContextClientError('Era context request failed before a response.', 'ERA_CONTEXT_NETWORK_ERROR', undefined, true);
      }
      if (!response.ok) {
        throw new EraContextClientError(
          `Era context request failed (HTTP ${response.status}).`,
          'ERA_CONTEXT_HTTP_ERROR',
          response.status,
          response.status >= 500 || response.status === 408 || response.status === 429,
        );
      }
      if (response.status === 204) return undefined;
      const body = await response.text();
      if (!body.trim()) return undefined;
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new EraContextClientError('Retriever returned invalid JSON.', 'ERA_CONTEXT_RESPONSE_INVALID', response.status, true);
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}

export function createEraContextClientFromEnv(env: NodeJS.ProcessEnv = process.env): EraContextClient {
  const endpoint = env.NEMO_RETRIEVER_BASE_URL?.trim() || 'http://127.0.0.1:7670';
  const collection = env.NEMO_ERA_CONTEXT_COLLECTION?.trim() || 'life-interview-era-context-v1';
  const timeoutMs = env.NEMO_RETRIEVER_TIMEOUT_MS?.trim();
  const token = env.NEMO_RETRIEVER_API_TOKEN?.trim();
  return new EraContextClient({
    endpoint,
    collection,
    ...(timeoutMs ? { timeoutMs: Number(timeoutMs) } : {}),
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
}
