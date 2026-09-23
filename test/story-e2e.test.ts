import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { after, test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { interviewSessions, lifeStages, stories } from '../src/db/schema.js';
import { parseTranscript } from '../src/db/transcript.js';
import type { TextModelProvider } from '../src/providers/text-model-provider.js';
import { parseQwenServerEvent } from '../src/realtime/qwen.js';
import type { NormalizedRealtimeEvent } from '../src/realtime/types.js';
import {
  createRealtimeInterviewProvider,
  type RealtimeInterviewProviderAdapter,
} from '../src/realtime/provider.js';
import { createInterviewServiceServer } from '../src/server.js';

const testTempRoot = path.resolve('data/test-tmp');
const temporaryDirectories: string[] = [];
mkdirSync(testTempRoot, { recursive: true });

after(() => temporaryDirectories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function waitForMessage(
  socket: WebSocket,
  predicate: (value: Record<string, unknown>) => boolean,
  messages: Array<Record<string, unknown>>,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out while waiting for an expected browser protocol message.'));
    }, timeoutMs);
    const onMessage = (data: WebSocket.RawData) => {
      let value: Record<string, unknown>;
      try { value = JSON.parse(data.toString()) as Record<string, unknown>; }
      catch { return; }
      messages.push(value);
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(value);
    };
    socket.on('message', onMessage);
  });
}

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
  if (type === 'response.audio_transcript.done') {
    return [{
      type: 'assistant.transcript.final',
      responseId: typeof event.response_id === 'string' ? event.response_id : 'response',
      text: typeof event.transcript === 'string' ? event.transcript : '',
      ...(typeof event.item_id === 'string' ? { itemId: event.item_id } : {}),
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

test('mock Story E2E creates a Story, links the Session, preserves Transcript, and isolates API identity', async () => {
  const directory = mkdtempSync(path.join(testTempRoot, 'rensheng-story-mock-e2e-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'story.db');
  const database = createDatabase(databasePath);
  try {
    runMigrations(database);
    seedDatabase(database);
  } finally { database.close(); }

  const providerHttp = createServer();
  const userText = '我第一次独立负责这段经历时，先听取团队意见，再重新安排了当天的分工。';
  const assistantText = '当时是哪一条信息让你决定调整分工？';
  type InterviewContext = Parameters<RealtimeInterviewProviderAdapter['setupSession']>[0];
  let interviewContext: InterviewContext | undefined;
  const fakeProviderServer = new WebSocketServer({ server: providerHttp });
  providerHttp.listen(0, '127.0.0.1');
  await once(providerHttp, 'listening');
  const providerAddress = providerHttp.address();
  assert.ok(providerAddress && typeof providerAddress === 'object');
  const providerUrl = `ws://127.0.0.1:${providerAddress.port}`;
  fakeProviderServer.on('connection', (providerSocket) => {
    providerSocket.on('message', (raw) => {
      const message = parseQwenServerEvent(raw);
      if (!message) return;
      if (message.type === 'mock.setup') {
        providerSocket.send(JSON.stringify({ type: 'session.updated', session: { id: 'mock-external-session-1' } }));
      }
      if (message.type === 'mock.initial') {
        providerSocket.send(JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: 'mock-user-message-1',
          transcript: userText,
        }));
        providerSocket.send(JSON.stringify({ type: 'response.created', response: { id: 'mock-response-1' } }));
        providerSocket.send(JSON.stringify({
          type: 'response.audio_transcript.done',
          response_id: 'mock-response-1',
          item_id: 'mock-assistant-message-1',
          transcript: assistantText,
        }));
        providerSocket.send(JSON.stringify({ type: 'response.done', response: { id: 'mock-response-1', status: 'completed', output: [] } }));
      }
    });
  });

  const textModel: TextModelProvider = {
    async complete(prompt, config) {
      assert.equal(config.structuredOutput?.name, 'submit_story_closeout');
      const userPayload = JSON.parse(prompt.user) as Record<string, unknown>;
      assert.equal(userPayload.target_story_title, '合成经历的转折');
      assert.equal(JSON.stringify(userPayload).includes('account_id'), false);
      assert.equal(JSON.stringify(userPayload).includes('phone'), false);
      return {
        output: {
          story: {
            title: '模型拟定标题（由用户标题覆盖）',
            summary: '用户回忆第一次独立负责这段经历时，先听取团队意见，再重新安排当天分工。',
            agent_memory: '【事件过程】用户回忆第一次独立负责这段经历时，先听取团队意见，再重新安排当天分工。',
            source_message_ids: ['m1'],
          },
        },
        model: 'mock-closeout-model',
        responseId: 'mock-closeout-response-1',
        latencyMs: 1,
      };
    },
  };
  const realtimeFactory: NonNullable<import('../src/server.js').InterviewServiceDependencies['realtimeProviderFactory']> = (id) => ({
    id,
    capabilities: { fullDuplex: true, supportsInterrupt: true, supportsExplicitTurnRequest: true, supportsPlaybackAck: false, supportsExplicitSessionClose: false },
    audio: { input: { encoding: 'pcm_s16le', sampleRate: 16_000, frameBytes: 640 }, output: { encoding: 'pcm_s16le', sampleRate: 24_000 } },
    connectOptions: () => ({ url: providerUrl, headers: {} }),
    setupSession: (context) => {
      interviewContext = context;
      return [{ type: 'mock.setup' }];
    },
    normalizeServerMessage: normalizeMockRealtime,
    appendAudioMessages: (audio) => [{ type: 'mock.audio', bytes: audio.byteLength }],
    requestAssistantTurnMessages: () => [{ type: 'mock.response' }],
    stopInputAfterCurrentTurn: () => [],
    beginInputShutdown: () => [],
    closePlan: () => null,
    connectionFailureMessage: () => 'mock realtime failure',
    handleControlEvent: () => [],
    initialResponsePlan: (context) => {
      interviewContext = context;
      return { steps: [{ message: { type: 'mock.initial' } }] };
    },
  });

  const appServer = createInterviewServiceServer({
    host: '127.0.0.1',
    port: 0,
    databasePath,
    region: 'cn-beijing',
    model: 'mock-realtime-model',
    apiKey: 'mock-realtime-key',
    workspaceId: 'mock-workspace',
    closeoutApiKey: 'mock-text-key',
    closeoutModel: 'mock-closeout-model',
    wrapUpMs: 100_000,
    maxSessionMs: 200_000,
    closeGraceMs: 5_000,
  }, {
    realtimeProviderFactory: realtimeFactory,
    closeout: { textModelProvider: textModel },
    storyCompletion: { evaluate: async () => ({ status: 'interviewing', gaps: [] }) },
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

  const verification = await fetch(`${baseUrl}/api/auth/verification`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '+1 (415) 555-0134' }),
  });
  assert.equal(verification.status, 200);
  const challenge = await verification.json() as { challengeId?: string; developmentCode?: string };
  assert.ok(challenge.challengeId);
  assert.ok(challenge.developmentCode);
  const secondLogin = await fetch(`${baseUrl}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      phone: '001 415 555 0134',
      challengeId: challenge.challengeId,
      code: challenge.developmentCode,
    }),
  });
  assert.equal(secondLogin.status, 200);
  const secondLoginPayload = await secondLogin.json() as { profile?: Record<string, unknown> };
  const secondUserId = secondLoginPayload.profile?.user_id;
  assert.equal(typeof secondUserId, 'string');
  const secondCookie = secondLogin.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(secondCookie);

  const secondStageId = randomUUID();
  const secondStoryId = randomUUID();
  const timestamp = '2026-09-13T00:00:00.000Z';
  const secondAccountDb = createDatabase(databasePath);
  try {
    secondAccountDb.db.insert(lifeStages).values({
      stageId: secondStageId,
      userId: String(secondUserId),
      title: '另一位用户的阶段',
      sortOrder: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
    secondAccountDb.db.insert(stories).values({
      storyId: secondStoryId,
      userId: String(secondUserId),
      stageId: secondStageId,
      title: '另一位用户的故事',
      summary: '不可跨账号读取。',
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
  } finally { secondAccountDb.close(); }

  const socket = new WebSocket(`ws://127.0.0.1:${appAddress.port}/api/realtime`, { headers: { cookie } });
  let foreignSocket: WebSocket | undefined;
  const messages: Array<Record<string, unknown>> = [];
  try {
    await once(socket, 'open');
    socket.send(JSON.stringify({
      type: 'start',
      stage_id: seedIds.work,
      story_title: '合成经历的转折',
      provider: 'qwen',
    }));
    const ready = await waitForMessage(socket, (message) => message.type === 'ready', messages);
    socket.send(JSON.stringify({ type: 'playback_ready' }));
    assert.equal(ready.story, null);
    assert.ok(interviewContext);
    if (interviewContext.interview_type === 'onboarding'
      || interviewContext.interview_type === 'external_contributor') {
      throw new Error('Expected Story interview context.');
    }
    assert.equal(interviewContext.story, null);
    assert.equal(interviewContext.life_stage.stage_id, seedIds.work);
    assert.equal(interviewContext.life_stage.title, '进入职场');
    assert.deepEqual(interviewContext.task_context, { mode: 'create', target_title: '合成经历的转折' });

    const stepfun = createRealtimeInterviewProvider('stepfun', {
      stepfunApiKey: 'test-only-key',
      region: 'cn-beijing',
      model: 'step-audio-2-mini',
    });
    const stepfunSetup = stepfun.setupSession(interviewContext)[0]!;
    const stepfunSession = stepfunSetup.session as Record<string, unknown>;
    assert.match(String(stepfunSession.instructions), /进入职场/);
    assert.match(String(stepfunSession.instructions), /合成经历的转折/);

    const userSaved = await waitForMessage(socket, (message) => message.type === 'transcript_saved' && message.role === 'user', messages);
    const assistantSaved = await waitForMessage(socket, (message) => message.type === 'transcript_saved' && message.role === 'assistant', messages);
    assert.ok(userSaved.messageId);
    assert.ok(assistantSaved.messageId);

    socket.send(JSON.stringify({ type: 'end', reason: 'user' }));
    const ended = await waitForMessage(socket, (message) => message.type === 'ended', messages, 10_000);
    assert.equal(ended.transcriptCount, 2);
    assert.equal((ended.closeout as Record<string, unknown>).status, 'processing');

    let result: Record<string, unknown> | undefined;
    for (let index = 0; index < 100; index += 1) {
      const response = await fetch(`${baseUrl}/api/interview-sessions/${encodeURIComponent(String(ready.sessionId))}/result`, {
        headers: { cookie },
        cache: 'no-store',
      });
      const value = await response.json() as Record<string, unknown>;
      if (value.closeoutStatus === 'completed' || value.closeoutStatus === 'failed') {
        result = value;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(result?.closeoutStatus, 'completed');
    const story = result?.story as Record<string, unknown>;
    assert.equal(story.title, '合成经历的转折');
    assert.equal(story.stage_id, seedIds.work);
    const resultSession = result?.session as Record<string, unknown>;
    assert.equal(resultSession.story_id, story.story_id);

    const verify = createDatabase(databasePath);
    try {
      const persistedSession = verify.db.select().from(interviewSessions)
        .where(eq(interviewSessions.sessionId, String(ready.sessionId))).get();
      const persistedStory = verify.db.select().from(stories)
        .where(eq(stories.storyId, String(story.story_id))).get();
      assert.equal(persistedSession?.storyId, persistedStory?.storyId);
      assert.equal(persistedSession?.stageId, null);
      assert.equal(persistedSession?.providerSessionId, 'mock-external-session-1');
      assert.equal(persistedStory?.createdSourceSessionId, persistedSession?.sessionId);
      const transcript = parseTranscript(persistedSession?.transcriptJson);
      assert.deepEqual(transcript.map((message) => ({
        role: message.role,
        text: message.text,
        provider: message.provider,
        provider_message_id: message.provider_message_id,
      })), [
        { role: 'user', text: userText, provider: 'qwen', provider_message_id: 'mock-user-message-1' },
        { role: 'assistant', text: assistantText, provider: 'qwen', provider_message_id: 'mock-assistant-message-1' },
      ]);
      assert.equal(verify.db.select().from(stories).where(eq(stories.createdSourceSessionId, persistedSession!.sessionId)).all().length, 1);
    } finally { verify.close(); }

    const ownStoriesResponse = await fetch(`${baseUrl}/api/stories`, { headers: { cookie } });
    const ownStories = (await ownStoriesResponse.json() as { stories: Array<Record<string, unknown>> }).stories;
    assert.equal(ownStoriesResponse.status, 200);
    assert.ok(ownStories.some((item) => item.story_id === story.story_id));
    assert.ok(!ownStories.some((item) => item.story_id === secondStoryId));
    const ownStagesResponse = await fetch(`${baseUrl}/api/life-stages`, { headers: { cookie } });
    const ownStages = (await ownStagesResponse.json() as { life_stages: Array<Record<string, unknown>> }).life_stages;
    assert.ok(!ownStages.some((item) => item.stage_id === secondStageId));

    const foreignStoriesResponse = await fetch(`${baseUrl}/api/stories?user_id=${encodeURIComponent(String(secondUserId))}`, {
      headers: { cookie: secondCookie },
    });
    const foreignStories = (await foreignStoriesResponse.json() as { stories: Array<Record<string, unknown>> }).stories;
    assert.equal(foreignStoriesResponse.status, 200);
    assert.deepEqual(foreignStories.map((item) => item.story_id), [secondStoryId]);
    assert.ok(!foreignStories.some((item) => item.story_id === story.story_id));
    const foreignStagesResponse = await fetch(`${baseUrl}/api/life-stages`, { headers: { cookie: secondCookie } });
    const foreignStages = (await foreignStagesResponse.json() as { life_stages: Array<Record<string, unknown>> }).life_stages;
    assert.deepEqual(foreignStages.map((item) => item.stage_id), [secondStageId]);

    const foreignResult = await fetch(`${baseUrl}/api/interview-sessions/${encodeURIComponent(String(ready.sessionId))}/result`, {
      headers: { cookie: secondCookie },
    });
    assert.equal(foreignResult.status, 404);
    const foreignCloseout = await fetch(`${baseUrl}/api/interview-sessions/${encodeURIComponent(String(ready.sessionId))}/closeout`, {
      method: 'POST',
      headers: { cookie: secondCookie },
    });
    assert.equal(foreignCloseout.status, 404);

    const beforeForeignInterview = createDatabase(databasePath);
    const sessionCountBefore = beforeForeignInterview.db.select().from(interviewSessions).all().length;
    beforeForeignInterview.close();
    foreignSocket = new WebSocket(`ws://127.0.0.1:${appAddress.port}/api/realtime`, { headers: { cookie: secondCookie } });
    await once(foreignSocket, 'open');
    const foreignMessages: Array<Record<string, unknown>> = [];
    const foreignErrorPromise = waitForMessage(foreignSocket, (message) => message.type === 'error', foreignMessages);
    foreignSocket.send(JSON.stringify({ type: 'start', story_id: story.story_id, provider: 'qwen' }));
    const foreignError = await foreignErrorPromise;
    assert.match(String(foreignError.message), /找不到当前人生档案中的故事/);
    foreignSocket.close();
    await once(foreignSocket, 'close');
    const afterForeignInterview = createDatabase(databasePath);
    try {
      assert.equal(afterForeignInterview.db.select().from(interviewSessions).all().length, sessionCountBefore);
    } finally { afterForeignInterview.close(); }

    const unauthorized = await fetch(`${baseUrl}/api/interview-sessions/${encodeURIComponent(String(ready.sessionId))}/result`);
    assert.equal(unauthorized.status, 401);
  } finally {
    if (foreignSocket && foreignSocket.readyState === WebSocket.OPEN) foreignSocket.close();
    if (socket.readyState === WebSocket.OPEN) socket.close();
    const closedApp = once(appServer, 'close');
    appServer.close();
    appServer.closeAllConnections();
    await closedApp;
    fakeProviderServer.close();
    const closedProvider = once(providerHttp, 'close');
    providerHttp.close();
    await closedProvider;
  }
});
