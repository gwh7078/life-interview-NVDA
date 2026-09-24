import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NemoClawAgentTaskAdapter,
  type AgentTaskExecutionRequest,
  type AgentTaskExecutionResult,
  type AgentTaskExecutor,
  type ContributorCloseoutTaskRequest,
  type InterviewContextHintTaskRequest,
  type StoryCompletionTaskRequest,
} from '../../src/agent-tasks/index.js';
import { AgentTaskContractError } from '../../src/agent-tasks/errors.js';

class FakeExecutor implements AgentTaskExecutor {
  requests: AgentTaskExecutionRequest[] = [];

  constructor(private readonly result: AgentTaskExecutionResult) {}

  async execute(request: AgentTaskExecutionRequest): Promise<AgentTaskExecutionResult> {
    this.requests.push(request);
    return this.result;
  }
}

test('NemoClawAgentTaskAdapter routes Completion through frozen Skill, model profile and execution policy', async () => {
  const executor = new FakeExecutor({
    output: { status: 'interviewing', gaps: [] },
    runtime: {
      runtime: 'nemoclaw-openclaw',
      skill: 'model-claimed-wrong-skill',
      provider: 'stepfun',
      model: 'test-model',
      latencyMs: 42,
    },
  });
  const adapter = new NemoClawAgentTaskAdapter(executor);

  const request: StoryCompletionTaskRequest = {
    runId: 'run-completion',
    taskType: 'story.completion',
    ownerId: 'owner-1',
    resource: { type: 'story', id: 'story-1', version: 'v-1' },
    schemaVersion: 'v1',
    payload: {
      title: '第一次登台',
      agent_memory: '已经知道人物、地点和主要经过。',
      stage_title: '学生时期',
      current_status: 'interviewing',
      previous_gaps: [],
      blocked_directions: [],
      session_count: 2,
    },
  };

  const result = await adapter.run(request);
  assert.equal(executor.requests.length, 1);
  assert.equal(executor.requests[0]?.skill, 'story-completion');
  assert.equal(executor.requests[0]?.skillVersion, 'v1');
  assert.equal(executor.requests[0]?.modelProfile, 'reasoning-fast');
  assert.equal(executor.requests[0]?.contextVersion, 'v1');
  assert.equal(executor.requests[0]?.executionPolicy.maxAttempts, 3);
  assert.deepEqual(executor.requests[0]?.executionPolicy.scriptCapabilities, []);
  assert.equal(executor.requests[0]?.payload, request.payload);
  assert.deepEqual(executor.requests[0]?.validateOutput({ status: 'interviewing', gaps: [] }), {
    status: 'interviewing',
    gaps: [],
  });
  assert.equal(result.runtime.skill, 'story-completion');
  assert.equal(result.runtime.skillVersion, 'v1');
  assert.equal(result.runtime.provider, 'stepfun');
  assert.equal(result.runtime.model, 'test-model');
  await assert.rejects(
    () => adapter.run(request, {
      scriptContext: { baseUrl: 'http://backend.test', token: 'short-lived' },
    }),
    (error: unknown) => error instanceof AgentTaskContractError
      && error.code === 'AGENT_SCRIPT_CAPABILITY_UNAUTHORIZED',
  );
});

test('NemoClawAgentTaskAdapter routes realtime context hints and preserves their trace context', async () => {
  const executor = new FakeExecutor({
    output: {
      selected_evidence_ids: ['e1'],
      possible_conflicts: [],
      interview_hints: ['可以问问当时是谁先提出这个安排。'],
    },
    runtime: { runtime: 'nemoclaw-openclaw', latencyMs: 20 },
  });
  const adapter = new NemoClawAgentTaskAdapter(executor);
  const request: InterviewContextHintTaskRequest & { traceContext: {
    traceId: string; sessionId: string; storyId: string; parentSpanId: string;
  } } = {
    runId: 'run-context-hint',
    taskType: 'interview.context_hint',
    ownerId: 'owner-1',
    resource: { type: 'interview_turn', id: 'turn-1' },
    schemaVersion: 'v1',
    traceContext: {
      traceId: 'trace-session-1', sessionId: 'session-1', storyId: 'story-1', parentSpanId: 'tool-cycle-1',
    },
    payload: {
      query: '那次是谁先提出的？',
      story: { story_id: 'story-1', subject_id: 'owner-1' },
      evidence: [{ id: 'e1', question: '当时谁和你一起去？', answer: '我和姐姐一起去的。' }],
    },
  };

  const result = await adapter.run(request);
  const routed = executor.requests[0];
  assert.deepEqual((routed as AgentTaskExecutionRequest & { traceContext?: unknown })?.traceContext, request.traceContext);
  assert.equal(routed?.skill, 'interview-observer');
  assert.equal(routed?.executionPolicy.agentId, 'realtime-context');
  assert.equal(routed?.modelProfile, 'realtime-context');
  assert.equal(routed?.executionPolicy.maxAttempts, 1);
  assert.equal(routed?.executionPolicy.timeoutMs, 4_800);
  assert.deepEqual(routed?.executionPolicy.scriptCapabilities, []);
  assert.equal(routed?.executionPolicy.allowFormatRepair, false);
  assert.equal(routed?.executionPolicy.allowValidationRepair, false);
  assert.deepEqual(result.output, {
    selected_evidence_ids: ['e1'],
    possible_conflicts: [],
    interview_hints: ['可以问问当时是谁先提出这个安排。'],
  });
  await assert.rejects(
    () => adapter.run(request, {
      scriptContext: { baseUrl: 'http://backend.test', token: 'short-lived' },
    }),
    (error: unknown) => error instanceof AgentTaskContractError
      && error.code === 'AGENT_SCRIPT_CAPABILITY_UNAUTHORIZED',
  );
});

