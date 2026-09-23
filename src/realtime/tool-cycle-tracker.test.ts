import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRealtimeToolCycleTracker } from './tool-cycle-tracker.js';
import type { RealtimeTraceFields } from './trace.js';

function createHarness() {
  const rows: Array<{ event: string; fields: RealtimeTraceFields }> = [];
  let now = 0;
  const tracker = createRealtimeToolCycleTracker({
    now: () => now,
    record: (event, fields = {}) => rows.push({ event, fields }),
  });
  return { tracker, rows, setNow: (value: number) => { now = value; } };
}

test('realtime tool cycle correlates the tool result, resumed response, first audio, and terminal latency', () => {
  const { tracker, rows, setNow } = createHarness();
  setNow(100);
  tracker.markAssistantResponseStarted('response-A');
  tracker.start({
    callId: 'call-1',
    toolName: 'get_interview_context',
    responseAId: 'response-A',
    turnId: 'user-turn-1',
    contextVersion: 2,
  });
  tracker.markRecallStarted('call-1');
  setNow(140);
  tracker.markRecallFinished('call-1', { status: 'completed', latencyMs: 38 });
  setNow(142);
  tracker.recordMessageWrite('call-1', { kind: 'output', messageIndex: 0, sent: true });
  setNow(145);
  tracker.recordMessageWrite('call-1', { kind: 'resume', messageIndex: 1, sent: true });
  setNow(160);
  tracker.markAssistantResponseStarted('response-B');
  setNow(190);
  tracker.markFirstAudio('response-B');
  setNow(260);
  tracker.markAssistantResponseDone('response-B', 'completed');

  assert.equal(rows[0]?.event, 'realtime.tool_cycle_started');
  assert.equal(rows[0]?.fields.responseAStartedToToolCallMs, 0);
  assert.equal(rows.find((row) => row.event === 'realtime.tool_cycle_message_write')?.fields.messageKind, 'output');
  assert.equal(rows.find((row) => row.event === 'realtime.tool_cycle_response_started')?.fields.responseBLatencyMs, 15);
  assert.equal(rows.find((row) => row.event === 'realtime.tool_cycle_response_first_audio')?.fields.responseBFirstAudioMs, 30);
  const terminal = rows.find((row) => row.event === 'realtime.tool_cycle_terminal');
  assert.equal(terminal?.fields.outcome, 'completed');
  assert.equal(terminal?.fields.responseBTotalMs, 100);
  assert.equal(terminal?.fields.toolCycleLatencyMs, 160);
  assert.equal(terminal?.fields.slowRecallLatencyMs, 38);
});

test('realtime tool cycle preserves timeout, failed-send, stale, and disconnect outcomes', () => {
  const { tracker, rows, setNow } = createHarness();
  tracker.start({ callId: 'timeout', toolName: 'context', responseAId: 'A-timeout' });
  tracker.markRecallFinished('timeout', { status: 'timeout', latencyMs: 500, errorCode: 'REALTIME_RECALL_TIMEOUT' });
  tracker.recordMessageWrite('timeout', { kind: 'output', messageIndex: 0, sent: true });
  tracker.recordMessageWrite('timeout', { kind: 'resume', messageIndex: 1, sent: true });
  tracker.markAssistantResponseStarted('B-timeout');
  tracker.markAssistantResponseDone('B-timeout', 'completed');

  tracker.start({ callId: 'partial', toolName: 'context', responseAId: 'A-partial' });
  tracker.recordMessageWrite('partial', { kind: 'output', messageIndex: 0, sent: true });
  tracker.recordMessageWrite('partial', { kind: 'resume', messageIndex: 1, sent: false });
  tracker.finish('partial', 'failed', 'resume_write_failed');

  tracker.start({ callId: 'stale', toolName: 'context', responseAId: 'A-stale' });
  tracker.finish('stale', 'stale', 'context_version_changed');

  tracker.start({ callId: 'disconnected', toolName: 'context', responseAId: 'A-disconnected' });
  setNow(900);
  tracker.finishAll('provider_disconnected', 'provider_socket_closed');

  const outcomes = new Map(rows
    .filter((row) => row.event === 'realtime.tool_cycle_terminal')
    .map((row) => [row.fields.callId, row.fields.outcome]));
  assert.deepEqual([...outcomes], [
    ['timeout', 'timeout'],
    ['partial', 'failed'],
    ['stale', 'stale'],
    ['disconnected', 'provider_disconnected'],
  ]);
  assert.equal(rows.find((row) => row.event === 'realtime.tool_cycle_terminal' && row.fields.callId === 'timeout')?.fields.errorCode,
    'REALTIME_RECALL_TIMEOUT');
});

test('realtime tool cycle can be closed when the session ends before a result arrives', () => {
  const { tracker, rows } = createHarness();
  tracker.start({ callId: 'pending', toolName: 'context', responseAId: 'A-pending' });
  tracker.finishAll('session_ended', 'user_ended');
  assert.equal(rows.at(-1)?.fields.outcome, 'session_ended');
  assert.equal(rows.at(-1)?.fields.reason, 'user_ended');
});

test('realtime tool cycle times out if the provider never starts the resumed response', async () => {
  const rows: Array<{ event: string; fields: RealtimeTraceFields }> = [];
  const tracker = createRealtimeToolCycleTracker({
    responseStartTimeoutMs: 5,
    record: (event, fields = {}) => rows.push({ event, fields }),
  });
  tracker.start({ callId: 'missing-response', toolName: 'context', responseAId: 'response-A' });
  tracker.recordMessageWrite('missing-response', { kind: 'output', messageIndex: 0, sent: true });
  tracker.recordMessageWrite('missing-response', { kind: 'resume', messageIndex: 1, sent: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const terminal = rows.find((row) => row.event === 'realtime.tool_cycle_terminal');
  assert.equal(terminal?.fields.outcome, 'timeout');
  assert.equal(terminal?.fields.reason, 'response_b_start_timeout');
});
