import assert from 'node:assert/strict';
import { test } from 'node:test';
import { automaticEndReason, shouldIgnoreAssistantResponseMessage } from './interview-state.js';

test('assistant output cannot restart a manually ending interview', () => {
  for (const messageType of [
    'assistant_started',
    'assistant_partial',
    'assistant_audio',
    'assistant_audio_started',
    'assistant_audio_done',
    'assistant_final',
  ]) {
    assert.equal(shouldIgnoreAssistantResponseMessage('ending', messageType), true, messageType);
  }

  assert.equal(shouldIgnoreAssistantResponseMessage('active', 'assistant_started'), false);
  assert.equal(shouldIgnoreAssistantResponseMessage('responding', 'assistant_audio'), false);
  assert.equal(shouldIgnoreAssistantResponseMessage('ending', 'user_final'), false);
  assert.equal(shouldIgnoreAssistantResponseMessage('ending', 'response_done'), false);
});

test('automatic end preserves the onboarding model-completion signal', () => {
  assert.equal(automaticEndReason('model_complete', 'onboarding'), 'model_complete');
  assert.equal(automaticEndReason('model_complete', 'story'), 'user_confirmed');
  assert.equal(automaticEndReason('timeout', 'onboarding'), 'timeout');
  assert.equal(automaticEndReason('assistant_farewell', 'story'), 'assistant_farewell');
  assert.equal(automaticEndReason('unknown', 'onboarding'), 'user_confirmed');
});
