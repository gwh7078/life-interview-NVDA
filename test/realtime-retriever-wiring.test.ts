import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { after, test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { stories } from '../src/db/schema.js';
import type { AgentTaskPort } from '../src/agent-tasks/ports/agent-task-port.js';
import { parseQwenServerEvent } from '../src/realtime/qwen.js';
import type { NormalizedRealtimeEvent } from '../src/realtime/types.js';
import type { RealtimeCoachPort } from '../src/realtime/coach/types.js';
import type { CoachGateInput, CoachGateResult, CoachResolveInput, CoachPacket } from '../src/realtime/coach/types.js';
import type { RetrieverAdapter } from '../src/retriever/types.js';
import type { EraContextAdapter, EraContextSearchInput } from '../src/era-context/types.js';
import { EraContextClient } from '../src/era-context/client.js';
import { StoryShareRepository } from '../src/repositories/story-share-repository.js';
import { createInterviewServiceServer } from '../src/server.js';

type JsonRecord = Record<string, unknown>;
type TriggerMode = 'voice_tool' | 'supervisor_auto';

const temporaryDirectories: string[] = [];

after(() => temporaryDirectories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function normalize(raw: unknown): NormalizedRealtimeEvent[] {
  const event = record(parseQwenServerEvent(raw));
  if (!event) return [];
  const type = String(event.type ?? '');
  if (type === 'session.updated') {
    return [
      { type: 'session.configured', turnDetectionMode: 'manual' },
      { type: 'session.ready', providerSessionId: 'mock-session' },
    ];
  }
  if (type === 'response.created') {
    const response = record(event.response);
    return [{ type: 'assistant.started', responseId: String(response?.id ?? 'opening') }];
  }
  if (type === 'response.done') {
    const response = record(event.response);
    return [{
      type: 'response.done',
      responseId: String(response?.id ?? 'opening'),
      status: String(response?.status ?? 'completed'),
    }];
  }
  if (type === 'input_audio_buffer.speech_started') return [{ type: 'speech.started' }];
  if (type === 'conversation.item.input_audio_transcription.completed') {
    return [{
      type: 'user.transcript.final',
      itemId: String(event.item_id ?? 'turn-1'),
      text: String(event.transcript ?? ''),
    }];
  }
  if (type === 'response.function_call_arguments.done') {
    const rawArguments = String(event.arguments ?? '{}');
    return [{
      type: 'tool.call.requested',
      name: String(event.name ?? 'get_interview_context'),
      callId: String(event.call_id ?? 'call-1'),
      arguments: JSON.parse(rawArguments),
      rawArguments,
      responseId: String(event.response_id ?? 'tool-response'),
    }];
  }
  return [];
}

function waitFor<T>(promise: Promise<T>, timeoutMs = 2_000, label = 'Realtime wiring'): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Timed out waiting for ' + label + '.')), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function waitForMatch<T>(
  read: () => T[],
  predicate: (item: T, index: number) => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<T> {
  const found = read().find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      const next = read().find(predicate);
      if (next) {
        clearInterval(interval);
        clearTimeout(timeout);
        resolve(next);
      }
    }, 5);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error('Timed out waiting for ' + label + '.'));
    }, timeoutMs);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sendProviderEvent(socket: WebSocket | undefined, event: JsonRecord): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Mock Realtime provider is not connected.');
  socket.send(JSON.stringify(event));
}

interface FixtureOptions {
  realtimeMemoryTriggerMode: TriggerMode;
  realtimeSlowDeadlineMs?: number;
  manualTurnControl?: boolean;
  supportsContextInjection?: boolean;
  provider?: 'qwen' | 'stepaudio2_mini';
  coach?: RealtimeCoachPort;
  coachGateTimeoutMs?: number;
  coachTotalTimeoutMs?: number;
  retrieverDelayMs?: number;
  eraEnabled?: boolean;
  eraContext?: EraContextAdapter;
  storyAgentMemory?: string;
  autoCompleteResponses?: boolean;
}

interface ClientConnection {
  socket: WebSocket;
  messages: JsonRecord[];
}

