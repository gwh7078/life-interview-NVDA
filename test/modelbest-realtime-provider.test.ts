import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveAiTaskConfig } from '../src/ai/task-config.js';
import { createModelBestRealtimeProvider, decodeFloat32Base64ToPcm16, encodePcm16ToFloat32Base64 } from '../src/realtime/modelbest.js';
import { resolveRealtimeProviderConfig } from '../src/realtime/runtime-config.js';
import { sessionProviders } from '../src/db/schema.js';
import { parseTranscript } from '../src/db/transcript.js';

const context = {
  interview_type: 'onboarding' as const,
  profile: { name: '测试用户' },
  previousOnboardingTranscripts: [],
  taskContext: { mode: 'new' as const },
};

test('ModelBest can be selected without changing existing Realtime provider options', () => {
  const task = resolveAiTaskConfig({
    STORY_INTERVIEW_PROVIDER: 'modelbest',
    MODELBEST_REALTIME_MODEL: 'MiniCPM-o-4.5-Realtime',
  } as NodeJS.ProcessEnv)['interview.story'];
  assert.equal(task.provider, 'modelbest');
  assert.equal(task.model, 'MiniCPM-o-4.5-Realtime');
  assert.equal(resolveAiTaskConfig({ STORY_INTERVIEW_PROVIDER: 'qwen' } as NodeJS.ProcessEnv)['interview.story'].provider, 'qwen');
  assert.equal(resolveAiTaskConfig({ STORY_INTERVIEW_PROVIDER: 'stepfun' } as NodeJS.ProcessEnv)['interview.story'].provider, 'stepfun');

  const config = resolveRealtimeProviderConfig('modelbest', {
    modelbestApiKey: 'test-modelbest-key',
    modelbestModel: task.model,
    region: 'cn-beijing',
    model: task.model,
  });
  const provider = createModelBestRealtimeProvider(config);
  assert.deepEqual(provider.connectOptions(), {
    url: 'wss://minicpmo45.modelbest.cn/v1/realtime?mode=audio',
    headers: { Authorization: 'Bearer test-modelbest-key' },
  });
  assert.equal(provider.capabilities.supportsToolCalling, false);
  assert.equal(provider.capabilities.supportsContextInjection, false);
  assert.equal(provider.capabilities.supportsExplicitTurnRequest, false);
  assert.equal(provider.requiresQueueBeforeSessionInit, true);
  assert.deepEqual(provider.audio, {
    input: { encoding: 'pcm_s16le', sampleRate: 16_000, frameBytes: 640 },
    output: { encoding: 'pcm_s16le', sampleRate: 24_000 },
  });
});

test('ModelBest provider is accepted by the persisted session and transcript schemas', () => {
  assert.ok((sessionProviders as readonly string[]).includes('modelbest'));
  const [message] = parseTranscript(JSON.stringify([{
    message_id: 'msg_modelbest',
    role: 'user',
    text: '测试语音。',
    timestamp: '2026-09-24T00:00:00.000Z',
    provider: 'modelbest',
  }]));
  assert.equal(message?.provider, 'modelbest');
});

test('ModelBest uses the documented queue, init, input and close lifecycle', () => {
  const provider = createModelBestRealtimeProvider({
    modelbestApiKey: 'test-modelbest-key',
    region: 'cn-beijing',
    model: 'MiniCPM-o-4.5-Realtime',
  });
  assert.deepEqual(provider.normalizeServerMessage(JSON.stringify({ type: 'session.queue_done' })), [
    { type: 'session.queue.ready' },
  ]);
  const setupMessage = provider.setupSession(context)[0];
  assert.equal(setupMessage?.type, 'session.init');
  const setup = setupMessage as { payload: Record<string, unknown> };
  assert.equal(typeof setup.payload.system_prompt, 'string');
  assert.match(setup.payload.system_prompt as string, /称呼/);
  assert.deepEqual(setup.payload.config, { tts_enabled: true });
  assert.deepEqual(provider.closePlan(), {
    steps: [{ message: { type: 'session.close', reason: 'user_stop' } }],
    waitFor: 'session.closed',
    timeoutMs: 5_000,
  });
});

