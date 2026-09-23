import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  automaticEndReason,
  realtimeCallStatus,
  resolveRealtimeProvider,
  shouldIgnoreAssistantResponseMessage,
} from './interview-state.js';

test('configured Realtime provider defaults to Step-Audio and preserves explicit Qwen routing', () => {
  assert.equal(resolveRealtimeProvider('stepfun'), 'stepfun');
  assert.equal(resolveRealtimeProvider('qwen'), 'qwen');
  assert.equal(resolveRealtimeProvider('unknown'), 'stepfun');
});

test('Step realtime events map to the visible call states', () => {
  const cases = [
    ['speech_started', 'user-speaking', '正在听你说'],
    ['speech_stopped', 'thinking', '正在理解'],
    ['user_final', 'thinking', '正在准备回应'],
    ['assistant_started', 'responding', '采访官正在说'],
    ['response_done', 'responding', '采访官正在说'],
    ['playback_drained', 'active', '正在听'],
  ];
  for (const [event, status, label] of cases) {
    assert.deepEqual(realtimeCallStatus(event, 'active'), { status, label });
  }
  assert.equal(realtimeCallStatus('tool_call_started', 'thinking'), null);
  assert.equal(realtimeCallStatus('assistant_started', 'ending'), null);
});

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
