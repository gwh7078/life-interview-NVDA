import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { interviewSessions, stories } from '../src/db/schema.js';
import { parseTranscript } from '../src/db/transcript.js';
import { TranscriptRepository } from '../src/repositories/domain-repositories.js';
import { beginInterviewCloseout, getInterviewCloseoutResult } from '../src/interview/closeout-workflow.js';
import { createStoryInterviewCore } from '../src/interview/core.js';
import { endRealtimeInterviewSession } from '../src/interview/session.js';
import { createInterviewServiceServer } from '../src/server.js';
import type { StoryCompletionService } from '../src/story/completion/service.js';
import type { TextModelProvider } from '../src/providers/text-model-provider.js';

const CHAT_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions';
const networkFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];
const testTempRoot = path.resolve('data/test-tmp');
let activeTestCookie = '';
mkdirSync(testTempRoot, { recursive: true });

after(() => temporaryDirectories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

interface Scenario {
  databasePath: string;
  sessionId: string;
  userId: string;
  storyId: string;
  stageId: string;
  userMessageId: string;
  assistantMessageId: string;
  userText: string;
  initialSummary: string;
  initialAgentMemory: string;
  initialTranscript: ReturnType<typeof parseTranscript>;
}

function prepareScenario(
  withTranscript = true,
  userText = '项目上线前，我担心团队之间的信息没有对齐；上线后我发现先听取其他团队意见很重要。2013年项目正式上线。',
  initialSummary?: string,
): Scenario {
  const directory = mkdtempSync(path.join(testTempRoot, 'rensheng-closeout-workflow-test-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'memoir.db');
  const storyId = '00000000-0000-4000-8000-000000000204';
  const connection = createDatabase(databasePath);
  try {
    runMigrations(connection);
    seedDatabase(connection);
    if (initialSummary !== undefined) {
      connection.db.update(stories).set({ summary: initialSummary, agentMemory: initialSummary }).where(eq(stories.storyId, storyId)).run();
    }
  } finally {
    connection.close();
  }
  const core = createStoryInterviewCore(databasePath);
  const context = core.prepare(seedIds.user, { mode: 'continue', storyId });
  const session = core.start(seedIds.user, context, 'stepfun');
  let userMessageId = '';
  let assistantMessageId = '';
  if (withTranscript) {
    const transcripts = new TranscriptRepository(databasePath);
    const user = transcripts.appendForSession(seedIds.user, session.sessionId, {
      role: 'user', text: userText, provider: 'stepfun', providerMessageId: 'workflow-user-1',
    });
    const assistant = transcripts.appendForSession(seedIds.user, session.sessionId, {
      role: 'assistant', text: '当时是什么让你意识到需要先听听其他团队的意见？',
      provider: 'stepfun', providerMessageId: 'workflow-assistant-1',
    });
    userMessageId = user.message_id;
    assistantMessageId = assistant.message_id;
  }
  endRealtimeInterviewSession(databasePath, seedIds.user, session.sessionId);
  const verify = createDatabase(databasePath);
  try {
    const story = verify.db.select().from(stories).where(eq(stories.storyId, storyId)).get();
    const savedSession = verify.db.select().from(interviewSessions)
      .where(eq(interviewSessions.sessionId, session.sessionId)).get();
    assert.ok(story);
    assert.ok(savedSession);
    return {
      databasePath,
      sessionId: session.sessionId,
      userId: seedIds.user,
      storyId,
      stageId: String(context.life_stage.stage_id),
      userMessageId,
      assistantMessageId,
      userText,
      initialSummary: story.summary,
      initialAgentMemory: story.agentMemory || story.summary,
      initialTranscript: parseTranscript(savedSession.transcriptJson),
    };
  } finally {
    verify.close();
  }
}

function modelOutput(scenario: Scenario, options: {
  newStories?: Array<Record<string, unknown>>;
  summary?: string;
  agentMemory?: string;
  sourceMessageIds?: string[];
  memoryChanges?: Array<Record<string, unknown>>;
} = {}): Record<string, unknown> {
  const summary = options.summary ?? `${scenario.initialSummary} ${scenario.userText}`;
  const agentMemory = options.agentMemory ?? options.summary ?? `${scenario.initialAgentMemory} ${scenario.userText}`;
  const sourceMessageIds = options.sourceMessageIds ?? ['u1'];
  const memoryChanges = options.memoryChanges ?? (
    agentMemory.trim() === scenario.initialAgentMemory.trim()
      ? []
      : [{
          type: 'add',
          previous_text: '',
          new_text: agentMemory.includes(scenario.userText) ? scenario.userText : agentMemory,
          source_message_ids: sourceMessageIds,
        }]
  );
  return {
    current_story: {
      summary,
      agent_memory: agentMemory,
      memory_changes: memoryChanges,
      source_message_ids: sourceMessageIds,
    },
    new_stories: options.newStories ?? [],
  };
}

function planResponse(content: string, options: { status?: number; finishReason?: string } = {}): Response {
  return new Response(JSON.stringify({
    id: 'chatcmpl-test-response',
    model: 'doubao-seed-2-1-turbo-260628',
    choices: [{
      finish_reason: options.finishReason ?? 'tool_calls',
      message: {
        role: 'assistant', content: null,
        tool_calls: [{
          id: 'call-test-closeout', type: 'function',
          function: { name: 'submit_story_closeout', arguments: content },
        }],
      },
    }],
    usage: { prompt_tokens: 420, completion_tokens: 90, total_tokens: 510 },
  }), { status: options.status ?? 200, headers: { 'content-type': 'application/json' } });
}

async function withPlanStub<T>(
  handler: (call: number, body: Record<string, unknown>, init: RequestInit | undefined) => Promise<Response>,
  action: (realFetch: typeof fetch, callCount: () => number) => Promise<T>,
): Promise<T> {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== CHAT_ENDPOINT) return realFetch(input, init);
    calls += 1;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return handler(calls, body, init);
  }) as typeof fetch;
  const authenticatedFetch = withTestAuth(realFetch);
  try { return await action(authenticatedFetch, () => calls); }
  finally { globalThis.fetch = realFetch; }
}

function withTestAuth(fetcher: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (activeTestCookie) headers.set('cookie', activeTestCookie);
    return fetcher(input, { ...init, headers });
  }) as typeof fetch;
}

async function startServer(
  databasePath: string,
  closeoutApiKey = 'test-closeout-secret',
  closeoutTimeoutMs = 5_000,
  storyCompletion: Pick<StoryCompletionService, 'evaluate'> = {
    evaluate: async () => ({ status: 'interviewing', gaps: [] }),
  },
) {
  const server = createInterviewServiceServer({
    host: '127.0.0.1', port: 0, databasePath,
    region: 'cn-beijing', model: 'qwen-audio-3.0-realtime-plus',
    closeoutApiKey,
    closeoutBaseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    closeoutApiFormat: 'chat-completions',
    closeoutModel: 'doubao-seed-2-1-turbo-260628',
    closeoutTimeoutMs,
  }, { storyCompletion });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const login = await networkFetch(`${baseUrl}/api/auth/development/legacy-session`, { method: 'POST' });
  assert.equal(login.status, 200);
  activeTestCookie = login.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  assert.ok(activeTestCookie);
  return { server, baseUrl };
}

