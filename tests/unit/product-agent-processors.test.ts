import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentToolTokenService } from '../../agent/tools/token.js';
import {
  AgentOnboardingCloseoutProcessor,
  AgentStoryCompletionProcessor,
  AgentStoryGenerationContextModel,
  type AgentTaskPort,
  type AgentTaskRunOptions,
  type AgentTaskRequestUnion,
  type AgentTaskResultUnion,
} from '../../src/agent-tasks/index.js';
import type { OnboardingCloseoutContext } from '../../src/onboarding/types.js';
import type { ProcessOnboardingCloseoutInput } from '../../src/onboarding/processor.js';
import type { StoryCompletionContext } from '../../src/story/completion/index.js';
import type { StoryGenerationContext } from '../../src/story/generation/index.js';

class FakeAgentTasks implements AgentTaskPort {
  requests: AgentTaskRequestUnion[] = [];
  options: AgentTaskRunOptions[] = [];

  constructor(private readonly outputs: Partial<Record<string, unknown>>) {}

  async run(request: AgentTaskRequestUnion, options: AgentTaskRunOptions = {}): Promise<AgentTaskResultUnion> {
    this.requests.push(request);
    this.options.push(options);
    const key = request.mode ? `${request.taskType}:${request.mode}` : request.taskType;
    const output = this.outputs[key];
    if (!output) throw new Error(`missing fake output for ${key}`);
    return {
      runId: request.runId,
      taskType: request.taskType,
      ...(request.mode ? { mode: request.mode } : {}),
      schemaVersion: request.schemaVersion,
      output,
      runtime: {
        runtime: 'nemoclaw-openclaw',
        skill: request.taskType === 'story.completion' ? 'story-completion' : 'story-generation',
        provider: 'fake-provider',
        model: 'fake-model',
        latencyMs: 3,
        attemptCount: 1,
        repairCount: 0,
        execCallCount: 0,
        scriptCallCount: 0,
        formatRepairUsed: false,
      },
    } as AgentTaskResultUnion;
  }
}

test('AgentStoryCompletionProcessor sends structured Completion context through AgentTaskPort', async () => {
  const context: StoryCompletionContext = {
    title: '第一次离开家乡',
    agentMemory: '用户毕业后离开家乡，开始第一份工作。',
    stageTitle: '初入职场',
    currentStatus: 'interviewing',
    previousGaps: ['为什么离开家乡？'],
    blockedDirections: [],
    sessionCount: 2,
  };
  const tasks = new FakeAgentTasks({
    'story.completion': {
      status: 'interviewing',
      gaps: ['当时你为什么决定离开家乡？'],
    },
  });
  const tokenService = new AgentToolTokenService('product-processor-test-secret-012345678901234567890');
  const processor = new AgentStoryCompletionProcessor(tasks, {
    baseUrl: 'http://backend.test',
    tokenService,
  });

  const output = await processor.process(context, {
    userId: 'owner-1',
    storyId: 'story-1',
  });

  assert.deepEqual(output, {
    status: 'interviewing',
    gaps: ['当时你为什么决定离开家乡？'],
  });
  assert.equal(tasks.requests.length, 1);
  const request = tasks.requests[0]!;
  assert.equal(request.taskType, 'story.completion');
  assert.equal(request.ownerId, 'owner-1');
  assert.deepEqual(request.resource, { type: 'story', id: 'story-1' });
  assert.deepEqual(request.payload, {
    title: context.title,
    agent_memory: context.agentMemory,
    stage_title: context.stageTitle,
    current_status: context.currentStatus,
    previous_gaps: context.previousGaps,
    blocked_directions: context.blockedDirections,
    session_count: context.sessionCount,
  });
  const scriptContext = tasks.options[0]?.scriptContext;
  assert.ok(scriptContext?.token);
  const token = tokenService.verify(scriptContext!.token, {
    tool: 'evidence_search', resourceType: 'agent_evidence_search',
  });
  assert.equal(token.userId, 'owner-1');
  assert.equal(token.evidenceSearch?.storyId, 'story-1');
  assert.deepEqual(token.evidenceSearch?.allowedSourceTypes, [
    'owner_transcript', 'story_memory', 'story_summary', 'related_story',
  ]);
});

