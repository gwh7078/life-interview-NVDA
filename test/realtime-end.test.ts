import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { after, test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { interviewSessions } from '../src/db/schema.js';
import { parseTranscript } from '../src/db/transcript.js';
import { parseQwenServerEvent } from '../src/realtime/qwen.js';
import type { NormalizedRealtimeEvent } from '../src/realtime/types.js';
import { createInterviewServiceServer } from '../src/server.js';

const testTempRoot = path.resolve('data/test-tmp');
const temporaryDirectories: string[] = [];
mkdirSync(testTempRoot, { recursive: true });

after(() => temporaryDirectories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function normalizeMockRealtime(raw: unknown): NormalizedRealtimeEvent[] {
  const event = parseQwenServerEvent(raw);
  if (!event) return [];
  const type = String(event.type ?? '');
  if (type === 'session.updated') {
    const session = event.session && typeof event.session === 'object' && !Array.isArray(event.session)
      ? event.session as Record<string, unknown>
      : undefined;
    return [{ type: 'session.ready', ...(typeof session?.id === 'string' ? { providerSessionId: session.id } : {}) }];
  }
  if (type === 'input_audio_buffer.speech_started') {
    return [{ type: 'speech.started' }];
  }
  if (type === 'input_audio_buffer.speech_stopped') {
    return [{ type: 'speech.stopped', source: 'speech_stopped' }];
  }
  if (type === 'conversation.item.input_audio_transcription.delta') {
    return [{
      type: 'user.transcript.delta',
      text: typeof event.delta === 'string' ? event.delta : typeof event.text === 'string' ? event.text : '',
      ...(typeof event.item_id === 'string' ? { itemId: event.item_id } : {}),
    }];
  }
  if (type === 'conversation.item.input_audio_transcription.completed') {
    return [{
      type: 'user.transcript.final',
      text: typeof event.transcript === 'string' ? event.transcript : '',
      ...(typeof event.item_id === 'string' ? { itemId: event.item_id } : {}),
    }];
  }
  if (type === 'response.created') {
    const response = event.response && typeof event.response === 'object' && !Array.isArray(event.response)
      ? event.response as Record<string, unknown>
      : undefined;
    return [{ type: 'assistant.started', responseId: typeof response?.id === 'string' ? response.id : 'response' }];
  }
  if (type === 'response.audio_transcript.delta') {
    return [{
      type: 'assistant.transcript.delta',
      responseId: typeof event.response_id === 'string' ? event.response_id : 'response',
      delta: typeof event.delta === 'string' ? event.delta : '',
    }];
  }
  if (type === 'response.done') {
    const response = event.response && typeof event.response === 'object' && !Array.isArray(event.response)
      ? event.response as Record<string, unknown>
      : undefined;
    return [{
      type: 'response.done',
      responseId: typeof response?.id === 'string' ? response.id : 'response',
      status: typeof response?.status === 'string' ? response.status : 'completed',
    }];
  }
  return [];
}

function collectMessages(socket: WebSocket) {
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  socket.on('message', (raw: WebSocket.RawData) => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw.toString()) as Record<string, unknown>; }
    catch { return; }
    messages.push(message);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]!;
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(index, 1);
      waiter.resolve(message);
    }
  });

  return {
    messages,
    waitFor(predicate: (message: Record<string, unknown>) => boolean, timeoutMs = 5_000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index >= 0) waiters.splice(index, 1);
          const receivedTypes = messages.map((message) => String(message.type ?? 'unknown')).join(', ');
          reject(new Error(`Timed out waiting for a Realtime end-protocol message; received: ${receivedTypes || 'none'}.`));
        }, timeoutMs);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
  };
}

