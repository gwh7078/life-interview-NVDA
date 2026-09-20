import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { WebSocket, type RawData } from 'ws';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { interviewSessions, stories } from '../src/db/schema.js';
import { closeoutResultSchema, parseTranscript, parseJsonColumn } from '../src/db/transcript.js';
import { createInterviewServiceServer } from '../src/server.js';
import { resolveDiagnosticsPath } from '../src/diagnostics/paths.js';

const RUN_ROOT = resolveDiagnosticsPath('test-artifacts', 'voice-closeout');
const TTS_TEXT = '大概是2012年，在杭州，我第一次负责跨团队项目。上线那天页面打不开，我先让大家暂停发布，再一起核对日志，发现是接口配置错误。修好后按时上线。这件事让我记住，出了问题要先把信息对齐。';
const LIVE_TIMEOUT_MS = 180_000;
const CLOSEOUT_TIMEOUT_MS = 240_000;

type WireMessage = Record<string, unknown>;

interface E2eReport {
  status: 'PASS' | 'FAIL';
  level: 'A';
  startedAt: string;
  endedAt?: string;
  audio: {
    source: 'macOS say synthesized Chinese speech';
    voice: string;
    format: 'pcm_s16le, 16000 Hz, mono';
    bytes: number;
    speechBytes: number;
    silenceTailMs: number;
    frameBytes: number;
    frameCount: number;
    keepaliveFrames: number;
  };
  realtimeProvider: string;
  realtimeModel: string;
  closeoutProvider?: string;
  closeoutModel?: string;
  sessionId?: string;
  storyId: string;
  resultUrl?: string;
  databasePath: string;
  closeoutStatus?: string;
  sessionStatus?: string;
  realtimeEnd?: {
    drainTimedOut: boolean;
    pendingWriteCount: number;
    transcriptCount: number;
    savedTranscriptCount: number;
    transcriptSaveErrorCount: number;
  };
  transcriptCount?: number;
  userFinalCount?: number;
  assistantFinalCount?: number;
  savedTranscriptCount?: number;
  sourceMessageIds?: string[];
  newStoryCount?: number;
  createdNewStoryIds?: string[];
  manualCloseoutPostSent: false;
  wireEventTypes?: string[];
  failure?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getWavPcm(wav: Buffer): Buffer {
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF', 'TTS conversion did not produce a RIFF WAV');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE', 'TTS conversion did not produce a WAVE file');
  let offset = 12;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitsPerSample: number | undefined;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (payload + size > wav.length) throw new Error(`Invalid WAV chunk: ${id}`);
    if (id === 'fmt ' && size >= 16) {
      const format = wav.readUInt16LE(payload);
      channels = wav.readUInt16LE(payload + 2);
      sampleRate = wav.readUInt32LE(payload + 4);
      bitsPerSample = wav.readUInt16LE(payload + 14);
      assert.equal(format, 1, 'Expected uncompressed PCM audio');
    }
    if (id === 'data') {
      assert.equal(channels, 1, 'Expected mono TTS audio');
      assert.equal(sampleRate, 16_000, 'Expected 16 kHz TTS audio');
      assert.equal(bitsPerSample, 16, 'Expected 16-bit TTS audio');
      const pcm = wav.subarray(payload, payload + size);
      assert.ok(pcm.length > 0, 'TTS audio is empty');
      return pcm;
    }
    offset = payload + size + (size % 2);
  }
  throw new Error('WAV audio data chunk was not found.');
}

