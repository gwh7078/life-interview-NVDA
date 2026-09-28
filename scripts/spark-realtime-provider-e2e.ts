import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { createInterviewServiceServer, type InterviewServiceDependencies } from '../src/server.js';
import type { RealtimeCoachPort } from '../src/realtime/coach/types.js';
import { startRealtimeSession } from './realtime-e2e-session.js';

type ClientMessage = Record<string, unknown> & { type: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pcmFromWav(file: string): Buffer {
  const wav = readFileSync(file);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ') {
      channels = wav.readUInt16LE(start + 2);
      sampleRate = wav.readUInt32LE(start + 4);
      bits = wav.readUInt16LE(start + 14);
    }
    if (id === 'data') {
      assert.equal(channels, 1);
      assert.equal(sampleRate, 24_000);
      assert.equal(bits, 16);
      return wav.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  throw new Error('fixture WAV has no PCM data chunk');
}

function messagesFor(socket: WebSocket): ClientMessage[] {
  const messages: ClientMessage[] = [];
  socket.on('message', (raw, isBinary) => {
    if (isBinary) return;
    try {
      const value = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (typeof value.type === 'string') messages.push(value as ClientMessage);
    } catch {
      // Client protocol frames used by this test are JSON.
    }
  });
  return messages;
}

async function waitFor(
  messages: ClientMessage[],
  predicate: (message: ClientMessage) => boolean,
  label: string,
  timeoutMs = 180_000,
): Promise<ClientMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = messages.find(predicate);
    if (match) return match;
    await sleep(10);
  }
  throw new Error(`timeout waiting for backend ${label}; seen=${messages.map((m) => m.type).slice(-30).join(',')}`);
}

const coach: RealtimeCoachPort = {
  async evaluate() {
    return {
      action: 'none',
      retrieve_memory: false,
      memory_query: null,
      retrieve_era: false,
      era_query: null,
      era_start_year: null,
      era_end_year: null,
      reason: 'normal',
      avoid: null,
      direction: null,
    };
  },
  async resolve() {
    return {
      selectedEvidenceIds: [],
      known: [],
      backgroundHint: null,
      conflict: null,
      avoid: null,
      direction: null,
    };
  },
};

const root = mkdtempSync(path.join(os.tmpdir(), 'spark-realtime-provider-e2e-'));
const databasePath = path.join(root, 'memoir.db');
const fixture = process.env.SPARK_REALTIME_FIXTURE
  || path.resolve('runtime/benchmarks/spark/fixtures/speech-short.wav');
const audio = pcmFromWav(fixture);
const database = createDatabase(databasePath);
runMigrations(database);
seedDatabase(database);
database.close();

const config = {
  host: '127.0.0.1',
  port: 0,
  databasePath,
  region: 'cn-beijing' as const,
  model: process.env.STEPFUN_REALTIME_MODEL?.trim() || 'step-audio-2-mini',
  defaultRealtimeProvider: 'stepaudio2_mini' as const,
  stepfunModel: process.env.STEPFUN_REALTIME_MODEL?.trim() || 'step-audio-2-mini',
  stepaudio2Execution: 'local' as const,
  stepaudio2LocalUrl: process.env.STEPAUDIO2_LOCAL_WS_URL?.trim() || 'ws://127.0.0.1:8092/realtime',
  realtimeMemoryTriggerMode: 'supervisor_auto' as const,
  realtimeCoachGateTimeoutMs: 2_000,
  realtimeCoachTotalTimeoutMs: 6_000,
  realtimeRetrieverEnabled: false,
  realtimeLocalSilenceTimeoutMs: 2_000,
  developmentAuthEnabled: true,
  wrapUpMs: 100_000,
  maxSessionMs: 200_000,
  closeGraceMs: 5_000,
  openingResponseTimeoutMs: 120_000,
  userTurnStallTimeoutMs: 120_000,
};
const dependencies: InterviewServiceDependencies = {
  realtimeCoach: coach,
  agentTasks: null,
  realtimeContextAgentTasks: null,
};
const server = createInterviewServiceServer(config, dependencies);
let socket: WebSocket | undefined;
const started = performance.now();

try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${baseUrl}/api/auth/development/legacy-session`, { method: 'POST' });
  assert.equal(login.ok, true);
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie);

  socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/realtime`, { headers: { cookie } });
  await once(socket, 'open');
  const messages = messagesFor(socket);
  const ready = await startRealtimeSession(
    socket,
    { type: 'start', story_id: seedIds.firstProject, provider: 'stepaudio2_mini' },
    () => waitFor(messages, (message) => message.type === 'ready', 'ready'),
  );
  assert.equal(ready.manualTurnControl, true);

  await waitFor(
    messages,
    (message) => message.type === 'response_done' && message.status === 'completed',
    'opening response',
  );

  socket.send(JSON.stringify({ type: 'manual_turn_started' }));
  await waitFor(messages, (message) => message.type === 'speech_started', 'manual speech start', 10_000);
  for (let offset = 0; offset < audio.length; offset += 960) {
    socket.send(audio.subarray(offset, Math.min(offset + 960, audio.length)));
  }
  const committedAt = performance.now();
  socket.send(JSON.stringify({ type: 'manual_turn_commit', silenceObservedMs: 2_100 }));

  const userFinal = await waitFor(
    messages,
    (message) => message.type === 'user_final' && typeof message.text === 'string' && message.text.trim().length > 0,
    'user_final',
  );
  const firstAudio = await waitFor(
    messages,
    (message) => message.type === 'assistant_audio' && typeof message.delta === 'string' && message.delta.length > 0,
    'assistant_audio',
  );
  const assistantFinal = await waitFor(
    messages,
    (message) => message.type === 'assistant_final' && typeof message.text === 'string' && message.text.trim().length > 0,
    'assistant_final',
  );
  await waitFor(
    messages,
    (message) => message.type === 'response_done' && message.status === 'completed'
      && messages.indexOf(message) > messages.indexOf(userFinal),
    'turn response_done',
  );

  const result = {
    status: 'PASS',
    provider: ready.provider ?? 'stepaudio2_mini',
    manual_turn_control: ready.manualTurnControl === true,
    user_transcript_chars: String(userFinal.text).length,
    assistant_transcript_chars: String(assistantFinal.text).length,
    assistant_audio_bytes: Buffer.from(String(firstAudio.delta), 'base64').byteLength,
    committed_to_user_final_ms: Math.round(performance.now() - committedAt),
    total_ms: Math.round(performance.now() - started),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  if (socket && socket.readyState === WebSocket.OPEN) socket.close();
  if (server.listening) {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await Promise.race([closed, sleep(2_000)]);
  }
  rmSync(root, { recursive: true, force: true });
}
