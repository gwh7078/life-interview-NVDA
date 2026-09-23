import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  readRealtimeToolTraceRows,
  summarizeRealtimeToolCycles,
} from './summarize-realtime-tool-cycles.js';

test('tool-cycle summary reports terminal outcomes and percentiles without identifiers', () => {
  const summary = summarizeRealtimeToolCycles([
    { event: 'realtime.tool_cycle_terminal', callId: 'private-call-1', outcome: 'completed', toolCycleLatencyMs: 100, slowRecallLatencyMs: 40, responseBLatencyMs: 15, responseBFirstAudioMs: 30, responseBTotalMs: 60 },
    { event: 'realtime.tool_cycle_terminal', callId: 'private-call-2', outcome: 'completed', toolCycleLatencyMs: 200, slowRecallLatencyMs: 80, responseBLatencyMs: 25, responseBFirstAudioMs: 50, responseBTotalMs: 120 },
    { event: 'realtime.tool_cycle_terminal', callId: 'private-call-3', outcome: 'timeout', toolCycleLatencyMs: 500, slowRecallLatencyMs: 500 },
    { event: 'realtime.tool_cycle_started', callId: 'private-call-4' },
  ]);

  assert.deepEqual(summary, {
    terminalCycles: 3,
    outcomeCounts: { completed: 2, timeout: 1 },
    latencyMs: {
      completedCycle: { samples: 2, p50: 100, p95: 200 },
      slowRecall: { samples: 3, p50: 80, p95: 500 },
      responseBStart: { samples: 2, p50: 15, p95: 25 },
      responseBFirstAudio: { samples: 2, p50: 30, p95: 50 },
      responseBTotal: { samples: 2, p50: 60, p95: 120 },
    },
  });
  assert.equal(JSON.stringify(summary).includes('private-call-1'), false);
});

test('trace summary reads retained UUID session files from a directory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'realtime-tool-cycle-summary-'));
  try {
    await writeFile(path.join(directory, '11111111-1111-4111-8111-111111111111.jsonl'), JSON.stringify({
      event: 'realtime.tool_cycle_terminal',
      outcome: 'failed',
      toolCycleLatencyMs: 15,
    }));
    await writeFile(path.join(directory, 'not-a-session.jsonl'), JSON.stringify({
      event: 'realtime.tool_cycle_terminal',
      outcome: 'completed',
    }));

    const result = await readRealtimeToolTraceRows(directory);
    assert.equal(result.files, 1);
    assert.deepEqual(summarizeRealtimeToolCycles(result.rows).outcomeCounts, { failed: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
