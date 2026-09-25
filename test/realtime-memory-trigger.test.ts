import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRealtimeMemoryTriggerMode } from '../src/realtime/runtime-config.js';

test('memory trigger accepts only explicit modes and defaults to the current backend strategy', () => {
  assert.equal(parseRealtimeMemoryTriggerMode(undefined), 'backend_auto');
  assert.equal(parseRealtimeMemoryTriggerMode(''), 'backend_auto');
  assert.equal(parseRealtimeMemoryTriggerMode('voice_tool'), 'voice_tool');
  assert.equal(parseRealtimeMemoryTriggerMode('backend_auto'), 'backend_auto');
  assert.throws(() => parseRealtimeMemoryTriggerMode('both'), /REALTIME_MEMORY_TRIGGER/);
});