async function closeServer(server: ReturnType<typeof createInterviewServiceServer>): Promise<void> {
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
}

async function waitForResult(realFetch: typeof fetch, baseUrl: string, sessionId: string): Promise<Record<string, unknown>> {
  for (let index = 0; index < 300; index += 1) {
    const response = await realFetch(`${baseUrl}/api/interview-sessions/${encodeURIComponent(sessionId)}/result`);
    const payload = await response.json() as Record<string, unknown>;
    if (payload.closeoutStatus === 'completed' || payload.closeoutStatus === 'failed') return payload;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`closeout did not finish: ${baseUrl}`);
}

async function waitForStoredResult(databasePath: string, sessionId: string, userId: string): Promise<Record<string, unknown>> {
  for (let index = 0; index < 300; index += 1) {
    const result = getInterviewCloseoutResult(databasePath, sessionId, userId);
    if (result.closeoutStatus === 'completed' || result.closeoutStatus === 'failed') return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('closeout did not finish in the isolated test database');
}

async function runCloseoutResponse(
  scenario: Scenario,
  output: Record<string, unknown>,
  inspectRequest?: (body: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  return withPlanStub(async (_call, body) => {
    inspectRequest?.(body);
    return planResponse(JSON.stringify(output));
  }, async (realFetch) => {
    const { server, baseUrl } = await startServer(scenario.databasePath);
    try {
      const started = await realFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/closeout`, { method: 'POST' });
      assert.ok(started.status === 202 || started.status === 200);
      return await waitForResult(realFetch, baseUrl, scenario.sessionId);
    } finally { await closeServer(server); }
  });
}

test('closeout diagnostics correlate lifecycle and each model attempt without logging story content', async () => {
  const scenario = prepareScenario(true, 'DIAGNOSTIC_PRIVATE_STORY_TEXT');
  const diagnosticsDirectory = mkdtempSync(path.join(testTempRoot, 'rensheng-closeout-diagnostics-'));
  temporaryDirectories.push(diagnosticsDirectory);
  const previousDiagnosticsDirectory = process.env.DIAGNOSTICS_DIR;
  const previousCaptureContent = process.env.DIAGNOSTICS_CAPTURE_CONTENT;
  process.env.DIAGNOSTICS_DIR = diagnosticsDirectory;
  process.env.DIAGNOSTICS_CAPTURE_CONTENT = '0';
  const textModelProvider: TextModelProvider = {
    async complete() {
      return {
        output: modelOutput(scenario),
        model: 'telemetry-test-model',
        responseId: 'telemetry-response-1',
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        diagnostics: {
          responseStatus: 200,
          choiceCount: 1,
          finishReason: 'tool_calls',
          responseChannel: 'tool_calls',
          toolCallCount: 1,
          argumentsType: 'string',
          argumentsLength: 32,
          requestedMaxTokens: 512,
        },
        latencyMs: 8,
      };
    },
  };
  try {
    beginInterviewCloseout(
      scenario.databasePath,
      scenario.sessionId,
      { apiKey: 'test-only', provider: 'telemetry-test-provider', model: 'telemetry-test-model' },
      scenario.userId,
      { textModelProvider },
    );
    const result = await waitForStoredResult(scenario.databasePath, scenario.sessionId, scenario.userId);
    assert.equal(result.closeoutStatus, 'completed');

    const logPath = path.join(diagnosticsDirectory, 'logs', 'story-closeout.jsonl');
    let logRows: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 100; index += 1) {
      logRows = readFileSync(logPath, 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      if (logRows.some((row) => row.event === 'closeout.completed')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const attemptIds = new Set(logRows.map((row) => row.attemptId));
    assert.equal(attemptIds.size, 1);
    const attemptId = [...attemptIds][0];
    assert.ok(attemptId);
    assert.deepEqual(logRows.map((row) => row.event), [
      'closeout.started',
      'model_call.started',
      'model_call.returned',
      'closeout.completed',
    ]);
    const returned = logRows.find((row) => row.event === 'model_call.returned');
    assert.equal(returned?.responseId, 'telemetry-response-1');
    assert.equal(returned?.responseStatus, 200);
    assert.equal(returned?.promptTokens, 20);
    assert.equal(returned?.completionTokens, 10);
    assert.equal(logRows.every((row) => row.sessionId === scenario.sessionId), true);
    assert.equal(JSON.stringify(logRows).includes(scenario.userText), false);

    const snapshotDirectory = path.join(diagnosticsDirectory, 'snapshots', 'story-closeout');
    const snapshotPath = path.join(snapshotDirectory, readdirSync(snapshotDirectory)[0]!);
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, unknown>;
    assert.equal(snapshot.attempt_id, attemptId);
    assert.equal(snapshot.content, undefined);
    assert.equal(snapshot.status, 'completed');

    process.env.DIAGNOSTICS_CAPTURE_CONTENT = '1';
    const captureScenario = prepareScenario(true, 'DIAGNOSTIC_CAPTURE_PRIVATE_TEXT');
    beginInterviewCloseout(
      captureScenario.databasePath,
      captureScenario.sessionId,
      { apiKey: 'test-only', provider: 'telemetry-test-provider', model: 'telemetry-test-model' },
      captureScenario.userId,
      {
        textModelProvider: {
          async complete() {
            return {
              output: modelOutput(captureScenario),
              model: 'telemetry-test-model',
              latencyMs: 3,
            };
          },
        },
      },
    );
    assert.equal(
      (await waitForStoredResult(captureScenario.databasePath, captureScenario.sessionId, captureScenario.userId)).closeoutStatus,
      'completed',
    );
    const capturedSnapshot = readdirSync(snapshotDirectory)
      .map((file) => JSON.parse(readFileSync(path.join(snapshotDirectory, file), 'utf8')) as Record<string, unknown>)
      .find((entry) => entry.id === captureScenario.sessionId);
    assert.ok(capturedSnapshot);
    assert.deepEqual(
      (capturedSnapshot.content as Record<string, unknown>).model_output,
      modelOutput(captureScenario),
    );
  } finally {
    if (previousDiagnosticsDirectory === undefined) delete process.env.DIAGNOSTICS_DIR;
    else process.env.DIAGNOSTICS_DIR = previousDiagnosticsDirectory;
    if (previousCaptureContent === undefined) delete process.env.DIAGNOSTICS_CAPTURE_CONTENT;
    else process.env.DIAGNOSTICS_CAPTURE_CONTENT = previousCaptureContent;
  }
});

test('compact closeout updates the Story, directly creates independent Stories, and serves sourced results', async () => {
  const scenario = prepareScenario();
  const newStory = {
    title: '上线当天的团队协作',
    summary: '2013年项目上线当天，团队先核对信息再调整分工。',
    stage_id: 's1',
    source_message_ids: ['u1'],
  };
  const output = modelOutput(scenario, { newStories: [newStory] });
  const evaluatedStories: Array<{ userId: string; storyId: string }> = [];
  await withPlanStub(async (_call, body) => {
    const input = body.messages as Array<Record<string, unknown>>;
    const userPayload = JSON.parse(String(input.find((message) => message.role === 'user')?.content)) as Record<string, unknown>;
    assert.deepEqual((userPayload.transcript as Array<Record<string, unknown>>).map((message) => message.message_id), ['u1', 'a1']);
    const currentStageAlias = String(userPayload.current_stage_id);
    assert.match(currentStageAlias, /^s\d+$/);
    assert.ok((userPayload.life_stages as Array<Record<string, unknown>>).every((stage) => /^s\d+$/.test(String(stage.stage_id))));
    assert.equal('story_state' in (userPayload.current_story as Record<string, unknown>), false);
    assert.equal('session_summary' in userPayload, false);
    assert.equal('completeness' in userPayload, false);
    const schema = (body.tools as Array<Record<string, unknown>>)[0]!.function as Record<string, unknown>;
    const properties = ((schema.parameters as Record<string, any>).properties) as Record<string, any>;
    assert.deepEqual(Object.keys(properties).sort(), ['current_story', 'new_stories']);
    assert.deepEqual(Object.keys(properties.current_story.properties).sort(), ['agent_memory', 'memory_changes', 'source_message_ids', 'summary']);
    const outputForPrompt = JSON.parse(JSON.stringify(output)) as Record<string, any>;
    outputForPrompt.new_stories[0].stage_id = currentStageAlias;
    return planResponse(JSON.stringify(outputForPrompt));
  }, async (realFetch) => {
    const { server, baseUrl } = await startServer(
      scenario.databasePath,
      'test-closeout-secret',
      5_000,
      { evaluate: async (userId, storyId) => {
        evaluatedStories.push({ userId, storyId });
        return { status: 'interviewing', gaps: [] };
      } },
    );
    try {
      const started = await realFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/closeout`, { method: 'POST' });
      assert.equal(started.status, 202);
      const result = await waitForResult(realFetch, baseUrl, scenario.sessionId);
      assert.equal(result.closeoutStatus, 'completed', JSON.stringify(result));
      for (let index = 0; index < 100 && evaluatedStories.length < 2; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const story = result.story as Record<string, unknown>;
      assert.match(String(story.summary), /信息没有对齐/);
      assert.equal((result.session as Record<string, unknown>).provider, 'stepfun');
      const created = result.newStories as Array<Record<string, unknown>>;
      assert.equal(created.length, 1);
      assert.equal(created[0]?.title, newStory.title);
      assert.equal(created[0]?.summary, newStory.summary);
      assert.equal(created[0]?.stage_id, scenario.stageId);
      assert.deepEqual(
        new Set(evaluatedStories.map((item) => item.storyId)),
        new Set([scenario.storyId, String(created[0]?.story_id)]),
        'Closeout evaluates Completion for the primary Story and every newly created Story Seed',
      );
      assert.equal(evaluatedStories.length, 2);
      assert.deepEqual(created[0]?.source_message_ids, [scenario.userMessageId]);
      assert.deepEqual(result.currentStorySourceMessageIds, [scenario.userMessageId]);
      assert.deepEqual((created[0]?.source_message_ids as string[]), [scenario.userMessageId]);
      assert.equal(typeof result.modelMetadata, 'object');
      assert.equal('closeoutResult' in result, false, 'the DTO must not expose the persisted Closeout JSON');
      assert.equal('debug' in result, false, 'the DTO must not expose debug/raw payloads');
      const databaseCloseout = createDatabase(scenario.databasePath);
      try {
        const saved = databaseCloseout.db.select().from(interviewSessions)
          .where(eq(interviewSessions.sessionId, scenario.sessionId)).get();
        const refs = JSON.parse(saved?.closeoutResultJson ?? '{}') as Record<string, unknown>;
        assert.deepEqual(Object.keys(refs).sort(), ['current_story_source_message_ids', 'model_metadata', 'new_stories']);
        assert.equal(JSON.stringify(refs).includes(newStory.summary), false, 'Story summary should not be duplicated in session JSON');
      } finally { databaseCloseout.close(); }
      assert.deepEqual((result.transcript as Array<Record<string, unknown>>).map((message) => message.message_id), scenario.initialTranscript.map((message) => message.message_id));
      const retry = await realFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/closeout`, { method: 'POST' });
      assert.equal(retry.status, 200);
      const database = createDatabase(scenario.databasePath);
      try {
        assert.equal(database.db.select().from(stories).all().length, 7);
        const primary = database.db.select().from(stories).where(eq(stories.storyId, scenario.storyId)).get();
        assert.match(primary?.agentMemory ?? '', /信息没有对齐/);
        const createdStory = database.db.select().from(stories).where(eq(stories.createdSourceSessionId, scenario.sessionId)).get();
        assert.equal(createdStory?.agentMemory, createdStory?.summary);
        const savedSession = database.db.select().from(interviewSessions)
          .where(eq(interviewSessions.sessionId, scenario.sessionId)).get();
        assert.equal(savedSession?.status, 'completed');
        assert.equal(savedSession?.closeoutStatus, 'completed');
        assert.equal(savedSession?.transcriptJson, JSON.stringify(scenario.initialTranscript));
        assert.equal('sessionSummary' in (savedSession ?? {}), false);
      } finally { database.close(); }
    } finally { await closeServer(server); }
  });
});

test('Story continuation accepts four independent Story Seeds across same and other stages and evaluates all of them', async () => {
  const scenario = prepareScenario(
    true,
    '这次项目上线后我们做了跨团队复盘，我还在一次会议里第一次公开反驳负责人。后来另一个人生阶段里，我搬到新城市做过第一份兼职，也第一次独自处理过家庭突发事件。',
  );
  const evaluatedStoryIds: string[] = [];
  await withPlanStub(async (_call, body) => {
    const messages = body.messages as Array<Record<string, unknown>>;
    const userPayload = JSON.parse(String(messages.find((message) => message.role === 'user')?.content)) as Record<string, unknown>;
    const stages = userPayload.life_stages as Array<Record<string, unknown>>;
    const currentStageAlias = String(userPayload.current_stage_id);
    const otherStageAlias = String(stages.find((stage) => String(stage.stage_id) !== currentStageAlias)?.stage_id ?? '');
    assert.ok(otherStageAlias, 'seed fixture must expose another Life Stage alias');
    return planResponse(JSON.stringify({
      current_story: {
        summary: `${scenario.initialSummary} ${scenario.userText}`,
        agent_memory: `${scenario.initialAgentMemory} ${scenario.userText}`,
        memory_changes: [{
          type: 'add',
          previous_text: '',
          new_text: scenario.userText,
          source_message_ids: ['u1'],
        }],
        source_message_ids: ['u1'],
      },
      new_stories: [
        {
          title: '项目上线后的第一次跨团队复盘',
          summary: '项目上线后，团队做了一次跨团队复盘。',
          stage_id: currentStageAlias,
          source_message_ids: ['u1'],
        },
        {
          title: '会议里第一次公开反驳负责人',
          summary: '一次会议中，我第一次公开反驳负责人。',
          stage_id: currentStageAlias,
          source_message_ids: ['u1'],
        },
        {
          title: '搬到新城市后的第一份兼职',
          summary: '后来在另一个人生阶段，我搬到新城市并做过第一份兼职。',
          stage_id: otherStageAlias,
          source_message_ids: ['u1'],
        },
        {
          title: '第一次独自处理家庭突发事件',
          summary: '另一个人生阶段里，我第一次独自处理过家庭突发事件。',
          stage_id: otherStageAlias,
          source_message_ids: ['u1'],
        },
      ],
    }));
  }, async (realFetch) => {
    const { server, baseUrl } = await startServer(
      scenario.databasePath,
      'test-closeout-secret',
      5_000,
      { evaluate: async (_userId, storyId) => {
        evaluatedStoryIds.push(storyId);
        return { status: 'interviewing', gaps: ['还可以继续补充细节'] };
      } },
    );
    try {
      const started = await realFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/closeout`, { method: 'POST' });
      assert.equal(started.status, 202);
      let result = await waitForResult(realFetch, baseUrl, scenario.sessionId);
      for (let index = 0; index < 100 && evaluatedStoryIds.length < 5; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      result = await (await realFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/result`)).json() as Record<string, unknown>;
      const created = result.newStories as Array<Record<string, unknown>>;
      assert.equal(created.length, 4, 'the new max must remain above the legacy max=3');
      assert.equal(new Set(created.map((story) => String(story.stage_id))).size, 2,
        'Story Seeds may stay in the current stage or attach to another existing stage');
      assert.deepEqual(
        new Set(evaluatedStoryIds),
        new Set([scenario.storyId, ...created.map((story) => String(story.story_id))]),
        'Completion must run for the current Story and every created Story Seed',
      );
      assert.equal(evaluatedStoryIds.length, 5);
      const database = createDatabase(scenario.databasePath);
      try {
        assert.equal(
          database.db.select().from(stories).where(eq(stories.createdSourceSessionId, scenario.sessionId)).all().length,
          4,
        );
      } finally { database.close(); }
    } finally { await closeServer(server); }
  });
});

test('Completion failure after Closeout leaves the saved Closeout result completed', async () => {
  const scenario = prepareScenario();
  let completionCalls = 0;
  await withPlanStub(async () => planResponse(JSON.stringify(modelOutput(scenario))), async (realFetch) => {
    const { server, baseUrl } = await startServer(
      scenario.databasePath,
      'test-closeout-secret',
      5_000,
      { evaluate: async () => { completionCalls += 1; throw new Error('synthetic completion failure'); } },
    );
    try {
      const started = await realFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/closeout`, { method: 'POST' });
      assert.ok(started.status === 202 || started.status === 200);
      const result = await waitForResult(realFetch, baseUrl, scenario.sessionId);
      assert.equal(result.closeoutStatus, 'completed');
      assert.equal(completionCalls, 1);
      const database = createDatabase(scenario.databasePath);
      try {
        const story = database.db.select().from(stories).where(eq(stories.storyId, scenario.storyId)).get();
        const session = database.db.select().from(interviewSessions)
          .where(eq(interviewSessions.sessionId, scenario.sessionId)).get();
        assert.notEqual(story?.summary, scenario.initialSummary, 'Closeout summary is already committed');
        assert.equal(session?.closeoutStatus, 'completed', 'derived Completion errors must not mark Closeout failed');
      } finally { database.close(); }
    } finally { await closeServer(server); }
  });
});

test('one Completion failure does not stop later Story Seed evaluations or roll back Closeout', async () => {
  const scenario = prepareScenario();
  const completionCalls: string[] = [];
  await withPlanStub(async (_call, body) => {
    const messages = body.messages as Array<Record<string, unknown>>;
    const userPayload = JSON.parse(String(messages.find((message) => message.role === 'user')?.content)) as Record<string, unknown>;
    const currentStageAlias = String(userPayload.current_stage_id);
    return planResponse(JSON.stringify({
      current_story: {
        summary: `${scenario.initialSummary} ${scenario.userText}`,
        agent_memory: `${scenario.initialAgentMemory} ${scenario.userText}`,
        memory_changes: [{
          type: 'add',
          previous_text: '',
          new_text: scenario.userText,
          source_message_ids: ['u1'],
        }],
        source_message_ids: ['u1'],
      },
      new_stories: [{
        title: '另一次独立的跨团队经历',
        summary: '用户还提到另一次独立的跨团队经历。',
        stage_id: currentStageAlias,
        source_message_ids: ['u1'],
      }],
    }));
  }, async (realFetch) => {
    const { server, baseUrl } = await startServer(
      scenario.databasePath,
      'test-closeout-secret',
      5_000,
      { evaluate: async (_userId, storyId) => {
        completionCalls.push(storyId);
        if (storyId === scenario.storyId) throw new Error('synthetic primary completion failure');
        return { status: 'interviewing', gaps: ['继续补充过程'] };
      } },
    );
    try {
      const started = await realFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/closeout`, { method: 'POST' });
      assert.equal(started.status, 202);
      let result = await waitForResult(realFetch, baseUrl, scenario.sessionId);
      for (let index = 0; index < 100 && completionCalls.length < 2; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      result = await (await realFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/result`)).json() as Record<string, unknown>;
      const created = result.newStories as Array<Record<string, unknown>>;
      assert.equal(result.closeoutStatus, 'completed');
      assert.equal(created.length, 1);
      assert.deepEqual(
        completionCalls,
        [scenario.storyId, String(created[0]?.story_id)],
        'workflow must continue evaluating later Story Seeds after one Completion failure',
      );
      const database = createDatabase(scenario.databasePath);
      try {
        const session = database.db.select().from(interviewSessions)
          .where(eq(interviewSessions.sessionId, scenario.sessionId)).get();
        assert.equal(session?.closeoutStatus, 'completed');
        assert.equal(
          database.db.select().from(stories).where(eq(stories.createdSourceSessionId, scenario.sessionId)).all().length,
          1,
        );
      } finally { database.close(); }
    } finally { await closeServer(server); }
  });
});

