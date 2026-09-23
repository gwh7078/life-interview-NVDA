import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { after, test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { parseQwenServerEvent } from '../src/realtime/qwen.js';
import type { NormalizedRealtimeEvent } from '../src/realtime/types.js';
import type { RetrieverAdapter } from '../src/retriever/types.js';
import { StoryShareRepository } from '../src/repositories/story-share-repository.js';
import { createInterviewServiceServer } from '../src/server.js';

const temporaryDirectories: string[] = [];

after(() => temporaryDirectories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalize(raw: unknown): NormalizedRealtimeEvent[] {
  const event = record(parseQwenServerEvent(raw));
  if (!event) return [];
  const type = String(event.type ?? '');
  if (type === 'session.updated') return [{ type: 'session.ready', providerSessionId: 'mock-session' }];
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
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs)),
  ]);
}

test('Realtime Tool Call uses the default Retriever recall adapter when one is configured', async () => {
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

  let searchInput: Parameters<RetrieverAdapter['searchTranscript']>[0] | undefined;
  let toolResultCount = 0;
  const retriever: RetrieverAdapter = {
    async indexSessionTranscript() { return { status: 'accepted' }; },
    async searchTranscript(input) {
      searchInput = input;
      return [{
        text: '2013 年春节以后第一次到北京。',
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
  let providerSocket: WebSocket | undefined;
  let resolveToolResult!: (value: Record<string, unknown>) => void;
  const toolResult = new Promise<Record<string, unknown>>((resolve) => { resolveToolResult = resolve; });
  let resolveExternalToolResult!: (value: Record<string, unknown>) => void;
  const externalToolResult = new Promise<Record<string, unknown>>((resolve) => {
    resolveExternalToolResult = resolve;
  });
  providerServer.on('connection', (socket) => {
    providerSocket = socket;
    socket.on('message', (raw) => {
      const message = record(JSON.parse(raw.toString()));
      if (!message) return;
      if (message.type === 'mock.setup') {
        socket.send(JSON.stringify({ type: 'session.updated', session: { id: 'mock-session' } }));
      } else if (message.type === 'mock.opening') {
        socket.send(JSON.stringify({ type: 'response.created', response: { id: 'opening' } }));
        socket.send(JSON.stringify({ type: 'response.done', response: { id: 'opening', status: 'completed' } }));
        setTimeout(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          socket.send(JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: 'turn-1',
            transcript: '我第一次去北京是什么时候？',
          }));
          socket.send(JSON.stringify({
            type: 'response.function_call_arguments.done',
            call_id: 'call-1',
            response_id: 'tool-response',
            name: 'get_interview_context',
            arguments: JSON.stringify({ query: '第一次去北京是什么时候' }),
          }));
        }, 20);
      } else if (message.type === 'mock.tool_result') {
        toolResultCount += 1;
        if (toolResultCount === 1) resolveToolResult(message);
        else resolveExternalToolResult(message);
      } else if (message.type === 'response.create') {
        socket.send(JSON.stringify({ type: 'response.created', response: { id: 'response-B' } }));
        socket.send(JSON.stringify({
          type: 'response.done',
          response: { id: 'response-B', status: 'completed' },
        }));
      }
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
    openingResponseTimeoutMs: 500,
    realtimeSlowDeadlineMs: 500,
    wrapUpMs: 100_000,
    maxSessionMs: 200_000,
    closeGraceMs: 2_000,
  }, {
    retriever,
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
        supportsExplicitTurnRequest: true,
        supportsPlaybackAck: false,
        supportsExplicitSessionClose: false,
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
      stopInputAfterCurrentTurn: () => [],
      beginInputShutdown: () => [],
      closePlan: () => null,
      connectionFailureMessage: () => 'mock realtime failure',
      normalizeServerMessage: normalize,
      handleControlEvent: () => [],
      handleToolResult: (_call, output, options) => [
        { type: 'mock.tool_result', output, resume: false },
        ...(options?.resume === false ? [] : [{ type: 'response.create' }]),
      ],
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
    clientSocket.send(JSON.stringify({ type: 'start', story_id: seedIds.firstProject, provider: 'qwen' }));
    await waitFor(new Promise<void>((resolve) => {
      clientSocket?.on('message', (raw) => {
        if (record(JSON.parse(raw.toString()))?.type === 'ready') resolve();
      });
    }), 2_000, 'story ready');

    const result = await waitFor(toolResult, 2_000, 'story tool result');
    const output = record(result.output);
    assert.equal(searchInput?.ownerId, seedIds.user);
    assert.equal(searchInput?.storyId, seedIds.firstProject);
    assert.equal(searchInput?.sourceType, 'subject');
    assert.equal(searchInput?.query, '第一次去北京是什么时候');
    assert.deepEqual(output?.facts, [{
      claim: '2013 年春节以后第一次到北京。',
      sourceMessageIds: ['history-message'],
    }]);
    assert.equal(result.resume, false);

    const storyEnded = new Promise<void>((resolve) => {
      clientSocket?.on('message', (raw) => {
        if (record(JSON.parse(raw.toString()))?.type === 'ended') resolve();
      });
    });
    clientSocket.send(JSON.stringify({ type: 'end', reason: 'user_confirmed' }));
    await waitFor(storyEnded, 5_000, 'story ended');
    const recallSnapshotDirectory = path.join(diagnosticsDirectory, 'snapshots', 'realtime-slow-recall');
    const recallSnapshot = JSON.parse(readFileSync(
      path.join(recallSnapshotDirectory, readdirSync(recallSnapshotDirectory)[0]!),
      'utf8',
    )) as Record<string, unknown>;
    assert.equal(recallSnapshot.status, 'completed');
    assert.deepEqual(recallSnapshot.result, result.output);

    const traceDirectory = path.join(diagnosticsDirectory, 'traces', 'realtime');
    const traceText = readFileSync(path.join(traceDirectory, readdirSync(traceDirectory)[0]!), 'utf8');
    const slowRecallTrace = traceText.trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((row) => row.event === 'realtime.slow_recall_finished');
    assert.equal(slowRecallTrace?.status, 'completed');
    assert.equal(slowRecallTrace?.factCount, 1);
    assert.equal(slowRecallTrace?.factSourceMessageIds, 'history-message');
    assert.equal('query' in (slowRecallTrace ?? {}), false);
    assert.equal(traceText.includes('第一次去北京是什么时候'), false);
    assert.equal(traceText.includes('2013 年春节以后第一次到北京。'), false);
    const traceRows = traceText.trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const cycleEvents = traceRows.filter((row) => String(row.event).startsWith('realtime.tool_cycle_'));
    assert.ok(cycleEvents.some((row) => row.event === 'realtime.tool_cycle_started' && row.callId === 'call-1'));
    assert.ok(cycleEvents.some((row) => row.event === 'realtime.tool_cycle_message_write'
      && row.messageKind === 'output' && row.sent === true));
    assert.ok(cycleEvents.some((row) => row.event === 'realtime.tool_cycle_message_write'
      && row.messageKind === 'resume' && row.sent === true));
    assert.ok(cycleEvents.some((row) => row.event === 'realtime.tool_cycle_response_started'
      && row.responseId === 'response-B'));
    assert.ok(cycleEvents.some((row) => row.event === 'realtime.tool_cycle_terminal'
      && row.outcome === 'completed'));
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close();
      await once(clientSocket, 'close');
    }
    clientSocket = undefined;
    const externalSocket = new WebSocket(
      `ws://127.0.0.1:${appAddress.port}/api/realtime?share_token=${encodeURIComponent(share.token)}`,
      { headers: { origin: baseUrl } },
    );
    clientSocket = externalSocket;
    await once(externalSocket, 'open');
    externalSocket.send(JSON.stringify({ type: 'start', interview_type: 'external_contributor', provider: 'qwen' }));
    await waitFor(new Promise<void>((resolve) => {
      externalSocket.on('message', (raw) => {
        if (record(JSON.parse(raw.toString()))?.type === 'ready') resolve();
      });
    }), 2_000, 'external ready');
    const externalResult = await waitFor(externalToolResult, 2_000, 'external tool result');
    const externalOutput = record(externalResult.output);
    assert.equal(externalOutput?.status, 'unavailable');
    assert.deepEqual(externalOutput?.facts, []);
    assert.equal(externalResult.resume, false);
    assert.equal(searchInput?.query, '第一次去北京是什么时候');
    assert.equal(toolResultCount, 2);
    const externalEnded = new Promise<void>((resolve) => {
      externalSocket.on('message', (raw) => {
        if (record(JSON.parse(raw.toString()))?.type === 'ended') resolve();
      });
    });
    externalSocket.send(JSON.stringify({ type: 'end', reason: 'user_confirmed' }));
    await waitFor(externalEnded, 5_000, 'external ended');
  } finally {
    if (clientSocket?.readyState === WebSocket.OPEN) clientSocket.close();
    if (providerSocket?.readyState === WebSocket.OPEN) providerSocket.close();
    const appClosed = once(appServer, 'close');
    appServer.close();
    appServer.closeAllConnections();
    await appClosed;
    providerServer.close();
    const providerClosed = once(providerHttp, 'close');
    providerHttp.close();
    await providerClosed;
    if (previousDiagnosticsDirectory === undefined) delete process.env.DIAGNOSTICS_DIR;
    else process.env.DIAGNOSTICS_DIR = previousDiagnosticsDirectory;
    if (previousCaptureContent === undefined) delete process.env.DIAGNOSTICS_CAPTURE_CONTENT;
    else process.env.DIAGNOSTICS_CAPTURE_CONTENT = previousCaptureContent;
  }
});