async function createFixture(options: FixtureOptions) {
  const directory = mkdtempSync(path.resolve('data/test-tmp/realtime-retriever-wiring-'));
  temporaryDirectories.push(directory);
  const diagnosticsDirectory = path.join(directory, 'diagnostics');
  const previousDiagnosticsDirectory = process.env.DIAGNOSTICS_DIR;
  const previousCaptureContent = process.env.DIAGNOSTICS_CAPTURE_CONTENT;
  const previousEraContextEnabled = process.env.NEMO_ERA_CONTEXT_ENABLED;
  process.env.DIAGNOSTICS_DIR = diagnosticsDirectory;
  process.env.DIAGNOSTICS_CAPTURE_CONTENT = '1';
  process.env.NEMO_ERA_CONTEXT_ENABLED = options.eraEnabled === true ? 'true' : 'false';

  const databasePath = path.join(directory, 'memoir.db');
  const database = createDatabase(databasePath);
  try {
    runMigrations(database);
    seedDatabase(database);
    if (options.storyAgentMemory) {
      database.db.update(stories).set({ agentMemory: options.storyAgentMemory })
        .where(eq(stories.storyId, seedIds.firstProject)).run();
    }
  } finally {
    database.close();
  }
  const share = new StoryShareRepository(databasePath)
    .createForStory(seedIds.user, seedIds.firstProject, 'daughter');
  assert.ok(share);

  const searchInputs: Parameters<RetrieverAdapter['searchTranscript']>[0][] = [];
  const eraSearchInputs: EraContextSearchInput[] = [];
  const agentQueries: string[] = [];
  const coachGateInputs: CoachGateInput[] = [];
  const coachResolveInputs: CoachResolveInput[] = [];
  const toolResults: JsonRecord[] = [];
  const injectedHints: Array<{ hint: unknown; at: number }> = [];
  const providerMessages: JsonRecord[] = [];
  const clientConnections: ClientConnection[] = [];
  const providerSockets: WebSocket[] = [];
  let providerHttpClosed = false;
  let appServerClosed = false;
  let responseId = 0;
  let openingId = 0;

  const retriever: RetrieverAdapter = {
    async indexSessionTranscript() { return { status: 'accepted' }; },
    async searchTranscript(input) {
      searchInputs.push(input);
      if (options.retrieverDelayMs) await delay(options.retrieverDelayMs);
      if (input.query === 'retriever-failure') throw new Error('RETRIEVER_TEST_FAILURE');
      if (input.query === 'empty-evidence') return [];
      const answer = input.query.includes('拖欠工资')
        ? '1997 年厂里已经开始拖欠工资。'
        : '2013 年春节以后第一次到北京。';
      return [{
        text: `[segment_id=history-message][message_id=history-message][Q+A]\nQuestion (context only): ${input.query.includes('拖欠工资') ? '单位什么时候开始拖欠工资？' : '第一次去北京是什么时候？'}\nAnswer (user-provided fact): ${answer}`,
        score: 0.95,
        ownerId: input.ownerId,
        storyId: input.storyId ?? null,
        sourceType: 'subject',
        sessionId: 'history-session',
        messageIds: ['history-message'],
        segmentIds: [],
      }];
    },
    async deleteSessionTranscript(sessionId) { return { documentId: sessionId, status: 'deleted' }; },
    async getIndexStatus(sessionId) { return { documentId: sessionId, status: 'indexed' }; },
  };
  const eraContextClient: EraContextAdapter | undefined = options.eraContext ? {
    async search(input) {
      eraSearchInputs.push(input);
      return options.eraContext!.search(input);
    },
  } : undefined;

  const providerHttp = createServer();
  const providerServer = new WebSocketServer({ server: providerHttp });
  providerServer.on('connection', (socket) => {
    providerSockets.push(socket);
    socket.on('message', (raw) => {
      const message = record(JSON.parse(raw.toString()));
      if (!message) return;
      providerMessages.push(message);
      if (message.type === 'mock.setup') {
        socket.send(JSON.stringify({
          type: 'session.updated',
          session: { id: 'mock-session', turn_detection: null },
        }));
      } else if (message.type === 'mock.opening') {
        const id = 'opening-' + (++openingId);
        socket.send(JSON.stringify({ type: 'response.created', response: { id } }));
        socket.send(JSON.stringify({ type: 'response.done', response: { id, status: 'completed' } }));
      } else if (message.type === 'mock.tool_result') {
        toolResults.push(message);
      } else if (message.type === 'response.create') {
        const id = 'response-' + (++responseId);
        socket.send(JSON.stringify({ type: 'response.created', response: { id } }));
        if (options.autoCompleteResponses !== false) {
          socket.send(JSON.stringify({ type: 'response.done', response: { id, status: 'completed' } }));
        }
      }
    });
  });
  providerHttp.listen(0, '127.0.0.1');
  await once(providerHttp, 'listening');
  const providerAddress = providerHttp.address();
  assert.ok(providerAddress && typeof providerAddress === 'object');
  const providerUrl = 'ws://127.0.0.1:' + providerAddress.port;

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
    realtimeSlowDeadlineMs: options.realtimeSlowDeadlineMs ?? 800,
    realtimeMemoryTriggerMode: options.realtimeMemoryTriggerMode,
    realtimeCoachGateTimeoutMs: options.coachGateTimeoutMs,
    realtimeCoachTotalTimeoutMs: options.coachTotalTimeoutMs,
    wrapUpMs: 100_000,
    maxSessionMs: 200_000,
    closeGraceMs: 2_000,
  }, {
    retriever,
    eraContextClient,
    realtimeCoach: options.coach ?? {
      async evaluate(input) {
        coachGateInputs.push(input);
        return {
          action: 'guide', retrieve_memory: false, memory_query: null,
          retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
          reason: 'missing_key_detail',
          avoid: null, direction: '继续追问刚才这段经历中的关键细节。',
        };
      },
      async resolve(input) {
        coachResolveInputs.push(input);
        return {
          selectedEvidenceIds: ['e1'],
          known: ['此前说第一次去北京在 2013 年春节后。'],
          backgroundHint: null,
          conflict: null,
          avoid: '不要重复问第一次去北京的时间。',
          direction: '接着问这次出行的目的。',
        };
      },
    },
    realtimeContextAgentTasks: {
      async run(taskRequest) {
        const query = String(record(taskRequest.payload)?.query ?? '');
        agentQueries.push(query);
        if (query === 'agent-failure') throw new Error('AGENT_RUNTIME_FAILED');
        if (query === 'agent-timeout') await new Promise<void>(() => {});
        return {
          runId: taskRequest.runId,
          taskType: 'interview.context_hint',
          schemaVersion: 'v1',
          output: { selected_evidence_ids: ['e1'], possible_conflicts: [], interview_hints: [] },
          runtime: { runtime: 'test-agent', skill: 'interview-observer', latencyMs: 1 },
        } as Awaited<ReturnType<AgentTaskPort['run']>>;
      },
    },
    closeout: {
      textModelProvider: {
        async complete() {
          return { output: { summary: '本地 wiring test 的外部贡献摘要。' }, model: 'mock-closeout', latencyMs: 1 };
        },
      },
    },
    realtimeProviderFactory: (id) => ({
      id,
      capabilities: {
        fullDuplex: true,
        supportsInterrupt: true,
        supportsToolCalling: true,
        supportsContextInjection: options.supportsContextInjection !== false,
        supportsExplicitTurnRequest: true,
        supportsPlaybackAck: false,
        supportsExplicitSessionClose: false,
        manualTurnControl: options.manualTurnControl === true,
      },
      audio: {
        input: { encoding: 'pcm_s16le', sampleRate: 16_000, frameBytes: 640 },
        output: { encoding: 'pcm_s16le', sampleRate: 24_000 },
      },
      connectOptions: () => ({ url: providerUrl, headers: {} }),
      setupSession: () => [{ type: 'mock.setup' }],
      initialResponsePlan: () => ({ steps: [{ message: { type: 'mock.opening' } }] }),
      appendAudioMessages: () => [],
      requestAssistantTurnMessages: (instruction: string) => [{
        type: 'response.create',
        response: { modalities: ['text', 'audio'], instructions: instruction },
      }],
      commitInputTurn: () => [{ message: { type: 'mock.commit' } }],
      commitAndRespondToInputTurn: () => [
        { message: { type: 'mock.commit' } },
        { message: { type: 'response.create' } },
      ],
      stopInputAfterCurrentTurn: () => [],
      beginInputShutdown: () => [],
      closePlan: () => null,
      connectionFailureMessage: () => 'mock realtime failure',
      normalizeServerMessage: normalize,
      handleControlEvent: () => [],
      injectContextHint: (hint) => {
        injectedHints.push({ hint, at: performance.now() });
        return [{ type: 'mock.context_hint', hint }];
      },
      handleToolResult: (_call, output, resultOptions) => [
        { type: 'mock.tool_result', output, resume: resultOptions?.resume !== false },
        ...(resultOptions?.resume === false ? [] : [{ type: 'response.create' }]),
      ],
    }),
  });
  appServer.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  const appAddress = appServer.address();
  assert.ok(appAddress && typeof appAddress === 'object');
  const baseUrl = 'http://127.0.0.1:' + appAddress.port;

  const observeClient = (socket: WebSocket): ClientConnection => {
    const connection = { socket, messages: [] as JsonRecord[] };
    socket.on('message', (raw) => {
      const message = record(JSON.parse(raw.toString()));
      if (message) connection.messages.push(message);
    });
    clientConnections.push(connection);
    return connection;
  };

  try {
    const login = await fetch(baseUrl + '/api/auth/development/legacy-session', { method: 'POST' });
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    const ownerSocket = new WebSocket('ws://127.0.0.1:' + appAddress.port + '/api/realtime', {
      headers: { cookie },
    });
    await once(ownerSocket, 'open');
    const owner = observeClient(ownerSocket);
    ownerSocket.send(JSON.stringify({ type: 'start', story_id: seedIds.firstProject, provider: options.provider ?? 'qwen' }));
    await waitForMatch(() => owner.messages, (message) => message.type === 'ready', 'story ready');
    ownerSocket.send(JSON.stringify({ type: 'playback_ready' }));
    await waitForMatch(
      () => owner.messages,
      (message) => message.type === 'response_done' && message.responseId === 'opening-1',
      'opening response',
    );

    const waitForProviderMessage = (predicate: (message: JsonRecord) => boolean, label: string) =>
      waitForMatch(() => providerMessages, predicate, label);
    const waitForToolResult = (count: number) => waitForMatch(
      () => toolResults,
      (_message, index) => index === count - 1,
      'Tool Result ' + count,
    );
    const waitForInjection = (count: number) => waitForMatch(
      () => injectedHints,
      (_entry, index) => index === count - 1,
      'Context Hint ' + count,
    );

    return {
      directory,
      diagnosticsDirectory,
      appAddress,
      baseUrl,
      shareToken: share.token,
      ownerSocket,
      ownerMessages: owner.messages,
      providerMessages,
      searchInputs,
      eraSearchInputs,
      agentQueries,
      coachGateInputs,
      coachResolveInputs,
      toolResults,
      injectedHints,
      sendProviderEvent: (event: JsonRecord) => sendProviderEvent(providerSockets.at(-1), event),
      waitForProviderMessage,
      waitForToolResult,
      waitForInjection,
      waitForAgentQuery: (query: string) => waitForMatch(
        () => agentQueries,
        (candidate) => candidate === query,
        'Context Agent query ' + query,
      ),
      waitForOwnerMessage: (predicate: (message: JsonRecord) => boolean, label: string) =>
        waitForMatch(() => owner.messages, predicate, label),
      openExternalClient: async () => {
        const externalSocket = new WebSocket(
          'ws://127.0.0.1:' + appAddress.port + '/api/realtime?share_token=' + encodeURIComponent(share.token),
          { headers: { origin: baseUrl } },
        );
        await once(externalSocket, 'open');
        const external = observeClient(externalSocket);
        return external;
      },
      close: async () => {
        for (const client of clientConnections) {
          if (client.socket.readyState === WebSocket.OPEN) {
            const closed = once(client.socket, 'close');
            client.socket.close();
            await closed;
          }
        }
        for (const socket of providerSockets) {
          if (socket.readyState === WebSocket.OPEN) socket.close();
        }
        if (!appServerClosed) {
          const closed = once(appServer, 'close');
          appServer.close();
          appServer.closeAllConnections();
          await closed;
          appServerClosed = true;
        }
        providerServer.close();
        if (!providerHttpClosed) {
          const closed = once(providerHttp, 'close');
          providerHttp.close();
          await closed;
          providerHttpClosed = true;
        }
        if (previousDiagnosticsDirectory === undefined) delete process.env.DIAGNOSTICS_DIR;
        else process.env.DIAGNOSTICS_DIR = previousDiagnosticsDirectory;
        if (previousCaptureContent === undefined) delete process.env.DIAGNOSTICS_CAPTURE_CONTENT;
        else process.env.DIAGNOSTICS_CAPTURE_CONTENT = previousCaptureContent;
        if (previousEraContextEnabled === undefined) delete process.env.NEMO_ERA_CONTEXT_ENABLED;
        else process.env.NEMO_ERA_CONTEXT_ENABLED = previousEraContextEnabled;
      },
    };
  } catch (error) {
    if (previousDiagnosticsDirectory === undefined) delete process.env.DIAGNOSTICS_DIR;
    else process.env.DIAGNOSTICS_DIR = previousDiagnosticsDirectory;
    if (previousCaptureContent === undefined) delete process.env.DIAGNOSTICS_CAPTURE_CONTENT;
    else process.env.DIAGNOSTICS_CAPTURE_CONTENT = previousCaptureContent;
    if (previousEraContextEnabled === undefined) delete process.env.NEMO_ERA_CONTEXT_ENABLED;
    else process.env.NEMO_ERA_CONTEXT_ENABLED = previousEraContextEnabled;
    throw error;
  }
}