test('manual end preserves a late user transcript and ignores the provider follow-up', async () => {
  const directory = mkdtempSync(path.join(testTempRoot, `rensheng-realtime-end-${randomUUID()}-`));
  temporaryDirectories.push(directory);
  const diagnosticsDirectory = path.join(directory, 'diagnostics');
  const previousDiagnosticsDir = process.env.DIAGNOSTICS_DIR;
  process.env.DIAGNOSTICS_DIR = diagnosticsDirectory;
  const databasePath = path.join(directory, 'session.db');
  const database = createDatabase(databasePath);
  try {
    runMigrations(database);
    seedDatabase(database);
  } finally { database.close(); }

  const providerHttp = createServer();
  const providerServer = new WebSocketServer({ server: providerHttp });
  let providerSocket: WebSocket | undefined;
  let transcriptionSent = false;
  let automaticResponseLeftOpen = false;
  const userText = '这段回答在我点结束后才完成识别。';
  providerHttp.listen(0, '127.0.0.1');
  await once(providerHttp, 'listening');
  const providerAddress = providerHttp.address();
  assert.ok(providerAddress && typeof providerAddress === 'object');
  const providerUrl = `ws://127.0.0.1:${providerAddress.port}`;

  providerServer.on('connection', (socket) => {
    providerSocket = socket;
    socket.on('message', (raw) => {
      const message = parseQwenServerEvent(raw);
      if (!message) return;
      if (message.type === 'mock.setup') {
        socket.send(JSON.stringify({ type: 'session.updated', session: { id: 'mock-end-session' } }));
      }
      if (message.type === 'mock.silence' && !transcriptionSent) {
        transcriptionSent = true;
        setTimeout(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          socket.send(JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: 'mock-late-user-message',
            transcript: userText,
          }));
          socket.send(JSON.stringify({ type: 'response.created', response: { id: 'mock-post-end-response' } }));
          automaticResponseLeftOpen = true;
          socket.send(JSON.stringify({
            type: 'response.audio_transcript.delta',
            response_id: 'mock-post-end-response',
            delta: '不应继续提出的追问',
          }));
        }, 40);
      }
    });
  });

  const appServer = createInterviewServiceServer({
    host: '127.0.0.1',
    port: 0,
    databasePath,
    region: 'cn-beijing',
    model: 'mock-realtime-model',
    apiKey: 'mock-realtime-key',
    workspaceId: 'mock-workspace',
    developmentAuthEnabled: true,
    wrapUpMs: 100_000,
    maxSessionMs: 200_000,
    closeGraceMs: 5_000,
  }, {
    realtimeProviderFactory: (id) => ({
      id,
      capabilities: { fullDuplex: true, supportsInterrupt: true, supportsExplicitTurnRequest: true, supportsPlaybackAck: false, supportsExplicitSessionClose: false },
      audio: { input: { encoding: 'pcm_s16le', sampleRate: 16_000, frameBytes: 640 }, output: { encoding: 'pcm_s16le', sampleRate: 24_000 } },
      connectOptions: () => ({ url: providerUrl, headers: {} }),
      setupSession: () => [{ type: 'mock.setup' }],
      normalizeServerMessage: normalizeMockRealtime,
      appendAudioMessages: (audio) => [{ type: 'mock.audio', bytes: audio.byteLength }],
      requestAssistantTurnMessages: () => [{ type: 'mock.noop' }],
      stopInputAfterCurrentTurn: () => [],
      beginInputShutdown: () => Array.from({ length: 40 }, () => ({
        message: { type: 'mock.silence' },
        delayAfterMs: 20,
      })),
      closePlan: () => null,
      connectionFailureMessage: () => 'mock realtime failure',
      handleControlEvent: () => [],
      initialResponsePlan: () => ({ steps: [{ message: { type: 'mock.noop' } }] }),
    }),
  });
  appServer.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  const appAddress = appServer.address();
  assert.ok(appAddress && typeof appAddress === 'object');
  const baseUrl = `http://127.0.0.1:${appAddress.port}`;
  let clientSocket: WebSocket | undefined;

  try {
    const lifecycleModule = await fetch(`${baseUrl}/interview-state.js`);
    assert.equal(lifecycleModule.status, 200);
    assert.match(lifecycleModule.headers.get('content-type') ?? '', /text\/javascript/);

    const login = await fetch(`${baseUrl}/api/auth/development/legacy-session`, { method: 'POST' });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);

    clientSocket = new WebSocket(`ws://127.0.0.1:${appAddress.port}/api/realtime`, { headers: { cookie } });
    await once(clientSocket, 'open');
    const clientMessages = collectMessages(clientSocket);
    clientSocket.send(JSON.stringify({
      type: 'start',
      stage_id: seedIds.work,
      story_title: '迟到转写的测试经历',
      provider: 'qwen',
    }));
    const ready = await clientMessages.waitFor((message) => message.type === 'ready');
    assert.ok(ready.sessionId);
    clientSocket.send(JSON.stringify({ type: 'playback_ready' }));
    assert.ok(providerSocket);
    clientSocket.send(JSON.stringify({
      type: 'diagnostic_trace',
      event: 'output_audio_node_ended',
      clientElapsedMs: 321.5,
      details: {
        responseId: 'mock-trace-response',
        chunk: 2,
        contextTimeMs: 2456.75,
        scheduledContextTimeMs: 2000.25,
        contextElapsedSinceScheduledStartMs: 456.5,
        nodeLifetimeMs: 600.5,
        contextState: 'running',
        pendingNodes: 0,
        transcript: 'TRACE_TRANSCRIPT_PAYLOAD_MUST_NOT_APPEAR',
        audio: 'TRACE_AUDIO_PAYLOAD_MUST_NOT_APPEAR',
      },
    }));

    providerSocket.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    await clientMessages.waitFor((message) => message.type === 'speech_started');
    providerSocket.send(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
    await clientMessages.waitFor((message) => message.type === 'speech_stopped');
    clientSocket.send(JSON.stringify({ type: 'end', reason: 'user' }));

    const ended = await clientMessages.waitFor((message) => message.type === 'ended', 5_000);
    assert.equal(ended.drainTimedOut, false);
    assert.equal(ended.transcriptCount, 1);
    const traceText = readFileSync(
      path.join(diagnosticsDirectory, 'traces', 'realtime', `${String(ready.sessionId)}.jsonl`),
      'utf8',
    );
    const traceRows = traceText.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const turnMilestones = traceRows.filter((row) => typeof row.tracePoint === 'string');
    assert.deepEqual(turnMilestones.map((row) => row.tracePoint), ['A', 'B']);
    assert.equal(turnMilestones[0]?.stage, 'speech_stopped');
    assert.equal(turnMilestones[1]?.stage, 'user_final');
    assert.equal(typeof turnMilestones[1]?.speechStoppedToUserFinalMs, 'number');
    const audioEndedTrace = traceRows.find((row) => row.event === 'client.output_audio_node_ended');
    assert.ok(audioEndedTrace, 'allowlisted client audio-ended trace should be persisted');
    assert.equal(audioEndedTrace.contextTimeMs, 2456.75);
    assert.equal(audioEndedTrace.scheduledContextTimeMs, 2000.25);
    assert.equal(audioEndedTrace.contextElapsedSinceScheduledStartMs, 456.5);
    assert.equal(audioEndedTrace.nodeLifetimeMs, 600.5);
    assert.equal(audioEndedTrace.pendingNodes, 0);
    assert.equal('transcript' in audioEndedTrace, false);
    assert.equal('audio' in audioEndedTrace, false);
    assert.equal(traceText.includes('TRACE_TRANSCRIPT_PAYLOAD_MUST_NOT_APPEAR'), false);
    assert.equal(traceText.includes('TRACE_AUDIO_PAYLOAD_MUST_NOT_APPEAR'), false);
    assert.equal(automaticResponseLeftOpen, true, 'test must end while the provider follow-up is still in flight');
    assert.ok(clientMessages.messages.some((message) => message.type === 'user_final' && message.text === userText));
    assert.ok(clientMessages.messages.some((message) => message.type === 'transcript_saved' && message.role === 'user'));
    assert.equal(clientMessages.messages.some((message) => [
      'assistant_started',
      'assistant_partial',
      'assistant_audio',
      'assistant_final',
    ].includes(String(message.type))), false);

    const verify = createDatabase(databasePath);
    try {
      const session = verify.db.select().from(interviewSessions)
        .where(eq(interviewSessions.sessionId, String(ready.sessionId))).get();
      const transcript = parseTranscript(session?.transcriptJson);
      assert.deepEqual(transcript.map(({ role, text }) => ({ role, text })), [{ role: 'user', text: userText }]);
    } finally { verify.close(); }
  } finally {
    if (clientSocket?.readyState === WebSocket.OPEN) clientSocket.close();
    if (providerSocket?.readyState === WebSocket.OPEN) providerSocket.close();
    const closedApp = once(appServer, 'close');
    appServer.close();
    appServer.closeAllConnections();
    await closedApp;
    providerServer.close();
    const closedProvider = once(providerHttp, 'close');
    providerHttp.close();
    await closedProvider;
    if (previousDiagnosticsDir === undefined) delete process.env.DIAGNOSTICS_DIR;
    else process.env.DIAGNOSTICS_DIR = previousDiagnosticsDir;
  }
});