test('NemoClawAgentTaskAdapter rejects unsupported schemaVersion before execution', async () => {
  const executor = new FakeExecutor({
    output: { status: 'interviewing', gaps: [] },
    runtime: { runtime: 'nemoclaw-openclaw' },
  });
  const adapter = new NemoClawAgentTaskAdapter(executor);
  const request: StoryCompletionTaskRequest = {
    runId: 'run-version',
    taskType: 'story.completion',
    ownerId: 'owner-1',
    resource: { type: 'story', id: 'story-1' },
    schemaVersion: 'v999',
    payload: {
      title: '第一次登台',
      agent_memory: '工作记忆。',
      stage_title: '学生时期',
      current_status: 'interviewing',
      previous_gaps: [],
      blocked_directions: [],
    },
  };
  await assert.rejects(
    () => adapter.run(request),
    (error: unknown) => error instanceof AgentTaskContractError
      && error.code === 'AGENT_TASK_SCHEMA_VERSION_MISMATCH',
  );
  assert.equal(executor.requests.length, 0);
});

test('NemoClawAgentTaskAdapter routes contributor through interview-closeout without Story context', async () => {
  const executor = new FakeExecutor({
    output: { summary: '第三者的独立回忆。' },
    runtime: { runtime: 'nemoclaw-openclaw' },
  });
  const adapter = new NemoClawAgentTaskAdapter(executor);

  const request: ContributorCloseoutTaskRequest = {
    runId: 'run-contributor',
    taskType: 'interview.closeout',
    mode: 'contributor',
    ownerId: 'owner-1',
    resource: { type: 'interview_session', id: 'session-1' },
    schemaVersion: 'v1',
    payload: {
      mode: 'contributor',
      relationship: '女儿',
      previous_contributor_summary: null,
      transcript: [{
        message_id: 'm1',
        role: 'user',
        text: '我记得那天他很早就出门了。',
        timestamp: '2026-09-20T10:00:00Z',
      }],
    },
  };

  const result = await adapter.run(request);
  assert.equal(executor.requests[0]?.skill, 'interview-closeout');
  assert.equal(executor.requests[0]?.modelProfile, 'reasoning');
  assert.deepEqual(executor.requests[0]?.executionPolicy.scriptCapabilities, []);
  assert.equal('current_story' in (executor.requests[0]?.payload as Record<string, unknown>), false);
  assert.deepEqual(result.output, { summary: '第三者的独立回忆。' });
});

test('NemoClawAgentTaskAdapter rejects invalid executor output before returning to the backend', async () => {
  const executor = new FakeExecutor({
    output: {
      status: 'interviewing',
      gaps: ['问题一？', '问题二？', '问题三？', '问题四？'],
    },
    runtime: { runtime: 'nemoclaw-openclaw' },
  });
  const adapter = new NemoClawAgentTaskAdapter(executor);

  const request: StoryCompletionTaskRequest = {
    runId: 'run-invalid',
    taskType: 'story.completion',
    ownerId: 'owner-1',
    resource: { type: 'story', id: 'story-1' },
    schemaVersion: 'v1',
    payload: {
      title: '第一次登台',
      agent_memory: '工作记忆。',
      stage_title: '学生时期',
      current_status: 'interviewing',
      previous_gaps: [],
      blocked_directions: [],
    },
  };

  await assert.rejects(
    () => adapter.run(request),
    (error: unknown) => error instanceof AgentTaskContractError
      && error.code === 'AGENT_TASK_OUTPUT_INVALID',
  );
  assert.equal(executor.requests.length, 1);
});
