import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import WebSocket, { WebSocketServer } from 'ws';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { interviewSessions, lifeStages, stories, users } from '../src/db/schema.js';
import { parseTranscript, serializeTranscript } from '../src/db/transcript.js';
import { OnboardingInterviewContextBuilder } from '../src/interview/onboarding/context-builder.js';
import type { OnboardingResult } from '../src/onboarding/types.js';
import { createRealtimeInterviewProvider } from '../src/realtime/provider.js';
import { parseQwenServerEvent } from '../src/realtime/qwen.js';
import { createInterviewServiceServer } from '../src/server.js';
import type { OnboardingCloseoutDependencies } from '../src/onboarding/closeout-workflow.js';

const testTempRoot = path.resolve('data/test-tmp');
const temporaryDirectories: string[] = [];
mkdirSync(testTempRoot, { recursive: true });

after(() => temporaryDirectories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function collectMessages(socket: WebSocket) {
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
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
    waitFor(predicate: (message: Record<string, unknown>) => boolean, timeoutMs = 5_000, fromIndex = 0) {
      const existing = messages.slice(fromIndex).find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for onboarding runtime event (${messages.map((item) => item.type).join(', ')}).`));
        }, timeoutMs);
        waiters.push({ predicate, resolve, timer });
      });
    },
  };
}

function createFixture(label: string, onboardingStatus: 'not_started' | 'in_progress' = 'not_started') {
  const directory = mkdtempSync(path.join(testTempRoot, `rensheng-onboarding-runtime-${label}-${randomUUID()}-`));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'session.db');
  const database = createDatabase(databasePath);
  try {
    runMigrations(database);
    seedDatabase(database);
    database.db.delete(interviewSessions).where(eq(interviewSessions.sessionType, 'onboarding')).run();
    database.db.update(users).set({ onboardingStatus }).where(eq(users.userId, seedIds.user)).run();
  } finally { database.close(); }
  return { directory, databasePath };
}

async function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
}

test('Onboarding context is discriminated and carries profile plus prior user/assistant turns', () => {
  const { databasePath } = createFixture('context', 'in_progress');
  const database = createDatabase(databasePath);
  try {
    const timestamp = '2026-09-10T01:00:00.000Z';
    database.db.insert(interviewSessions).values({
      sessionId: 'prior-onboarding-session',
      provider: 'qwen',
      userId: seedIds.user,
      stageId: null,
      storyId: null,
      sessionType: 'onboarding',
      status: 'ended',
      closeoutStatus: 'pending',
      transcriptJson: serializeTranscript([
        { message_id: 'prior-user', role: 'user', text: '我在南京长大。', timestamp, provider: 'qwen' },
        { message_id: 'prior-assistant', role: 'assistant', text: '后来搬去了哪里？', timestamp, provider: 'qwen' },
      ]),
      startedAt: timestamp,
      endedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
  } finally { database.close(); }

  const context = new OnboardingInterviewContextBuilder(databasePath).build(seedIds.user, { interview_type: 'onboarding' });
  assert.equal(context.interview_type, 'onboarding');
  assert.equal(context.taskContext.mode, 'continue');
  assert.equal(context.profile.name, '周明');
  assert.equal(context.profile.birth_year, 1985);
  assert.equal('birth_date' in context.profile, false);
  assert.equal('birth_date_precision' in context.profile, false);
  assert.equal(context.profile.birth_place, '浙江杭州');
  assert.equal('user_id' in context.profile, false);
  assert.deepEqual(context.previousOnboardingTranscripts, [{
    startedAt: '2026-09-10T01:00:00.000Z',
    messages: [
      { role: 'user', text: '我在南京长大。', timestamp: '2026-09-10T01:00:00.000Z' },
      { role: 'assistant', text: '后来搬去了哪里？', timestamp: '2026-09-10T01:00:00.000Z' },
    ],
  }]);
});

async function startOnboardingHarness(
  databasePath: string,
  onboardingCloseout?: OnboardingCloseoutDependencies,
) {
  const providerHttp = createServer();
  const providerServer = new WebSocketServer({ server: providerHttp });
  let providerSocket: WebSocket | undefined;
  const providerMessages: Array<Record<string, unknown>> = [];
  const providerWaiters: Array<{
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
    timer: NodeJS.Timeout;
  }> = [];
  providerServer.on('connection', (socket) => {
    providerSocket = socket;
    socket.on('message', (raw) => {
      const message = parseQwenServerEvent(raw);
      if (!message) return;
      providerMessages.push(message);
      for (let index = providerWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = providerWaiters[index]!;
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        providerWaiters.splice(index, 1);
        waiter.resolve(message);
      }
      if (message.type === 'session.update') {
        socket.send(JSON.stringify({
          type: 'session.updated',
          session: { id: 'mock-onboarding-provider-session' },
        }));
      }
      if (message.type === 'session.close') socket.send(JSON.stringify({ type: 'session.closed' }));
    });
  });
  providerHttp.listen(0, '127.0.0.1');
  await once(providerHttp, 'listening');
  const providerAddress = providerHttp.address();
  assert.ok(providerAddress && typeof providerAddress === 'object');
  const providerUrl = `ws://127.0.0.1:${providerAddress.port}`;

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
    realtimeProviderFactory: (id, config) => {
      const adapter = createRealtimeInterviewProvider(id, config);
      return { ...adapter, connectOptions: () => ({ url: providerUrl, headers: {} }) };
    },
    ...(onboardingCloseout ? { onboardingCloseout } : {}),
  });
  appServer.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  const appAddress = appServer.address();
  assert.ok(appAddress && typeof appAddress === 'object');
  const baseUrl = `http://127.0.0.1:${appAddress.port}`;
  const login = await fetch(`${baseUrl}/api/auth/development/legacy-session`, { method: 'POST' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie);
  const clientSocket = new WebSocket(`ws://127.0.0.1:${appAddress.port}/api/realtime`, { headers: { cookie } });
  await once(clientSocket, 'open');

  return {
    appServer,
    appAddress,
    baseUrl,
    cookie,
    clientSocket,
    clientMessages: collectMessages(clientSocket),
    get providerSocket() { return providerSocket; },
    providerMessages,
    async waitForProvider(predicate: (message: Record<string, unknown>) => boolean, timeoutMs = 5_000) {
      const existing = providerMessages.find(predicate);
      if (existing) return existing;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = providerWaiters.findIndex((waiter) => waiter.timer === timer);
          if (index >= 0) providerWaiters.splice(index, 1);
          reject(new Error(`Timed out waiting for provider message (${providerMessages.map((item) => item.type).join(', ')}).`));
        }, timeoutMs);
        providerWaiters.push({ predicate, resolve, timer });
      });
    },
    async close() {
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
      if (providerSocket?.readyState === WebSocket.OPEN) providerSocket.close();
      const providerClosed = once(providerServer, 'close');
      providerServer.close();
      await providerClosed;
      const providerHttpClosed = once(providerHttp, 'close');
      providerHttp.close();
      await providerHttpClosed;
      await closeHttpServer(appServer);
    },
  };
}