function listenForMessages(socket: WebSocket): {
  messages: WireMessage[];
  waitFor: (predicate: (message: WireMessage) => boolean, label: string, timeoutMs?: number) => Promise<WireMessage>;
} {
  const messages: WireMessage[] = [];
  const waiters = new Set<{
    predicate: (message: WireMessage) => boolean;
    resolve: (message: WireMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  socket.on('message', (raw: RawData) => {
    let message: WireMessage;
    try {
      const parsed: unknown = JSON.parse(raw.toString());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      message = parsed as WireMessage;
    } catch { return; }
    messages.push(message);
    const isError = message.type === 'error' || message.type === 'transcript_save_error';
    for (const waiter of [...waiters]) {
      if (isError) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.reject(new Error(String(message.message ?? 'Realtime service returned an error.')));
      } else if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  });
  socket.on('error', (error) => {
    for (const waiter of [...waiters]) {
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.reject(new Error(`Browser WebSocket failed: ${error.message}`));
    }
  });

  return {
    messages,
    waitFor(predicate, label, timeoutMs = LIVE_TIMEOUT_MS) {
      const existing = messages.find((message) => predicate(message));
      if (existing) return Promise.resolve(existing);
      const existingError = messages.find((message) => message.type === 'error' || message.type === 'transcript_save_error');
      if (existingError) return Promise.reject(new Error(String(existingError.message ?? 'Realtime service returned an error.')));
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`Timed out waiting for ${label}.`));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
  };
}

function wavFile(voice: string, directory: string): { pcm: Buffer; wavPath: string; aiffPath: string } {
  const aiffPath = path.join(directory, 'synthetic-interview.aiff');
  const wavPath = path.join(directory, 'synthetic-interview-16k-mono.wav');
  execFileSync('say', ['-v', voice, '-o', aiffPath, TTS_TEXT], { stdio: 'ignore' });
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiffPath, wavPath], { stdio: 'ignore' });
  const pcm = getWavPcm(readFileSync(wavPath));
  return { pcm, wavPath, aiffPath };
}

function cleanError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value
    .replace(/\b(?:ark|sk)-[A-Za-z0-9_-]{16,}\b/gi, '[redacted]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
}

