import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalVadTurnController } from './local-vad-turn-controller.js';

test('speech starts only after consecutive high-threshold frames', () => {
  const controller = createLocalVadTurnController();

  assert.deepEqual(controller.update(0.5, 0), []);
  assert.equal(controller.getState().candidateFrames, 1);
  assert.deepEqual(controller.update(0.2, 10), []);
  assert.deepEqual(controller.update(0.5, 20), []);
  assert.deepEqual(controller.update(0.8, 30), [{ type: 'speech_started' }]);
  assert.equal(controller.getState().isSpeaking, true);
  assert.equal(controller.getState().candidateFrames, 0);
});

test('invalid probabilities are ignored without breaking a start candidate or triggering commit', () => {
  const controller = createLocalVadTurnController();

  assert.deepEqual(controller.update(0.7, 0), []);
  for (const probability of [NaN, -0.01, 1.01, Infinity]) {
    assert.deepEqual(controller.update(probability, 10), []);
  }
  assert.deepEqual(controller.update(0.5, 20), [{ type: 'speech_started' }]);

  assert.deepEqual(controller.update(0.2, 100), [{ type: 'silence_started' }]);
  assert.deepEqual(controller.update(NaN, 5100), []);
  assert.deepEqual(controller.update(0.2, 5200), [{
    type: 'commit_triggered',
    silenceObservedMs: 5100,
    silenceThresholdMs: 2000,
  }]);
});

test('continuation threshold is inclusive and commit fires once at exactly the silence threshold', () => {
  const controller = createLocalVadTurnController();

  controller.update(0.6, 0);
  assert.deepEqual(controller.update(0.5, 10), [{ type: 'speech_started' }]);
  assert.deepEqual(controller.update(0.25, 100), []);
  assert.deepEqual(controller.update(0.249, 200), [{ type: 'silence_started' }]);
  assert.deepEqual(controller.update(0.2, 2199), []);
  assert.deepEqual(controller.update(0.2, 2200), [{
    type: 'commit_triggered',
    silenceObservedMs: 2000,
    silenceThresholdMs: 2000,
  }]);
  assert.deepEqual(controller.update(0.1, 6000), []);
});

test('speech resumption clears silence and starts a fresh silence interval later', () => {
  const controller = createLocalVadTurnController();

  controller.update(0.8, 0);
  controller.update(0.8, 10);
  assert.deepEqual(controller.update(0.1, 100), [{ type: 'silence_started' }]);
  assert.deepEqual(controller.update(0.25, 200), [{ type: 'speech_resumed' }]);
  assert.equal(controller.getState().silenceStartedAtMs, null);
  assert.equal(controller.getState().commitTriggered, false);
  assert.deepEqual(controller.update(0.1, 300), [{ type: 'silence_started' }]);
  assert.deepEqual(controller.update(0.1, 2299), []);
  assert.deepEqual(controller.update(0.1, 2300), [{
    type: 'commit_triggered',
    silenceObservedMs: 2000,
    silenceThresholdMs: 2000,
  }]);
});

test('custom thresholds, silence timeout, and required start frames are honored', () => {
  const controller = createLocalVadTurnController({
    silenceTimeoutMs: 1000,
    startThreshold: 0.7,
    continueThreshold: 0.2,
    consecutiveStartFrames: 3,
  });

  assert.deepEqual(controller.update(0.69, 0), []);
  assert.deepEqual(controller.update(0.7, 10), []);
  assert.deepEqual(controller.update(0.9, 20), []);
  assert.deepEqual(controller.update(0.8, 30), [{ type: 'speech_started' }]);
  assert.deepEqual(controller.update(0.2, 100), []);
  assert.deepEqual(controller.update(0.19, 200), [{ type: 'silence_started' }]);
  assert.deepEqual(controller.update(0.1, 1199), []);
  assert.deepEqual(controller.update(0.1, 1200), [{
    type: 'commit_triggered',
    silenceObservedMs: 1000,
    silenceThresholdMs: 1000,
  }]);
});

test('disabling clears a start candidate and silence without committing', () => {
  const controller = createLocalVadTurnController();

  controller.update(0.8, 0);
  controller.setEnabled(false);
  assert.equal(controller.getState().candidateFrames, 0);
  assert.equal(controller.getState().isSpeaking, false);
  assert.deepEqual(controller.update(0.8, 10), []);
  controller.setEnabled(true);
  assert.deepEqual(controller.update(0.8, 20), []);
  assert.deepEqual(controller.update(0.8, 30), [{ type: 'speech_started' }]);

  assert.deepEqual(controller.update(0.1, 100), [{ type: 'silence_started' }]);
  controller.setEnabled(false);
  assert.deepEqual(controller.update(0.1, 6000), []);
  assert.equal(controller.getState().silenceStartedAtMs, null);
  controller.setEnabled(true);
  assert.deepEqual(controller.update(0.1, 6001), []);
  assert.equal(controller.getState().commitTriggered, false);
});

test('reset clears candidates and silence without changing enabled state or committing', () => {
  const controller = createLocalVadTurnController();

  controller.update(0.8, 0);
  controller.reset();
  assert.equal(controller.getState().enabled, true);
  assert.equal(controller.getState().candidateFrames, 0);
  assert.deepEqual(controller.update(0.8, 10), []);
  assert.deepEqual(controller.update(0.8, 20), [{ type: 'speech_started' }]);

  assert.deepEqual(controller.update(0.1, 100), [{ type: 'silence_started' }]);
  controller.reset();
  assert.equal(controller.getState().isSpeaking, false);
  assert.equal(controller.getState().silenceStartedAtMs, null);
  assert.deepEqual(controller.update(0.1, 6000), []);
  assert.equal(controller.getState().commitTriggered, false);
});
