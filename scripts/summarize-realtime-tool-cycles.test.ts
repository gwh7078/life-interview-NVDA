import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  readRealtimeToolTraceRows,
  summarizeRealtimeToolCycles,
} from './summarize-realtime-tool-cycles.js';

test('tool-cycle summary reports latency, fallback and token metrics without identifiers', () => {
  const summary = summarizeRealtimeToolCycles([
    { event: 'realtime.tool_cycle_terminal', callId: 'private-call-1', outcome: 'completed', toolCycleLatencyMs: 100, slowRecallLatencyMs: 40, retrievalLatencyMs: 10, slowAgentLatencyMs: 25, slowPathLatencyMs: 40, toolResultWriteLatencyMs: 42, responseBLatencyMs: 15, responseBFirstAudioMs: 30, toolToFirstAudioMs: 75, responseBTotalMs: 60, selectedEvidenceCount: 1, slowAgentStarted: true, promptTokens: 20, completionTokens: 8, totalTokens: 28 },
    { event: 'realtime.tool_cycle_terminal', callId: 'private-call-2', outcome: 'completed', toolCycleLatencyMs: 200, slowRecallLatencyMs: 80, retrievalLatencyMs: 20, slowAgentLatencyMs: 55, slowPathLatencyMs: 80, toolResultWriteLatencyMs: 85, responseBLatencyMs: 25, responseBFirstAudioMs: 50, toolToFirstAudioMs: 120, responseBTotalMs: 120, selectedEvidenceCount: 3, fallbackUsed: true, slowAgentStarted: true, promptTokens: 40, completionTokens: 10, totalTokens: 50 },
    { event: 'realtime.tool_cycle_terminal', callId: 'private-call-3', outcome: 'timeout', toolCycleLatencyMs: 500, slowRecallLatencyMs: 500, fallbackUsed: true, slowAgentSkipped: true, slowAgentSkipReason: 'no_evidence' },
    { event: 'realtime.tool_cycle_started', callId: 'private-call-4' },
  ]);

  assert.deepEqual(summary, {
    terminalCycles: 3,
    outcomeCounts: { completed: 2, timeout: 1 },
    fallback: { cycles: 2, rate: 0.6667 },
    noEvidenceSkip: { cycles: 1, rate: 0.3333 },
    agentStartedCycles: 2,
    selectedEvidenceAverage: 2,
    tokenUsage: {
      prompt: { samples: 2, p50: 20, p95: 40, average: 30 },
      completion: { samples: 2, p50: 8, p95: 10, average: 9 },
      total: { samples: 2, p50: 28, p95: 50, average: 39 },
    },
    latencyMs: {
      completedCycle: { samples: 2, p50: 100, p95: 200 },
      slowRecall: { samples: 3, p50: 80, p95: 500 },
      retrieval: { samples: 2, p50: 10, p95: 20 },
      slowAgent: { samples: 2, p50: 25, p95: 55 },
      slowPath: { samples: 2, p50: 40, p95: 80 },
      toolResultWrite: { samples: 2, p50: 42, p95: 85 },
      responseBStart: { samples: 2, p50: 15, p95: 25 },
      responseBFirstAudio: { samples: 2, p50: 30, p95: 50 },
      toolToFirstAudio: { samples: 2, p50: 75, p95: 120 },
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
