import { createHash } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { interviewSessions, retrieverIndexJobs } from '../db/schema.js';
import { nowUtcIso } from '../db/time.js';
import { parseTranscript, type TranscriptMessage } from '../db/transcript.js';
import type {
  RetrieverAdapter,
  RetrieverDocumentReference,
  RetrieverIndexInput,
  RetrieverIndexResult,
  RetrieverIndexStatus,
} from './types.js';

export class RetrieverIndexError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'SESSION_NOT_FOUND'
      | 'SESSION_NOT_ENDED'
      | 'TRANSCRIPT_INVALID'
      | 'RETRIEVER_INDEX_FAILED',
  ) {
    super(message);
    this.name = 'RetrieverIndexError';
  }
}

export interface RetrieverIndexOutcome {
  status: 'pending' | 'indexing' | 'indexed' | 'failed' | 'skipped';
  jobId?: string;
  documentId?: string;
  errorCode?: string;
}

export interface RetrieverIndexWaitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

function shortError(error: unknown): { code: string; message: string } {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? String((error as { code: string }).code)
    : 'RETRIEVER_INDEX_FAILED';
  const message = error instanceof Error ? error.message : 'Retriever indexing failed.';
  return { code: code.slice(0, 128), message: message.slice(0, 1000) };
}

const indexedStatuses = new Set(['completed', 'complete', 'indexed', 'ready', 'succeeded', 'success']);
const failedStatuses = new Set([
  'aborted', 'cancelled', 'canceled', 'error', 'errored', 'failed', 'not_found', 'rejected',
]);

function isIndexedStatus(status: string): boolean {
  return indexedStatuses.has(status.trim().toLowerCase());
}

function isFailedStatus(status: string): boolean {
  return failedStatuses.has(status.trim().toLowerCase());
}

function remoteFailureCode(status: string): string {
  const normalized = status.trim().toUpperCase().replace(/[^A-Z0-9]+/gu, '_').slice(0, 96);
  return `RETRIEVER_REMOTE_${normalized || 'FAILED'}`;
}

function referenceFromRow(row: {
  retrieverJobId: string | null;
  retrieverDocumentId: string | null;
}): RetrieverDocumentReference | undefined {
  if (!row.retrieverJobId && !row.retrieverDocumentId) return undefined;
  return {
    ...(row.retrieverJobId ? { jobId: row.retrieverJobId } : {}),
    ...(row.retrieverDocumentId ? { documentId: row.retrieverDocumentId } : {}),
  };
}

function mergeRemoteStatus(
  initial: RetrieverIndexResult,
  status: RetrieverIndexStatus,
): RetrieverIndexResult {
  return {
    ...status,
    ...(initial.jobId ? { jobId: initial.jobId } : {}),
    ...(initial.documentId ? { documentId: initial.documentId } : {}),
  };
}

const ANSWER_CHUNK_SIZE = 320;

function splitAnswer(text: string): string[] {
  const characters = Array.from(text);
  if (characters.length <= ANSWER_CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length;) {
    let end = Math.min(offset + ANSWER_CHUNK_SIZE, characters.length);
    if (end < characters.length) {
      for (let boundary = end - 1; boundary >= offset + 160; boundary -= 1) {
        if (/[。！？!?；;\n]/u.test(characters[boundary] ?? '')) {
          end = boundary + 1;
          break;
        }
      }
    }
    chunks.push(characters.slice(offset, end).join(''));
    offset = end;
  }
  return chunks;
}