test('opening response watchdog retries once then ends explicitly when provider never creates a response', async () => {
  const directory = mkdtempSync(path.join(testTempRoot, `rensheng-opening-watchdog-${randomUUID()}-`)); temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'session.db'); const database = createDatabase(databasePath);
  try { runMigrations(database); seedDatabase(database); } finally { database.close(); }
  const providerHttp = createServer(); const providerServer = new WebSocketServer({ server: providerHttp }); let openingRequests = 0;
  providerHttp.listen(0, '127.0.0.1'); await once(providerHttp, 'listening'); const providerAddress = providerHttp.address(); assert.ok(providerAddress && typeof providerAddress === 'object');
  const providerUrl = `ws://127.0.0.1:${providerAddress.port}`;
  providerServer.on('connection', (socket) => socket.on('message', (raw) => { const message = parseQwenServerEvent(raw); if (!message) return; if (message.type === 'mock.setup') socket.send(JSON.stringify({ type: 'session.updated', session: { id: 'mock-opening-watchdog' } })); if (message.type === 'mock.opening') openingRequests += 1; }));
  const appServer = createInterviewServiceServer({ host:'127.0.0.1',port:0,databasePath,region:'cn-beijing',model:'mock-realtime-model',apiKey:'mock-realtime-key',workspaceId:'mock-workspace',developmentAuthEnabled:true,openingResponseTimeoutMs:30,wrapUpMs:100_000,maxSessionMs:200_000,closeGraceMs:5_000 }, { realtimeProviderFactory:(id)=>({ id,capabilities:{fullDuplex:true,supportsInterrupt:true,supportsExplicitTurnRequest:true,supportsPlaybackAck:false,supportsExplicitSessionClose:false},audio:{input:{encoding:'pcm_s16le',sampleRate:16_000,frameBytes:640},output:{encoding:'pcm_s16le',sampleRate:24_000}},connectOptions:()=>({url:providerUrl,headers:{}}),setupSession:()=>[{type:'mock.setup'}],normalizeServerMessage:normalizeMockRealtime,appendAudioMessages:(audio)=>[{type:'mock.audio',bytes:audio.byteLength}],requestAssistantTurnMessages:()=>[{type:'mock.noop'}],stopInputAfterCurrentTurn:()=>[],beginInputShutdown:()=>[],closePlan:()=>null,connectionFailureMessage:()=> 'mock realtime failure',handleControlEvent:()=>[],initialResponsePlan:()=>({steps:[{message:{type:'mock.opening'}}]}) }) });
  appServer.listen(0,'127.0.0.1'); await once(appServer,'listening'); const appAddress=appServer.address(); assert.ok(appAddress && typeof appAddress==='object'); const baseUrl=`http://127.0.0.1:${appAddress.port}`; let clientSocket:WebSocket|undefined;
  try {
    const login=await fetch(`${baseUrl}/api/auth/development/legacy-session`,{method:'POST'}); const cookie=login.headers.get('set-cookie')?.split(';',1)[0]; assert.ok(cookie);
    clientSocket=new WebSocket(`ws://127.0.0.1:${appAddress.port}/api/realtime`,{headers:{cookie}}); await once(clientSocket,'open'); const messages=collectMessages(clientSocket);
    clientSocket.send(JSON.stringify({type:'start',stage_id:seedIds.work,story_title:'开场 watchdog 测试',provider:'qwen'})); await messages.waitFor((m)=>m.type==='ready'); clientSocket.send(JSON.stringify({type:'playback_ready'}));
    const failure=await messages.waitFor((m)=>m.type==='error' && /首轮回应/u.test(String(m.message??'')),2_000); assert.match(String(failure.message),/重新开始采访/); await messages.waitFor((m)=>m.type==='ended',2_000); assert.equal(openingRequests,2);
  } finally { if(clientSocket?.readyState===WebSocket.OPEN)clientSocket.close(); const ca=once(appServer,'close'); appServer.close(); appServer.closeAllConnections(); await ca; providerServer.close(); const cp=once(providerHttp,'close'); providerHttp.close(); await cp; }
});