test('Qwen completion tool is internal; closeout waits for final assistant Transcript drain', async () => {
  const { databasePath } = createFixture('complete');
  let closeoutCalls = 0;
  let observedCloseoutTranscript: Array<{ role: string; text: string }> = [];
  const harness = await startOnboardingHarness(databasePath, {
    processor: {
      async process({ context, assertCurrentAttempt }) {
        closeoutCalls += 1;
        assertCurrentAttempt();
        const current = context.transcripts.find((session: { sessionId: string }) => session.sessionId === context.sessionId);
        observedCloseoutTranscript = current?.messages.map((message: { role: string; text: string }) => ({
          role: message.role,
          text: message.text,
        })) ?? [];
        const userMessage = current?.messages.find((message: { role: string }) => message.role === 'user');
        assert.ok(userMessage);
        return {
          output: {
            profile: {
              name: { value: '周明', source_refs: [{ session_id: context.sessionId, message_id: userMessage.message_id }] },
              birth_year: { value: null, source_refs: [] },
              gender: { value: null, source_refs: [] },
              birth_place: { value: null, source_refs: [] },
              current_location: { value: null, source_refs: [] },
              current_status: { value: null, source_refs: [] },
              profile_summary: { value: null, source_refs: [] },
            },
            life_stages: [],
          },
          modelResult: { output: {}, model: 'mock-closeout-model', latencyMs: 0 },
        };
      },
    },
  });

  try {
    harness.clientSocket.send(JSON.stringify({ type: 'start', interview_type: 'onboarding', provider: 'qwen' }));
    const ready = await harness.clientMessages.waitFor((message) => message.type === 'ready');
    harness.clientSocket.send(JSON.stringify({ type: 'playback_ready' }));
    assert.equal(ready.session_type, 'onboarding');
    assert.equal(ready.onboarding_mode, 'new');
    assert.equal((ready.profile as Record<string, unknown>).name, '周明');
    assert.ok(harness.providerSocket);
    assert.equal((await harness.waitForProvider((message) => message.type === 'response.create')).type, 'response.create');

    const verifyCreated = createDatabase(databasePath);
    try {
      const created = verifyCreated.db.select().from(interviewSessions)
        .where(eq(interviewSessions.sessionId, String(ready.sessionId))).get();
      const user = verifyCreated.db.select().from(users).where(eq(users.userId, seedIds.user)).get();
      assert.equal(created?.sessionType, 'onboarding');
      assert.equal(created?.stageId, null);
      assert.equal(created?.storyId, null);
      assert.equal(created?.status, 'active');
      assert.equal(user?.onboardingStatus, 'in_progress');
    } finally { verifyCreated.close(); }

    harness.providerSocket!.send(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'onboarding-user-turn',
      transcript: '我叫周明。',
    }));
    await harness.clientMessages.waitFor((message) => message.type === 'transcript_saved' && message.role === 'user');
    harness.providerSocket!.send(JSON.stringify({ type: 'response.created', response: { id: 'tool-response' } }));
    harness.providerSocket!.send(JSON.stringify({
      type: 'response.function_call_arguments.done',
      name: 'complete_onboarding',
      call_id: 'completion-call',
      response_id: 'tool-response',
      arguments: '{"private":"must-not-leak"}',
    }));
    harness.providerSocket!.send(JSON.stringify({ type: 'response.done', response: { id: 'tool-response', status: 'completed' } }));

    const functionOutput = await harness.waitForProvider((message) => message.type === 'conversation.item.create');
    assert.deepEqual(functionOutput.item, {
      type: 'function_call_output',
      call_id: 'completion-call',
      output: '{"ok":true}',
    });
    const closeRequest = await harness.waitForProvider((message) => message.type === 'response.create'
      && typeof (message.response as Record<string, unknown> | undefined)?.instructions === 'string');
    assert.match(String((closeRequest.response as Record<string, unknown>).instructions), /不得改写、删减、扩展、提问/);
    assert.equal(harness.clientMessages.messages.some((message) => message.endReason === 'model_complete'), false);

    const closingText = '谢谢你分享这些经历，我已经大致了解你的人生框架。';
    harness.providerSocket!.send(JSON.stringify({ type: 'response.created', response: { id: 'natural-close' } }));
    harness.providerSocket!.send(JSON.stringify({ type: 'response.audio.delta', response_id: 'natural-close', delta: 'AQID' }));
    harness.providerSocket!.send(JSON.stringify({ type: 'response.audio_transcript.delta', response_id: 'natural-close', delta: closingText }));
    harness.providerSocket!.send(JSON.stringify({ type: 'response.audio_transcript.done', response_id: 'natural-close', transcript: closingText }));
    harness.providerSocket!.send(JSON.stringify({ type: 'response.done', response: { id: 'natural-close', status: 'completed' } }));

    const completedResponse = await harness.clientMessages.waitFor((message) => message.type === 'response_done'
      && message.responseId === 'natural-close');
    assert.equal(completedResponse.endReason, 'model_complete');
    assert.ok(harness.clientMessages.messages.some((message) => message.type === 'assistant_audio'));
    await harness.clientMessages.waitFor((message) => message.type === 'transcript_saved' && message.role === 'assistant');
    assert.equal(JSON.stringify(harness.clientMessages.messages).includes('must-not-leak'), false);
    assert.equal(JSON.stringify(harness.clientMessages.messages).includes('completion-call'), false);

    harness.clientSocket.send(JSON.stringify({ type: 'end', reason: 'model_complete' }));
    const ended = await harness.clientMessages.waitFor((message) => message.type === 'ended');
    assert.equal(ended.session_type, 'onboarding');
    assert.equal(ended.end_reason, 'model_complete');
    assert.match(String(ended.resultUrl), /^\/onboarding\/processing\?session_id=/);
    assert.ok(['processing', 'completed'].includes(String(ended.closeout_status)));
    assert.equal(closeoutCalls, 1);
    assert.deepEqual(observedCloseoutTranscript, [
      { role: 'user', text: '我叫周明。' },
      { role: 'assistant', text: closingText },
    ]);

    const storedConnection = createDatabase(databasePath);
    try {
      const stored = storedConnection.db.select().from(interviewSessions)
        .where(eq(interviewSessions.sessionId, String(ready.sessionId))).get();
      assert.equal(stored?.sessionType, 'onboarding');
      assert.equal(stored?.stageId, null);
      assert.equal(stored?.storyId, null);
      const closeoutState = JSON.parse(stored?.closeoutResultJson ?? '{}') as Record<string, unknown>;
      assert.equal(closeoutState.completion_eligible, true);
      assert.equal(closeoutState.transcript_complete, true);
      assert.deepEqual(parseTranscript(stored?.transcriptJson).map(({ role, text }) => ({ role, text })), [
        { role: 'user', text: '我叫周明。' },
        { role: 'assistant', text: closingText },
      ]);
      const user = storedConnection.db.select().from(users).where(eq(users.userId, seedIds.user)).get();
      assert.equal(user?.onboardingStatus, 'completed');
    } finally { storedConnection.close(); }

    const resultResponse = await fetch(`${harness.baseUrl}/api/onboarding/result`, { headers: { cookie: harness.cookie } });
    assert.equal(resultResponse.status, 200);
    const result = await resultResponse.json() as OnboardingResult;
    assert.equal(result.session?.session_id, ready.sessionId);
    assert.equal(result.onboarding_status, 'completed');
    const closeoutResponse = await fetch(`${harness.baseUrl}/api/onboarding/sessions/${ready.sessionId}/closeout`, {
      method: 'POST',
      headers: { cookie: harness.cookie },
    });
    assert.equal(closeoutResponse.status, 200);
    assert.equal((await closeoutResponse.json() as OnboardingResult).session?.closeout_status, 'completed');
    const foreignResult = await fetch(`${harness.baseUrl}/api/onboarding/result?session_id=${seedIds.storySession}`, {
      headers: { cookie: harness.cookie },
    });
    assert.equal(foreignResult.status, 404);
  } finally {
    await harness.close();
  }
});