function sendUserFinal(fixture: Awaited<ReturnType<typeof createFixture>>, itemId: string, text: string): void {
  fixture.sendProviderEvent({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript: text,
  });
}

async function sendManualUserFinal(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  itemId: string,
  text: string,
): Promise<void> {
  fixture.ownerSocket.send(JSON.stringify({ type: 'manual_turn_started' }));
  await fixture.waitForOwnerMessage((message) => message.type === 'speech_started', 'manual speech start');
  fixture.ownerSocket.send(JSON.stringify({ type: 'manual_turn_commit', silenceObservedMs: 5_000 }));
  await fixture.waitForProviderMessage((message) => message.type === 'mock.commit', 'manual input commit');
  sendUserFinal(fixture, itemId, text);
  await fixture.waitForOwnerMessage(
    (message) => message.type === 'user_final' && message.itemId === itemId,
    'manual user final',
  );
}

function sendContextToolCall(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  callId: string,
  query: string,
  responseId = 'tool-response-' + callId,
): void {
  fixture.sendProviderEvent({
    type: 'response.function_call_arguments.done',
    call_id: callId,
    response_id: responseId,
    name: 'get_interview_context',
    arguments: JSON.stringify({ query }),
  });
}

async function endStorySession(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<void> {
  const ended = fixture.waitForOwnerMessage((message) => message.type === 'ended', 'story ended');
  fixture.ownerSocket.send(JSON.stringify({ type: 'end', reason: 'user_confirmed' }));
  await waitFor(ended, 5_000, 'story ended');
}

test('voice_tool routes only get_interview_context through one shared Retriever and Agent pipeline', async () => {
  const fixture = await createFixture({ realtimeMemoryTriggerMode: 'voice_tool', realtimeSlowDeadlineMs: 800 });
  try {
    const failures: string[] = [];
    const check = (condition: boolean, message: string) => {
      if (!condition) failures.push(message);
    };

    sendUserFinal(fixture, 'voice-final', '我第一次去北京是什么时候？');
    await fixture.waitForOwnerMessage((message) => message.type === 'user_final', 'voice user final');
    await delay(40);
    const searchesAfterFinal = fixture.searchInputs.length;
    const agentsAfterFinal = fixture.agentQueries.length;
    check(searchesAfterFinal === 0, 'user final must not start Retriever in voice_tool mode');
    check(agentsAfterFinal === 0, 'user final must not start Agent in voice_tool mode');

    sendContextToolCall(fixture, 'voice-context', '第一次去北京是什么时候？');
    const contextResult = await fixture.waitForToolResult(1);
    check(
      fixture.searchInputs.filter((input) => input.query === '第一次去北京是什么时候？').length === 1,
      'get_interview_context query must invoke Retriever exactly once',
    );
    check(
      fixture.agentQueries.filter((query) => query === '第一次去北京是什么时候？').length === 1,
      'get_interview_context query must invoke the shared Context Agent exactly once',
    );
    check(
      (record(contextResult.output)?.facts as unknown[] | undefined)?.length === 1,
      'successful shared recall should return its selected user evidence',
    );

    sendContextToolCall(fixture, 'voice-agent-failure', 'agent-failure');
    const failedResult = await fixture.waitForToolResult(2);
    check(
      fixture.searchInputs.filter((input) => input.query === 'agent-failure').length === 1
        && fixture.agentQueries.filter((query) => query === 'agent-failure').length === 1,
      'Agent failure case must exercise the shared Retriever and Agent pipeline',
    );
    check(
      (record(failedResult.output)?.facts as unknown[] | undefined)?.length === 0,
      'Agent failure must return an empty Tool Result',
    );
    check(failedResult.resume === true, 'Agent failure Tool Result must Resume');

    sendContextToolCall(fixture, 'voice-timeout', 'agent-timeout');
    const timeoutResult = await fixture.waitForToolResult(3);
    check(
      fixture.searchInputs.filter((input) => input.query === 'agent-timeout').length === 1
        && fixture.agentQueries.filter((query) => query === 'agent-timeout').length === 1,
      'timeout case must exercise the shared Retriever and Agent pipeline',
    );
    check(
      (record(timeoutResult.output)?.facts as unknown[] | undefined)?.length === 0,
      'pipeline timeout must return an empty Tool Result',
    );
    check(timeoutResult.resume === true, 'pipeline timeout Tool Result must Resume');
    check(
      fixture.providerMessages.filter((message) => message.type === 'response.create').length >= 3,
      'each Tool Result must send a Resume response.create',
    );

    await endStorySession(fixture);
    assert.deepEqual(failures, [], failures.join('\n'));
  } finally {
    await fixture.close();
  }
});

test('voice_tool cancels a stuck response and writes empty Tool Result plus Resume within its deadline', async () => {
  const deadlineMs = 240;
  const fixture = await createFixture({
    realtimeMemoryTriggerMode: 'voice_tool',
    realtimeSlowDeadlineMs: deadlineMs,
  });
  try {
    sendUserFinal(fixture, 'stuck-tool-final', '我第一次去北京是什么时候？');
    await fixture.waitForOwnerMessage((message) => message.type === 'user_final', 'stuck Tool Call user final');
    fixture.sendProviderEvent({ type: 'response.created', response: { id: 'stuck-tool-response' } });
    await delay(20);
    const startedAt = performance.now();
    sendContextToolCall(fixture, 'stuck-tool', 'agent-timeout', 'stuck-tool-response');

    const result = await fixture.waitForToolResult(1);
    await fixture.waitForProviderMessage((message) => message.type === 'response.cancel', 'stuck response cancel');
    await fixture.waitForProviderMessage((message) => message.type === 'response.create', 'deadline Resume');

    assert.deepEqual(record(result.output)?.facts, []);
    assert.equal(result.resume, true);
    assert.ok(performance.now() - startedAt < deadlineMs,
      'Tool Result and Resume must be written before the total Tool Call deadline');
  } finally {
    await fixture.close();
  }
});

test('stepaudio2_mini supervisor_auto coaches the same user turn before its response.create', async () => {
  let gateInput: CoachGateInput | undefined;
  let resolveInput: CoachResolveInput | undefined;
  const fixture = await createFixture({
    realtimeMemoryTriggerMode: 'supervisor_auto',
    provider: 'stepaudio2_mini',
    manualTurnControl: true,
    coach: {
      async evaluate(input) {
        gateInput = input;
        return {
          action: 'guide', retrieve_memory: true, memory_query: '第一次去北京的时间',
          retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
          reason: 'history_reference',
          avoid: null, direction: '核对历史时间后继续追问。',
        };
      },
      async resolve(input) {
        resolveInput = input;
        return {
          selectedEvidenceIds: ['e1'],
          known: ['此前提到春节后出发。'],
          backgroundHint: null,
          conflict: '当前提到的年份可能不同。',
          avoid: '不要重复问第一次去北京的时间。',
          direction: '确认这次回忆对应哪次出行。',
        };
      },
    },
  });
  try {
    const answer = '我想起第一次去北京大概是 2012 年。';
    await sendManualUserFinal(fixture, 'coach-turn-a', answer);
    await waitForMatch(() => fixture.providerMessages, (message) => (
      message.type === 'response.create'
      && String(record(message.response)?.instructions ?? '').includes('确认这次回忆对应哪次出行')
    ), 'coached response for turn A');

    const response = fixture.providerMessages.find((message) => message.type === 'response.create'
      && String(record(message.response)?.instructions ?? '').includes('确认这次回忆对应哪次出行'))!;
    const responseIndex = fixture.providerMessages.indexOf(response);
    const commitIndex = fixture.providerMessages.findIndex((message) => message.type === 'mock.commit');
    const instructions = String(record(response.response)?.instructions ?? '');

    assert.ok(commitIndex >= 0 && commitIndex < responseIndex);
    assert.equal(gateInput?.currentUserAnswer, answer);
    assert.equal(fixture.searchInputs.length, 1);
    assert.equal(fixture.searchInputs[0]?.query, '第一次去北京的时间');
    assert.equal(fixture.searchInputs[0]?.storyId, seedIds.firstProject);
    assert.equal(fixture.searchInputs[0]?.sourceType, 'subject');
    assert.equal(resolveInput?.scenario, 'story_continue');
    assert.equal(resolveInput?.memoryEvidence.length, 1);
    assert.deepEqual(resolveInput?.eraEvidence, []);
    assert.match(instructions, /【采访教练】/);
    assert.ok(Array.from(instructions).length < 1_600);
    assert.equal(instructions.includes('2013 年春节以后第一次到北京。'), false);
    assert.equal(instructions.includes(answer), false);
    assert.equal(fixture.agentQueries.length, 0, 'Pass B must not run a third OpenClaw/Agent model call');
  } finally {
    await fixture.close();
  }
});

test('stepaudio2_mini retrieves current-story memory and Era Context in parallel through EraContextClient', async () => {
  let resolveEraStarted!: () => void;
  const eraStarted = new Promise<void>((resolve) => { resolveEraStarted = resolve; });
  let requestBody: Record<string, unknown> | undefined;
  let resolveInput: CoachResolveInput | undefined;
  let gateInput: CoachGateInput | undefined;
  const eraRecord = {
    start_year: 1996,
    end_year: 2000,
    category: '工作就业' as const,
    title: '国企单位经营调整',
    summary: '1998年前后，一些国企经历经营调整，部分职工面临岗位变化与分流。',
  };
  const eraClient = new EraContextClient({
    endpoint: 'http://retriever.test',
    collection: 'life-interview-era-context-v1',
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      resolveEraStarted();
      return new Response(JSON.stringify({ hits: [{
        text: JSON.stringify(eraRecord), metadata: eraRecord, _rerank_score: 0.92,
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const fixture = await createFixture({
    realtimeMemoryTriggerMode: 'supervisor_auto',
    provider: 'stepaudio2_mini',
    manualTurnControl: true,
    retrieverDelayMs: 500,
    eraEnabled: true,
    eraContext: eraClient,
    storyAgentMemory: '1997年厂里已经开始拖欠工资。',
    coach: {
      async evaluate(input) {
        gateInput = input;
        return {
          action: 'guide', retrieve_memory: true, memory_query: '历史采访中的拖欠工资',
          retrieve_era: true, era_query: '1998年前后国企单位经营调整与职工分流',
          era_start_year: 1996, era_end_year: 2000,
          reason: 'history_reference', avoid: '不要因时代背景断言用户下岗。',
          direction: '第一次感到单位可能留不住你时，发生了什么？',
        };
      },
      async resolve(input) {
        resolveInput = input;
        return {
          selectedEvidenceIds: [input.memoryEvidence[0]!.id],
          known: ['历史采访里提到 1997 年开始拖欠工资。'],
          backgroundHint: '那几年不少单位也在调整。',
          conflict: null,
          avoid: '不要把用户直接归为下岗职工。',
          direction: '第一次感到工作可能保不住时，单位里发生了什么？',
        };
      },
    },
  });
  try {
    await sendManualUserFinal(fixture, 'coach-era-parallel-turn', '第二年情况更严重了。');
    await waitFor(eraStarted, 200, 'EraContextClient request to start alongside memory retrieval');
    assert.equal(fixture.searchInputs.length, 1, 'Current Story memory retrieval also started');
    const currentStory = record(gateInput?.scenarioState.current_story);
    assert.match(String(currentStory?.agent_memory), /1997年厂里已经开始拖欠工资/u);

    const response = await fixture.waitForProviderMessage((message) => (
      message.type === 'response.create'
      && String(record(message.response)?.instructions ?? '').includes('第一次感到工作可能保不住时')
    ), 'Mini response with the resolved Era-aware Coach Packet');
    const instructions = String(record(response.response)?.instructions ?? '');
    assert.equal(fixture.searchInputs[0]?.query, '历史采访中的拖欠工资');
    assert.equal(fixture.searchInputs[0]?.storyId, seedIds.firstProject);
    assert.deepEqual(fixture.eraSearchInputs.map(({ query, start_year, end_year }) => ({ query, start_year, end_year })), [{
      query: '1998年前后国企单位经营调整与职工分流', start_year: 1996, end_year: 2000,
    }]);
    assert.equal(requestBody?.collection_name, 'life-interview-era-context-v1');
    assert.equal(requestBody?.query, '1998年前后国企单位经营调整与职工分流');
    assert.deepEqual(requestBody?.metadata_filter, {
      start_year: { $lte: 2000 }, end_year: { $gte: 1996 },
    });
    assert.equal(resolveInput?.memoryEvidence.length, 1);
    assert.equal(resolveInput?.memoryEvidence[0]?.answer.includes('1997'), true);
    assert.equal(resolveInput?.eraEvidence.length, 1);
    assert.equal(resolveInput?.eraEvidence[0]?.summary, eraRecord.summary);
    assert.match(instructions, /背景：那几年不少单位也在调整/u);
    assert.match(instructions, /不要把用户直接归为下岗职工/u);
    assert.doesNotMatch(instructions, new RegExp(eraRecord.summary));
    assert.ok(Array.from(instructions).length < 1_600);
  } finally {
    await fixture.close();
  }
});

test('empty, timed-out, and disabled Era retrieval fail open while Coach Resolve continues', async () => {
  const cases: Array<{
    name: string;
    eraEnabled: boolean;
    eraContext?: EraContextAdapter;
    expectedEraCalls: number;
  }> = [
    { name: 'no results', eraEnabled: true, eraContext: { async search() { return []; } }, expectedEraCalls: 1 },
    {
      name: 'service timeout', eraEnabled: true,
      eraContext: { async search() { await new Promise<void>(() => {}); return []; } },
      expectedEraCalls: 1,
    },
    { name: 'flag disabled', eraEnabled: false, expectedEraCalls: 0 },
  ];

  for (const [index, scenario] of cases.entries()) {
    let resolveInput: CoachResolveInput | undefined;
    const fixture = await createFixture({
      realtimeMemoryTriggerMode: 'supervisor_auto',
      provider: 'stepaudio2_mini',
      manualTurnControl: true,
      eraEnabled: scenario.eraEnabled,
      eraContext: scenario.eraContext,
      coach: {
        async evaluate() {
          return {
            action: 'guide', retrieve_memory: true, memory_query: 'unit history',
            retrieve_era: true, era_query: '1998 unit conditions',
            era_start_year: 1996, era_end_year: 2000,
            reason: 'missing_key_detail', avoid: null, direction: '询问当时工作环境有什么变化。',
          };
        },
        async resolve(input) {
          resolveInput = input;
          return {
            selectedEvidenceIds: input.memoryEvidence.map((item) => item.id),
            known: ['用户此前谈过工作经历。'], backgroundHint: null,
            conflict: null, avoid: null, direction: '询问当时工作环境有什么变化？',
          };
        },
      },
    });
    try {
      await sendManualUserFinal(fixture, `coach-era-fallback-${index}`, '单位效益不好。');
      const response = await fixture.waitForProviderMessage((message) => (
        message.type === 'response.create'
        && String(record(message.response)?.instructions ?? '').includes('询问当时工作环境有什么变化？')
      ), `${scenario.name} Coach response`);
      assert.equal(resolveInput?.memoryEvidence.length, 1, `${scenario.name} preserves successful personal retrieval`);
      assert.deepEqual(resolveInput?.eraEvidence, [], `${scenario.name} gives Resolve no Era evidence`);
      assert.equal(fixture.eraSearchInputs.length, scenario.expectedEraCalls);
      assert.match(String(record(response.response)?.instructions ?? ''), /【采访教练】/);
    } finally {
      await fixture.close();
    }
  }
});

test('personal retrieval failure does not discard successful Era evidence', async () => {
  let resolveInput: CoachResolveInput | undefined;
  const eraRecord = {
    start_year: 1996, end_year: 2000, category: '工作就业' as const,
    title: '工作环境变化', summary: '1998年前后，部分单位的经营和岗位安排出现变化。',
  };
  const fixture = await createFixture({
    realtimeMemoryTriggerMode: 'supervisor_auto',
    provider: 'stepaudio2_mini',
    manualTurnControl: true,
    eraEnabled: true,
    eraContext: {
      async search() { return [{ ...eraRecord, score: 0.9 }]; },
    },
    coach: {
      async evaluate() {
        return {
          action: 'guide', retrieve_memory: true, memory_query: 'retriever-failure',
          retrieve_era: true, era_query: '1998年单位经营与就业',
          era_start_year: 1996, era_end_year: 2000,
          reason: 'missing_key_detail', avoid: '不要断言用户被裁员。',
          direction: '你第一次觉得工作不稳定时，发生了什么？',
        };
      },
      async resolve(input) {
        resolveInput = input;
        return {
          selectedEvidenceIds: [], known: [], backgroundHint: '那几年部分单位经历调整。',
          conflict: null, avoid: '不要断言用户被裁员。', direction: '第一次觉得工作不稳定时，发生了什么？',
        };
      },
    },
  });
  try {
    await sendManualUserFinal(fixture, 'coach-era-memory-failure-turn', '单位效益不好。');
    const response = await fixture.waitForProviderMessage((message) => (
      message.type === 'response.create'
      && String(record(message.response)?.instructions ?? '').includes('那几年部分单位经历调整')
    ), 'Era-aware response after Current Story retrieval fails');
    assert.deepEqual(resolveInput?.memoryEvidence, []);
    assert.equal(resolveInput?.eraEvidence.length, 1);
    assert.match(String(record(response.response)?.instructions ?? ''), /那几年部分单位经历调整/u);
  } finally {
    await fixture.close();
  }
});

test('stepaudio2_mini spoken end requests a farewell on the current turn and closes after playback', async () => {
  const fixture = await createFixture({
    realtimeMemoryTriggerMode: 'supervisor_auto',
    provider: 'stepaudio2_mini',
    manualTurnControl: true,
  });
  try {
    await sendManualUserFinal(fixture, 'spoken-end-turn', '结束对话。');
    const response = await fixture.waitForProviderMessage(
      (message) => message.type === 'response.create',
      'spoken-end farewell response',
    );
    assert.match(String(record(response.response)?.instructions ?? ''), /本次先聊到这里，再见/u);
    assert.equal(fixture.coachGateInputs.length, 0);
    const done = await fixture.waitForOwnerMessage(
      (message) => message.type === 'response_done' && message.responseId === 'response-1',
      'spoken-end response done',
    );
    assert.equal(done.endAfterPlayback, true);
    assert.equal(done.endReason, 'user_confirmed');
    fixture.ownerSocket.send(JSON.stringify({ type: 'end', reason: 'user_confirmed' }));
    const ended = await fixture.waitForOwnerMessage((message) => message.type === 'ended', 'spoken end saved');
    assert.equal(ended.type, 'ended');
  } finally {
    await fixture.close();
  }
});

test('spoken end ignores an unrelated response and closes if the farewell response fails', async () => {
  const fixture = await createFixture({
    realtimeMemoryTriggerMode: 'supervisor_auto',
    provider: 'stepaudio2_mini',
    manualTurnControl: true,
    autoCompleteResponses: false,
  });
  try {
    await sendManualUserFinal(fixture, 'spoken-end-failure-turn', '结束对话。');
    await fixture.waitForProviderMessage((message) => message.type === 'response.create', 'farewell request');
    fixture.sendProviderEvent({ type: 'response.done', response: { id: 'unrelated-response', status: 'completed' } });
    const unrelated = await fixture.waitForOwnerMessage(
      (message) => message.type === 'response_done' && message.responseId === 'unrelated-response',
      'unrelated response done',
    );
    assert.equal(unrelated.endAfterPlayback, false);
    fixture.sendProviderEvent({ type: 'response.done', response: { id: 'response-1', status: 'failed' } });
    const ended = await fixture.waitForOwnerMessage((message) => message.type === 'ended', 'failed farewell saved');
    assert.equal(ended.type, 'ended');
  } finally {
    await fixture.close();
  }
});

test('stepaudio2_mini voice_tool uses the same Retriever and Pass B and returns only a compact Coach Packet', async () => {
  const fixture = await createFixture({
    realtimeMemoryTriggerMode: 'voice_tool',
    provider: 'stepaudio2_mini',
  });
  try {
    sendUserFinal(fixture, 'mini-voice-tool-turn', '我记得第一次去北京是在春节以后。');
    await fixture.waitForOwnerMessage(
      (message) => message.type === 'user_final' && message.itemId === 'mini-voice-tool-turn',
      'Mini voice_tool user final',
    );
    sendContextToolCall(fixture, 'mini-voice-tool-call', '第一次去北京的时间');
    const result = await fixture.waitForToolResult(1);
    await fixture.waitForProviderMessage((message) => message.type === 'response.create', 'Mini voice_tool Resume');

    const output = record(result.output);
    assert.equal(output?.status, 'coach-context');
    assert.match(String(output?.coach_packet ?? ''), /【采访教练】/);
    assert.equal(JSON.stringify(output).includes('2013 年春节以后第一次到北京'), false);
    assert.equal(fixture.searchInputs.length, 1);
    assert.equal(fixture.searchInputs[0]?.storyId, seedIds.firstProject);
    assert.equal(fixture.searchInputs[0]?.sourceType, 'subject');
    assert.equal(fixture.coachGateInputs.length, 0, 'voice_tool lets the Mini decide whether to retrieve');
    assert.equal(fixture.coachResolveInputs.length, 1, 'both trigger modes share Pass B');
  } finally {
    await fixture.close();
  }
});

test('stepaudio2_mini supervisor_auto skips Retriever for an ordinary answer', async () => {
  let gateCalls = 0;
  const fixture = await createFixture({
    realtimeMemoryTriggerMode: 'supervisor_auto',
    provider: 'stepaudio2_mini',
    manualTurnControl: true,
    coach: {
      async evaluate() {
        gateCalls += 1;
        await delay(50);
        return {
          action: 'none', retrieve_memory: false, memory_query: null,
          retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
          reason: 'normal', avoid: null, direction: null,
        };
      },
      async resolve() { throw new Error('Pass B must not run after action=none'); },
    },
  });
  try {
    await sendManualUserFinal(fixture, 'coach-normal-turn', '后来我又去了北京。');
    sendUserFinal(fixture, 'coach-normal-turn', '后来我又去了北京。');
    const response = await fixture.waitForProviderMessage((message) => message.type === 'response.create', 'normal Coach response');
    const instructions = String(record(response.response)?.instructions ?? '');
    assert.match(instructions, /你是人生采访记者/);
    assert.doesNotMatch(instructions, /方向：/);
    assert.equal(fixture.searchInputs.length, 0);
    assert.equal(fixture.eraSearchInputs.length, 0);
    assert.equal(fixture.coachResolveInputs.length, 0);
    await delay(100);
    assert.equal(gateCalls, 1, 'a repeated final message ID must not start another Coach turn');
    assert.equal(fixture.ownerMessages.filter((message) => message.type === 'user_final' && message.itemId === 'coach-normal-turn').length, 1,
      'a duplicate final must not be forwarded as a second user turn');
    assert.equal(fixture.providerMessages.filter((message) => message.type === 'response.create').length, 1,
      'Gate action=none must request exactly one current-turn response');
  } finally {
    await fixture.close();
  }
});

test('stepaudio2_mini supervisor_auto discards an aborted Coach without speaking over new user speech', async () => {
  let resolveStarted!: () => void;
  let resolveAborted!: () => void;
  let abortObserved = false;
  const resolveStartedPromise = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const resolveAbortedPromise = new Promise<void>((resolve) => { resolveAborted = resolve; });
  const fixture = await createFixture({
    realtimeMemoryTriggerMode: 'supervisor_auto',
    provider: 'stepaudio2_mini',
    manualTurnControl: true,
    coach: {
      async evaluate() {
        return {
          action: 'guide', retrieve_memory: true, memory_query: '历史工作经历',
          retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
          reason: 'history_reference', avoid: null, direction: '不应在用户开口时插话。',
        };
      },
      async resolve(_input, options) {
        resolveStarted();
        return new Promise<CoachPacket>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            abortObserved = true;
            resolveAborted();
            reject(new Error('Coach interrupted by user speech'));
          }, { once: true });
        });
      },
    },
  });
  try {
    await sendManualUserFinal(fixture, 'coach-interrupted-turn', '我还记得以前的工作。');
    await waitFor(resolveStartedPromise, 1_000, 'Coach Resolve start');
    fixture.sendProviderEvent({ type: 'input_audio_buffer.speech_started', event_id: 'interrupt-current-coach' });
    await fixture.waitForOwnerMessage((message) => message.type === 'speech_started', 'new user speech');
    await waitFor(resolveAbortedPromise, 1_000, 'Coach abort from new user speech');
    await delay(50);

    assert.equal(abortObserved, true);
    assert.equal(fixture.providerMessages.filter((message) => message.type === 'response.create').length, 0,
      'external abort must discard the old Coach silently instead of starting Mini speech');
  } finally {
    await fixture.close();
  }
});

test('stepaudio2_mini supervisor_auto ignores an empty final without invalidating a valid Coach turn', async () => {
  let gateCalls = 0;
  const fixture = await createFixture({
    realtimeMemoryTriggerMode: 'supervisor_auto',
    provider: 'stepaudio2_mini',
    manualTurnControl: true,
    coach: {
      async evaluate() {
        gateCalls += 1;
        await delay(100);
        return {
          action: 'guide', retrieve_memory: false, memory_query: null,
          retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
          reason: 'missing_key_detail', avoid: null, direction: '继续讲述这段有效回答。',
        };
      },
      async resolve() { throw new Error('Resolve must not run without requested retrieval'); },
    },
  });
  try {
    await sendManualUserFinal(fixture, 'coach-valid-turn-before-empty', '那年我第一次换了工作。');
    sendUserFinal(fixture, 'empty-final-must-not-advance-turn', '   ');
    const response = await fixture.waitForProviderMessage((message) => (
      message.type === 'response.create'
      && String(record(message.response)?.instructions ?? '').includes('继续讲述这段有效回答')
    ), 'response for valid turn after empty final');

    assert.match(String(record(response.response)?.instructions ?? ''), /继续讲述这段有效回答/u);
    assert.equal(gateCalls, 1);
    assert.equal(fixture.ownerMessages.filter((message) => (
      message.type === 'user_final' && message.itemId === 'empty-final-must-not-advance-turn'
    )).length, 0, 'blank transcript must not become a user turn');
    assert.equal(fixture.providerMessages.filter((message) => message.type === 'response.create').length, 1,
      'the valid turn must receive exactly one response');
  } finally {
    await fixture.close();
  }
});

test('stepaudio2_mini manual turn accepts another turn after an empty transcript final', async () => {
  const fixture = await createFixture({
    realtimeMemoryTriggerMode: 'supervisor_auto',
    provider: 'stepaudio2_mini',
    manualTurnControl: true,
    coach: {
      async evaluate() {
        return {
          action: 'none', retrieve_memory: false, memory_query: null,
          retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
          reason: 'normal', avoid: null, direction: null,
        };
      },
      async resolve() { throw new Error('Resolve must not run for action=none'); },
    },
  });
  try {
    fixture.ownerSocket.send(JSON.stringify({ type: 'manual_turn_started' }));
    await waitForMatch(
      () => fixture.ownerMessages.filter((message) => message.type === 'speech_started'),
      (_message, index) => index === 0,
      'first manual speech start',
    );
    fixture.ownerSocket.send(JSON.stringify({ type: 'manual_turn_commit', silenceObservedMs: 5_000 }));
    await waitForMatch(
      () => fixture.providerMessages.filter((message) => message.type === 'mock.commit'),
      (_message, index) => index === 0,
      'empty-turn commit',
    );
    sendUserFinal(fixture, 'empty-only-turn', '   ');
    await delay(30);
    assert.equal(fixture.providerMessages.filter((message) => message.type === 'response.create').length, 0,
      'an empty transcript must not create a Mini response');

    fixture.ownerSocket.send(JSON.stringify({ type: 'manual_turn_started' }));
    await waitForMatch(
      () => fixture.ownerMessages.filter((message) => message.type === 'speech_started'),
      (_message, index) => index === 1,
      'manual speech after empty transcript',
    );
    fixture.ownerSocket.send(JSON.stringify({ type: 'manual_turn_commit', silenceObservedMs: 5_000 }));
    await waitForMatch(
      () => fixture.providerMessages.filter((message) => message.type === 'mock.commit'),
      (_message, index) => index === 1,
      'next valid-turn commit',
    );
    sendUserFinal(fixture, 'valid-turn-after-empty', '下一轮我想继续说。');
    await fixture.waitForOwnerMessage((message) => message.type === 'user_final' && message.itemId === 'valid-turn-after-empty', 'next valid final');
    await fixture.waitForProviderMessage((message) => message.type === 'response.create', 'next valid Mini response');
    assert.equal(fixture.providerMessages.filter((message) => message.type === 'response.create').length, 1);
  } finally {
    await fixture.close();
  }
});

test('stepaudio2_mini supervisor_auto fails open at 2s and discards a late Gate result across turns', async () => {
  let lateGateFinished = false;
  const normalGate: CoachGateResult = {
    action: 'none', retrieve_memory: false, memory_query: null,
    retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
    reason: 'normal', avoid: null, direction: null,
  };
  const fixture = await createFixture({
    realtimeMemoryTriggerMode: 'supervisor_auto',
    provider: 'stepaudio2_mini',
    manualTurnControl: true,
    coachGateTimeoutMs: 2_000,
    coach: {
      async evaluate(input) {
        if (input.currentUserAnswer === '迟到的 Gate 结果。') {
          await delay(2_200);
          lateGateFinished = true;
          return {
            action: 'guide', retrieve_memory: true, memory_query: '不应执行的历史检索',
            retrieve_era: true, era_query: '不应执行的时代检索', era_start_year: 1998, era_end_year: 1999,
            reason: 'history_reference', avoid: null, direction: '迟到指导不得污染后续回合。',
          };
        }
        return normalGate;
      },
      async resolve() { throw new Error('Pass B must not run after Gate timeout'); },
    },
  });
  try {
    await sendManualUserFinal(fixture, 'coach-timeout-turn', '迟到的 Gate 结果。');
    const firstResponse = await waitForMatch(
      () => fixture.providerMessages.filter((message) => message.type === 'response.create'),
      (_message, index) => index === 0,
      '2s Gate fail-open response',
      3_000,
    );
    assert.match(String(record(firstResponse.response)?.instructions ?? ''), /你是人生采访记者/u);
    await fixture.waitForOwnerMessage(
      (message) => message.type === 'response_done' && message.responseId === 'response-1',
      'first Mini response completion',
    );

    await sendManualUserFinal(fixture, 'coach-next-turn', '下一轮正常回答。');
    const secondResponse = await waitForMatch(
      () => fixture.providerMessages.filter((message) => message.type === 'response.create'),
      (_message, index) => index === 1,
      'next-turn Mini response',
    );
    const secondInstructions = String(record(secondResponse.response)?.instructions ?? '');
    assert.match(secondInstructions, /你是人生采访记者/u);
    assert.doesNotMatch(secondInstructions, /迟到指导不得污染后续回合/u);
    await fixture.waitForOwnerMessage(
      (message) => message.type === 'response_done' && message.responseId === 'response-2',
      'second Mini response completion',
    );
    await delay(300);
    assert.equal(lateGateFinished, true, 'the test observes the Gate result after the hard timeout');
    assert.equal(fixture.providerMessages.filter((message) => message.type === 'response.create').length, 2,
      'each turn must request one response and the late Gate must not request another');
    assert.equal(fixture.searchInputs.length, 0);
    assert.equal(fixture.eraSearchInputs.length, 0);
    assert.equal(fixture.coachResolveInputs.length, 0);
  } finally {
    await fixture.close();
  }
});

test('stepaudio2_mini supervisor_auto fails open once when the 6s Coach deadline expires in retrieval', async () => {
  const fixture = await createFixture({
    realtimeMemoryTriggerMode: 'supervisor_auto',
    provider: 'stepaudio2_mini',
    manualTurnControl: true,
    coachTotalTimeoutMs: 6_000,
    retrieverDelayMs: 6_200,
    coach: {
      async evaluate() {
        return {
          action: 'guide', retrieve_memory: true, memory_query: '历史时间',
          retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
          reason: 'history_reference',
          avoid: null, direction: '核对历史后继续。',
        };
      },
      async resolve() { throw new Error('Pass B must not run after total timeout'); },
    },
  });
  try {
    const startedAt = performance.now();
    await sendManualUserFinal(fixture, 'coach-total-timeout-turn', '我想起以前的时间。');
    const response = await waitForMatch(
      () => fixture.providerMessages,
      (message) => message.type === 'response.create',
      '6s total-timeout response',
      7_000,
    );
    assert.equal(String(record(response.response)?.instructions ?? '').includes('核对历史后继续。'), false);
    assert.equal(fixture.searchInputs.length, 1);
    assert.equal(fixture.coachResolveInputs.length, 0, 'Resolve must not run after the shared 6s deadline');
    assert.ok(performance.now() - startedAt >= 5_600,
      'the configured shared Coach budget should remain six seconds after Gate time');
    await delay(350);
    assert.equal(fixture.providerMessages.filter((message) => message.type === 'response.create').length, 1,
      'a late retrieval completion must not request a second response');
  } finally {
    await fixture.close();
  }
});

test('stepaudio2_mini supervisor_auto fails open when pipeline completion crosses the total deadline', async () => {
  const fixture = await createFixture({
    realtimeMemoryTriggerMode: 'supervisor_auto',
    provider: 'stepaudio2_mini',
    manualTurnControl: true,
    coachTotalTimeoutMs: 75,
    coach: {
      async evaluate() {
        return {
          action: 'guide', retrieve_memory: true, memory_query: '历史时间',
          retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
          reason: 'history_reference', avoid: null, direction: '临界结果不应应用。',
        };
      },
      async resolve(input) {
        const after = performance.now() + 125;
        while (performance.now() < after) { /* Hold the event loop so pipeline completion beats the overdue timer callback. */ }
        return {
          selectedEvidenceIds: input.memoryEvidence.map((item) => item.id),
          known: ['迟到的历史事实。'], backgroundHint: null, conflict: null,
          avoid: null, direction: '临界结果不应应用。',
        };
      },
    },
  });
  try {
    await sendManualUserFinal(fixture, 'coach-deadline-race-turn', '我想起以前的时间。');
    const response = await fixture.waitForProviderMessage((message) => message.type === 'response.create', 'deadline-race fail-open response');
    const instructions = String(record(response.response)?.instructions ?? '');
    assert.match(instructions, /你是人生采访记者/u);
    assert.doesNotMatch(instructions, /临界结果不应应用|迟到的历史事实/u);
    assert.equal(fixture.providerMessages.filter((message) => message.type === 'response.create').length, 1,
      'completed-at-boundary must still request exactly one Mini response');
  } finally {
    await fixture.close();
  }
});

test('stepaudio2_mini supervisor_auto skips Resolve when Memory and Era evidence are both empty', async () => {
  const fixture = await createFixture({
    realtimeMemoryTriggerMode: 'supervisor_auto',
    provider: 'stepaudio2_mini',
    manualTurnControl: true,
    eraEnabled: true,
    eraContext: { async search() { return []; } },
    coach: {
      async evaluate() {
        return {
          action: 'guide', retrieve_memory: true, memory_query: 'empty-evidence',
          retrieve_era: true, era_query: 'empty-era', era_start_year: 1998, era_end_year: 1999,
          reason: 'missing_key_detail', avoid: '避免引导用户接受某个原因。', direction: '沿着当前回答追问当时的变化。',
        };
      },
      async resolve() { throw new Error('Resolve must be skipped when both retrieval paths are empty'); },
    },
  });
  try {
    await sendManualUserFinal(fixture, 'coach-empty-evidence-turn', '那段时间确实有些变化。');
    const response = await fixture.waitForProviderMessage((message) => (
      message.type === 'response.create'
      && String(record(message.response)?.instructions ?? '').includes('沿着当前回答追问当时的变化')
    ), 'deterministic Gate Coach Packet');
    const instructions = String(record(response.response)?.instructions ?? '');
    assert.match(instructions, /避免：避免引导用户接受某个原因/u);
    assert.equal(fixture.searchInputs.length, 1);
    assert.equal(fixture.eraSearchInputs.length, 1);
    assert.equal(fixture.coachResolveInputs.length, 0);
    assert.equal(fixture.providerMessages.filter((message) => message.type === 'response.create').length, 1);
  } finally {
    await fixture.close();
  }
});

test('stepaudio2_mini supervisor_auto answers directly with a short packet for guide without retrieval', async () => {
  const fixture = await createFixture({
    realtimeMemoryTriggerMode: 'supervisor_auto',
    provider: 'stepaudio2_mini',
    manualTurnControl: true,
    coach: {
      async evaluate() {
        return {
          action: 'guide', retrieve_memory: false, memory_query: null,
          retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
          reason: 'direction_drift', avoid: '回到当前故事。', direction: '继续问第一次作决定时的原因。',
        };
      },
      async resolve() { throw new Error('Resolve must not run when Gate requests no retrieval'); },
    },
  });
  try {
    await sendManualUserFinal(fixture, 'coach-direct-guide-turn', '之后我换了一个选择。');
    const response = await fixture.waitForProviderMessage((message) => (
      message.type === 'response.create'
      && String(record(message.response)?.instructions ?? '').includes('继续问第一次作决定时的原因')
    ), 'direct Gate Coach Packet');
    const instructions = String(record(response.response)?.instructions ?? '');
    assert.match(instructions, /【采访教练】/u);
    assert.match(instructions, /继续问第一次作决定时的原因/u);
    assert.equal(fixture.searchInputs.length, 0);
    assert.equal(fixture.eraSearchInputs.length, 0);
    assert.equal(fixture.coachResolveInputs.length, 0);
    assert.equal(fixture.providerMessages.filter((message) => message.type === 'response.create').length, 1);
  } finally {
    await fixture.close();
  }
});

test('stepaudio2_mini supervisor_auto discards Coach when both requested retrievals fail', async () => {
  const fixture = await createFixture({
    realtimeMemoryTriggerMode: 'supervisor_auto',
    provider: 'stepaudio2_mini',
    manualTurnControl: true,
    eraEnabled: true,
    eraContext: { async search() { throw new Error('ERA_TEST_FAILURE'); } },
    coach: {
      async evaluate() {
        return {
          action: 'guide', retrieve_memory: true, memory_query: 'retriever-failure',
          retrieve_era: true, era_query: 'era-failure', era_start_year: 1998, era_end_year: 1999,
          reason: 'history_reference', avoid: '不要推断任何未经证实的经历。', direction: '利用历史证据继续追问。',
        };
      },
      async resolve() { throw new Error('Resolve has no evidence after both retrievals fail'); },
    },
  });
  try {
    await sendManualUserFinal(fixture, 'coach-both-retrievals-fail', '我还记得那段时间。');
    const response = await fixture.waitForProviderMessage(
      (message) => message.type === 'response.create',
      'ordinary Mini response after both retrievals fail',
    );
    const instructions = String(record(response.response)?.instructions ?? '');
    assert.match(instructions, /你是人生采访记者/u);
    assert.doesNotMatch(instructions, /利用历史证据继续追问|【采访教练】已知：/u);
    assert.equal(fixture.searchInputs.length, 1);
    assert.equal(fixture.eraSearchInputs.length, 1);
    assert.equal(fixture.coachResolveInputs.length, 0);
    assert.equal(fixture.providerMessages.filter((message) => message.type === 'response.create').length, 1);
  } finally {
    await fixture.close();
  }
});