test('opening waits for playback readiness whether it arrives before or after the provider session', async () => {
  const directory = mkdtempSync(path.join(testTempRoot, `rensheng-playback-ready-${randomUUID()}-`));
  temporaryDirectories.push(directory);
  const diagnosticsDirectory = path.join(directory, 'diagnostics');
  const previousDiagnosticsDir = process.env.DIAGNOSTICS_DIR;
  process.env.DIAGNOSTICS_DIR = diagnosticsDirectory;
  const databasePath = path.join(directory, 'session.db');
  const database = createDatabase(databasePath);
  try { runMigrations(database); seedDatabase(database); } finally { database.close(); }

  const providerHttp = createServer();
  const providerServer = new WebSocketServer({ server: providerHttp });
  let providerConnections = 0;
  let openingRequests = 0;
  providerHttp.listen(0, '127.0.0.1');
  await once(providerHttp, 'listening');
  const providerAddress = providerHttp.address();
  assert.ok(providerAddress && typeof providerAddress === 'object');
  const providerUrl = `ws://127.0.0.1:${providerAddress.port}`;
  providerServer.on('connection', (socket) => {
    const connectionNumber = ++providerConnections;
    socket.on('message', (raw) => {
      const message = parseQwenServerEvent(raw);
      if (!message) return;
      if (message.type === 'mock.setup') {
        setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'session.updated', session: { id: `mock-playback-${connectionNumber}` } }));
          }
        }, connectionNumber === 2 ? 60 : 0);
      } else if (message.type === 'mock.opening') {
        openingRequests += 1;
        socket.send(JSON.stringify({ type: 'response.created', response: { id: `mock-opening-${connectionNumber}` } }));
        socket.send(JSON.stringify({ type: 'response.done', response: { id: `mock-opening-${connectionNumber}`, status: 'completed' } }));
      }
    });
  });

  const appServer = createInterviewServiceServer({
    host: '127.0.0.1', port: 0, databasePath, region: 'cn-beijing', model: 'mock-realtime-model',
    apiKey: 'mock-realtime-key', workspaceId: 'mock-workspace', developmentAuthEnabled: true,
    openingResponseTimeoutMs: 1_000, wrapUpMs: 100_000, maxSessionMs: 200_000, closeGraceMs: 5_000,
  }, {
    realtimeProviderFactory: (id) => ({
      id,
      capabilities: { fullDuplex: true, supportsInterrupt: true, supportsExplicitTurnRequest: true, supportsPlaybackAck: false, supportsExplicitSessionClose: false },
      audio: { input: { encoding: 'pcm_s16le', sampleRate: 16_000, frameBytes: 640 }, output: { encoding: 'pcm_s16le', sampleRate: 24_000 } },
      connectOptions: () => ({ url: providerUrl, headers: {} }),
      setupSession: () => [{ type: 'mock.setup' }],
      normalizeServerMessage: normalizeMockRealtime,
      appendAudioMessages: (audio) => [{ type: 'mock.audio', bytes: audio.byteLength }],
      requestAssistantTurnMessages: () => [{ type: 'mock.noop' }],
      stopInputAfterCurrentTurn: () => [],
      beginInputShutdown: () => [],
      closePlan: () => null,
      connectionFailureMessage: () => 'mock realtime failure',
      handleControlEvent: () => [],
      initialResponsePlan: () => ({ steps: [{ message: { type: 'mock.opening' } }] }),
    }),
  });
  appServer.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  const appAddress = appServer.address();
  assert.ok(appAddress && typeof appAddress === 'object');
  const baseUrl = `http://127.0.0.1:${appAddress.port}`;
  const clients: WebSocket[] = [];

  const waitForOpenings = async (expected: number) => {
    const deadline = Date.now() + 2_000;
    while (openingRequests < expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(openingRequests, expected);
  };

  try {
    const login = await fetch(`${baseUrl}/api/auth/development/legacy-session`, { method: 'POST' });
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);

    const lateReady = new WebSocket(`ws://127.0.0.1:${appAddress.port}/api/realtime`, { headers: { cookie } });
    clients.push(lateReady);
    await once(lateReady, 'open');
    const lateMessages = collectMessages(lateReady);
    lateReady.send(JSON.stringify({ type: 'start', stage_id: seedIds.work, provider: 'qwen' }));
    await lateMessages.waitFor((message) => message.type === 'ready');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(openingRequests, 0, 'provider readiness alone must not open the first response');
    lateReady.send(JSON.stringify({ type: 'playback_ready' }));
    await waitForOpenings(1);
    lateReady.close();
    await once(lateReady, 'close');

    const earlyReady = new WebSocket(`ws://127.0.0.1:${appAddress.port}/api/realtime`, { headers: { cookie } });
    clients.push(earlyReady);
    await once(earlyReady, 'open');
    const earlyMessages = collectMessages(earlyReady);
    earlyReady.send(JSON.stringify({ type: 'start', stage_id: seedIds.work, provider: 'qwen' }));
    earlyReady.send(JSON.stringify({ type: 'playback_ready' }));
    await earlyMessages.waitFor((message) => message.type === 'ready');
    await waitForOpenings(2);
  } finally {
    for (const socket of clients) if (socket.readyState === WebSocket.OPEN) socket.close();
    const appClosed = once(appServer, 'close');
    appServer.close();
    appServer.closeAllConnections();
    await appClosed;
    providerServer.close();
    const providerClosed = once(providerHttp, 'close');
    providerHttp.close();
    await providerClosed;
    if (previousDiagnosticsDir === undefined) delete process.env.DIAGNOSTICS_DIR;
    else process.env.DIAGNOSTICS_DIR = previousDiagnosticsDir;
  }
});


