import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startRealtimeSession } from './realtime-e2e-session.js';
import { and, eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { interviewSessions, retrieverIndexJobs } from '../src/db/schema.js';
import { parseTranscript } from '../src/db/transcript.js';
import { createInterviewServiceServer, type InterviewServiceDependencies } from '../src/server.js';
import { createRetrieverClientFromEnv, type RetrieverClient } from '../src/retriever/client.js';
import { RetrieverIndexService } from '../src/retriever/indexer.js';
import type { RetrieverIndexResult, RetrieverIndexStatus } from '../src/retriever/types.js';
import type { CloseoutProcessor } from '../src/interview/closeout/processor.js';
import type { StoryCompletionService } from '../src/story/completion/service.js';

type GateStatus = 'PASS' | 'FAIL' | 'BLOCKED';
type JsonRecord = Record<string, unknown>;

interface BackendGateResult {
  status: GateStatus;
  durationMs: number;
  summary: string;
  evidence?: JsonRecord;
}

interface BackendReport {
  generatedAt: string;
  status: GateStatus;
  gates: Record<string, BackendGateResult>;
  sessionId?: string;
  tracePath?: string;
  cleanupWarnings?: string[];
  error?: string;
}

interface TemporaryDocument {
  ownerId: string;
  storyId: string;
  sessionId: string;
  messageId: string;
  reference: { jobId?: string; documentId?: string };
}

interface ClientMessage extends JsonRecord {
  type: string;
}

interface LiveSessionResult {
  sessionId: string;
  traceSourcePath: string;
  messages: ClientMessage[];
  ended: ClientMessage;
  traceEvents: JsonRecord[];
  inputMessageObserved: boolean;
  toolResponseObserved: boolean;
}

/**
 * The live-session check must exercise real indexing for the session it ends,
 * but the production post-closeout hook also reindexes every seeded session in
 * the temporary database. Suppress only that broad hook so the runner cannot
 * leave unrelated seed documents in the shared Retriever collection.
 */
class GateRetrieverIndexService extends RetrieverIndexService {
  override async reindexStorySessions(_userId: string, _storyId: string): Promise<void> {
    return;
  }
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = path.resolve(
  process.env.PHASE3_BACKEND_REPORT_PATH?.trim()
    || path.join(projectRoot, 'runtime/diagnostics/phase3-backend-stepfun-e2e.json'),
);
const stableTracePath = path.resolve(
  process.env.PHASE3_BACKEND_TRACE_PATH?.trim()
    || path.join(projectRoot, 'runtime/diagnostics/phase3-backend-stepfun-trace.jsonl'),
);
const retrieverWaitMs = integerEnv('PHASE3_BACKEND_RETRIEVER_WAIT_MS', 45_000);
const providerWaitMs = integerEnv('PHASE3_BACKEND_PROVIDER_WAIT_MS', 75_000);
const slowDeadlineMs = integerEnv('REALTIME_SLOW_DEADLINE_MS', 5_000);
const stepfunModel = process.env.STEPFUN_REALTIME_MODEL?.trim() || 'step-audio-2-mini';
const inputText = process.env.PHASE3_STEPFUN_INPUT_TEXT?.trim()
  || '我以前跟你讲过王师傅，你还记得他和我的关系吗？';
const ttsVoice = process.env.PHASE3_STEPFUN_TTS_VOICE?.trim() || 'Tingting';
const inputSampleRate = 24_000;
const pcmFrameBytes = 960;
const pcmFrameDurationMs = 20;

function integerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const key = process.env.STEPFUN_API_KEY?.trim();
  return key ? message.split(key).join('<redacted>') : message.replace(/Bearer\s+[^\s"']+/gi, 'Bearer <redacted>');
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isIndexed(status: string): boolean {
  return /^(indexed|completed|complete|ready|succeeded|success)$/i.test(status);
}

function isFailed(status: string): boolean {
  return /^(failed|error|cancelled|canceled|rejected|not_found)$/i.test(status);
}

function extractPcm16FromWav(buffer: Buffer): Buffer {
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF'
    || buffer.subarray(8, 12).toString('ascii') !== 'WAVE') return buffer;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + chunkSize, buffer.length);
    if (chunkType === 'data') return buffer.subarray(start, end);
    offset = start + chunkSize + (chunkSize % 2);
  }
  throw new Error('STEPFUN_PCM16_PATH 的 WAV 文件没有 data chunk。');
}

function makeInputAudio(): Buffer {
  const configuredPath = process.env.STEPFUN_PCM16_PATH?.trim();
  if (configuredPath) {
    const pcm16 = extractPcm16FromWav(readFileSync(configuredPath));
    requireCondition(pcm16.length > 0 && pcm16.length % 2 === 0, 'STEPFUN_PCM16_PATH 必须包含非空 PCM16 音频。');
    return pcm16;
  }
  requireCondition(process.platform === 'darwin', '非 macOS 环境必须设置 STEPFUN_PCM16_PATH。');

  const directory = mkdtempSync(path.join(os.tmpdir(), 'phase3-stepfun-input-'));
  const aiffPath = path.join(directory, 'input.aiff');
  const wavPath = path.join(directory, 'input.wav');
  try {
    const speech = spawnSync('say', ['-v', ttsVoice, '-o', aiffPath, inputText], { encoding: 'utf8' });
    requireCondition(speech.status === 0, `macOS say 失败：${speech.stderr || speech.stdout || 'unknown error'}`);
    const conversion = spawnSync(
      'afconvert',
      ['-f', 'WAVE', '-d', `LEI16@${inputSampleRate}`, '-c', '1', aiffPath, wavPath],
      { encoding: 'utf8' },
    );
    requireCondition(conversion.status === 0, `afconvert 失败：${conversion.stderr || conversion.stdout || 'unknown error'}`);
    const pcm16 = extractPcm16FromWav(readFileSync(wavPath));
    requireCondition(pcm16.length > 0 && pcm16.length % 2 === 0, 'macOS 生成的 PCM16 音频为空或未对齐。');
    return pcm16;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function waitForRetrieverIndex(
  client: RetrieverClient,
  sessionId: string,
  timeoutMs = retrieverWaitMs,
): Promise<RetrieverIndexStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: RetrieverIndexStatus | undefined;
  while (Date.now() < deadline) {
    try {
      lastStatus = await client.getIndexStatus(sessionId);
      if (isIndexed(lastStatus.status) || isFailed(lastStatus.status)) return lastStatus;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await sleep(500);
  }
  throw new Error(`Retriever indexing 在 ${timeoutMs}ms 内未完成（status=${lastStatus?.status ?? 'unknown'}）。`);
}

async function indexTemporaryDocument(
  client: RetrieverClient,
  input: {
    ownerId: string;
    storyId: string;
    sessionId: string;
    messageId: string;
    text: string;
  },
  onAccepted?: (document: TemporaryDocument) => void,
): Promise<TemporaryDocument> {
  const indexed: RetrieverIndexResult = await client.indexSessionTranscript({
    userId: input.ownerId,
    sessionId: input.sessionId,
    storyId: input.storyId,
    stageId: `phase3-stage-${randomUUID()}`,
    sessionType: 'story',
    sourceType: 'subject',
    endedAt: new Date().toISOString(),
    contentHash: randomUUID(),
    transcriptText: [
      `user_id: ${input.ownerId}`,
      `session_id: ${input.sessionId}`,
      `story_id: ${input.storyId}`,
      `message_id: ${input.messageId}`,
      `[segment_id=${input.messageId}][message_id=${input.messageId}][user] ${input.text}`,
    ].join('\n'),
  });
  const document: TemporaryDocument = {
    ownerId: input.ownerId,
    storyId: input.storyId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    reference: { jobId: indexed.jobId, documentId: indexed.documentId },
  };
  onAccepted?.(document);
  const status = await waitForRetrieverIndex(client, input.sessionId);
  requireCondition(isIndexed(status.status), `Temporary Retriever document failed: ${status.status}`);
  return document;
}

async function deleteTemporaryDocument(client: RetrieverClient, document: TemporaryDocument): Promise<void> {
  if (!document.reference.documentId) return;
  await client.deleteSessionTranscript(document.sessionId, { reference: document.reference });
}

function readTrace(filePath: string): JsonRecord[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return isRecord(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

async function waitForTraceEvent(filePath: string, event: string, timeoutMs: number): Promise<JsonRecord | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = readTrace(filePath).find((candidate) => candidate.event === event);
    if (row) return row;
    await sleep(250);
  }
  return undefined;
}

function collectClientMessages(socket: WebSocket): ClientMessage[] {
  const messages: ClientMessage[] = [];
  socket.on('message', (raw) => {
    try {
      const parsed: unknown = JSON.parse(raw.toString());
      if (isRecord(parsed) && typeof parsed.type === 'string') messages.push(parsed as ClientMessage);
    } catch {
      // The backend client protocol is JSON. Ignore malformed frames and let the
      // bounded wait report the missing lifecycle event.
    }
  });
  socket.on('error', (error) => messages.push({ type: 'socket_error', message: errorMessage(error) }));
  return messages;
}

async function waitForMessage(
  messages: ClientMessage[],
  predicate: (message: ClientMessage) => boolean,
  timeoutMs: number,
  label: string,
): Promise<ClientMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await sleep(100);
  }
  const received = messages.map((message) => message.type).slice(-20).join(', ');
  throw new Error(`等待 backend ${label} 超时；最近消息：${received || 'none'}`);
}

async function closeSocket(socket: WebSocket | undefined): Promise<void> {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'phase3 gate complete');
  await Promise.race([once(socket, 'close'), sleep(1_000)]);
}

