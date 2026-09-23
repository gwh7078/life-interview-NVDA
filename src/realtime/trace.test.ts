import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createRealtimeTraceStageTracker, createRealtimeTraceWriter } from './trace.js';

const testTempRoot = path.resolve('data/test-tmp');
mkdirSync(testTempRoot, { recursive: true });

test('realtime trace writes a timestamped metadata-only JSONL timeline', async () => {
  const directory = await mkdtemp(path.join(testTempRoot, 'rensheng-trace-'));
  try {
    const trace = createRealtimeTraceWriter({
      directory,
      sessionId: '2c68b0e0-9c6f-4c09-b568-26e691c7d608',
      provider: 'stepfun',
    });
    trace.record('provider.audio.delta', {
      responseId: 'resp_test_1',
      eventId: 'evt_test_1',
      chunk: 1,
      deltaBytes: 1280,
      transcript: 'sensitive text must never be logged',
      activeResponseCount: 0,
      pendingSpeech: false,
      awaitingUserTranscript: false,
      awaitingAssistant: false,
    });
    trace.record('client.audio_context_ready', {
      contextState: 'running',
      sampleRate: 48000,
      baseLatencyMs: 10.2,
    });
    trace.record('client.output_audio_scheduled', {
      boundaryJump: 0.42,
      peak: 0.86,
      rms: 0.21,
      terminalSampleAbs: 0.38,
      clippedSamples: 0,
      nonFiniteSamples: 0,
      firstSample: 0.9,
    });
    trace.record('provider.input_audio_committed', {
      eventId: 'evt_commit_1',
      responseActive: true,
      activeResponseCount: 1,
      pendingSpeech: true,
      awaitingUserTranscript: true,
      lifecycle: 'active',
      transcript: 'must not be logged',
      audio: 'must not be logged',
    });
    trace.record('client.output_audio_node_start_called', {
      responseId: 'resp_test_1',
      chunk: 2,
      contextTimeMs: 1200,
      scheduledContextTimeMs: 1320,
      contextState: 'running',
      pendingNodes: 2,
      audio: 'must not be logged',
    });
    trace.record('client.output_audio_node_ended', {
      responseId: 'resp_test_1',
      chunk: 2,
      contextTimeMs: 1580,
      scheduledContextTimeMs: 1320,
      contextElapsedSinceScheduledStartMs: 260,
      nodeLifetimeMs: 380,
      contextState: 'running',
      pendingNodes: 1,
      transcript: 'must not be logged',
    });
    await trace.flush();

    const lines = (await readFile(trace.filePath, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 6);
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.match(String(first.at), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(first.session_id, '2c68b0e0-9c6f-4c09-b568-26e691c7d608');
    assert.equal(first.event, 'provider.audio.delta');
    assert.equal(first.deltaBytes, 1280);
    assert.equal(first.eventId, 'evt_test_1');
    assert.equal('transcript' in first, false);
    assert.equal(first.activeResponseCount, 0);
    assert.equal(first.pendingSpeech, false);
    assert.equal(first.awaitingUserTranscript, false);
    assert.equal(first.awaitingAssistant, false);
    const second = JSON.parse(lines[1]) as Record<string, unknown>;
    assert.equal(second.contextState, 'running');
    assert.equal(second.sampleRate, 48000);
    const third = JSON.parse(lines[2]) as Record<string, unknown>;
    assert.equal(third.boundaryJump, 0.42);
    assert.equal(third.terminalSampleAbs, 0.38);
    assert.equal(third.clippedSamples, 0);
    assert.equal(third.nonFiniteSamples, 0);
    assert.equal('firstSample' in third, false);
    const committed = JSON.parse(lines[3]) as Record<string, unknown>;
    assert.equal(committed.eventId, 'evt_commit_1');
    assert.equal(committed.responseActive, true);
    assert.equal(committed.activeResponseCount, 1);
    assert.equal(committed.pendingSpeech, true);
    assert.equal(committed.awaitingUserTranscript, true);
    assert.equal(committed.lifecycle, 'active');
    assert.equal('transcript' in committed, false);
    assert.equal('audio' in committed, false);
    const scheduledNode = JSON.parse(lines[4]) as Record<string, unknown>;
    assert.equal(scheduledNode.responseId, 'resp_test_1');
    assert.equal(scheduledNode.chunk, 2);
    assert.equal(scheduledNode.contextTimeMs, 1200);
    assert.equal(scheduledNode.scheduledContextTimeMs, 1320);
    assert.equal(scheduledNode.pendingNodes, 2);
    assert.equal('audio' in scheduledNode, false);
    const endedNode = JSON.parse(lines[5]) as Record<string, unknown>;
    assert.equal(endedNode.contextElapsedSinceScheduledStartMs, 260);
    assert.equal(endedNode.nodeLifetimeMs, 380);
    assert.equal(endedNode.pendingNodes, 1);
    assert.equal('transcript' in endedNode, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('realtime trace annotates A-D milestones once and derives turn latencies without content', async () => {
  const directory = await mkdtemp(path.join(testTempRoot, 'rensheng-trace-milestones-'));
  try {
    const trace = createRealtimeTraceWriter({
      directory,
      sessionId: '6d9956fb-2d5a-4d26-970b-4a2f21a8c41d',
      provider: 'qwen',
    });
    let now = 100;
    const tracker = createRealtimeTraceStageTracker({ now: () => now });
    trace.record('provider.input_audio_buffer.speech_stopped_received', tracker.mark('speech_stopped', {
      source: 'speech_stopped',
    }));
    trace.record('realtime.slow_recall_finished', {
      provider: 'stepfun',
      name: 'get_interview_context',
      sent: true,
      latencyMs: 12.345,
      totalElapsedMs: 13.456,
      error: 'must remain metadata-only',
    });
    now = 110;
    trace.record('provider.input_audio_buffer.speech_stopped_received', tracker.mark('speech_stopped', {
      source: 'duplicate',
    }));
    now = 240;
    trace.record('provider.user_transcription_completed', tracker.mark('user_final', {
      chars: 8,
      text: '敏感回答不应写入 trace',
    }));
    now = 275;
    trace.record('provider.response_created', tracker.mark('assistant_started', {
      responseId: 'response-1',
    }));
    now = 310;
    trace.record('provider.audio_delta', tracker.mark('first_audio', {
      responseId: 'response-1',
      chunk: 1,
      deltaBytes: 640,
    }));
    now = 320;
    trace.record('provider.audio_delta', tracker.mark('first_audio', {
      responseId: 'response-1',
      chunk: 2,
      deltaBytes: 640,
    }));
    await trace.flush();

    const rows = (await readFile(trace.filePath, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows.length, 7);
    const recall = rows[1];
    assert.equal(recall.provider, 'stepfun');
    assert.equal(recall.name, 'get_interview_context');
    assert.equal(recall.sent, true);
    assert.equal(recall.latencyMs, 12.35);
    assert.equal(recall.totalElapsedMs, 13.46);
    assert.equal(recall.error, 'must remain metadata-only');
    const milestones = rows.filter((row) => typeof row.tracePoint === 'string');
    assert.deepEqual(milestones.map((row) => row.tracePoint), ['A', 'B', 'C', 'D']);
    assert.deepEqual(milestones.map((row) => row.stage), [
      'speech_stopped',
      'user_final',
      'assistant_started',
      'first_audio',
    ]);
    assert.equal(milestones.every((row) => row.turnId === 1), true);
    assert.equal(milestones[1]?.speechStoppedToUserFinalMs, 140);
    assert.equal(milestones[2]?.userFinalToAssistantStartedMs, 35);
    assert.equal(milestones[3]?.speechStoppedToUserFinalMs, 140);
    assert.equal(milestones[3]?.userFinalToAssistantStartedMs, 35);
    assert.equal(milestones[3]?.assistantStartedToFirstAudioMs, 35);
    assert.equal('text' in rows[2]!, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