async function main(): Promise<void> {
  const voice = process.env.E2E_TTS_VOICE?.trim() || 'Tingting';
  const report: E2eReport = {
    status: 'FAIL',
    level: 'A',
    startedAt: new Date().toISOString(),
    audio: { source: 'macOS say synthesized Chinese speech', voice, format: 'pcm_s16le, 16000 Hz, mono', bytes: 0, speechBytes: 0, silenceTailMs: 2_000, frameBytes: 640, frameCount: 0, keepaliveFrames: 0 },
    realtimeProvider: 'doubao',
    realtimeModel: 'Seeduplex 1.0 (1.2.6.1)',
    storyId: seedIds.firstProject,
    databasePath: '',
    manualCloseoutPostSent: false,
  };

  if (!process.env.VOLCENGINE_API_KEY?.trim()) throw new Error('VOLCENGINE_API_KEY is not configured in the current environment.');
  if (!process.env.CLOSEOUT_API_KEY?.trim()) throw new Error('CLOSEOUT_API_KEY is not configured in the current environment.');

  mkdirSync(RUN_ROOT, { recursive: true });
  const runDirectory = mkdtempSync(path.join(RUN_ROOT, `${new Date().toISOString().replace(/[:.]/g, '-')}-`));
  report.databasePath = path.join(runDirectory, 'memoir.db');
  const generated = wavFile(voice, runDirectory);
  const silenceTail = Buffer.alloc(16_000 * 2 * report.audio.silenceTailMs / 1_000);
  report.audio.speechBytes = generated.pcm.length;
  report.audio.bytes = generated.pcm.length + silenceTail.length;
  report.audio.frameCount = Math.ceil(generated.pcm.length / report.audio.frameBytes)
    + silenceTail.length / report.audio.frameBytes;

  const database = createDatabase(report.databasePath);
  try {
    runMigrations(database);
    seedDatabase(database);
  } finally {
    database.close();
  }

  const server = createInterviewServiceServer({
    host: '127.0.0.1',
    port: 0,
    databasePath: report.databasePath,
    region: 'cn-beijing',
    model: process.env.DASHSCOPE_MODEL?.trim() || 'qwen-audio-3.0-realtime-plus',
    doubaoApiKey: process.env.VOLCENGINE_API_KEY.trim(),
    closeoutApiKey: process.env.CLOSEOUT_API_KEY.trim(),
    closeoutBaseUrl: process.env.CLOSEOUT_BASE_URL?.trim() || 'https://ark.cn-beijing.volces.com/api/plan/v3',
    closeoutApiFormat: (process.env.CLOSEOUT_API_FORMAT?.trim() as 'chat-completions' | 'chat-json-schema' | 'responses' | undefined) || 'chat-completions',
    closeoutModel: process.env.CLOSEOUT_MODEL?.trim() || 'deepseek-v4-flash',
    closeoutTimeoutMs: 180_000,
    wrapUpMs: 9 * 60_000,
    maxSessionMs: 10 * 60_000,
    closeGraceMs: 45_000,
  });
  let socket: WebSocket | undefined;
  let baseUrl = '';
  let reportError: Error | undefined;
  let getWireEventTypes: (() => string[]) | undefined;

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;

    const healthResponse = await fetch(`${baseUrl}/api/health`, { cache: 'no-store' });
    assert.equal(healthResponse.status, 200, 'isolated service health should be available');
    const health = await healthResponse.json() as Record<string, unknown>;
    assert.equal(health.databaseAvailable, true);
    assert.equal(((health.providers as Record<string, Record<string, unknown>>).doubao).configured, true);
    assert.equal(((health.closeout as Record<string, unknown>).configured), true);
    assert.equal(JSON.stringify(health).includes(process.env.VOLCENGINE_API_KEY), false, 'health response must not disclose the Realtime key');
    assert.equal(JSON.stringify(health).includes(process.env.CLOSEOUT_API_KEY), false, 'health response must not disclose the Closeout key');

    socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/api/realtime`);
    await once(socket, 'open');
    const channel = listenForMessages(socket);
    getWireEventTypes = () => [...new Set(channel.messages.map((message) => String(message.type ?? 'unknown')))];
    socket.send(JSON.stringify({ type: 'start', story_id: report.storyId, provider: 'doubao' }));
    const ready = await channel.waitFor((message) => message.type === 'ready', 'Realtime ready event');
    report.sessionId = String(ready.sessionId);
    report.resultUrl = `${baseUrl}/interview/result?session_id=${encodeURIComponent(report.sessionId)}`;

    const firstResponseDone = await channel.waitFor((message) => message.type === 'response_done'
      && message.status === 'completed', 'Realtime synthesized opening audio');

    for (const audioSegment of [generated.pcm, silenceTail]) {
      for (let offset = 0; offset < audioSegment.length; offset += report.audio.frameBytes) {
        socket.send(audioSegment.subarray(offset, Math.min(offset + report.audio.frameBytes, audioSegment.length)), { binary: true });
        await sleep(20);
      }
    }

    const silenceFrame = Buffer.alloc(report.audio.frameBytes);
    const keepalive = setInterval(() => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(silenceFrame, { binary: true });
      report.audio.keepaliveFrames += 1;
      report.audio.frameCount += 1;
      report.audio.bytes += silenceFrame.length;
    }, 20);
    try {
      const userFinal = await channel.waitFor((message) => message.type === 'user_final', 'ASR final transcript', 60_000);
      assert.match(String(userFinal.text), /(项目|杭州|上线)/, 'provider ASR should recognize the synthetic spoken story');
      const providerMessageId = String(userFinal.itemId);
      await channel.waitFor((message) => message.type === 'transcript_saved'
        && message.role === 'user' && message.providerMessageId === providerMessageId, 'saved final user Transcript');
      const assistantFinal = await channel.waitFor((message) => message.type === 'assistant_final'
        && typeof message.responseId === 'string' && message.responseId !== firstResponseDone.responseId, 'Realtime assistant follow-up', 30_000);
      assert.ok(String(assistantFinal.text).trim().length > 0);
      clearInterval(keepalive);
      await channel.waitFor((message) => message.type === 'transcript_saved'
        && message.role === 'assistant' && message.providerMessageId === assistantFinal.itemId, 'saved final assistant Transcript');
    } finally {
      clearInterval(keepalive);
    }
    report.wireEventTypes = getWireEventTypes();

    socket.send(JSON.stringify({ type: 'end', reason: 'user' }));
    const ended = await channel.waitFor((message) => message.type === 'ended', 'normal WebSocket end event');
    assert.equal(ended.sessionId, report.sessionId);
    report.realtimeEnd = {
      drainTimedOut: ended.drainTimedOut === true,
      pendingWriteCount: Number(ended.pendingWriteCount ?? -1),
      transcriptCount: Number(ended.transcriptCount ?? -1),
      savedTranscriptCount: Number(ended.savedTranscriptCount ?? -1),
      transcriptSaveErrorCount: Array.isArray(ended.transcriptSaveErrors) ? ended.transcriptSaveErrors.length : -1,
    };
    assert.equal(ended.drainTimedOut, false);
    assert.equal(ended.pendingWriteCount, 0);
    assert.deepEqual(ended.transcriptSaveErrors, []);
    assert.equal(ended.transcriptCount, ended.savedTranscriptCount);

    const closeoutDeadline = Date.now() + CLOSEOUT_TIMEOUT_MS;
    let result: Record<string, unknown> | undefined;
    let sawProcessing = false;
    while (Date.now() < closeoutDeadline) {
      const resultResponse: Response = await fetch(`${baseUrl}/api/interview-sessions/${encodeURIComponent(report.sessionId)}/result`, {
        method: 'GET', cache: 'no-store', headers: { accept: 'application/json' },
      });
      assert.equal(resultResponse.status, 200, 'result polling must use the GET result endpoint');
      result = await resultResponse.json() as Record<string, unknown>;
      if (result.closeoutStatus === 'processing') sawProcessing = true;
      if (result.closeoutStatus === 'completed' || result.closeoutStatus === 'failed') break;
      await sleep(1_000);
    }
    assert.ok(result, 'result API should return a response');
    assert.equal(result.closeoutStatus, 'completed', `automatic Closeout should complete without POST: ${JSON.stringify(result)}`);
    const sessionView = result.session as Record<string, unknown>;
    const storyView = result.story as Record<string, unknown>;
    const transcript = parseTranscript(JSON.stringify(result.transcript));
    assert.equal(sessionView.status, 'completed');
    assert.equal(sessionView.closeout_status, 'completed');
    assert.equal(typeof storyView.summary, 'string');
    assert.ok(String(storyView.summary).trim().length > 0);
    assert.equal(transcript.length, ended.transcriptCount);
    assert.equal(new Set(transcript.map((message) => message.message_id)).size, transcript.length, 'message IDs must be unique');
    assert.ok(transcript.some((message) => message.role === 'user' && message.provider === 'doubao'));
    assert.ok(transcript.some((message) => message.role === 'assistant' && message.provider === 'doubao'));
    assert.ok(transcript.every((message) => message.provider_message_id), 'provider final messages should retain provider IDs');

    assert.equal('closeoutResult' in result, false, 'the public DTO must not expose persisted Closeout JSON');
    const modelMetadata = result.modelMetadata as Record<string, unknown> | null;
    assert.ok(modelMetadata, 'result DTO should expose safe model metadata');
    assert.equal(modelMetadata.provider, 'volcengine-agent-plan');
    assert.ok(typeof modelMetadata.model === 'string' && modelMetadata.model.length > 0);
    report.closeoutProvider = String(modelMetadata.provider);
    report.closeoutModel = String(modelMetadata.model);
    const userMessageIds = new Set(transcript.filter((message) => message.role === 'user').map((message) => message.message_id));
    const sourceMessageIds = result.currentStorySourceMessageIds as string[];
    assert.ok(sourceMessageIds.length > 0, 'updated current-story summary should cite a current user message');
    assert.ok(sourceMessageIds.every((messageId) => userMessageIds.has(messageId)), 'summary sources must be current-session user messages only');

    const newStories = result.newStories as Array<Record<string, unknown>>;
    const createdNewStoryIds = newStories.map((story) => String(story.story_id));
    assert.ok(newStories.every((story) => story.status === 'pending'), 'new Stories must await user confirmation');
    for (const newStory of newStories) {
      assert.ok((newStory.source_message_ids as string[]).every((messageId) => userMessageIds.has(messageId)));
    }

    const verify = createDatabase(report.databasePath);
    try {
      const session = verify.db.select().from(interviewSessions).where(eq(interviewSessions.sessionId, report.sessionId)).get();
      const updatedStory = verify.db.select().from(stories).where(eq(stories.storyId, report.storyId)).get();
      assert.equal(session?.status, 'completed');
      assert.equal(session?.closeoutStatus, 'completed');
      assert.equal(session?.endedAt !== null, true);
      const persistedCloseout = parseJsonColumn(session?.closeoutResultJson, closeoutResultSchema);
      assert.ok(persistedCloseout?.model_metadata, 'real Closeout model metadata should be persisted');
      assert.deepEqual(persistedCloseout.model_metadata, modelMetadata);
      assert.deepEqual(persistedCloseout.current_story_source_message_ids, sourceMessageIds);
      assert.equal(updatedStory?.summary, storyView.summary);
      const persistedStories = verify.db.select().from(stories).where(eq(stories.createdSourceSessionId, report.sessionId)).all();
      assert.equal(persistedStories.length, newStories.length);
      assert.deepEqual(new Set(persistedStories.map((story) => story.storyId)), new Set(createdNewStoryIds));
    } finally {
      verify.close();
    }

    const htmlResponse = await fetch(report.resultUrl, { cache: 'no-store' });
    assert.equal(htmlResponse.status, 200, 'result page route should load for this same Session');
    const html = await htmlResponse.text();
    assert.match(html, /访谈结果/);
    assert.match(html, /本次新建的故事/);

    report.status = 'PASS';
    report.endedAt = new Date().toISOString();
    report.realtimeProvider = 'doubao';
    report.realtimeModel = String((health.providers as Record<string, Record<string, unknown>>).doubao.model);
    report.closeoutStatus = String(result.closeoutStatus);
    report.sessionStatus = String(sessionView.status);
    report.transcriptCount = transcript.length;
    report.userFinalCount = transcript.filter((message) => message.role === 'user').length;
    report.assistantFinalCount = transcript.filter((message) => message.role === 'assistant').length;
    report.savedTranscriptCount = Number(ended.savedTranscriptCount);
    report.sourceMessageIds = sourceMessageIds;
    report.newStoryCount = newStories.length;
    report.createdNewStoryIds = createdNewStoryIds;
    report.wireEventTypes = getWireEventTypes();
    writeFileSync(path.join(runDirectory, 'e2e-report.json'), `${JSON.stringify({ ...report, sawProcessing }, null, 2)}\n`, 'utf8');
  } catch (error) {
    reportError = error instanceof Error ? error : new Error(String(error));
    report.failure = cleanError(reportError);
    report.endedAt = new Date().toISOString();
    report.wireEventTypes = getWireEventTypes?.();
    try { writeFileSync(path.join(runDirectory, 'e2e-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8'); } catch { /* Preserve the original failure. */ }
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close(1000, 'acceptance finished');
      try { await once(socket, 'close'); } catch { /* Socket may already be closed. */ }
    }
  }

  console.log(JSON.stringify(report, null, 2));
  if (reportError) {
    if (process.argv.includes('--hold')) {
      console.log(`Failure artifacts preserved in ${path.dirname(report.databasePath)}; the isolated server remains open for inspection.`);
      console.log('Press Enter to stop the isolated test server.');
      await once(process.stdin, 'data');
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exitCode = 1;
    return;
  }

  if (process.argv.includes('--hold')) {
    console.log(`Result page is open at ${report.resultUrl}`);
    console.log('Press Enter to stop the isolated test server; the audit database and report are preserved.');
    await once(process.stdin, 'data');
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log(`Audit files preserved in ${path.dirname(report.databasePath)}`);
}

main().catch((error: unknown) => {
  console.error(`VOICE_E2E_FAILED: ${cleanError(error)}`);
  process.exitCode = 1;
});
