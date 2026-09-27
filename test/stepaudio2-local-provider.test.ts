import assert from 'node:assert/strict';
import test from 'node:test';
import { createRealtimeInterviewProvider } from '../src/realtime/provider.js';
import { resolveRealtimeProviderConfig, realtimeProviderHealthSummary } from '../src/realtime/runtime-config.js';

test('local Step-Audio-2 starts conservative and accepts explicit bridge capabilities', () => {
  const config = resolveRealtimeProviderConfig('stepaudio2_mini', {
    region: 'cn-beijing',
    model: 'step-audio-2-mini',
    stepfunModel: 'step-audio-2-mini',
    stepaudio2Execution: 'local',
    stepaudio2LocalUrl: 'ws://127.0.0.1:8092/realtime',
  });
  const provider = createRealtimeInterviewProvider('stepaudio2_mini', config);

  assert.deepEqual(provider.connectOptions(), {
    url: 'ws://127.0.0.1:8092/realtime',
    headers: {},
  });
  assert.deepEqual(provider.audio, {
    input: {
      codec: 'pcm_s16le',
      encoding: 'pcm_s16le',
      sampleRate: 24_000,
      channels: 1,
      chunkFormat: 'raw-pcm',
      frameBytes: 960,
    },
    output: {
      codec: 'pcm_s16le',
      encoding: 'pcm_s16le',
      sampleRate: 24_000,
      channels: 1,
      chunkFormat: 'raw-pcm',
    },
  });
  assert.equal(provider.capabilities.fullDuplex, false);
  assert.equal(provider.capabilities.supportsContextInjection, false);
  assert.equal(provider.capabilities.manualTurnControl, false);

  assert.deepEqual(provider.normalizeServerMessage(JSON.stringify({
    type: 'session.capabilities',
    capabilities: {
      fullDuplex: false,
      supportsInterrupt: false,
      supportsToolCalling: false,
      supportsContextInjection: true,
      supportsExplicitTurnRequest: true,
      supportsPlaybackAck: false,
      supportsExplicitSessionClose: true,
      manualTurnControl: true,
    },
  })), []);

  assert.deepEqual(provider.capabilities, {
    fullDuplex: false,
    supportsInterrupt: false,
    supportsToolCalling: false,
    supportsContextInjection: true,
    supportsExplicitTurnRequest: true,
    supportsPlaybackAck: false,
    supportsExplicitSessionClose: true,
    manualTurnControl: true,
  });

  assert.deepEqual(provider.normalizeServerMessage(JSON.stringify({
    type: 'session.updated',
    session: { id: 'local-session', turn_detection: null },
  })), [
    { type: 'session.ready', providerSessionId: 'local-session' },
    { type: 'session.configured', turnDetectionMode: 'manual' },
  ]);
});

test('local Step-Audio-2 rejects incomplete capability claims instead of inventing support', () => {
  const provider = createRealtimeInterviewProvider('stepaudio2_mini', {
    region: 'cn-beijing',
    model: 'step-audio-2-mini',
    stepaudio2Execution: 'local',
    stepaudio2LocalUrl: 'ws://localhost:8092/realtime',
  });
  const events = provider.normalizeServerMessage(JSON.stringify({
    type: 'session.capabilities',
    capabilities: { fullDuplex: true },
  }));
  assert.equal(events[0]?.type, 'provider.error');
  assert.equal(provider.capabilities.fullDuplex, false);
});

test('health summary distinguishes local Step-Audio-2 from cloud compatibility alias', () => {
  const health = realtimeProviderHealthSummary({
    region: 'cn-beijing',
    model: 'step-audio-2-mini',
    stepfunModel: 'step-audio-2-mini',
    stepaudio2Execution: 'local',
    stepaudio2LocalUrl: 'ws://127.0.0.1:8092/realtime',
  });
  assert.equal(health.stepaudio2_mini.configured, true);
  assert.equal(health.stepaudio2_mini.execution, 'local');
  assert.equal(health.stepfun.configured, false);
  assert.equal(health.stepfun.execution, 'stepfun-cloud');
});