async function closeServer(server: ReturnType<typeof createInterviewServiceServer> | undefined): Promise<void> {
  if (!server || !server.listening) return;
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await Promise.race([closed, sleep(3_000)]);
}

function closeoutProcessor(): CloseoutProcessor {
  return {
    async process(input) {
      requireCondition(input.context.mode === 'continue' && input.context.currentStory, 'Phase3 gate expected an existing Story.');
      return {
        output: {
          mode: 'continue',
          current_story: {
            summary: input.context.currentStory.summary,
            agent_memory: input.context.currentStory.agent_memory,
            source_message_ids: [],
          },
          new_stories: [],
        },
        modelResult: {
          output: {},
          model: 'phase3-gate-validator',
          latencyMs: 0,
        },
        repairAttemptCount: 0,
      };
    },
  };
}

function storyCompletionStub(): Pick<StoryCompletionService, 'evaluate'> {
  return { evaluate: async () => ({ status: 'interviewing', gaps: [] }) };
}

function traceEvent(traceEvents: JsonRecord[], event: string): JsonRecord | undefined {
  return traceEvents.find((row) => row.event === event);
}

async function runConcurrentIsolation(
  client: RetrieverClient,
  onAccepted?: (document: TemporaryDocument) => void,
): Promise<JsonRecord> {
  const sharedQuery = `phase3 concurrent isolation ${randomUUID()}`;
  const documents = [0, 1].map((index) => ({
    ownerId: `phase3-isolation-owner-${index}-${randomUUID()}`,
    storyId: `phase3-isolation-story-${index}-${randomUUID()}`,
    sessionId: `phase3-isolation-session-${index}-${randomUUID()}`,
    messageId: `phase3-isolation-message-${index}-${randomUUID()}`,
    text: `${sharedQuery}：这是第 ${index} 个 owner 的历史事实。`,
  }));
  const indexed: TemporaryDocument[] = [];
  try {
    const results = await Promise.allSettled(documents.map((document) => indexTemporaryDocument(
      client,
      document,
      (accepted) => {
        indexed.push(accepted);
        onAccepted?.(accepted);
      },
    )));
    for (const result of results) {
      if (result.status !== 'fulfilled') throw result.reason;
    }
    const searches = await Promise.all(documents.map((document) => client.searchTranscript({
      ownerId: document.ownerId,
      storyId: document.storyId,
      sourceType: 'subject',
      query: sharedQuery,
      topK: 10,
    })));
    const checks = searches.map((evidence, index) => {
      const expected = documents[index]!;
      const matching = evidence.filter((item) => item.ownerId === expected.ownerId
        && item.storyId === expected.storyId
        && item.sourceType === 'subject'
        && item.sessionId === expected.sessionId
        && item.messageIds.includes(expected.messageId)
        && item.text.includes(sharedQuery));
      const foreign = evidence.filter((item) => item.ownerId !== expected.ownerId
        || item.storyId !== expected.storyId
        || item.sessionId !== expected.sessionId);
      return {
        resultCount: evidence.length,
        matchingCount: matching.length,
        foreignCount: foreign.length,
        observedSessionIds: evidence.map((item) => item.sessionId),
      };
    });
    requireCondition(checks.every((check) => check.matchingCount > 0 && check.foreignCount === 0), '并发 Retriever scoped query 出现跨 owner/story 结果。');
    return { sharedQueryChars: sharedQuery.length, checks };
  } finally {
    let cleanupError: unknown;
    await Promise.all(indexed.map(async (document) => {
      try {
        await deleteTemporaryDocument(client, document);
      } catch (error) {
        cleanupError ??= error;
      }
    }));
    if (cleanupError) throw cleanupError;
  }
}

