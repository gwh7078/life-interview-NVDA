import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { after, test } from 'node:test';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { ObservationBus } from '../src/observability/observation-bus.js';
import { createObservationContext, createObservationEvent } from '../src/observability/observation-event.js';
import { createInterviewServiceServer } from '../src/server.js';

const temporaryDirectories: string[] = [];
const testTempRoot = path.resolve('data/test-tmp');
mkdirSync(testTempRoot, { recursive: true });

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

test('SSE is authenticated, session-scoped, and disconnecting it leaves service routes available', async () => {
  const directory = mkdtempSync(path.join(testTempRoot, 'observability-server-test-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'memoir.db');
  const database = createDatabase(databasePath);
  try {
    runMigrations(database);
    seedDatabase(database);
  } finally {
    database.close();
  }

  const bus = new ObservationBus();
  const server = createInterviewServiceServer({
    host: '127.0.0.1', port: 0, databasePath,
    apiKey: 'unused', workspaceId: 'test', region: 'cn-beijing', model: 'test', stepfunApiKey: 'unused',
    wrapUpMs: 1_080_000, maxSessionMs: 1_200_000, closeGraceMs: 45_000,
  }, { agentTasks: null, observationBus: bus });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    assert.equal((await fetch(`${baseUrl}/api/observability/events?sessionId=${seedIds.storySession}`)).status, 401);
    const login = await fetch(`${baseUrl}/api/auth/development/legacy-session`, { method: 'POST' });
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    const headers = { cookie };
    assert.equal((await fetch(`${baseUrl}/api/observability/events?sessionId=not-owned`, { headers })).status, 404);
    assert.equal((await fetch(`${baseUrl}/tech-observer.js`)).status, 200);

    const sessionEvent = (sessionId: string, title: string) => createObservationEvent(
      createObservationContext({ sessionId }),
      { category: 'realtime', eventType: 'realtime.listening', status: 'running', component: 'test', title },
    );
    bus.emit(sessionEvent(seedIds.storySession, 'SESSION A EVENT'));
    bus.emit(sessionEvent(seedIds.onboardingSession, 'SESSION B EVENT'));

    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/observability/events?sessionId=${seedIds.storySession}`, {
      headers, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/u);
    const reader = response.body?.getReader();
    assert.ok(reader);
    let chunk = '';
    for (let index = 0; index < 3 && !chunk.includes('SESSION A EVENT'); index += 1) {
      const part = await reader.read();
      if (part.value) chunk += new TextDecoder().decode(part.value);
    }
    assert.match(chunk, /SESSION A EVENT/u);
    assert.doesNotMatch(chunk, /SESSION B EVENT/u);
    await reader.cancel();
    controller.abort();
    bus.dispose();

    const logoutController = new AbortController();
    const logoutStream = await fetch(`${baseUrl}/api/observability/events?sessionId=${seedIds.storySession}`, {
      headers, signal: logoutController.signal,
    });
    assert.equal(logoutStream.status, 200);
    const logoutReader = logoutStream.body?.getReader();
    assert.ok(logoutReader);
    await logoutReader.read();
    const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers });
    assert.equal(logout.status, 200);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      logoutReader.read(),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 1_000); }),
    ]);
    if (timer) clearTimeout(timer);
    assert.equal(closed?.done, true, 'logout closes the active observation stream');
    logoutController.abort();
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('an unavailable observation stream does not prevent a realtime session with observation disabled', async () => {
  const directory = mkdtempSync(path.join(testTempRoot, 'observability-disabled-test-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'memoir.db');
  const previousDiagnosticsDir = process.env.DIAGNOSTICS_DIR;
  process.env.DIAGNOSTICS_DIR = path.join(directory, 'diagnostics');
  const database = createDatabase(databasePath);
  try {
    runMigrations(database);
    seedDatabase(database);
  } finally {
    database.close();
  }

  const providerHttp = createServer();
  const providerServer = new WebSocketServer({ server: providerHttp });
  let providerSocket: WebSocket | undefined;
  providerServer.on('connection', (socket) => {
    providerSocket = socket;
    socket.on('message', (raw) => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
      if (message.type === 'mock.setup') socket.send(JSON.stringify({ type: 'session.updated', session: { id: 'mock-session' } }));
    });
  });
  providerHttp.listen(0, '127.0.0.1');
  await once(providerHttp, 'listening');
  const providerAddress = providerHttp.address();
  assert.ok(providerAddress && typeof providerAddress === 'object');
  const providerUrl = `ws://127.0.0.1:${providerAddress.port}`;

  const observationBus = new ObservationBus({ enabled: false });
  const server = createInterviewServiceServer({
    host: '127.0.0.1', port: 0, databasePath, developmentAuthEnabled: true,
    apiKey: 'unused', workspaceId: 'test', region: 'cn-beijing', model: 'test', stepfunApiKey: 'unused',
    wrapUpMs: 100_000, maxSessionMs: 200_000, closeGraceMs: 5_000,
  }, {
    observationBus,
    agentTasks: null,
    realtimeProviderFactory: (id) => ({
      id,
      capabilities: { fullDuplex: true, supportsInterrupt: true, supportsExplicitTurnRequest: true, supportsPlaybackAck: false, supportsExplicitSessionClose: false },
      audio: { input: { encoding: 'pcm_s16le', sampleRate: 16_000, frameBytes: 640 }, output: { encoding: 'pcm_s16le', sampleRate: 24_000 } },
      connectOptions: () => ({ url: providerUrl, headers: {} }),
      setupSession: () => [{ type: 'mock.setup' }],
      normalizeServerMessage: (raw) => {
        let message: Record<string, unknown>;
        try { message = JSON.parse(String(raw)) as Record<string, unknown>; } catch { return []; }
        return message.type === 'session.updated' ? [{ type: 'session.ready', providerSessionId: 'mock-session' }] : [];
      },
      appendAudioMessages: () => [],
      requestAssistantTurnMessages: () => [],
      stopInputAfterCurrentTurn: () => [],
      beginInputShutdown: () => [],
      closePlan: () => null,
      connectionFailureMessage: () => 'mock realtime failure',
      handleControlEvent: () => [],
      initialResponsePlan: () => ({ steps: [] }),
    }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let client: WebSocket | undefined;

  try {
    const login = await fetch(`${baseUrl}/api/auth/development/legacy-session`, { method: 'POST' });
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/api/observability/events?sessionId=${seedIds.storySession}`, {
      headers: { cookie }, signal: controller.signal,
    });
    assert.equal(stream.status, 503);
    controller.abort();

    client = new WebSocket(`ws://127.0.0.1:${address.port}/api/realtime`, { headers: { cookie } });
    await once(client, 'open');
    const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Realtime ready timed out with Observability disabled.')), 4_000);
      client!.on('message', (raw) => {
        let message: Record<string, unknown>;
        try { message = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
        if (message.type === 'ready') { clearTimeout(timer); resolve(message); }
        if (message.type === 'error') { clearTimeout(timer); reject(new Error(String(message.message))); }
      });
    });
    client.send(JSON.stringify({ type: 'start', stage_id: seedIds.work, story_title: '观测关闭测试', provider: 'qwen' }));
    const readyMessage = await ready;
    assert.equal(readyMessage.type, 'ready');
    assert.deepEqual(observationBus.recent(String(readyMessage.sessionId)), []);
    const ended = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Realtime end timed out with Observability disabled.')), 4_000);
      client!.on('message', (raw) => {
        let message: Record<string, unknown>;
        try { message = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
        if (message.type === 'ended') { clearTimeout(timer); resolve(); }
      });
    });
    client.send(JSON.stringify({ type: 'end' }));
    await ended;
  } finally {
    if (client?.readyState === WebSocket.OPEN) client.close();
    if (providerSocket?.readyState === WebSocket.OPEN) providerSocket.close();
    const serverClosed = once(server, 'close');
    server.close();
    await serverClosed;
    const providerClosed = once(providerHttp, 'close');
    providerServer.close();
    providerHttp.close();
    await providerClosed;
    if (previousDiagnosticsDir === undefined) delete process.env.DIAGNOSTICS_DIR;
    else process.env.DIAGNOSTICS_DIR = previousDiagnosticsDir;
  }
});
