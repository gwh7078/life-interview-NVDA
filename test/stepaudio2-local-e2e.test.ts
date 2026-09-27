import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { createRealtimeInterviewProvider } from '../src/realtime/provider.js';
import type { NormalizedRealtimeEvent, RealtimeOutboundStep } from '../src/realtime/types.js';
import { startFakeStepAudio2Server } from './support/fake-stepaudio2-local-server.js';

function sendSteps(ws: WebSocket, steps: RealtimeOutboundStep[]): void {
  for (const step of steps) ws.send(JSON.stringify(step.message));
}

test('local Step-Audio2 transport preserves the shared normalized realtime contract', async () => {
  const fake = await startFakeStepAudio2Server();
  try {
    const provider = createRealtimeInterviewProvider('stepaudio2_mini', {
      region: 'cn-beijing',
      model: 'step-audio-2-mini',
      stepaudio2Execution: 'local',
      stepaudio2LocalUrl: fake.url,
    });
    const events: NormalizedRealtimeEvent[] = [];
    const ws = new WebSocket(provider.connectOptions().url);
    ws.on('message', (raw) => events.push(...provider.normalizeServerMessage(raw)));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    ws.send(JSON.stringify({ type: 'session.update', session: { instructions: 'test', turn_detection: null } }));
    await assertEventually(() => events.some((event) => event.type === 'session.configured'));

    sendSteps(ws, provider.appendAudioMessages(Buffer.alloc(960)));
    sendSteps(ws, provider.commitAndRespondToInputTurn?.() ?? []);
    await assertEventually(() => events.some((event) => event.type === 'response.done'));

    assert.equal(provider.capabilities.fullDuplex, false);
    assert.equal(provider.capabilities.supportsInterrupt, false);
    assert.equal(provider.capabilities.supportsToolCalling, false);
    assert.equal(provider.capabilities.supportsContextInjection, true);
    assert.equal(provider.capabilities.supportsExplicitTurnRequest, true);
    assert.equal(provider.capabilities.supportsExplicitSessionClose, true);
    assert.equal(provider.capabilities.manualTurnControl, true);

    const types = events.map((event) => event.type);
    for (const expected of [
      'session.ready',
      'session.configured',
      'speech.started',
      'speech.stopped',
      'user.transcript.final',
      'assistant.started',
      'assistant.transcript.delta',
      'assistant.transcript.final',
      'assistant.audio.delta',
      'assistant.audio.done',
      'response.done',
    ]) assert.ok(types.includes(expected as NormalizedRealtimeEvent['type']), `missing normalized event: ${expected}`);

    const close = provider.closePlan?.();
    assert.ok(close);
    sendSteps(ws, close.steps);
    await assertEventually(() => events.some((event) => event.type === 'session.closed'));
  } finally {
    await fake.close();
  }
});

async function assertEventually(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met before timeout');
}