function transcriptDocument(input: {
  userId: string;
  sessionId: string;
  storyId: string | null;
  stageId: string | null;
  sessionType: string;
  sourceType: string;
  endedAt: string | null;
  messages: TranscriptMessage[];
}): { text: string; contentHash: string } {
  const exchanges: Array<{ question: string; answer: TranscriptMessage }> = [];
  let latestAssistant: TranscriptMessage | undefined;
  for (const message of input.messages) {
    if (message.role === 'assistant') {
      latestAssistant = message;
    } else {
      // TranscriptMessage has no partial/final marker, so index only persisted user messages.
      if (message.text.trim()) exchanges.push({ question: latestAssistant?.text ?? '', answer: message });
      latestAssistant = undefined;
    }
  }

  const lines = [
    '# Life Interview Transcript',
    `user_id: ${input.userId}`,
    `session_id: ${input.sessionId}`,
    `story_id: ${input.storyId ?? ''}`,
    `stage_id: ${input.stageId ?? ''}`,
    `session_type: ${input.sessionType}`,
    `source_type: ${input.sourceType}`,
    `ended_at: ${input.endedAt ?? ''}`,
    '',
    ...exchanges.flatMap(({ question, answer }) => splitAnswer(answer.text).map((chunk) => (
      `[segment_id=${answer.message_id}][message_id=${answer.message_id}][Q+A]\nQuestion (context only): ${question}\nAnswer (user-provided fact): ${chunk}`
    ))),
  ];
  const text = lines.join('\n');
  const contentHash = createHash('sha256').update(text, 'utf8').digest('hex');
  return { text, contentHash };
}

export function buildRetrieverIndexInput(session: {
  userId: string;
  sessionId: string;
  storyId: string | null;
  stageId: string | null;
  sessionType: string;
  sourceType: string;
  endedAt: string | null;
  transcriptJson: string;
}): RetrieverIndexInput {
  let messages: TranscriptMessage[];
  try {
    messages = parseTranscript(session.transcriptJson);
  } catch {
    throw new RetrieverIndexError('Session Transcript JSON is invalid.', 'TRANSCRIPT_INVALID');
  }
  const document = transcriptDocument({ ...session, messages });
  return {
    userId: session.userId,
    sessionId: session.sessionId,
    storyId: session.storyId,
    stageId: session.stageId,
    sessionType: session.sessionType,
    sourceType: session.sourceType,
    endedAt: session.endedAt,
    transcriptText: document.text,
    contentHash: document.contentHash,
  };
}

export class RetrieverIndexService {
  constructor(
    private readonly databasePath: string | undefined,
    private readonly adapter: RetrieverAdapter,
  ) {}