async function runLiveSession(
  client: RetrieverClient,
  retrieverIndex: RetrieverIndexService,
  databasePath: string,
  diagnosticsDirectory: string,
): Promise<LiveSessionResult> {
  const config = {
    host: '127.0.0.1',
    port: 0,
    databasePath,
    region: 'cn-beijing' as const,
    model: stepfunModel,
    defaultRealtimeProvider: 'stepfun' as const,
    stepfunModel,
    stepfunApiKey: process.env.STEPFUN_API_KEY,
    developmentAuthEnabled: true,
    openingResponseTimeoutMs: 20_000,
    realtimeSlowDeadlineMs: slowDeadlineMs,
    wrapUpMs: 100_000,
    maxSessionMs: 200_000,
    closeGraceMs: 5_000,
    closeoutProvider: 'phase3-gate',
    closeoutModel: 'phase3-gate-validator',
    closeoutApiKey: 'phase3-gate',
    closeoutTimeoutMs: 1_000,
  };
  const dependencies: InterviewServiceDependencies = {
    retriever: client,
    retrieverIndex,
    agentTasks: null,
    storyCompletion: storyCompletionStub(),
    closeout: { processor: closeoutProcessor() },
  };
  const server = createInterviewServiceServer(config, dependencies);
  const audio = makeInputAudio();
  let socket: WebSocket | undefined;
  let sessionId = '';
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    requireCondition(address && typeof address === 'object', 'Backend server did not expose a TCP address.');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${baseUrl}/api/auth/development/legacy-session`, { method: 'POST' });
    requireCondition(login.ok, `Backend development login failed with HTTP ${login.status}.`);
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    requireCondition(cookie, 'Backend development login did not return a session cookie.');

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/realtime`, { headers: { cookie } });
    await once(socket, 'open');
    const messages = collectClientMessages(socket);
    const ready = await startRealtimeSession(
      socket,
      { type: 'start', story_id: seedIds.firstProject, provider: 'stepfun' },
      () => waitForMessage(messages, (message) => message.type === 'ready', providerWaitMs, 'ready'),
    );
    sessionId = typeof ready.sessionId === 'string' ? ready.sessionId : '';
    requireCondition(sessionId, 'Backend ready message did not include sessionId.');
    const traceSourcePath = path.join(diagnosticsDirectory, 'traces', 'realtime', `${sessionId}.jsonl`);

    // The backend sends the opening response automatically. Wait for it to
    // finish so this probe exercises a normal user turn rather than an overlap.
    await waitForMessage(messages, (message) => message.type === 'response_done' && message.status === 'completed', providerWaitMs, 'opening response');
    for (let offset = 0; offset < audio.length; offset += pcmFrameBytes) {
      const frame = Buffer.alloc(pcmFrameBytes);
      audio.copy(frame, 0, offset, Math.min(audio.length, offset + pcmFrameBytes));
      if (socket.readyState !== WebSocket.OPEN) throw new Error('Backend WebSocket closed during audio upload.');
      socket.send(frame);
      await sleep(pcmFrameDurationMs);
    }
    // StepFun server VAD needs an actual silence tail to emit speech_stopped.
    for (let index = 0; index < 80; index += 1) {
      if (socket.readyState !== WebSocket.OPEN) throw new Error('Backend WebSocket closed during silence tail.');
      socket.send(Buffer.alloc(pcmFrameBytes));
      await sleep(pcmFrameDurationMs);
    }

    const userFinal = await waitForMessage(messages, (message) => message.type === 'user_final' && typeof message.text === 'string' && message.text.trim().length > 0, providerWaitMs, 'user_final');
    const inputMessageObserved = typeof userFinal.text === 'string' && userFinal.text.trim().length > 0;
    const toolRequested = await waitForTraceEvent(traceSourcePath, 'realtime.tool_call_requested', providerWaitMs);
    const toolResult = await waitForTraceEvent(traceSourcePath, 'realtime.tool_result_sent', providerWaitMs);
    const toolResponseObserved = Boolean(toolRequested && toolResult);
    await waitForMessage(
      messages,
      (message) => message.type === 'assistant_final' && messages.indexOf(message) > messages.indexOf(userFinal),
      providerWaitMs,
      'resumed assistant_final',
    ).catch(() => undefined);

    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'end', reason: 'user_confirmed' }));
    const ended = await waitForMessage(messages, (message) => message.type === 'ended', providerWaitMs, 'ended');
    const traceEvents = readTrace(traceSourcePath);
    requireCondition(traceEvents.length > 0, 'Backend ended without a realtime trace file.');
    mkdirSync(path.dirname(stableTracePath), { recursive: true, mode: 0o700 });
    copyFileSync(traceSourcePath, stableTracePath);
    return {
      sessionId,
      traceSourcePath,
      messages,
      ended,
      traceEvents,
      inputMessageObserved,
      toolResponseObserved,
    };
  } finally {
    await closeSocket(socket);
    await closeServer(server);
  }
}