test('manual Onboarding end saves the Transcript but skips Closeout and returns to welcome', async () => {
  const { databasePath } = createFixture('manual');
  let closeoutCalls = 0;
  const harness = await startOnboardingHarness(databasePath, {
    processor: { async process() { closeoutCalls += 1; throw new Error('manual ends must not call closeout'); } },
  });
  try {
    harness.clientSocket.send(JSON.stringify({ type: 'start', interview_type: 'onboarding', provider: 'qwen' }));
    const ready = await harness.clientMessages.waitFor((message) => message.type === 'ready');
    harness.clientSocket.send(JSON.stringify({ type: 'playback_ready' }));
    assert.equal(ready.session_type, 'onboarding');
    assert.equal(ready.onboarding_mode, 'new');
    assert.ok(harness.providerSocket);
    await harness.waitForProvider((message) => message.type === 'response.create');
    harness.providerSocket!.send(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'manual-user-turn',
      transcript: '我想先记下童年的一件事。',
    }));
    await harness.clientMessages.waitFor((message) => message.type === 'transcript_saved' && message.role === 'user');
    harness.clientSocket.send(JSON.stringify({ type: 'end', reason: 'user' }));
    const ended = await harness.clientMessages.waitFor((message) => message.type === 'ended');
    assert.equal(ended.session_type, 'onboarding');
    assert.equal(ended.end_reason, 'user');
    assert.equal(ended.onboarding_status, 'in_progress');
    assert.equal(ended.closeout_status, 'pending');
    assert.equal(ended.resultUrl, '/onboarding');
    assert.equal(closeoutCalls, 0);

    const storedConnection = createDatabase(databasePath);
    try {
      const stored = storedConnection.db.select().from(interviewSessions)
        .where(eq(interviewSessions.sessionId, String(ready.sessionId))).get();
      assert.equal(stored?.status, 'ended');
      assert.equal(stored?.closeoutStatus, 'pending');
      const closeoutState = JSON.parse(stored?.closeoutResultJson ?? '{}') as Record<string, unknown>;
      assert.equal(closeoutState.completion_eligible, false);
      assert.equal(closeoutState.transcript_complete, false);
      assert.deepEqual(parseTranscript(stored?.transcriptJson).map(({ role, text }) => ({ role, text })), [
        { role: 'user', text: '我想先记下童年的一件事。' },
      ]);
      assert.equal(storedConnection.db.select().from(lifeStages)
        .where(eq(lifeStages.createdSourceSessionId, String(ready.sessionId))).all().length, 0);
      assert.equal(storedConnection.db.select().from(stories)
        .where(eq(stories.createdSourceSessionId, String(ready.sessionId))).all().length, 0);
      const user = storedConnection.db.select().from(users).where(eq(users.userId, seedIds.user)).get();
      assert.equal(user?.onboardingStatus, 'in_progress');
    } finally { storedConnection.close(); }

    const retryResponse = await fetch(`${harness.baseUrl}/api/onboarding/sessions/${ready.sessionId}/closeout`, {
      method: 'POST',
      headers: { cookie: harness.cookie, origin: harness.baseUrl },
    });
    assert.equal(retryResponse.status, 409);
    const retryPayload = await retryResponse.json() as Record<string, unknown>;
    assert.equal(retryPayload.errorCode, 'ONBOARDING_COMPLETION_REQUIRED');
    assert.equal(retryPayload.retryable, false);
    assert.equal(closeoutCalls, 0);

    for (const route of ['/onboarding', '/onboarding/processing', '/onboarding/result']) {
      assert.equal((await fetch(`${harness.baseUrl}${route}`)).status, 200);
    }
  } finally {
    await harness.close();
  }
});