  async indexSessionTranscript(
    userId: string,
    sessionId: string,
    options: { signal?: AbortSignal; force?: boolean } = {},
  ): Promise<RetrieverIndexOutcome> {
    const connection = createDatabase(this.databasePath);
    let input: RetrieverIndexInput;
    try {
      const session = connection.db.select().from(interviewSessions).where(and(
        eq(interviewSessions.userId, userId),
        eq(interviewSessions.sessionId, sessionId),
      )).get();
      if (!session) throw new RetrieverIndexError('Session not found.', 'SESSION_NOT_FOUND');
      if (!session.endedAt || !['ended', 'completed'].includes(session.status)) {
        throw new RetrieverIndexError('Session must be ended before indexing.', 'SESSION_NOT_ENDED');
      }
      input = buildRetrieverIndexInput(session);
    } finally {
      connection.close();
    }

    const previous = this.getIndexStatus(userId, input.sessionId);
    const claim = this.claim(userId, input, options.force === true);
    if (claim.status === 'indexed' || claim.status === 'indexing') return claim;

    try {
      const previousReference = previous ? referenceFromRow(previous) : undefined;
      const shouldReplace = Boolean(
        previousReference?.documentId
        && (options.force === true || previous?.contentHash !== input.contentHash),
      );
      if (shouldReplace) {
        await this.adapter.deleteSessionTranscript(input.sessionId, {
          signal: options.signal,
          reference: previousReference,
        });
        this.clearRemoteReference(userId, input.sessionId);
      }
      const result = await this.adapter.indexSessionTranscript(input, { signal: options.signal });
      if (isFailedStatus(result.status)) {
        const errorCode = remoteFailureCode(result.status);
        this.markFailed(userId, input.sessionId, errorCode, `Retriever returned terminal status: ${result.status}.`, result);
        return {
          status: 'failed',
          errorCode,
          ...(result.jobId ? { jobId: result.jobId } : {}),
          ...(result.documentId ? { documentId: result.documentId } : {}),
        };
      }
      let settled = result;
      if (!isIndexedStatus(result.status)) {
        try {
          const status = await this.adapter.getIndexStatus(input.sessionId, {
            signal: options.signal,
            reference: {
              ...(result.jobId ? { jobId: result.jobId } : {}),
              ...(result.documentId ? { documentId: result.documentId } : {}),
            },
          });
          settled = mergeRemoteStatus(result, status);
        } catch {
          // The upload was accepted. Keep the durable state at indexing so a
          // later refresh/retry can confirm the remote job without duplicating it.
          this.markIndexing(userId, input.sessionId, input.contentHash, result);
          return {
            status: 'indexing',
            ...(result.jobId ? { jobId: result.jobId } : {}),
            ...(result.documentId ? { documentId: result.documentId } : {}),
          };
        }
      }
      if (isFailedStatus(settled.status)) {
        const errorCode = remoteFailureCode(settled.status);
        this.markFailed(userId, input.sessionId, errorCode, `Retriever returned terminal status: ${settled.status}.`, settled);
        return {
          status: 'failed',
          errorCode,
          ...(settled.jobId ? { jobId: settled.jobId } : {}),
          ...(settled.documentId ? { documentId: settled.documentId } : {}),
        };
      }
      if (isIndexedStatus(settled.status)) {
        this.markIndexed(userId, input.sessionId, input.contentHash, settled);
      } else {
        this.markIndexing(userId, input.sessionId, input.contentHash, settled);
      }
      return {
        status: isIndexedStatus(settled.status) ? 'indexed' : 'indexing',
        ...(settled.jobId ? { jobId: settled.jobId } : {}),
        ...(settled.documentId ? { documentId: settled.documentId } : {}),
      };
    } catch (error) {
      const failure = shortError(error);
      this.markFailed(userId, input.sessionId, failure.code, failure.message);
      return { status: 'failed', errorCode: failure.code };
    }
  }

  async retrySessionTranscript(
    userId: string,
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<RetrieverIndexOutcome> {
    return this.indexSessionTranscript(userId, sessionId, { ...options, force: true });
  }

  getIndexStatus(userId: string, sessionId: string) {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.select().from(retrieverIndexJobs).where(and(
        eq(retrieverIndexJobs.userId, userId),
        eq(retrieverIndexJobs.sessionId, sessionId),
      )).get() ?? null;
    } finally {
      connection.close();
    }
  }