test('result reports post-Closeout Story Completion while it is still running', async () => {
  const scenario = prepareScenario();
  let releaseCompletion!: () => void;
  let markCompletionStarted!: () => void;
  const completionStarted = new Promise<void>((resolve) => { markCompletionStarted = resolve; });
  const completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve; });
  await withPlanStub(async () => planResponse(JSON.stringify(modelOutput(scenario))), async (realFetch) => {
    const { server, baseUrl } = await startServer(scenario.databasePath, 'test-closeout-secret', 5_000, {
      evaluate: async () => {
        markCompletionStarted();
        await completionGate;
        return { status: 'interviewing', gaps: [] };
      },
    });
    try {
      const started = await realFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/closeout`, { method: 'POST' });
      assert.equal(started.status, 202);
      await completionStarted;

      const pending = await waitForResult(realFetch, baseUrl, scenario.sessionId);
      assert.equal(pending.closeoutStatus, 'completed');
      assert.equal(pending.storyCompletionPending, true);
      const database = createDatabase(scenario.databasePath);
      try {
        const session = database.db.select().from(interviewSessions)
          .where(eq(interviewSessions.sessionId, scenario.sessionId)).get();
        assert.equal(session?.closeoutStatus, 'completed', 'Completion running must not delay or rewrite saved Closeout');
      } finally { database.close(); }

      releaseCompletion();
      let finished: Record<string, unknown> | undefined;
      for (let index = 0; index < 300; index += 1) {
        const response = await realFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/result`);
        finished = await response.json() as Record<string, unknown>;
        if (finished.storyCompletionPending === false) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(finished?.storyCompletionPending, false, 'the transient flag clears after evaluation ends');
      assert.equal(finished?.closeoutStatus, 'completed');
    } finally {
      releaseCompletion();
      await closeServer(server);
    }
  });
});