test('AgentStoryGenerationContextModel sends structured Generation context and resource version', async () => {
  const context: StoryGenerationContext = {
    mode: 'initial',
    style: 'documentary',
    userInstruction: '按时间顺序整理。',
    profile: { name: '林岚', profileSummary: '长期在杭州生活。' },
    lifeStage: { title: '青年时期', startDate: '1985', endDate: '1995' },
    transcript: [
      {
        sessionId: 'session-1',
        messageId: 'message-1',
        role: 'user',
        text: '那次远行大约在1988年。',
        timestamp: '2026-09-01T10:00:00.000Z',
      },
    ],
    transcriptSessionIds: ['session-1'],
    story: { title: '第一次独立远行', summary: '这次远行的故事骨架。' },
    selectedDocument: null,
  };
  const tasks = new FakeAgentTasks({
    'story.generation': { content: '根据原始访谈整理的正文。' },
  });
  const tokenService = new AgentToolTokenService('product-generation-test-secret-012345678901234567890');
  const model = new AgentStoryGenerationContextModel(tasks, {
    baseUrl: 'http://backend.test',
    tokenService,
  });

  const output = await model.generateContext({
    ownerId: 'owner-1',
    storyId: 'story-1',
    resourceVersion: '2026-09-03T00:00:00.000Z',
    context,
  });

  assert.deepEqual(output, {
    output: { content: '根据原始访谈整理的正文。' },
    provider: 'fake-provider',
    model: 'fake-model',
  });
  assert.equal(tasks.requests.length, 1);
  const request = tasks.requests[0]!;
  assert.equal(request.taskType, 'story.generation');
  assert.deepEqual(request.resource, {
    type: 'story',
    id: 'story-1',
    version: '2026-09-03T00:00:00.000Z',
  });
  assert.equal(JSON.stringify(request.payload).includes('session-1'), false);
  assert.equal(JSON.stringify(request.payload).includes('message-1'), false);
  assert.equal(JSON.stringify(request.payload).includes('那次远行大约在1988年。'), true);
  const scriptContext = tasks.options[0]?.scriptContext;
  assert.ok(scriptContext?.token);
  const token = tokenService.verify(scriptContext!.token, {
    tool: 'evidence_search', resourceType: 'agent_evidence_search',
  });
  assert.equal(token.evidenceSearch?.storyId, 'story-1');
  assert.deepEqual(token.evidenceSearch?.allowedSourceTypes, [
    'owner_transcript', 'contributor_transcript', 'profile', 'life_stage',
    'story_memory', 'story_summary', 'related_story', 'era',
  ]);
});

test('AgentOnboardingCloseoutProcessor receives only its owner-scoped evidence sources', async () => {
  const context: OnboardingCloseoutContext = {
    sessionId: 'onboarding-session-1',
    userId: 'owner-1',
    profile: {
      userId: 'owner-1', name: '林岚', birthDate: null, gender: null, birthPlace: null,
      currentLocation: null, currentStatus: null, profileSummary: null,
    } as OnboardingCloseoutContext['profile'],
    transcripts: [{
      sessionId: 'onboarding-session-1',
      startedAt: '2026-09-01T10:00:00.000Z',
      messages: [{
        message_id: 'message-1', role: 'user', text: '我叫林岚。',
        timestamp: '2026-09-01T10:00:00.000Z', provider: 'test',
      }],
      status: 'completed',
      closeoutStatus: 'pending',
      provider: 'test',
    }],
  };
  const output = {
    profile: {
      name: { value: '林岚', source_refs: ['source_1'] },
      birth_year: { value: null, source_refs: [] },
      gender: { value: null, source_refs: [] },
      birth_place: { value: null, source_refs: [] },
      current_location: { value: null, source_refs: [] },
      current_status: { value: null, source_refs: [] },
      profile_summary: { value: null, source_refs: [] },
    },
    life_stages: [],
  };
  const tasks = new FakeAgentTasks({ 'onboarding.closeout': output });
  const tokenService = new AgentToolTokenService('product-onboarding-test-secret-012345678901234567890');
  const processor = new AgentOnboardingCloseoutProcessor(tasks, {
    baseUrl: 'http://backend.test', tokenService,
  });
  const input: ProcessOnboardingCloseoutInput = {
    context,
    config: { baseUrl: 'http://unused.test', apiKey: 'unused' },
    signal: new AbortController().signal,
    assertCurrentAttempt() {},
  };

  await processor.process(input);
  const scriptContext = tasks.options[0]?.scriptContext;
  assert.ok(scriptContext?.token);
  const token = tokenService.verify(scriptContext!.token, {
    tool: 'evidence_search', resourceType: 'agent_evidence_search',
  });
  assert.equal(token.userId, 'owner-1');
  assert.deepEqual(token.evidenceSearch?.allowedSourceTypes, ['profile', 'life_stage', 'related_story']);
});
