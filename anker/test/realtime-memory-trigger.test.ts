import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseRealtimeMemoryTriggerMode,
  resolveRealtimeMemoryTriggerMode,
} from '../src/realtime/runtime-config.js';

test('memory trigger normalizes the deprecated alias and leaves profile defaults unresolved', () => {
  assert.equal(parseRealtimeMemoryTriggerMode(undefined), undefined);
  assert.equal(parseRealtimeMemoryTriggerMode(''), undefined);
  assert.equal(parseRealtimeMemoryTriggerMode('voice_tool'), 'voice_tool');
  assert.equal(parseRealtimeMemoryTriggerMode('supervisor_auto'), 'supervisor_auto');
  assert.equal(parseRealtimeMemoryTriggerMode('backend_auto'), 'supervisor_auto');
  assert.throws(() => parseRealtimeMemoryTriggerMode('both'), /REALTIME_MEMORY_TRIGGER/);
});

test('StepAudio profiles select independent trigger defaults and keep Audio 3 off Coach', () => {
  assert.equal(resolveRealtimeMemoryTriggerMode('stepaudio3_quality'), 'voice_tool');
  assert.equal(resolveRealtimeMemoryTriggerMode('stepaudio2_mini'), 'supervisor_auto');
  assert.equal(resolveRealtimeMemoryTriggerMode('stepaudio2_mini', 'voice_tool'), 'voice_tool');
  assert.equal(resolveRealtimeMemoryTriggerMode('stepaudio3_quality', 'supervisor_auto'), 'voice_tool');
  assert.equal(resolveRealtimeMemoryTriggerMode('stepfun'), 'supervisor_auto');
});