test('a short supplement is merged into one complete Story Summary without sidecar structures', async () => {
  const oldSummary = '2019年我第一次独自搬到上海生活。';
  const userText = '大概是2019年春天，关上出租屋门时我既害怕，也第一次觉得自己真正自由了。';
  const scenario = prepareScenario(true, userText, oldSummary);
  const refinedMemory = '大概在2019年春天，我第一次独自搬到上海租房生活。关上出租屋家门时，我既有些害怕，也第一次强烈感受到独立生活带来的自由。';
  const output = modelOutput(scenario, {
    summary: refinedMemory,
    agentMemory: refinedMemory,
    memoryChanges: [{
      type: 'refine',
      previous_text: oldSummary,
      new_text: refinedMemory,
      source_message_ids: ['u1'],
    }],
    newStories: [],
  });
  let schemaProperties: string[] = [];
  const result = await runCloseoutResponse(scenario, output, (body) => {
    const definition = (body.tools as Array<Record<string, unknown>>)[0]!.function as Record<string, unknown>;
    schemaProperties = Object.keys((definition.parameters as Record<string, unknown>).properties as Record<string, unknown>).sort();
    const messages = body.messages as Array<Record<string, unknown>>;
    const userPayload = JSON.parse(String(messages.find((message) => message.role === 'user')?.content)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(userPayload).sort(), ['current_stage_id', 'current_story', 'life_stages', 'other_stories', 'transcript']);
    assert.equal('session_summary' in userPayload, false);
    assert.equal('story_state' in (userPayload.current_story as Record<string, unknown>), false);
  });
  assert.equal(result.closeoutStatus, 'completed');
  assert.deepEqual(schemaProperties, ['current_story', 'new_stories']);
  const database = createDatabase(scenario.databasePath);
  try {
    const story = database.db.select().from(stories).where(eq(stories.storyId, scenario.storyId)).get();
    const session = database.db.select().from(interviewSessions).where(eq(interviewSessions.sessionId, scenario.sessionId)).get();
    assert.equal(story?.summary, output.current_story && (output.current_story as Record<string, unknown>).summary);
    assert.equal(story?.agentMemory, output.current_story && (output.current_story as Record<string, unknown>).agent_memory);
    assert.equal(database.db.select().from(stories).all().length, 6);
    assert.equal(session?.transcriptJson, JSON.stringify(scenario.initialTranscript));
  } finally { database.close(); }
});

