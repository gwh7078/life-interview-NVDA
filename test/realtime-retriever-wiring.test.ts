import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { after, test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import type { AgentTaskPort } from '../src/agent-tasks/ports/agent-task-port.js';
import { parseQwenServerEvent } from '../src/realtime/qwen.js';
import type { NormalizedRealtimeEvent } from '../src/realtime/types.js';
import type { RetrieverAdapter } from '../src/retriever/types.js';
import { StoryShareRepository } from '../src/repositories/story-share-repository.js';
import { createInterviewServiceServer } from '../src/server.js';

type JsonRecord = Record<string, unknown>;
type TriggerMode = 'voice_tool' | 'backend_auto';

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
  process.env.DIAGNOSTICS_DIR = diagnosticsDirectory;
  process.env.DIAGNOSTICS_CAPTURE_CONTENT = '1';

  const databasePath = path.join(directory, 'memoir.db');
  const database = createDatabase(databasePath);
  try {
    runMigrations(database);
    seedDatabase(database);
  } finally {
    database.close();
  }
  const share = new StoryShareRepository(databasePath)
    .createForStory(seedIds.user, seedIds.firstProject, 'daughter');
  assert.ok(share);

  const searchInputs: Parameters<RetrieverAdapter['searchTranscript']>[0][] = [];
  const agentQueries: string[] = [];
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
      if (input.query === 'retriever-failure') throw new Error('RETRIEVER_TEST_FAILURE');
      return [{
        text: '[segment_id=history-message][message_id=history-message][Q+A]\nQuestion (context only): 第一次去北京是什么时候？\nAnswer (user-provided fact): 2013 年春节以后第一次到北京。',
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
        socket.send(JSON.stringify({ type: 'response.done', response: { id, status: 'completed' } }));
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
    wrapUpMs: 100_000,
    maxSessionMs: 200_000,
    closeGraceMs: 2_000,
  }, {
    retriever,
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
      requestAssistantTurnMessages: () => [],
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
    ownerSocket.send(JSON.stringify({ type: 'start', story_id: seedIds.firstProject, provider: 'qwen' }));
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
      agentQueries,
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
      },
    };
  } catch (error) {
    if (previousDiagnosticsDirectory === undefined) delete process.env.DIAGNOSTICS_DIR;
    else process.env.DIAGNOSTICS_DIR = previousDiagnosticsDirectory;
    if (previousCaptureContent === undefined) delete process.env.DIAGNOSTICS_CAPTURE_CONTENT;
    else process.env.DIAGNOSTICS_CAPTURE_CONTENT = previousCaptureContent;
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

test('backend_auto starts once from user final and Tool Call does not start a second pipeline or HOLD early', async () => {
  const fixture = await createFixture({ realtimeMemoryTriggerMode: 'backend_auto' });
  try {
    sendUserFinal(fixture, 'auto-final', '我第一次去北京是什么时候？');
    await fixture.waitForOwnerMessage((message) => message.type === 'user_final', 'backend_auto user final');
    await fixture.waitForInjection(1);

    assert.equal(fixture.searchInputs.length, 1);
    assert.equal(fixture.agentQueries.length, 1);
    assert.equal(fixture.searchInputs[0]?.query, '我第一次去北京是什么时候？');
    assert.equal(fixture.agentQueries[0], '我第一次去北京是什么时候？');
    assert.equal(
      fixture.providerMessages.some((message) => message.type === 'mock.tool_result'
        || message.type === 'response.create'),
      false,
      'backend_auto without a Tool Call must not enter HOLD or send Tool Result/Resume',
    );

    sendContextToolCall(fixture, 'auto-unexpected-tool', '后来发生了什么');
    const toolResult = await fixture.waitForToolResult(1);
    assert.equal(fixture.searchInputs.length, 1, 'Tool Call must not launch a second Retriever pipeline');
    assert.equal(fixture.agentQueries.length, 1, 'Tool Call must not launch a second Agent pipeline');
    assert.equal(fixture.searchInputs[0]?.query, '我第一次去北京是什么时候？');
    assert.equal(
      (record(toolResult.output)?.facts as unknown[] | undefined)?.length,
      0,
      'backend_auto must not reuse its pending Context Hint to answer an unexpected model Tool Call',
    );
    assert.equal(toolResult.resume, true);

    await endStorySession(fixture);
    const traceDirectory = path.join(fixture.diagnosticsDirectory, 'traces', 'realtime');
    const traceText = readFileSync(path.join(traceDirectory, readdirSync(traceDirectory)[0]!), 'utf8');
    const traceRows = traceText.trim().split('\n')
      .map((line) => JSON.parse(line) as JsonRecord);
    const recall = traceRows.find((row) => row.event === 'realtime.slow_recall_finished');
    assert.equal(recall?.status, 'completed');
    assert.equal(recall?.factCount, 1);
    assert.equal('factSourceMessageIds' in (recall ?? {}), false);
    assert.equal('query' in (recall ?? {}), false);
    assert.equal(traceText.includes('我第一次去北京是什么时候？'), false);
    assert.equal(traceText.includes('2013 年春节以后第一次到北京。'), false);
    const cycleEvents = traceRows.filter((row) => String(row.event).startsWith('realtime.tool_cycle_'));
    assert.ok(cycleEvents.some((row) => row.event === 'realtime.tool_cycle_started'
      && row.callId === 'auto-unexpected-tool'));
    assert.ok(cycleEvents.some((row) => row.event === 'realtime.tool_cycle_message_write'
      && row.messageKind === 'output' && row.sent === true));
    assert.ok(cycleEvents.some((row) => row.event === 'realtime.tool_cycle_message_write'
      && row.messageKind === 'resume' && row.sent === true));
    assert.ok(cycleEvents.some((row) => row.event === 'realtime.tool_cycle_response_started'
      && row.responseId === 'response-1'));
    assert.ok(cycleEvents.some((row) => row.event === 'realtime.tool_cycle_terminal'
      && row.outcome === 'completed'));

    const external = await fixture.openExternalClient();
    external.socket.send(JSON.stringify({
      type: 'start',
      interview_type: 'external_contributor',
      provider: 'qwen',
    }));
    await waitForMatch(
      () => external.messages,
      (message) => message.type === 'ready',
      'external ready',
    );
    external.socket.send(JSON.stringify({ type: 'playback_ready' }));
    sendContextToolCall(fixture, 'external-tool', '外部贡献者不应查询 owner Story');
    const externalResult = await fixture.waitForToolResult(2);
    const externalOutput = record(externalResult.output);
    assert.equal(externalOutput?.status, 'unavailable');
    assert.deepEqual(externalOutput?.facts, []);
    assert.equal(externalResult.resume, true);
    assert.equal(fixture.searchInputs.length, 1, 'external contributor must not run owner Story retrieval');

    const externalEnded = waitForMatch(
      () => external.messages,
      (message) => message.type === 'ended',
      'external ended',
    );
    external.socket.send(JSON.stringify({ type: 'end', reason: 'user_confirmed' }));
    await waitFor(externalEnded, 5_000, 'external ended');
  } finally {
    await fixture.close();
  }
});

test('backend_auto runs the shared pipeline and reports unsupported when Context Injection is unavailable', async () => {
  const fixture = await createFixture({
    realtimeMemoryTriggerMode: 'backend_auto',
    supportsContextInjection: false,
  });
  try {
    sendUserFinal(fixture, 'unsupported-final', '我第一次去北京是什么时候？');
    await fixture.waitForAgentQuery('我第一次去北京是什么时候？');

    assert.equal(fixture.searchInputs.length, 1);
    assert.equal(fixture.agentQueries.length, 1);
    assert.equal(fixture.injectedHints.length, 0);

    await delay(40);
    fixture.sendProviderEvent({ type: 'response.created', response: { id: 'unsupported-next-response' } });
    fixture.sendProviderEvent({
      type: 'response.done',
      response: { id: 'unsupported-next-response', status: 'completed' },
    });
    await fixture.waitForOwnerMessage(
      (message) => message.type === 'response_done' && message.responseId === 'unsupported-next-response',
      'unsupported flow voice response',
    );
    await endStorySession(fixture);
    const traceDirectory = path.join(fixture.diagnosticsDirectory, 'traces', 'realtime');
    const traceText = readFileSync(path.join(traceDirectory, readdirSync(traceDirectory)[0]!), 'utf8');
    const traceRows = traceText.trim().split('\n').map((line) => JSON.parse(line) as JsonRecord);
    assert.ok(traceRows.some((row) => row.event === 'realtime.memory_trigger.unsupported'
      && row.reason === 'context_injection_unsupported'));
    assert.ok(traceRows.some((row) => row.event === 'realtime.slow_recall_finished'
      && row.status === 'unsupported'));
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

test('backend_auto drops a pending Hint that expires before the next safe manual commit', async () => {
  const deadlineMs = 250;
  const fixture = await createFixture({
    realtimeMemoryTriggerMode: 'backend_auto',
    realtimeSlowDeadlineMs: deadlineMs,
    manualTurnControl: true,
  });
  try {
    const triggerStartedAt = performance.now();
    sendUserFinal(fixture, 'ttl-final', '需要保存的这一轮上下文。');
    await fixture.waitForOwnerMessage((message) => message.type === 'user_final', 'TTL user final');
    const prepared = await fixture.waitForInjection(1);
    assert.ok(prepared.at - triggerStartedAt < deadlineMs,
      'the Hint must be generated within the test deadline before expiry is exercised');

    const expireAfter = prepared.at + deadlineMs + 25;
    const waitMs = expireAfter - performance.now();
    if (waitMs > 0) await delay(waitMs);
    assert.ok(performance.now() > expireAfter, 'the pending Hint must be expired before commit');

    fixture.sendProviderEvent({ type: 'response.created', response: { id: 'auto-answer' } });
    fixture.sendProviderEvent({
      type: 'response.done',
      response: { id: 'auto-answer', status: 'completed' },
    });
    await fixture.waitForOwnerMessage(
      (message) => message.type === 'response_done' && message.responseId === 'auto-answer',
      'automatic answer completed',
    );
    fixture.ownerSocket.send(JSON.stringify({ type: 'manual_turn_started' }));
    await fixture.waitForOwnerMessage((message) => message.type === 'speech_started', 'manual turn started');
    fixture.ownerSocket.send(JSON.stringify({ type: 'manual_turn_commit', silenceObservedMs: 5_000 }));
    await fixture.waitForProviderMessage((message) => message.type === 'mock.commit', 'safe manual commit');

    assert.equal(
      fixture.providerMessages.some((message) => message.type === 'mock.context_hint'),
      false,
      'an expired pending Hint must be dropped instead of injected at the safe manual commit',
    );
  } finally {
    await fixture.close();
  }
});