async function waitForLiveIndex(
  databasePath: string,
  sessionId: string,
  timeoutMs = retrieverWaitMs,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonRecord | undefined;
  while (Date.now() < deadline) {
    const connection = createDatabase(databasePath);
    try {
      const row = connection.db.select().from(retrieverIndexJobs)
        .where(eq(retrieverIndexJobs.sessionId, sessionId)).get();
      if (row) {
        last = row as unknown as JsonRecord;
        if (row.status === 'indexed' || row.status === 'failed') return last;
      }
    } finally {
      connection.close();
    }
    await sleep(500);
  }
  throw new Error(`Live session Retriever row 在 ${timeoutMs}ms 内未完成（status=${String(last?.status ?? 'missing')}）。`);
}

async function waitForLiveSessionCloseout(
  databasePath: string,
  sessionId: string,
  timeoutMs = retrieverWaitMs,
): Promise<typeof interviewSessions.$inferSelect> {
  const deadline = Date.now() + timeoutMs;
  let last: typeof interviewSessions.$inferSelect | undefined;
  while (Date.now() < deadline) {
    const connection = createDatabase(databasePath);
    try {
      last = connection.db.select().from(interviewSessions)
        .where(and(eq(interviewSessions.sessionId, sessionId), eq(interviewSessions.userId, seedIds.user))).get();
      if (last?.closeoutStatus === 'completed' || last?.closeoutStatus === 'failed') return last;
    } finally {
      connection.close();
    }
    await sleep(250);
  }
  throw new Error(`SQLite closeout 在 ${timeoutMs}ms 内未完成（status=${last?.closeoutStatus ?? 'missing'}）。`);
}