test('an explicit correction replaces the old year while the original Transcript remains intact', async () => {
  const oldSummary = '2019年我第一次独自搬到上海生活。';
  const userText = '我刚才记错了，其实不是2019年，是2020年春天。我第一次独自搬到上海生活。';
  const scenario = prepareScenario(true, userText, oldSummary);
  const correctedMemory = '2020年春天，我第一次独自搬到上海生活。';
  const output = modelOutput(scenario, {
    summary: correctedMemory,
    agentMemory: correctedMemory,
    memoryChanges: [{
      type: 'correct',
      previous_text: oldSummary,
      new_text: correctedMemory,
      source_message_ids: ['u1'],
    }],
    newStories: [],
  });
  const result = await runCloseoutResponse(scenario, output);
  assert.equal(result.closeoutStatus, 'completed');
  const database = createDatabase(scenario.databasePath);
  try {
    const story = database.db.select().from(stories).where(eq(stories.storyId, scenario.storyId)).get();
    const session = database.db.select().from(interviewSessions).where(eq(interviewSessions.sessionId, scenario.sessionId)).get();
    assert.equal(story?.summary, '2020年春天，我第一次独自搬到上海生活。');
    assert.equal(story?.agentMemory, '2020年春天，我第一次独自搬到上海生活。');
    assert.doesNotMatch(story?.summary ?? '', /2019年/);
    assert.doesNotMatch(story?.agentMemory ?? '', /2019年/);
    assert.equal(session?.transcriptJson, JSON.stringify(scenario.initialTranscript));
    assert.match(session?.transcriptJson ?? '', /不是2019年，是2020年/);
    assert.equal(database.db.select().from(stories).where(eq(stories.createdSourceSessionId, scenario.sessionId)).all().length, 0);
  } finally { database.close(); }
});

