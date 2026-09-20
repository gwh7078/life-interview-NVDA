import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodePcmSamples,
  decodePcmSamplesWithMetrics,
  isOutputAudioPlaybackPending,
  shouldDeferDoubaoSpeechInterruption,
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

test('Doubao speech_started defers interruption while generation or local playback is still pending', () => {
  assert.equal(shouldDeferDoubaoSpeechInterruption({ responseActive: true }), true);
  assert.equal(shouldDeferDoubaoSpeechInterruption({ outputAudioPending: true }), true);
  assert.equal(shouldDeferDoubaoSpeechInterruption({}), false);
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

test('decodePcmSamples reads Seeduplex float32 PCM as little-endian normalized samples', () => {
  const bytes = new Uint8Array(20);
  const view = new DataView(bytes.buffer);
  [-1, -0.25, 0, 0.5, 1].forEach((sample, index) => view.setFloat32(index * 4, sample, true));
  assert.deepEqual(Array.from(decodePcmSamples(bytes, 'pcm_f32le')), [-1, -0.25, 0, 0.5, 1]);
});

test('decodePcmSamples keeps the Qwen int16 PCM path little-endian', () => {
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  [-32768, 0, 16384].forEach((sample, index) => view.setInt16(index * 2, sample, true));
  assert.deepEqual(Array.from(decodePcmSamples(bytes, 'pcm_s16le')), [-1, 0, 0.5]);
});

test('decodePcmSamples rejects unknown and incomplete PCM formats instead of playing noise', () => {
  assert.throws(() => decodePcmSamples(new Uint8Array(4), 'ogg_opus'), /Unsupported PCM encoding/);
  assert.throws(() => decodePcmSamples(new Uint8Array(3), 'pcm_s16le'), /aligned to 2-byte/);
  assert.throws(() => decodePcmSamples(new Uint8Array(6), 'pcm_f32le'), /aligned to 4-byte/);
});

test('decodePcmSamplesWithMetrics reports privacy-safe waveform diagnostics', () => {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  [-2, Number.NaN, 0.5, 1.5].forEach((sample, index) => view.setFloat32(index * 4, sample, true));
  const result = decodePcmSamplesWithMetrics(bytes, 'pcm_f32le');
  assert.deepEqual(Array.from(result.samples), [-1, 0, 0.5, 1]);
  assert.equal(result.firstSample, -1);
  assert.equal(result.lastSample, 1);
  assert.equal(result.peak, 1);
  assert.equal(result.rms, 0.75);
  assert.equal(result.clippedSamples, 2);
  assert.equal(result.nonFiniteSamples, 1);
});
