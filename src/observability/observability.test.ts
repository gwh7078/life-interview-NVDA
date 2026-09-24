import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { adaptAgentRun } from './adapters/agent-adapter.js';
import { adaptNatEvaluation } from './adapters/nat-adapter.js';
import { adaptRealtimeTrace, normalizeAgentSkipReasonForObservation } from './adapters/realtime-adapter.js';
import { ObservationBus, emitObservationEvent } from './observation-bus.js';
import { createObservationContext, type ObservationEvent } from './observation-event.js';

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

test('realtime adapter maps safe lifecycle, slow-path outcomes, and timing fields', () => {
  assert.equal(normalizeAgentSkipReasonForObservation('agent_unavailable', true), 'agent_disabled');
  assert.equal(normalizeAgentSkipReasonForObservation('agent_unavailable', false), 'agent_unavailable');
  assert.equal(normalizeAgentSkipReasonForObservation('no_evidence', true), 'no_evidence');

  const observation = adaptRealtimeTrace({
    sessionId: 'session-a',
    provider: 'stepfun',
    environment: 'Development',
    event: 'realtime.slow_recall_finished',
    fields: { status: 'completed', factCount: 3, latencyMs: 42, query: 'private query', claim: 'private evidence' },
  });
  assert.equal(observation?.eventType, 'realtime.slow_path.result.completed');
  assert.equal(observation?.sessionId, 'session-a');
  assert.equal(observation?.status, 'success');
  assert.equal(observation?.durationMs, 42);
  assert.equal(JSON.stringify(observation).includes('private'), false);
  assert.equal(adaptRealtimeTrace({
    sessionId: 'session-a', provider: 'stepfun', event: 'realtime.slow_recall_finished', fields: { status: 'indexing' },
  })?.eventType, 'realtime.slow_path.result.unknown');
  assert.equal(adaptRealtimeTrace({
    sessionId: 'session-a', provider: 'stepfun', event: 'realtime.tool_cycle_recall_finished', fields: { status: 'completed' },
  }), undefined);
  const retrieverLifecycle = [
    ['realtime.tool_cycle_recall_started', { toolRunId: 'tool-cycle-a' }],
    ['realtime.recall_started', { toolRunId: 'tool-cycle-a' }],
    ['realtime.slow_path.retrieval.started', { toolRunId: 'tool-cycle-a', status: 'started' }],
    ['realtime.slow_path.retrieval.finished', { toolRunId: 'tool-cycle-a', status: 'finished' }],
    ['realtime.tool_cycle_recall_finished', { toolRunId: 'tool-cycle-a', status: 'completed' }],
  ].map(([eventName, fields]) => adaptRealtimeTrace({
    sessionId: 'session-a', provider: 'stepfun', event: eventName as string, fields: fields as Record<string, unknown>,
  })).filter((item) => item?.category === 'retriever');
  assert.deepEqual(retrieverLifecycle.map((item) => item?.eventType), ['retriever.started', 'retriever.completed']);
  assert.equal(adaptRealtimeTrace({ sessionId: 'session-a', provider: 'stepfun', event: 'client.microphone_uplink' }), undefined);
  const vadRequest = adaptRealtimeTrace({ sessionId: 'session-a', provider: 'stepfun', event: 'provider.turn_detection_requested', fields: { turnDetectionMode: 'manual' } });
  const vadAcknowledgement = adaptRealtimeTrace({ sessionId: 'session-a', provider: 'stepfun', event: 'provider.turn_detection_acknowledged', fields: { turnDetectionMode: 'manual', instructions: 'private prompt' } });
  const vadCommit = adaptRealtimeTrace({ sessionId: 'session-a', provider: 'stepfun', event: 'client.local_vad_commit_triggered', fields: { silenceObservedMs: 2_000, silenceThresholdMs: 2_000 } });
  assert.equal(vadRequest?.eventType, 'realtime.turn_detection_requested');
  assert.equal(vadAcknowledgement?.eventType, 'realtime.turn_detection_acknowledged');
  assert.deepEqual([vadRequest?.status, vadAcknowledgement?.status], ['start', 'success']);
  assert.equal(vadCommit?.eventType, 'realtime.turn_committed');
  assert.deepEqual([vadCommit?.metrics?.silenceObservedMs, vadCommit?.metrics?.silenceThresholdMs], [2_000, 2_000]);
  assert.equal(JSON.stringify(vadAcknowledgement).includes('private prompt'), false);
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
  const context = createObservationContext({ sessionId: 'session-a', storyId: 'story-a', rootSpanId: 'session:session-a' });
  const retrieved = adaptRealtimeTrace({
    context, sessionId: 'session-a', storyId: 'story-a', provider: 'stepfun',
    event: 'realtime.slow_path.retrieval.finished',
    fields: {
      status: 'completed', toolRunId: 'tool-cycle-1', latencyMs: 42, candidateCount: 8,
      retrievalEvidenceCount: 3, query: 'SENSITIVE_QUERY_SENTINEL', transcript: 'SENSITIVE_TRANSCRIPT_SENTINEL',
      storySummary: 'SENSITIVE_SUMMARY_SENTINEL', evidenceText: 'SENSITIVE_EVIDENCE_SENTINEL', sourceMessageIds: ['message-1'], apiKey: 'sk-secret',
    },
  });
  assert.equal(retrieved?.category, 'retriever');
  assert.equal(retrieved?.eventType, 'retriever.completed');
  assert.equal(retrieved?.status, 'success');
  assert.equal(retrieved?.durationMs, 42);
  assert.equal(retrieved?.metrics?.candidateCount, 8);
  assert.equal(retrieved?.metrics?.evidenceCount, 3);
  assert.equal(retrieved?.spanId, 'tool-cycle-1');
  assert.equal(retrieved?.parentSpanId, 'session:session-a');
  assert.equal(JSON.stringify(retrieved).includes('SENSITIVE_'), false);
  assert.equal(JSON.stringify(retrieved).includes('sk-secret'), false);

  const skipped = adaptRealtimeTrace({
    context, sessionId: 'session-a', provider: 'stepfun', event: 'realtime.slow_path.slow_agent.skipped',
    fields: { status: 'skipped', slowAgentSkipReason: 'no_evidence' },
  });
  assert.deepEqual([skipped?.eventType, skipped?.status, skipped?.metrics?.skipReason], ['agent.skipped', 'skip', 'no_evidence']);

  const timedOut = adaptRealtimeTrace({
    context, sessionId: 'session-a', provider: 'stepfun', event: 'realtime.slow_path.slow_agent.failed',
    fields: {
      status: 'failed', latencyMs: 4_800, errorCode: 'AGENT_RUNTIME_TIMEOUT', fallbackUsed: true,
      fallbackType: 'direct_retrieval', slowAgentModel: 'bailian/qwen3.6-35b-a3b', skill: 'interview-observer',
      promptTokens: 40, completionTokens: 12, totalTokens: 52,
    },
  });
  assert.equal(timedOut, undefined);
  for (const status of ['started']) {
    assert.equal(adaptRealtimeTrace({
      context, sessionId: 'session-a', provider: 'stepfun', event: `realtime.slow_path.slow_agent.${status}`,
      fields: { status, toolRunId: 'tool-cycle-a' },
    }), undefined);
  }
  const contextAgentMetrics = adaptRealtimeTrace({
    context, sessionId: 'session-a', provider: 'stepfun', event: 'realtime.slow_path.slow_agent.finished',
    fields: {
      status: 'completed', toolRunId: 'tool-cycle-a', runId: 'run-context', latencyMs: 84,
      promptTokens: 40, completionTokens: 12, totalTokens: 52, selectedEvidenceCount: 2,
    },
  });
  assert.equal(contextAgentMetrics?.eventType, 'agent.metrics');
  assert.equal(contextAgentMetrics?.spanId, 'agent:run-context');
  assert.equal(contextAgentMetrics?.parentSpanId, 'tool-cycle-a');
  assert.deepEqual([
    contextAgentMetrics?.metrics?.promptTokens, contextAgentMetrics?.metrics?.completionTokens,
    contextAgentMetrics?.metrics?.selectedEvidenceCount,
  ], [40, 12, 2]);

  const ready = adaptRealtimeTrace({
    context, sessionId: 'session-a', provider: 'stepfun', event: 'realtime.slow_path.context_hint.ready',
    fields: { status: 'ready', selectedEvidenceCount: 3, fallbackUsed: true, fallbackType: 'direct_retrieval' },
  });
  const result = adaptRealtimeTrace({
    context, sessionId: 'session-a', provider: 'stepfun', event: 'realtime.slow_recall_finished',
    fields: { status: 'completed', slowRecallLatencyMs: 5_100, factCount: 3 },
  });
  assert.deepEqual([ready?.eventType, ready?.status, ready?.metrics?.selectedEvidenceCount, ready?.metrics?.fallbackUsed], [
    'evidence.ready', 'success', 3, true,
  ]);
  assert.deepEqual([result?.eventType, result?.status, result?.durationMs], [
    'realtime.slow_path.result.completed', 'success', 5_100,
  ]);

  const resume = adaptRealtimeTrace({
    sessionId: 'session-a', provider: 'stepfun', event: 'realtime.tool_cycle_response_started',
    fields: { responseBLatencyMs: 115, responseId: 'response-secret' },
  });
  const firstAudio = adaptRealtimeTrace({
    sessionId: 'session-a', provider: 'stepfun', event: 'realtime.tool_cycle_response_first_audio',
    fields: { toolToFirstAudioMs: 730, responseBFirstAudioMs: 128, responseId: 'response-secret' },
  });
  assert.deepEqual([resume?.eventType, resume?.durationMs, resume?.metrics?.resumeLatencyMs], [
    'realtime.responding', 115, 115,
  ]);
  assert.deepEqual([firstAudio?.eventType, firstAudio?.durationMs, firstAudio?.metrics?.firstAudioLatencyMs], [
    'realtime.first_audio', 730, 730,
  ]);
  assert.equal(firstAudio?.metrics?.responseBFirstAudioMs, 128);
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

test('Realtime Context Agent and Skill spans stay under the originating Tool Cycle', () => {
  const source = {
    runId: 'run-context',
    agentType: 'interview-observer',
    taskType: 'interview.context_hint',
    resourceType: 'story',
    resourceId: 'story-a',
    runtime: 'nemoclaw-openclaw',
    skill: 'interview-observer',
    model: 'qwen-test',
    traceContext: {
      traceId: 'trace-a', sessionId: 'session-a', storyId: 'story-a', parentSpanId: 'tool-cycle-a',
    },
  } as Parameters<typeof adaptAgentRun>[0];
  const [agent, skill] = adaptAgentRun(source, { eventType: 'agent.started', status: 'running' });
  assert.equal(agent?.traceId, 'trace-a');
  assert.equal(agent?.sessionId, 'session-a');
  assert.equal(agent?.storyId, 'story-a');
  assert.equal(agent?.parentSpanId, 'tool-cycle-a');
  assert.equal(agent?.component, 'realtime-context-agent');
  assert.equal(agent?.metrics?.model, 'qwen-test');
  assert.equal(skill?.traceId, 'trace-a');
  assert.equal(skill?.parentSpanId, 'agent:run-context');
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

test('Tech Observer stays isolated and renders only safe fields', () => {
  const source = readFileSync(new URL('../../public/tech-observer.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => runInNewContext(source, {
    document: { querySelector() { throw new Error('simulated observer DOM failure'); } },
  }));
  const makeElement = (): any => ({
    dataset: {}, children: [], hidden: true, textContent: '',
    classList: { toggle() {} },
    addEventListener() {}, setAttribute() {},
    append(...children: any[]) { this.children.push(...children); },
    replaceChildren(...children: any[]) {
      this.children = children.flatMap((child) => child.isFragment === true ? child.children as Array<Record<string, unknown>> : [child]);
    },
  });
  const flowItems = ['realtime', 'agent', 'skill', 'tool', 'retriever', 'evidence', 'validator', 'persistence']
    .map((category) => ({ dataset: { category } }));
  const elements = new Map<string, ReturnType<typeof makeElement>>();
  for (const id of [
    'tech-observer', 'tech-observer-toggle', 'tech-observer-events', 'tech-observer-live',
    'tech-observer-session', 'tech-observer-trace', 'tech-observer-count', 'tech-observer-empty',
    'tech-observer-environment', 'tech-observer-provider', 'tech-observer-agent', 'tech-observer-runtime',
    'tech-observer-skill', 'tech-observer-tool', 'tech-observer-model',
  ]) elements.set(id, makeElement());
  const panel = elements.get('tech-observer')!;
  panel.querySelectorAll = (selector: string) => selector === '.tech-observer-flow li' ? flowItems : [];
  const shell = { classList: { toggle() {} } };
  const listeners = new Map<string, (event: { detail?: unknown }) => void>();
  const windowObject = {
    location: { search: '?demo=tech' },
    addEventListener(type: string, listener: (event: { detail?: unknown }) => void) { listeners.set(type, listener); },
  };
  const streams: Array<{ listeners: Map<string, (event: { data: string }) => void> }> = [];
  class FakeEventSource {
    listeners = new Map<string, (event: { data: string }) => void>();
    constructor(_url: string) { streams.push(this); }
    addEventListener(type: string, listener: (event: { data: string }) => void) { this.listeners.set(type, listener); }
    close() {}
  }
  const documentObject = {
    querySelector(selector: string) { return selector === '.app-shell' ? shell : null; },
    getElementById(id: string) { return elements.get(id) ?? null; },
    createElement() { return makeElement(); },
    createDocumentFragment() { return { ...makeElement(), isFragment: true }; },
  };
  runInNewContext(source, {
    document: documentObject, window: windowObject, EventSource: FakeEventSource,
    URLSearchParams, Date, requestAnimationFrame: (callback: () => void) => callback(),
  });
  listeners.get('interview:session')?.({ detail: { sessionId: 'session-secret' } });
  streams[0]?.listeners.get('observation')?.({ data: JSON.stringify({
    eventId: 'event-secret', timestamp: '2026-09-24T08:00:00.000Z', traceId: 'trace-secret',
    spanId: 'call-secret', parentSpanId: 'story-secret', sessionId: 'session-secret', storyId: 'story-secret',
    category: 'agent', eventType: 'agent.timeout', status: 'warning', component: 'realtime-context-agent',
    title: 'SENSITIVE_TITLE_SENTINEL', summary: 'SENSITIVE_EVIDENCE_SENTINEL',
    metrics: {
      errorCode: 'AGENT_RUNTIME_TIMEOUT', fallbackUsed: true, fallbackType: 'direct_retrieval',
      promptTokens: 40, model: 'sk-secret', query: 'SENSITIVE_QUERY_SENTINEL',
    },
    metadata: { agent: 'Interview Agent', provider: 'session-secret', runtime: 'Bearer secret-value' },
  }) });
  streams[0]?.listeners.get('observation')?.({ data: JSON.stringify({
    eventId: 'skip-event', timestamp: '2026-09-24T08:00:01.000Z', traceId: 'trace-secret',
    spanId: 'call-secret', parentSpanId: 'story-secret', sessionId: 'session-secret', storyId: 'story-secret',
    category: 'agent', eventType: 'agent.skipped', status: 'skip', component: 'realtime-context-agent',
    title: 'UNTRUSTED TITLE', metrics: { skipReason: 'agent_disabled', fallbackUsed: true, fallbackType: 'direct_retrieval' },
  }) });

  const collectText = (node: { textContent?: string; children?: Array<Record<string, unknown>> }): string =>
    `${node.textContent ?? ''} ${(node.children ?? []).map((child) => collectText(child as typeof node)).join(' ')}`;
  const rendered = collectText(elements.get('tech-observer-events')!);
  assert.match(rendered, /CONTEXT HINT AGENT TIMEOUT/u);
  assert.match(rendered, /AGENT_RUNTIME_TIMEOUT/u);
  assert.match(rendered, /直接使用检索证据/u);
  assert.match(rendered, /Agent 未启用/u);
  for (const secret of ['session-secret', 'story-secret', 'trace-secret', 'call-secret', 'SENSITIVE_', 'sk-secret', 'Bearer']) {
    assert.equal(rendered.includes(secret), false, `observer leaked ${secret}`);
  }
  assert.equal(elements.get('tech-observer-session')?.textContent, '当前采访');
  assert.equal(elements.get('tech-observer-trace')?.textContent, '已关联');
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