test('a one-line unrelated mention is ignored without creating a candidate or touching the Story timestamp', async () => {
  const oldSummary = '我在南京参与过社区志愿服务。';
  const scenario = prepareScenario(true, '后来我还去北京工作过。', oldSummary);
  const databaseBefore = createDatabase(scenario.databasePath);
  const priorUpdatedAt = databaseBefore.db.select().from(stories).where(eq(stories.storyId, scenario.storyId)).get()!.updatedAt;
  databaseBefore.close();
  const output = modelOutput(scenario, { summary: oldSummary, sourceMessageIds: [], newStories: [] });
  const result = await runCloseoutResponse(scenario, output);
  assert.equal(result.closeoutStatus, 'completed');
  assert.equal((result.newStories as unknown[]).length, 0);
  const database = createDatabase(scenario.databasePath);
  try {
    const story = database.db.select().from(stories).where(eq(stories.storyId, scenario.storyId)).get();
    assert.equal(story?.summary, oldSummary);
    assert.equal(story?.updatedAt, priorUpdatedAt);
    assert.equal(database.db.select().from(stories).all().length, 6);
    assert.equal(database.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='story_candidates'").get(), undefined);
  } finally { database.close(); }
});

test('result parsing strips legacy Story State and unapproved nested closeout fields', () => {
  const scenario = prepareScenario();
  const database = createDatabase(scenario.databasePath);
  try {
    database.db.update(interviewSessions).set({ closeoutResultJson: JSON.stringify({
      previous_story_state: { private_notes: 'legacy sidecar' },
      current_story_source_message_ids: [scenario.userMessageId],
      new_stories: [{ story_id: 'not-created', source_message_ids: [scenario.userMessageId], summary: 'duplicated story text' }],
      model_metadata: { model: 'test-model', prompt: 'must not survive', response_id: 'resp_test' },
      processing_attempt_id: 'expired-attempt',
    }) }).where(eq(interviewSessions.sessionId, scenario.sessionId)).run();
  } finally { database.close(); }

  const result = getInterviewCloseoutResult(scenario.databasePath, scenario.sessionId, scenario.userId);
  assert.equal('closeoutResult' in result, false);
  assert.equal('debug' in result, false);
  assert.deepEqual(result.currentStorySourceMessageIds, [scenario.userMessageId]);
  assert.deepEqual(result.modelMetadata, { model: 'test-model', response_id: 'resp_test' });
  assert.deepEqual(result.newStories, []);
});

test('invalid source IDs and unsupported years trigger repairs before any persistence', async () => {
  const scenario = prepareScenario();
  const otherCore = createStoryInterviewCore(scenario.databasePath);
  const otherContext = otherCore.prepare(seedIds.user, { mode: 'continue', storyId: scenario.storyId });
  const otherSession = otherCore.start(seedIds.user, otherContext, 'stepfun');
  const otherMessage = new TranscriptRepository(scenario.databasePath).appendForSession(scenario.userId, otherSession.sessionId, {
    role: 'user',
    text: '这是另一次访谈里的来源，不应被当前会话引用。',
    provider: 'stepfun',
    providerMessageId: 'other-session-user-1',
  });
  const otherSessionMessageId = otherMessage.message_id;
  assert.ok(otherSessionMessageId);
  let calls = 0;
  await withPlanStub(async (_call, body) => {
    calls += 1;
    const reply = calls === 1
      ? modelOutput(scenario, { sourceMessageIds: [otherSessionMessageId] })
      : calls === 2
        ? modelOutput(scenario, { summary: `${scenario.initialSummary} 2099年发生了变化。` })
        : modelOutput(scenario);
    const userPrompt = JSON.parse(String((body.messages as Array<Record<string, unknown>>).find((message) => message.role === 'user')?.content)) as Record<string, unknown>;
    if (calls === 2) assert.equal((userPrompt.retry_feedback as Record<string, unknown>)?.code, 'INVALID_SOURCE_MESSAGE_IDS');
    if (calls === 3) assert.equal((userPrompt.retry_feedback as Record<string, unknown>)?.code, 'UNSUPPORTED_YEAR');
    return planResponse(JSON.stringify(reply));
  }, async (realFetch, callCount) => {
    const { server, baseUrl } = await startServer(scenario.databasePath);
    try {
      await realFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/closeout`, { method: 'POST' });
      const result = await waitForResult(realFetch, baseUrl, scenario.sessionId);
      assert.equal(result.closeoutStatus, 'completed');
      assert.equal(callCount(), 3);
      const database = createDatabase(scenario.databasePath);
      try {
        const story = database.db.select().from(stories).where(eq(stories.storyId, scenario.storyId)).get();
        assert.match(story?.summary ?? '', /信息没有对齐/);
        assert.doesNotMatch(story?.summary ?? '', /2099年/);
      } finally { database.close(); }
    } finally { await closeServer(server); }
  });
});

test('silent Agent Memory information loss is repaired before persistence', async () => {
  const oldMemory = '2019年我第一次独自搬到上海生活。父亲当时帮我搬家。';
  const scenario = prepareScenario(
    true,
    '我刚才记错了，不是2019年，是2020年搬到上海。父亲帮我搬家这件事没有变化。',
    oldMemory,
  );
  let calls = 0;
  await withPlanStub(async (_call, body) => {
    calls += 1;
    const userPrompt = JSON.parse(String((body.messages as Array<Record<string, unknown>>)
      .find((message) => message.role === 'user')?.content)) as Record<string, unknown>;
    if (calls === 2) {
      assert.equal((userPrompt.retry_feedback as Record<string, unknown>)?.code, 'MEMORY_INFORMATION_LOSS');
    }
    const correctedSentence = '2020年我第一次独自搬到上海生活。';
    return planResponse(JSON.stringify({
      current_story: {
        summary: calls === 1
          ? correctedSentence
          : `${correctedSentence}父亲当时帮我搬家。`,
        agent_memory: calls === 1
          ? correctedSentence
          : `${correctedSentence}父亲当时帮我搬家。`,
        memory_changes: [{
          type: 'correct',
          previous_text: '2019年我第一次独自搬到上海生活。',
          new_text: correctedSentence,
          source_message_ids: ['u1'],
        }],
        source_message_ids: ['u1'],
      },
      new_stories: [],
    }));
  }, async (realFetch, callCount) => {
    const { server, baseUrl } = await startServer(scenario.databasePath);
    try {
      await realFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/closeout`, { method: 'POST' });
      const result = await waitForResult(realFetch, baseUrl, scenario.sessionId);
      assert.equal(result.closeoutStatus, 'completed');
      assert.equal(callCount(), 2);
      assert.equal(calls, 2);
      assert.equal((result.modelMetadata as Record<string, unknown>).repair_attempt_count, 1);
      const database = createDatabase(scenario.databasePath);
      try {
        const story = database.db.select().from(stories).where(eq(stories.storyId, scenario.storyId)).get();
        assert.match(story?.agentMemory ?? '', /2020年/);
        assert.match(story?.agentMemory ?? '', /父亲当时帮我搬家/);
        assert.doesNotMatch(story?.agentMemory ?? '', /2019年/);
      } finally { database.close(); }
    } finally { await closeServer(server); }
  });
});

