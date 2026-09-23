import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodePcmSamples,
  decodePcmSamplesWithMetrics,
  isOutputAudioPlaybackPending,
  shouldInterruptOutputAudioOnEnd,
} from './audio-format.js';

test('output playback drain waits for pending decode, scheduled nodes, and future audio', () => {
  assert.equal(isOutputAudioPlaybackPending({ pendingScheduleCount: 1 }), true);
  assert.equal(isOutputAudioPlaybackPending({ playbackNodeCount: 1 }), true);
  assert.equal(isOutputAudioPlaybackPending({
    contextState: 'running',
    currentTime: 3,
    playbackCursor: 4,
  }), true);
  assert.equal(isOutputAudioPlaybackPending({
    contextState: 'running',
    currentTime: 4,
    playbackCursor: 3,
  }), false);
  assert.equal(isOutputAudioPlaybackPending({
    contextState: 'closed',
    currentTime: 0,
    playbackCursor: 4,
  }), false);
});

test('manual end interrupts an active or queued assistant response, but keeps a pending final reply', () => {
  assert.equal(shouldInterruptOutputAudioOnEnd({
    reason: 'user',
    lifecycle: 'responding',
  }), true);
  assert.equal(shouldInterruptOutputAudioOnEnd({
    reason: 'user',
    lifecycle: 'active',
    outputAudioPending: true,
  }), true);
  assert.equal(shouldInterruptOutputAudioOnEnd({
    reason: 'user',
    lifecycle: 'active',
    outputAudioPending: false,
  }), false);
  assert.equal(shouldInterruptOutputAudioOnEnd({
    reason: 'assistant_farewell',
    lifecycle: 'responding',
    outputAudioPending: true,
  }), false);
});

test('decodePcmSamples reads realtime PCM16 little-endian samples', () => {
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  [-32768, 0, 16384].forEach((sample, index) => view.setInt16(index * 2, sample, true));
  assert.deepEqual(Array.from(decodePcmSamples(bytes, 'pcm_s16le')), [-1, 0, 0.5]);
});

test('decodePcmSamples rejects unknown and incomplete PCM formats instead of playing noise', () => {
  assert.throws(() => decodePcmSamples(new Uint8Array(4), 'ogg_opus'), /Unsupported PCM encoding/);
  assert.throws(() => decodePcmSamples(new Uint8Array(3), 'pcm_s16le'), /aligned to 2-byte/);
  assert.throws(() => decodePcmSamples(new Uint8Array(6), 'pcm_f32le'), /Unsupported PCM encoding/);
});