test('user turn stall watchdog requests provider recovery after ASR is idle past the configured threshold', async () => {
  const directory = mkdtempSync(path.join(testTempRoot, `rensheng-turn-stall-${randomUUID()}-`));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'session.db');
  const database = createDatabase(databasePath);
  try { runMigrations(database); seedDatabase(database); } finally { database.close(); }

  const providerHttp = createServer();
  const providerServer = new WebSocketServer({ server: providerHttp });
  let recoveryRequests = 0;
  providerHttp.listen(0, '127.0.0.1');
  await once(providerHttp, 'listening');
  const providerAddress = providerHttp.address();
  assert.ok(providerAddress && typeof providerAddress === 'object');
  const providerUrl = `ws://127.0.0.1:${providerAddress.port}`;

  providerServer.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = parseQwenServerEvent(raw);
      if (!message) return;
      if (message.type === 'mock.setup') {
        socket.send(JSON.stringify({ type: 'session.updated', session: { id: 'mock-turn-stall' } }));
        return;
      }
      if (message.type === 'mock.opening') {
        socket.send(JSON.stringify({ type: 'response.created', response: { id: 'mock-opening-response' } }));
        socket.send(JSON.stringify({ type: 'response.done', response: { id: 'mock-opening-response', status: 'completed' } }));
        setTimeout(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          socket.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
          socket.send(JSON.stringify({
            type: 'conversation.item.input_audio_transcription.delta',
            item_id: 'stalled-user-turn',
            delta: '这是一段已经开始识别但迟迟不结束的回答',
          }));
        }, 10);
        return;
      }
      if (message.type === 'mock.commit') {
        recoveryRequests += 1;
        socket.send(JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: 'stalled-user-turn',
          transcript: '这是一段已经开始识别但迟迟不结束的回答',
        }));
        socket.send(JSON.stringify({ type: 'response.created', response: { id: 'mock-after-recovery' } }));
      }
    });
  });

  const appServer = createInterviewServiceServer({
    host: '127.0.0.1',
    port: 0,
    databasePath,
    region: 'cn-beijing',
    model: 'mock-realtime-model',
    apiKey: 'mock-realtime-key',
    workspaceId: 'mock-workspace',
    developmentAuthEnabled: true,
    openingResponseTimeoutMs: 500,
    userTurnStallTimeoutMs: 40,
    wrapUpMs: 100_000,
    maxSessionMs: 200_000,
    closeGraceMs: 5_000,
  }, {
    realtimeProviderFactory: (id) => ({
      id,
      capabilities: { fullDuplex: true, supportsInterrupt: true, supportsExplicitTurnRequest: true, supportsPlaybackAck: false, supportsExplicitSessionClose: false },
      audio: { input: { encoding: 'pcm_s16le', sampleRate: 16_000, frameBytes: 640 }, output: { encoding: 'pcm_s16le', sampleRate: 24_000 } },
      connectOptions: () => ({ url: providerUrl, headers: {} }),
      setupSession: () => [{ type: 'mock.setup' }],
      normalizeServerMessage: normalizeMockRealtime,
      appendAudioMessages: (audio) => [{ type: 'mock.audio', bytes: audio.byteLength }],
      requestAssistantTurnMessages: () => [{ type: 'mock.noop' }],
      recoverStalledUserTurn: () => [{ message: { type: 'mock.commit' } }],
      stopInputAfterCurrentTurn: () => [],
      beginInputShutdown: () => [],
      closePlan: () => null,
      connectionFailureMessage: () => 'mock realtime failure',
      handleControlEvent: () => [],
      initialResponsePlan: () => ({ steps: [{ message: { type: 'mock.opening' } }] }),
    }),
  });
  appServer.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  const appAddress = appServer.address();
  assert.ok(appAddress && typeof appAddress === 'object');
  const baseUrl = `http://127.0.0.1:${appAddress.port}`;
  let clientSocket: WebSocket | undefined;

  try {
    const login = await fetch(`${baseUrl}/api/auth/development/legacy-session`, { method: 'POST' });
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    clientSocket = new WebSocket(`ws://127.0.0.1:${appAddress.port}/api/realtime`, { headers: { cookie } });
    await once(clientSocket, 'open');
    const messages = collectMessages(clientSocket);
    clientSocket.send(JSON.stringify({ type: 'start', stage_id: seedIds.work, story_title: 'User turn stall 测试', provider: 'qwen' }));
    await messages.waitFor((m) => m.type === 'ready');
    clientSocket.send(JSON.stringify({ type: 'playback_ready' }));
    const final = await messages.waitFor((m) => m.type === 'user_final' && m.itemId === 'stalled-user-turn', 2_000);
    assert.match(String(final.text), /迟迟不结束/);
    assert.equal(recoveryRequests, 1);
  } finally {
    if (clientSocket?.readyState === WebSocket.OPEN) clientSocket.close();
    const closedApp = once(appServer, 'close');
    appServer.close();
    appServer.closeAllConnections();
    await closedApp;
    providerServer.close();
    const closedProvider = once(providerHttp, 'close');
    providerHttp.close();
    await closedProvider;
  }
});