test('a transient network failure is retried before any database writes', async () => {
  const scenario = prepareScenario();
  await withPlanStub(async (call, _body) => {
    if (call === 1) throw new TypeError('synthetic socket reset');
    const database = createDatabase(scenario.databasePath);
    try {
      const story = database.db.select().from(stories).where(eq(stories.storyId, scenario.storyId)).get();
      assert.equal(story?.summary, scenario.initialSummary);
      assert.equal(database.db.select().from(stories).where(eq(stories.createdSourceSessionId, scenario.sessionId)).all().length, 0);
    } finally { database.close(); }
    return planResponse(JSON.stringify(modelOutput(scenario)));
  }, async (realFetch, callCount) => {
    const { server, baseUrl } = await startServer(scenario.databasePath);
    try {
      await realFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/closeout`, { method: 'POST' });
      const result = await waitForResult(realFetch, baseUrl, scenario.sessionId);
      assert.equal(result.closeoutStatus, 'completed');
      assert.equal(callCount(), 2);
      assert.equal((result.modelMetadata as Record<string, unknown>).repair_attempt_count, 1);
    } finally { await closeServer(server); }
  });
});

test('truncated structured output doubles the token budget and retries without partial writes', async () => {
  const scenario = prepareScenario();
  const requestedTokenBudgets: number[] = [];
  await withPlanStub(async (call, body) => {
    requestedTokenBudgets.push(Number(body.max_tokens));
    if (call === 1) return planResponse('{"partial":', { finishReason: 'length' });
    const database = createDatabase(scenario.databasePath);
    try {
      const story = database.db.select().from(stories).where(eq(stories.storyId, scenario.storyId)).get();
      assert.equal(story?.summary, scenario.initialSummary);
      assert.equal(database.db.select().from(stories).where(eq(stories.createdSourceSessionId, scenario.sessionId)).all().length, 0);
    } finally { database.close(); }
    return planResponse(JSON.stringify(modelOutput(scenario)));
  }, async (realFetch, callCount) => {
    const { server, baseUrl } = await startServer(scenario.databasePath);
    try {
      await realFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/closeout`, { method: 'POST' });
      const result = await waitForResult(realFetch, baseUrl, scenario.sessionId);
      assert.equal(result.closeoutStatus, 'completed');
      assert.equal(callCount(), 2);
      assert.deepEqual(requestedTokenBudgets, [8_192, 16_384]);
      assert.equal((result.modelMetadata as Record<string, unknown>).repair_attempt_count, 1);
    } finally { await closeServer(server); }
  });
});

test('a timed-out model request is retried and the result remains atomic', async () => {
  const scenario = prepareScenario();
  await withPlanStub(async (call, _body, init) => {
    if (call === 1) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('synthetic timeout')), { once: true });
      });
    }
    const database = createDatabase(scenario.databasePath);
    try {
      const story = database.db.select().from(stories).where(eq(stories.storyId, scenario.storyId)).get();
      assert.equal(story?.summary, scenario.initialSummary);
    } finally { database.close(); }
    return planResponse(JSON.stringify(modelOutput(scenario)));
  }, async (realFetch, callCount) => {
    const { server, baseUrl } = await startServer(scenario.databasePath, 'test-closeout-secret', 25);
    try {
      await realFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/closeout`, { method: 'POST' });
      const result = await waitForResult(realFetch, baseUrl, scenario.sessionId);
      assert.equal(result.closeoutStatus, 'completed');
      assert.equal(callCount(), 2);
      assert.equal((result.modelMetadata as Record<string, unknown>).repair_attempt_count, 1);
    } finally { await closeServer(server); }
  });
});

test('missing model credentials fail terminally before a provider request or partial write', async () => {
  const scenario = prepareScenario();
  await withPlanStub(async () => { throw new Error('provider must not be called'); }, async (realFetch, callCount) => {
    const { server, baseUrl } = await startServer(scenario.databasePath, '');
    try {
      const started = await realFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/closeout`, { method: 'POST' });
      assert.ok(started.status === 422 || started.status === 202);
      const result = await waitForResult(realFetch, baseUrl, scenario.sessionId);
      assert.equal(result.closeoutStatus, 'failed');
      assert.equal(result.errorCode, 'LLM_NOT_CONFIGURED');
      assert.equal(result.retryable, false);
      assert.equal(callCount(), 0);
      const database = createDatabase(scenario.databasePath);
      try {
        const story = database.db.select().from(stories).where(eq(stories.storyId, scenario.storyId)).get();
        assert.equal(story?.summary, scenario.initialSummary);
        assert.equal(database.db.select().from(stories).where(eq(stories.createdSourceSessionId, scenario.sessionId)).all().length, 0);
      } finally { database.close(); }
    } finally { await closeServer(server); }
  });
});

test('Agent runtime and exhausted proposal repairs remain manually retryable', async () => {
  const cases = [
    { error: Object.assign(new Error('timeout'), { code: 'AGENT_RUNTIME_TIMEOUT' }), code: 'AGENT_RUNTIME_TIMEOUT', retryable: true },
    { error: Object.assign(new Error('exec failed'), { code: 'AGENT_RUNTIME_EXEC_FAILED' }), code: 'AGENT_RUNTIME_EXEC_FAILED', retryable: true },
    { error: Object.assign(new Error('invalid result'), { code: 'AGENT_RESULT_INVALID' }), code: 'AGENT_RESULT_INVALID', retryable: true },
    {
      error: Object.assign(new Error('proposal rejected'), {
        name: 'AgentProposalValidationError',
        feedback: [{ code: 'INVALID_SOURCE_MESSAGE_IDS' }],
      }),
      code: 'INVALID_SOURCE_MESSAGE_IDS',
      retryable: true,
    },
    { error: Object.assign(new Error('runtime configuration is invalid'), { code: 'AGENT_TASK_OUTPUT_INVALID' }), code: 'AGENT_TASK_OUTPUT_INVALID', retryable: false },
  ] as const;

  for (const item of cases) {
    const scenario = prepareScenario();
    beginInterviewCloseout(
      scenario.databasePath,
      scenario.sessionId,
      { apiKey: 'test-closeout-secret' },
      scenario.userId,
      { processor: { process: async () => { throw item.error; } } },
    );
    const result = await waitForStoredResult(scenario.databasePath, scenario.sessionId, scenario.userId);
    assert.equal(result.closeoutStatus, 'failed');
    assert.equal(result.errorCode, item.code);
    assert.equal(result.retryable, item.retryable, item.code);
  }
});

test('a stale processing lease is reclaimed and completed by the new attempt', async () => {
  const scenario = prepareScenario();
  const database = createDatabase(scenario.databasePath);
  try {
    database.db.update(interviewSessions).set({
      closeoutStatus: 'processing',
      closeoutResultJson: JSON.stringify({ processing_attempt_id: 'expired-test-attempt' }),
      updatedAt: '2000-01-01T00:00:00.000Z',
    }).where(eq(interviewSessions.sessionId, scenario.sessionId)).run();
  } finally { database.close(); }

  await withPlanStub(async () => planResponse(JSON.stringify(modelOutput(scenario))), async (_realFetch, callCount) => {
    const claimed = beginInterviewCloseout(scenario.databasePath, scenario.sessionId, {
      apiKey: 'test-closeout-secret',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      apiFormat: 'chat-completions',
      model: 'doubao-seed-2-1-turbo-260628',
      timeoutMs: 5_000,
      provider: 'test-provider',
    }, scenario.userId);
    assert.equal(claimed.status, 'processing');
    assert.equal(claimed.alreadyProcessing, false);
    const result = await waitForStoredResult(scenario.databasePath, scenario.sessionId, scenario.userId);
    assert.equal(result.closeoutStatus, 'completed');
    assert.equal(callCount(), 1);
  });
});