function persistedRetrieverReference(
  databasePath: string,
  sessionId: string,
): { jobId?: string; documentId?: string } | undefined {
  const connection = createDatabase(databasePath);
  try {
    const row = connection.db.select({
      jobId: retrieverIndexJobs.retrieverJobId,
      documentId: retrieverIndexJobs.retrieverDocumentId,
    }).from(retrieverIndexJobs).where(eq(retrieverIndexJobs.sessionId, sessionId)).get();
    if (!row || (!row.jobId && !row.documentId)) return undefined;
    return {
      ...(row.jobId ? { jobId: row.jobId } : {}),
      ...(row.documentId ? { documentId: row.documentId } : {}),
    };
  } finally {
    connection.close();
  }
}

async function main(): Promise<void> {
  requireCondition(process.env.STEPFUN_API_KEY?.trim(), 'STEPFUN_API_KEY 未配置，不能执行真实 backend + StepFun Gate。');
  const report: BackendReport = {
    generatedAt: new Date().toISOString(),
    status: 'FAIL',
    gates: {},
  };
  const originalDiagnosticsDir = process.env.DIAGNOSTICS_DIR;
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'phase3-backend-e2e-'));
  const diagnosticsDirectory = path.join(temporaryRoot, 'diagnostics');
  const databasePath = path.join(temporaryRoot, 'phase3.db');
  process.env.DIAGNOSTICS_DIR = diagnosticsDirectory;
  mkdirSync(diagnosticsDirectory, { recursive: true, mode: 0o700 });
  rmSync(stableTracePath, { force: true });

  const client = createRetrieverClientFromEnv(process.env);
  const retrieverIndex = new GateRetrieverIndexService(databasePath, client);
  let liveSessionId: string | undefined;
  let liveReference: { jobId?: string; documentId?: string } | undefined;
  const cleanupWarnings: string[] = [];
  const temporaryDocuments: TemporaryDocument[] = [];
  let live: LiveSessionResult | undefined;
  try {
    const database = createDatabase(databasePath);
    try {
      runMigrations(database);
      seedDatabase(database);
    } finally {
      database.close();
    }

    const historySessionId = `phase3-backend-history-${randomUUID()}`;
    const historyDocument = await indexTemporaryDocument(client, {
      ownerId: seedIds.user,
      storyId: seedIds.firstProject,
      sessionId: historySessionId,
      messageId: `phase3-backend-history-message-${randomUUID()}`,
      text: '王师傅是我第一次进厂后的第一位师傅，早期工作中他教我如何处理现场问题。',
    }, (accepted) => {
      temporaryDocuments.push(accepted);
    });
    const historyEvidence = await client.searchTranscript({
      ownerId: seedIds.user,
      storyId: seedIds.firstProject,
      sourceType: 'subject',
      query: '王师傅和我的关系',
      topK: 5,
    });
    const historyMatch = historyEvidence.some((item) => item.sessionId === historyDocument.sessionId
      && item.messageIds.includes(historyDocument.messageId)
      && item.text.includes('王师傅'));
    requireCondition(historyMatch, '真实 Retriever 未返回预置历史上下文；不能继续宣称 backend recall 可验收。');

    const g6StartedAt = Date.now();
    try {
      const evidence = await runConcurrentIsolation(client, (accepted) => temporaryDocuments.push(accepted));
      report.gates.G6 = {
        status: 'PASS',
        durationMs: Date.now() - g6StartedAt,
        summary: '两个并发真实 Retriever scoped query 均只返回各自 owner/story/session 的证据；G6 当前覆盖 Retriever 查询并发隔离。',
        evidence,
      };
    } catch (error) {
      report.gates.G6 = {
        status: 'FAIL',
        durationMs: Date.now() - g6StartedAt,
        summary: '并发真实 Retriever 隔离校验失败。',
        evidence: { error: errorMessage(error) },
      };
    }

    const g5StartedAt = Date.now();
    try {
      live = await runLiveSession(client, retrieverIndex, databasePath, diagnosticsDirectory);
      liveSessionId = live.sessionId;
      const requested = traceEvent(live.traceEvents, 'realtime.tool_call_requested');
      const recallFinished = traceEvent(live.traceEvents, 'realtime.slow_recall_finished');
      const toolResult = traceEvent(live.traceEvents, 'realtime.tool_result_sent');
      const factSourceMessageIds = typeof recallFinished?.factSourceMessageIds === 'string'
        ? recallFinished.factSourceMessageIds.split(',').filter(Boolean)
        : [];
      const historyFactMatched = factSourceMessageIds.includes(historyDocument.messageId);
      const resumedAssistant = live.messages.some((message, index) => message.type === 'assistant_final'
        && live!.messages.slice(0, index).some((prior) => prior.type === 'user_final'));
      const passed = live.inputMessageObserved
        && Boolean(requested)
        && recallFinished?.status === 'completed'
        && toolResult?.recallStatus === 'completed'
        && toolResult?.resumeRequested === true
        && live.toolResponseObserved
        && historyFactMatched
        && resumedAssistant;
      report.gates.G5 = {
        status: passed ? 'PASS' : 'FAIL',
        durationMs: Date.now() - g5StartedAt,
        summary: passed
          ? '真实 StepFun 会话完成 Tool call、Retriever recall、Tool result 和续答。'
          : '真实 backend 会话未完成完整 Tool/HOLD/Resume 链路。',
        evidence: {
          sessionId: live.sessionId,
          inputMessageObserved: live.inputMessageObserved,
          toolCallRequested: Boolean(requested),
          recallStatus: recallFinished?.status ?? null,
          toolResultStatus: toolResult?.recallStatus ?? null,
          resumeRequested: toolResult?.resumeRequested ?? null,
          factCount: recallFinished?.factCount ?? null,
          factSourceMessageIds,
          historyMessageId: historyDocument.messageId,
          historyFactMatched,
          resumedAssistant,
          clientMessageTypes: live.messages.map((message) => message.type),
        },
      };
    } catch (error) {
      report.gates.G5 = {
        status: 'FAIL',
        durationMs: Date.now() - g5StartedAt,
        summary: '真实 backend + StepFun 会话执行失败。',
        evidence: { error: errorMessage(error) },
      };
    }

    if (live) {
      const g7StartedAt = Date.now();
      const recallFinished = traceEvent(live.traceEvents, 'realtime.slow_recall_finished');
      const toolResult = traceEvent(live.traceEvents, 'realtime.tool_result_sent');
      const slowRecallLatencyMs = typeof recallFinished?.slowRecallLatencyMs === 'number'
        ? recallFinished.slowRecallLatencyMs : null;
      const toolResultLatencyMs = typeof toolResult?.toolResultLatencyMs === 'number'
        ? toolResult.toolResultLatencyMs : null;
      const passed = recallFinished?.status === 'completed'
        && typeof slowRecallLatencyMs === 'number'
        && slowRecallLatencyMs <= slowDeadlineMs
        && toolResult?.recallStatus === 'completed'
        && typeof toolResultLatencyMs === 'number'
        && toolResultLatencyMs <= slowDeadlineMs + 1_000;
      report.gates.G7 = {
        status: passed ? 'PASS' : 'FAIL',
        durationMs: Date.now() - g7StartedAt,
        summary: passed ? '真实 slow recall 延迟在配置预算内。' : '真实 slow recall 未满足延迟预算。',
        evidence: {
          configuredDeadlineMs: slowDeadlineMs,
          slowRecallLatencyMs,
          toolResultLatencyMs,
          recallStatus: recallFinished?.status ?? null,
          toolResultStatus: toolResult?.recallStatus ?? null,
        },
      };
    } else {
      report.gates.G7 = { status: 'BLOCKED', durationMs: 0, summary: 'G5 未产生可检查的真实会话 trace。' };
    }

    if (live && liveSessionId) {
      const g8StartedAt = Date.now();
      try {
        const ended = live.ended;
        const indexRow = await waitForLiveIndex(databasePath, liveSessionId);
        liveReference = {
          jobId: typeof indexRow.retrieverJobId === 'string' ? indexRow.retrieverJobId : undefined,
          documentId: typeof indexRow.retrieverDocumentId === 'string' ? indexRow.retrieverDocumentId : undefined,
        };
        requireCondition(indexRow.status === 'indexed', `Live session Retriever index status=${String(indexRow.status)}。`);
        const session = await waitForLiveSessionCloseout(databasePath, liveSessionId);
        requireCondition(['ended', 'completed'].includes(session.status), `SQLite session status=${session.status} 不是合法终态。`);
        requireCondition(session.closeoutStatus === 'completed', `SQLite closeout status=${session.closeoutStatus}。`);
        const transcript = parseTranscript(session?.transcriptJson);
        const userTranscript = transcript.find((message) => message.role === 'user' && message.text.trim());
        requireCondition(userTranscript, 'SQLite Transcript 缺少用户语音转写。');
        requireCondition(transcript.some((message) => message.role === 'assistant' && message.text.trim()), 'SQLite Transcript 缺少 assistant 语音回复。');
        const liveEvidence = await client.searchTranscript({
          ownerId: seedIds.user,
          storyId: seedIds.firstProject,
          sessionId: liveSessionId,
          sourceType: 'subject',
          query: userTranscript.text.slice(0, 120),
          topK: 5,
        });
        requireCondition(liveEvidence.some((item) => item.ownerId === seedIds.user
          && item.storyId === seedIds.firstProject
          && item.sessionId === liveSessionId
          && item.sourceType === 'subject'), 'Retriever query 未返回本次 live session 的派生 Transcript。');
        const traceNames = new Set(live.traceEvents.map((row) => row.event));
        const requiredTraceEvents = [
          'session.started',
          'realtime.tool_call_requested',
          'realtime.slow_recall_finished',
          'realtime.tool_result_sent',
          'transcript.write_succeeded',
          'retriever.index_scheduled',
          'session.ended',
        ];
        requireCondition(requiredTraceEvents.every((event) => traceNames.has(event)), 'Realtime trace 缺少最终验收所需事件。');
        const traceText = readFileSync(stableTracePath, 'utf8');
        requireCondition(!traceText.includes('STEPFUN_API_KEY') && !traceText.includes('Bearer '), 'Trace 中出现不应保存的凭据内容。');
        const passed = Array.isArray(ended.transcriptSaveErrors)
          && ended.transcriptSaveErrors.length === 0;
        requireCondition(passed, 'ended 消息报告 Transcript save error。');
        report.gates.G8 = {
          status: 'PASS',
          durationMs: Date.now() - g8StartedAt,
          summary: 'SQLite Transcript、session 状态、Retriever index 和 trace 最终状态均已核对。',
          evidence: {
            sessionStatus: session.status,
            provider: session.provider,
            transcriptCount: transcript.length,
            userTranscriptCount: transcript.filter((message) => message.role === 'user').length,
            assistantTranscriptCount: transcript.filter((message) => message.role === 'assistant').length,
            retrieverIndexStatus: indexRow.status,
            retrieverJobIdPresent: Boolean(indexRow.retrieverJobId),
            retrieverDocumentIdPresent: Boolean(indexRow.retrieverDocumentId),
            liveEvidenceCount: liveEvidence.length,
            traceEventCount: live.traceEvents.length,
            tracePath: stableTracePath,
          },
        };
      } catch (error) {
        report.gates.G8 = {
          status: 'FAIL',
          durationMs: Date.now() - g8StartedAt,
          summary: 'SQLite、Retriever index 或 trace 最终状态校验失败。',
          evidence: { error: errorMessage(error), tracePath: stableTracePath },
        };
      }
    } else {
      report.gates.G8 = { status: 'BLOCKED', durationMs: 0, summary: 'G5 未产生可检查的真实会话最终状态。' };
    }
  } catch (error) {
    report.error = errorMessage(error);
    if (!report.gates.G5) report.gates.G5 = { status: 'FAIL', durationMs: 0, summary: '真实 backend + StepFun Gate 前置准备失败。', evidence: { error: report.error } };
    if (!report.gates.G6) report.gates.G6 = { status: 'BLOCKED', durationMs: 0, summary: 'G6 等待真实 Retriever 前置准备。' };
    if (!report.gates.G7) report.gates.G7 = { status: 'BLOCKED', durationMs: 0, summary: 'G7 等待真实 backend trace。' };
    if (!report.gates.G8) report.gates.G8 = { status: 'BLOCKED', durationMs: 0, summary: 'G8 等待真实 backend 最终状态。' };
  } finally {
    if (liveSessionId && !liveReference?.documentId) {
      try {
        liveReference = persistedRetrieverReference(databasePath, liveSessionId);
      } catch (error) {
        cleanupWarnings.push(`live session reference lookup: ${errorMessage(error)}`);
      }
    }
    if (liveSessionId && liveReference?.documentId) {
      try { await client.deleteSessionTranscript(liveSessionId, { reference: liveReference }); }
      catch (error) { cleanupWarnings.push(`live session cleanup: ${errorMessage(error)}`); }
    } else if (liveSessionId && liveReference) {
      cleanupWarnings.push('live session cleanup: persisted Retriever reference has no document id');
    }
    for (const document of temporaryDocuments) {
      try { await deleteTemporaryDocument(client, document); }
      catch (error) { cleanupWarnings.push(`temporary document cleanup (${document.sessionId}): ${errorMessage(error)}`); }
    }
    if (cleanupWarnings.length > 0) {
      report.cleanupWarnings = cleanupWarnings;
      const cleanupGate = report.gates.G8 ?? report.gates.G6 ?? report.gates.G5;
      if (cleanupGate) {
        cleanupGate.status = 'FAIL';
        cleanupGate.summary = `${cleanupGate.summary} 清理失败，不能接受 Gate。`;
        cleanupGate.evidence = { ...(cleanupGate.evidence ?? {}), cleanupWarnings };
      }
    }
    report.sessionId = liveSessionId;
    report.tracePath = existsSync(stableTracePath) ? stableTracePath : undefined;
    report.status = cleanupWarnings.length === 0
      && Object.values(report.gates).every((gate) => gate.status === 'PASS') ? 'PASS' : 'FAIL';
    mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    if (originalDiagnosticsDir === undefined) delete process.env.DIAGNOSTICS_DIR;
    else process.env.DIAGNOSTICS_DIR = originalDiagnosticsDir;
    rmSync(temporaryRoot, { recursive: true, force: true });
  }

  process.stdout.write(`PHASE3_BACKEND_STATUS=${report.status}\nREPORT_PATH=${reportPath}\n`);
  if (report.status !== 'PASS') process.exitCode = 1;
}

void main().catch((error) => {
  const fallback: BackendReport = {
    generatedAt: new Date().toISOString(),
    status: 'FAIL',
    error: errorMessage(error),
    gates: {
      G5: { status: 'FAIL', durationMs: 0, summary: '真实 backend + StepFun Gate 未能启动。', evidence: { error: errorMessage(error) } },
      G6: { status: 'BLOCKED', durationMs: 0, summary: 'G6 未执行。' },
      G7: { status: 'BLOCKED', durationMs: 0, summary: 'G7 未执行。' },
      G8: { status: 'BLOCKED', durationMs: 0, summary: 'G8 未执行。' },
    },
  };
  mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  writeFileSync(reportPath, `${JSON.stringify(fallback, null, 2)}\n`, { mode: 0o600 });
  process.stderr.write(`PHASE3_BACKEND_ERROR=${fallback.error}\n`);
  process.exitCode = 1;
});
