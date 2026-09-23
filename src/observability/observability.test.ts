import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { adaptAgentRun } from './adapters/agent-adapter.js';
import { adaptNatEvaluation } from './adapters/nat-adapter.js';
import { adaptRealtimeTrace } from './adapters/realtime-adapter.js';
import { createObservationAnalyticsConsumer } from './analytics-consumer.js';
import { ObservationBus, emitObservationEvent } from './observation-bus.js';
import { createObservationContext, createObservationEvent, type ObservationEvent } from './observation-event.js';

function event(sessionId: string, eventId: string, status: ObservationEvent['status'] = 'running', durationMs?: number): ObservationEvent {
  return {
    eventId,
    timestamp: '2026-09-23T00:00:00.000Z',
    traceId: sessionId,
    sessionId,
    category: 'realtime',
    eventType: 'realtime.listening',
    status,
    component: 'test',
    title: 'LISTENING',
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

test('observation context groups events by trace and parent span', () => {
  const context = createObservationContext({ sessionId: 'session-a', rootSpanId: 'root-a' });
  const observation = createObservationEvent(context, {
    spanId: 'tool-cycle-a',
    parentSpanId: context.rootSpanId,
    category: 'tool',
    eventType: 'tool.started',
    status: 'running',
    component: 'realtime-tool',
    title: 'TOOL CALL',
  });
  assert.equal(observation.traceId, 'session-a');
  assert.equal(observation.sessionId, 'session-a');
  assert.equal(observation.parentSpanId, 'root-a');
});

test('disabled bus is a no-op and event consumers cannot break emission', async () => {
  const bus = new ObservationBus({ enabled: false });
  let received = 0;
  bus.subscribe(() => { received += 1; });
  emitObservationEvent(event('session-a', 'disabled'), bus);
  await Promise.resolve();
  assert.equal(received, 0);
  assert.deepEqual(bus.recent('session-a'), []);

  const activeBus = new ObservationBus();
  activeBus.subscribe(() => { throw new Error('consumer failure'); });
  emitObservationEvent(event('session-a', 'consumer-failure'), activeBus);
  await Promise.resolve();
  assert.equal(activeBus.recent('session-a').length, 1);
});

test('ring buffers are capped and isolated by session', () => {
  const bus = new ObservationBus({ capacity: 2, maxSessions: 2 });
  bus.emit(event('session-a', 'a1'));
  bus.emit(event('session-b', 'b1'));
  bus.emit(event('session-a', 'a2'));
  bus.emit(event('session-a', 'a3'));
  assert.deepEqual(bus.recent('session-a').map((item) => item.eventId), ['a2', 'a3']);
  assert.deepEqual(bus.recent('session-b').map((item) => item.eventId), ['b1']);
  bus.emit(event('session-c', 'c1'));
  assert.deepEqual(bus.recent('session-b'), []);
});

test('realtime adapter maps only existing safe lifecycle fields', () => {
  const observation = adaptRealtimeTrace({
    sessionId: 'session-a',
    provider: 'stepfun',
    environment: 'Development',
    event: 'realtime.slow_recall_finished',
    fields: { status: 'completed', factCount: 3, latencyMs: 42, query: 'private query', claim: 'private evidence' },
  });
  assert.equal(observation?.eventType, 'retriever.completed');
  assert.equal(observation?.sessionId, 'session-a');
  assert.equal(observation?.durationMs, 42);
  assert.equal(observation?.summary, '3 results · 42 ms');
  assert.equal(JSON.stringify(observation).includes('private'), false);
  assert.equal(adaptRealtimeTrace({
    sessionId: 'session-a', provider: 'stepfun', event: 'realtime.slow_recall_finished', fields: { status: 'indexing' },
  })?.eventType, 'retriever.running');
  assert.equal(adaptRealtimeTrace({ sessionId: 'session-a', provider: 'stepfun', event: 'client.microphone_uplink' }), undefined);
  assert.deepEqual([
    adaptRealtimeTrace({ sessionId: 'session-a', provider: 'stepfun', event: 'provider.speech_started' })?.eventType,
    adaptRealtimeTrace({ sessionId: 'session-a', provider: 'stepfun', event: 'realtime.tool_cycle_started' })?.eventType,
    adaptRealtimeTrace({ sessionId: 'session-a', provider: 'stepfun', event: 'realtime.tool_cycle_message_write', fields: { messageKind: 'resume', sent: true } })?.eventType,
  ], ['realtime.user_speaking', 'realtime.hold', 'realtime.resume']);
  assert.deepEqual([
    adaptRealtimeTrace({ sessionId: 'session-a', provider: 'stepfun', event: 'provider.speech_stopped_forwarded' })?.eventType,
    adaptRealtimeTrace({ sessionId: 'session-a', provider: 'stepfun', event: 'provider.audio_started' })?.eventType,
  ], ['realtime.listening', 'realtime.responding']);
  assert.deepEqual(['indexed', 'failed', 'indexing'].map((status) => {
    const item = adaptRealtimeTrace({ sessionId: 'session-a', provider: 'stepfun', event: 'retriever.index_finished', fields: { status } });
    return [item?.eventType, item?.status];
  }), [
    ['retriever.completed', 'success'], ['retriever.failed', 'error'], ['retriever.running', 'running'],
  ]);
});

test('Agent and Skill observations preserve status, duration and session correlation', () => {
  const source = {
    runId: 'run-a',
    agentType: 'Interview Agent',
    taskType: 'interview.closeout',
    resourceType: 'interview_session',
    resourceId: 'session-a',
    runtime: 'NemoClaw / OpenClaw',
    skill: 'story-interview',
    toolCallCount: 2,
  };
  const started = adaptAgentRun(source, { eventType: 'agent.started', status: 'running' });
  const completed = adaptAgentRun(source, { eventType: 'agent.completed', status: 'success', durationMs: 84 });
  assert.deepEqual(started.map((item) => item.category), ['agent', 'skill']);
  assert.ok(started.every((item) => item.sessionId === 'session-a'));
  assert.ok(started.every((item) => item.traceId === 'session-a'));
  assert.equal(started[0]?.parentSpanId, 'session:session-a');
  assert.equal(started[1]?.parentSpanId, 'agent:run-a');
  assert.equal(completed[0]?.status, 'success');
  assert.equal(completed[0]?.durationMs, 84);
  assert.equal(completed[0]?.metrics?.toolCallCount, 2);
  assert.equal(completed[0]?.metadata?.runtime, 'NemoClaw / OpenClaw');
  assert.equal(completed[1]?.eventType, 'skill.completed');
  assert.ok(adaptAgentRun({ ...source, resourceType: 'story', resourceId: 'story-a' }, {
    eventType: 'agent.failed', status: 'error', durationMs: 20,
  }).every((item) => item.sessionId === undefined && item.storyId === 'story-a'));
});

test('NAT adapter emits evaluation and validator events without synthetic session links', () => {
  const result = adaptNatEvaluation({
    caseId: 'smoke-case', status: 'succeeded', validation: { contract_valid: true, backend_validation: 'passed', semantic_valid: true }, latencyMs: 91,
  });
  assert.deepEqual(result.map((item) => item.eventType), ['agent.completed', 'validator.passed']);
  assert.ok(result.every((item) => item.sessionId === undefined));
  const linked = adaptNatEvaluation({
    trace: {
      runId: 'nat-run', agentType: 'Interview Agent', taskType: 'interview.closeout', resourceType: 'interview_session',
      resourceId: 'session-a', runtime: 'NemoClaw / OpenClaw', skill: 'story-interview', status: 'succeeded',
      startedAt: '2026-09-23T00:00:00.000Z', completedAt: '2026-09-23T00:00:00.100Z', latencyMs: 100,
    },
    caseId: 'linked-case', status: 'succeeded', validation: { contract_valid: true, backend_validation: 'passed', semantic_valid: true },
  });
  assert.deepEqual(linked.map((item) => item.eventType), ['agent.started', 'skill.started', 'agent.completed', 'skill.completed', 'validator.passed']);
  assert.ok(linked.every((item) => item.sessionId === 'session-a'));
  assert.ok(linked.every((item) => item.traceId === 'session-a'));
  assert.equal(linked.at(-1)?.parentSpanId, 'agent:nat-run');
  const contradictory = adaptNatEvaluation({
    caseId: 'failed-validator', status: 'succeeded',
    validation: { contract_valid: true, backend_validation: 'failed', semantic_valid: true },
  });
  assert.equal(contradictory.at(-1)?.eventType, 'validator.failed');
  assert.equal(adaptNatEvaluation({
    caseId: 'incomplete-validator', status: 'succeeded', validation: { backend_validation: 'passed' },
  }).some((item) => item.category === 'validator'), false);
  assert.equal(adaptNatEvaluation({
    caseId: 'backend-not-applicable', status: 'succeeded',
    validation: { contract_valid: true, backend_validation: 'not_applicable', semantic_valid: true },
  }).some((item) => item.eventType === 'validator.passed'), false);
  const failedEvaluation = adaptNatEvaluation({
    caseId: 'failed-evaluation', status: 'failed',
    validation: { contract_valid: true, backend_validation: 'passed', semantic_valid: true },
  });
  assert.equal(failedEvaluation.at(-1)?.eventType, 'validator.failed');
});

test('a broken observer module fails inside its own isolated boundary', () => {
  const source = readFileSync(new URL('../../public/tech-observer.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => runInNewContext(source, {
    document: { querySelector() { throw new Error('simulated observer DOM failure'); } },
  }));
});

test('analytics consumer calculates rates and nearest-rank latency percentiles', async () => {
  const bus = new ObservationBus();
  const analytics = createObservationAnalyticsConsumer(bus);
  bus.emit(event('session-a', 'succeeded', 'success', 10));
  bus.emit(event('session-a', 'failed', 'error', 40));
  await Promise.resolve();
  assert.deepEqual(analytics.snapshot(), {
    count: 2, successRate: 0.5, errorRate: 0.5, p50Ms: 10, p95Ms: 40,
    byType: { 'realtime.listening': 2 },
  });
  analytics.dispose();
});

test('high event volume keeps session storage bounded with an asynchronous consumer', async () => {
  const bus = new ObservationBus({ capacity: 100 });
  let delivered = 0;
  bus.subscribe(() => { delivered += 1; });
  const start = performance.now();
  for (let index = 0; index < 10_000; index += 1) bus.emit(event('session-a', `event-${index}`));
  const elapsed = performance.now() - start;
  await Promise.resolve();
  assert.equal(bus.recent('session-a').length, 100);
  assert.equal(delivered, 100);
  assert.ok(elapsed < 3000, `10,000 event inserts took ${elapsed.toFixed(1)} ms`);
});