test('a superseded processing attempt cannot persist its late model response', async () => {
  const scenario = prepareScenario();
  const realFetch = globalThis.fetch;
  let modelStartedResolve!: () => void;
  let resolveModelResponse!: (response: Response) => void;
  const modelStarted = new Promise<void>((resolve) => { modelStartedResolve = resolve; });
  globalThis.fetch = (async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== CHAT_ENDPOINT) return realFetch(input);
    modelStartedResolve();
    return new Promise<Response>((resolve) => { resolveModelResponse = resolve; });
  }) as typeof fetch;
  const authenticatedFetch = withTestAuth(realFetch);
  const { server, baseUrl } = await startServer(scenario.databasePath);
  try {
    await authenticatedFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/closeout`, { method: 'POST' });
    await modelStarted;
    const database = createDatabase(scenario.databasePath);
    try {
      database.db.update(interviewSessions).set({
        closeoutStatus: 'processing',
        closeoutResultJson: JSON.stringify({ processing_attempt_id: 'superseding-test-attempt' }),
      }).where(eq(interviewSessions.sessionId, scenario.sessionId)).run();
    } finally { database.close(); }
    resolveModelResponse(planResponse(JSON.stringify(modelOutput(scenario))));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const verify = createDatabase(scenario.databasePath);
    try {
      const story = verify.db.select().from(stories).where(eq(stories.storyId, scenario.storyId)).get();
      const session = verify.db.select().from(interviewSessions)
        .where(eq(interviewSessions.sessionId, scenario.sessionId)).get();
      assert.equal(story?.summary, scenario.initialSummary);
      assert.equal(verify.db.select().from(stories).where(eq(stories.createdSourceSessionId, scenario.sessionId)).all().length, 0);
      assert.equal(session?.closeoutStatus, 'processing');
      assert.equal(JSON.parse(session?.closeoutResultJson ?? '{}').processing_attempt_id, 'superseding-test-attempt');
    } finally { verify.close(); }
  } finally {
    globalThis.fetch = realFetch;
    await closeServer(server);
  }
});

test('a model request can be cancelled without partially changing Story or Session data', async () => {
  const scenario = prepareScenario();
  const realFetch = globalThis.fetch;
  let modelStartedResolve!: () => void;
  const modelStarted = new Promise<void>((resolve) => { modelStartedResolve = resolve; });
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== CHAT_ENDPOINT) return realFetch(input, init);
    modelStartedResolve();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }) as typeof fetch;
  const authenticatedFetch = withTestAuth(realFetch);
  const { server, baseUrl } = await startServer(scenario.databasePath);
  try {
    await authenticatedFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/closeout`, { method: 'POST' });
    await modelStarted;
    const cancelled = await authenticatedFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/closeout/cancel`, { method: 'POST' });
    assert.equal(cancelled.status, 202);
    const result = await waitForResult(authenticatedFetch, baseUrl, scenario.sessionId);
    assert.equal(result.closeoutStatus, 'failed');
    assert.equal(result.errorCode, 'CLOSEOUT_CANCELLED');
    const database = createDatabase(scenario.databasePath);
    try {
      const story = database.db.select().from(stories).where(eq(stories.storyId, scenario.storyId)).get();
      const session = database.db.select().from(interviewSessions).where(eq(interviewSessions.sessionId, scenario.sessionId)).get();
      assert.equal(story?.summary, scenario.initialSummary);
      assert.equal(session?.status, 'ended');
      assert.equal(session?.closeoutStatus, 'failed');
    } finally { database.close(); }
  } finally {
    globalThis.fetch = realFetch;
    await closeServer(server);
  }
});

test('an empty transcript is explicitly marked empty and is not offered a blind retry', async () => {
  const scenario = prepareScenario(false);
  await withPlanStub(async () => { throw new Error('model must not be called'); }, async (realFetch, calls) => {
    const { server, baseUrl } = await startServer(scenario.databasePath);
    try {
      const started = await realFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/closeout`, { method: 'POST' });
      assert.ok(started.status === 202 || started.status === 422);
      const result = await waitForResult(realFetch, baseUrl, scenario.sessionId);
      assert.equal(result.closeoutStatus, 'failed');
      assert.equal(result.errorCode, 'TRANSCRIPT_EMPTY');
      assert.equal(result.retryable, false);
      await realFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/closeout`, { method: 'POST' });
      assert.equal(calls(), 0);
    } finally { await closeServer(server); }
  });
});

test('Story Closeout stops after three retryable invalid model outputs and writes nothing', async () => {
  const scenario = prepareScenario();
  await withPlanStub(async () => planResponse(JSON.stringify(modelOutput(scenario, { summary: `${scenario.initialSummary} 2099年发生了变化。` }))), async (realFetch, callCount) => {
    const { server, baseUrl } = await startServer(scenario.databasePath);
    try {
      await realFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/closeout`, { method: 'POST' });
      const result = await waitForResult(realFetch, baseUrl, scenario.sessionId);
      assert.equal(result.closeoutStatus, 'failed'); assert.equal(callCount(), 3);
      const database = createDatabase(scenario.databasePath);
      try { const story = database.db.select().from(stories).where(eq(stories.storyId, scenario.storyId)).get(); assert.equal(story?.summary, scenario.initialSummary); assert.equal(story?.agentMemory, scenario.initialAgentMemory); }
      finally { database.close(); }
    } finally { await closeServer(server); }
  });
});

test('Story Closeout preserves previous gaps when Completion fails after a successful closeout', async () => {
  const scenario = prepareScenario(); const previousGaps = ['项目上线前最让你担心的具体问题是什么？'];
  const setup = createDatabase(scenario.databasePath);
  try { setup.db.update(stories).set({ gapsJson: JSON.stringify(previousGaps) }).where(eq(stories.storyId, scenario.storyId)).run(); } finally { setup.close(); }
  await withPlanStub(async () => planResponse(JSON.stringify(modelOutput(scenario))), async (realFetch) => {
    const { server, baseUrl } = await startServer(scenario.databasePath, 'test-closeout-secret', 5_000, { evaluate: async () => { throw new Error('synthetic completion failure'); } });
    try {
      await realFetch(`${baseUrl}/api/interview-sessions/${scenario.sessionId}/closeout`, { method: 'POST' });
      const result = await waitForResult(realFetch, baseUrl, scenario.sessionId); assert.equal(result.closeoutStatus, 'completed');
      const database = createDatabase(scenario.databasePath);
      try { const story = database.db.select().from(stories).where(eq(stories.storyId, scenario.storyId)).get(); assert.deepEqual(JSON.parse(story?.gapsJson ?? '[]'), previousGaps); assert.notEqual(story?.summary, scenario.initialSummary); }
      finally { database.close(); }
    } finally { await closeServer(server); }
  });
});