  async refreshIndexStatus(
    userId: string,
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<RetrieverIndexOutcome | null> {
    const row = this.getIndexStatus(userId, sessionId);
    if (!row) return null;
    const reference = referenceFromRow(row);
    if (!reference?.documentId && !reference?.jobId) {
      return { status: row.status as RetrieverIndexOutcome['status'] };
    }
    try {
      const result = await this.adapter.getIndexStatus(sessionId, {
        signal: options.signal,
        reference,
      });
      const settled: RetrieverIndexResult = {
        ...result,
        ...(row.retrieverJobId ? { jobId: row.retrieverJobId } : {}),
        ...(row.retrieverDocumentId ? { documentId: row.retrieverDocumentId } : {}),
      };
      if (isIndexedStatus(settled.status)) {
        this.markIndexed(userId, sessionId, row.contentHash ?? '', settled);
        return {
          status: 'indexed',
          ...(settled.jobId ? { jobId: settled.jobId } : {}),
          ...(settled.documentId ? { documentId: settled.documentId } : {}),
        };
      }
      if (isFailedStatus(settled.status)) {
        const errorCode = remoteFailureCode(settled.status);
        this.markFailed(userId, sessionId, errorCode, `Retriever returned terminal status: ${settled.status}.`, settled);
        return {
          status: 'failed',
          errorCode,
          ...(settled.jobId ? { jobId: settled.jobId } : {}),
          ...(settled.documentId ? { documentId: settled.documentId } : {}),
        };
      }
      this.markIndexing(userId, sessionId, row.contentHash ?? '', settled);
      return {
        status: 'indexing',
        ...(settled.jobId ? { jobId: settled.jobId } : {}),
        ...(settled.documentId ? { documentId: settled.documentId } : {}),
      };
    } catch (error) {
      const failure = shortError(error);
      this.markFailed(userId, sessionId, failure.code, failure.message);
      return { status: 'failed', errorCode: failure.code };
    }
  }

  async waitForIndex(
    userId: string,
    sessionId: string,
    options: RetrieverIndexWaitOptions = {},
  ): Promise<RetrieverIndexOutcome | null> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const pollIntervalMs = options.pollIntervalMs ?? 500;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('RETRIEVER_WAIT_TIMEOUT_INVALID');
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) throw new Error('RETRIEVER_POLL_INTERVAL_INVALID');
    const deadline = Date.now() + timeoutMs;
    let current = this.getIndexStatus(userId, sessionId);
    while (current?.status === 'indexing' && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const onAbort = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          reject(new Error('RETRIEVER_WAIT_CANCELLED'));
        };
        timer = setTimeout(() => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, Math.min(pollIntervalMs, remaining));
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted) onAbort();
      });
      const refreshed = await this.refreshIndexStatus(userId, sessionId, options);
      if (!refreshed || refreshed.status !== 'indexing') return refreshed;
      current = this.getIndexStatus(userId, sessionId);
    }
    return current
      ? {
          status: current.status as RetrieverIndexOutcome['status'],
          ...(current.retrieverJobId ? { jobId: current.retrieverJobId } : {}),
          ...(current.retrieverDocumentId ? { documentId: current.retrieverDocumentId } : {}),
          ...(current.lastErrorCode ? { errorCode: current.lastErrorCode } : {}),
        }
      : null;
  }

  async reindexStorySessions(userId: string, storyId: string): Promise<void> {
    const connection = createDatabase(this.databasePath);
    let sessionIds: string[];
    try {
      sessionIds = connection.db.select({ sessionId: interviewSessions.sessionId })
        .from(interviewSessions)
        .where(and(
          eq(interviewSessions.userId, userId),
          eq(interviewSessions.storyId, storyId),
          eq(interviewSessions.sourceType, 'subject'),
        ))
        .all()
        .map((row) => row.sessionId);
    } finally {
      connection.close();
    }
    const outcomes = await Promise.all(sessionIds.map((sessionId) => this.indexSessionTranscript(userId, sessionId)));
    await Promise.all(outcomes.map((outcome, index) => outcome.status === 'indexing'
      ? this.waitForIndex(userId, sessionIds[index]!)
      : undefined));
  }

  private claim(userId: string, input: RetrieverIndexInput, force: boolean): RetrieverIndexOutcome {
    const connection = createDatabase(this.databasePath);
    const now = nowUtcIso();
    try {
      return connection.db.transaction((tx) => {
        let row = tx.select().from(retrieverIndexJobs).where(and(
          eq(retrieverIndexJobs.userId, userId),
          eq(retrieverIndexJobs.sessionId, input.sessionId),
        )).get();
        if (!row) {
          try {
            tx.insert(retrieverIndexJobs).values({
              sessionId: input.sessionId,
              userId,
              status: 'pending',
              contentHash: input.contentHash,
              createdAt: now,
              updatedAt: now,
            }).run();
          } catch {
            // A concurrent enqueue won the insert; the following read decides ownership.
          }
          row = tx.select().from(retrieverIndexJobs).where(and(
            eq(retrieverIndexJobs.userId, userId),
            eq(retrieverIndexJobs.sessionId, input.sessionId),
          )).get();
        }
        if (!row) throw new Error('RETRIEVER_INDEX_STATE_CREATE_FAILED');
        if (!force && row.status === 'indexed' && row.contentHash === input.contentHash) {
          return {
            status: 'indexed' as const,
            ...(row.retrieverJobId ? { jobId: row.retrieverJobId } : {}),
            ...(row.retrieverDocumentId ? { documentId: row.retrieverDocumentId } : {}),
          };
        }
        if (!force && row.status === 'indexing' && row.contentHash === input.contentHash) {
          return {
            status: 'indexing' as const,
            ...(row.retrieverJobId ? { jobId: row.retrieverJobId } : {}),
            ...(row.retrieverDocumentId ? { documentId: row.retrieverDocumentId } : {}),
          };
        }
        const claimWhere = force
          ? and(
              eq(retrieverIndexJobs.userId, userId),
              eq(retrieverIndexJobs.sessionId, input.sessionId),
            )
          : and(
              eq(retrieverIndexJobs.userId, userId),
              eq(retrieverIndexJobs.sessionId, input.sessionId),
              ne(retrieverIndexJobs.status, 'indexing'),
            );
        const result = tx.update(retrieverIndexJobs).set({
          status: 'indexing',
          contentHash: input.contentHash,
          attemptCount: row.attemptCount + 1,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: now,
        }).where(claimWhere).run();
        if (result.changes !== 1) {
          return { status: 'indexing' as const };
        }
        return { status: 'pending' as const };
      });
    } finally {
      connection.close();
    }
  }

  private markIndexed(userId: string, sessionId: string, contentHash: string, result: RetrieverIndexResult): void {
    const now = nowUtcIso();
    const connection = createDatabase(this.databasePath);
    try {
      connection.db.update(retrieverIndexJobs).set({
        status: 'indexed',
        contentHash,
        retrieverJobId: result.jobId ?? null,
        retrieverDocumentId: result.documentId ?? null,
        indexedAt: now,
        updatedAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
      }).where(and(
        eq(retrieverIndexJobs.userId, userId),
        eq(retrieverIndexJobs.sessionId, sessionId),
        eq(retrieverIndexJobs.status, 'indexing'),
      )).run();
    } finally {
      connection.close();
    }
  }

  private markIndexing(userId: string, sessionId: string, contentHash: string, result: RetrieverIndexResult): void {
    const now = nowUtcIso();
    const connection = createDatabase(this.databasePath);
    try {
      connection.db.update(retrieverIndexJobs).set({
        status: 'indexing',
        contentHash,
        retrieverJobId: result.jobId ?? null,
        retrieverDocumentId: result.documentId ?? null,
        indexedAt: null,
        updatedAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
      }).where(and(
        eq(retrieverIndexJobs.userId, userId),
        eq(retrieverIndexJobs.sessionId, sessionId),
        eq(retrieverIndexJobs.status, 'indexing'),
      )).run();
    } finally {
      connection.close();
    }
  }

  private clearRemoteReference(userId: string, sessionId: string): void {
    const connection = createDatabase(this.databasePath);
    try {
      connection.db.update(retrieverIndexJobs).set({
        retrieverJobId: null,
        retrieverDocumentId: null,
        updatedAt: nowUtcIso(),
      }).where(and(
        eq(retrieverIndexJobs.userId, userId),
        eq(retrieverIndexJobs.sessionId, sessionId),
        eq(retrieverIndexJobs.status, 'indexing'),
      )).run();
    } finally {
      connection.close();
    }
  }

  private markFailed(
    userId: string,
    sessionId: string,
    code: string,
    message: string,
    result?: RetrieverIndexResult,
  ): void {
    const now = nowUtcIso();
    const connection = createDatabase(this.databasePath);
    try {
      connection.db.update(retrieverIndexJobs).set({
        status: 'failed',
        ...(result ? {
          retrieverJobId: result.jobId ?? null,
          retrieverDocumentId: result.documentId ?? null,
        } : {}),
        lastErrorCode: code,
        lastErrorMessage: message,
        updatedAt: now,
      }).where(and(
        eq(retrieverIndexJobs.userId, userId),
        eq(retrieverIndexJobs.sessionId, sessionId),
        eq(retrieverIndexJobs.status, 'indexing'),
      )).run();
    } finally {
      connection.close();
    }
  }
}
