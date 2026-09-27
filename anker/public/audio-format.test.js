import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodePcmSamples,
  decodePcmSamplesWithMetrics,
  canResumeRealtimeListening,
  canSchedulePlaybackSegment,
  createPlaybackScheduleQueue,
  isOutputAudioPlaybackPending,
  pcm16MonoDurationMs,
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

test('listening resumes only after the matching completed response has drained', () => {
  const base = { lifecycle: 'responding', status: 'completed', responseMatches: true };
  assert.equal(canResumeRealtimeListening({ ...base, playbackPending: true }), false);
  assert.equal(canResumeRealtimeListening({ ...base, playbackPending: false }), true);
  assert.equal(canResumeRealtimeListening({ ...base, responseMatches: false, playbackPending: false }), false);
  assert.equal(canResumeRealtimeListening({ ...base, lifecycle: 'ending', playbackPending: false }), false);
  assert.equal(canResumeRealtimeListening({ ...base, status: 'cancelled', playbackPending: false }), false);
});

test('PCM scheduling keeps each segment within the bounded AudioContext lookahead', () => {
  const segment = { segmentDurationSeconds: 0.25, startLeadSeconds: 0.12, maxAheadSeconds: 0.85 };
  assert.equal(canSchedulePlaybackSegment({ currentTime: 0, playbackCursor: 0, ...segment }), true);
  assert.equal(canSchedulePlaybackSegment({ currentTime: 0, playbackCursor: 0.6, ...segment }), true);
  assert.equal(canSchedulePlaybackSegment({ currentTime: 0, playbackCursor: 0.61, ...segment }), false);
  assert.equal(canSchedulePlaybackSegment({ currentTime: 3, playbackCursor: 3.61, ...segment }), false);
});

test('playback schedule queue preserves chunk order and invalidates stale async work', async () => {
  const queue = createPlaybackScheduleQueue();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const scheduled = [];
  const first = queue.enqueue('response-1', async (isCurrent) => {
    scheduled.push('first-started');
    markFirstStarted();
    await firstGate;
    if (isCurrent()) scheduled.push('first-scheduled');
  });
  const second = queue.enqueue('response-1', async (isCurrent) => {
    if (isCurrent()) scheduled.push('second-scheduled');
  });
  await firstStarted;
  assert.deepEqual(scheduled, ['first-started']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(scheduled, ['first-started', 'first-scheduled', 'second-scheduled']);

  let releaseStale;
  const staleGate = new Promise((resolve) => { releaseStale = resolve; });
  const staleWork = queue.enqueue('response-2', async (isCurrent) => {
    await staleGate;
    if (isCurrent()) scheduled.push('stale-scheduled');
  });
  queue.invalidate('response-2');
  const freshWork = queue.enqueue('response-3', async (isCurrent) => {
    if (isCurrent()) scheduled.push('fresh-scheduled');
  });
  releaseStale();
  await Promise.all([staleWork, freshWork]);
  assert.equal(scheduled.includes('stale-scheduled'), false);
  assert.equal(scheduled.at(-1), 'fresh-scheduled');
});

test('decodePcmSamples reads realtime PCM16 little-endian samples', () => {
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  [-32768, 0, 16384].forEach((sample, index) => view.setInt16(index * 2, sample, true));
  assert.deepEqual(Array.from(decodePcmSamples(bytes, 'pcm_s16le')), [-1, 0, 0.5]);
});

test('StepFun mono PCM16 byte counts convert to the expected 24 kHz playback duration', () => {
  assert.equal(pcm16MonoDurationMs(48_000, 24_000), 1_000);
  assert.equal(pcm16MonoDurationMs(12_000, 24_000), 250);
  assert.equal(pcm16MonoDurationMs(3, 24_000), 0.0625);
});

test('decodePcmSamples rejects unknown and incomplete PCM formats instead of playing noise', () => {
  assert.throws(() => decodePcmSamples(new Uint8Array(4), 'ogg_opus'), /Unsupported PCM encoding/);
  assert.throws(() => decodePcmSamples(new Uint8Array(3), 'pcm_s16le'), /aligned to 2-byte/);
  assert.throws(() => decodePcmSamples(new Uint8Array(6), 'pcm_f32le'), /Unsupported PCM encoding/);
});