test('ModelBest converts PCM16 microphone frames to Float32 and Float32 output back to PCM16', () => {
  const pcm16 = Buffer.alloc(6);
  pcm16.writeInt16LE(32767, 0);
  pcm16.writeInt16LE(-32768, 2);
  pcm16.writeInt16LE(16384, 4);

  const encoded = Buffer.from(encodePcm16ToFloat32Base64(pcm16), 'base64');
  assert.equal(encoded.length, 12);
  assert.ok(Math.abs(encoded.readFloatLE(0) - 32767 / 32768) < 0.000001);
  assert.equal(encoded.readFloatLE(4), -1);
  assert.equal(encoded.readFloatLE(8), 0.5);

  const floatAudio = Buffer.alloc(16);
  [0, 1, -1, 0.5].forEach((sample, index) => floatAudio.writeFloatLE(sample, index * 4));
  const decoded = decodeFloat32Base64ToPcm16(floatAudio.toString('base64'));
  assert.deepEqual(
    Array.from({ length: decoded.length / 2 }, (_, index) => decoded.readInt16LE(index * 2)),
    [0, 32767, -32768, 16384],
  );
});

test('ModelBest maps provider transcript, assistant, audio, completion and errors safely', () => {
  const secret = 'test-modelbest-key';
  const provider = createModelBestRealtimeProvider({
    modelbestApiKey: secret,
    region: 'cn-beijing',
    model: 'MiniCPM-o-4.5-Realtime',
  });

  assert.deepEqual(provider.normalizeServerMessage(JSON.stringify({
    type: 'session.created',
    session_id: 'modelbest-session',
  })), [{ type: 'session.ready', providerSessionId: 'modelbest-session' }]);

  const userTranscript = provider.normalizeServerMessage(JSON.stringify({
    type: 'response.listen',
    transcript: '我在天津长大。',
    item_id: 'user-item-1',
  }));
  assert.ok(userTranscript.some((event) => event.type === 'user.transcript.final'
    && event.text === '我在天津长大。'));

  const assistantText = provider.normalizeServerMessage(JSON.stringify({
    type: 'response.output_text.delta',
    response_id: 'assistant-1',
    text: '你好。',
  }));
  assert.deepEqual(assistantText, [
    { type: 'assistant.started', responseId: 'assistant-1' },
    { type: 'assistant.transcript.delta', responseId: 'assistant-1', delta: '你好。' },
  ]);

  const floatAudio = Buffer.alloc(8);
  floatAudio.writeFloatLE(0.5, 0);
  floatAudio.writeFloatLE(-0.5, 4);
  const audioEvents = provider.normalizeServerMessage(JSON.stringify({
    type: 'response.output_audio.delta',
    response_id: 'assistant-1',
    audio: floatAudio.toString('base64'),
  }));
  assert.deepEqual(audioEvents.map((event) => event.type), ['assistant.audio.started', 'assistant.audio.delta']);
  const audio = audioEvents[1];
  assert.equal(audio?.type, 'assistant.audio.delta');
  if (audio?.type !== 'assistant.audio.delta') throw new Error('Expected normalized ModelBest audio.');
  assert.equal(audio.encoding, 'pcm_s16le');
  const decodedAudio = Buffer.from(audio.audio, 'base64');
  assert.deepEqual([
    decodedAudio.readInt16LE(0),
    decodedAudio.readInt16LE(2),
  ], [16_384, -16_384]);

  assert.deepEqual(provider.normalizeServerMessage(JSON.stringify({
    type: 'response.done',
    response_id: 'assistant-1',
    status: 'completed',
  })), [{ type: 'response.done', responseId: 'assistant-1', status: 'completed' }]);
  const error = provider.normalizeServerMessage(JSON.stringify({
    type: 'error',
    error: { code: 'invalid_api_key', message: `Rejected ${secret}` },
  }));
  assert.equal(JSON.stringify(error).includes(secret), false);
});

test('ModelBest audio full-duplex listening transition completes the active assistant response', () => {
  const provider = createModelBestRealtimeProvider({
    modelbestApiKey: 'test-modelbest-key',
    region: 'cn-beijing',
    model: 'MiniCPM-o-4.5-Realtime',
  });
  assert.deepEqual(provider.normalizeServerMessage(JSON.stringify({
    type: 'response.output.delta',
    kind: 'text',
    response_id: 'response-1',
    text: '这段经历从什么时候开始？',
  })).map((event) => event.type), ['assistant.started', 'assistant.transcript.delta']);
  assert.deepEqual(provider.normalizeServerMessage(JSON.stringify({
    type: 'response.output.delta',
    kind: 'listen',
    session_id: 'session-1',
  })), [{ type: 'response.done', responseId: 'response-1', status: 'completed' }]);
});
