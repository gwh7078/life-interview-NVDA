import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentStoryCompletionProcessor,
  AgentStoryGenerationContextModel,
  type AgentTaskPort,
  type AgentTaskRequestUnion,
  type AgentTaskResultUnion,
} from '../../src/agent-tasks/index.js';
import type { StoryCompletionContext } from '../../src/story/completion/index.js';
import type { StoryGenerationContext } from '../../src/story/generation/index.js';

class FakeAgentTasks implements AgentTaskPort {
  requests: AgentTaskRequestUnion[] = [];

  constructor(private readonly outputs: Partial<Record<string, unknown>>) {}

  async run(request: AgentTaskRequestUnion): Promise<AgentTaskResultUnion> {
    this.requests.push(request);
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
  const processor = new AgentStoryCompletionProcessor(tasks);

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
  const model = new AgentStoryGenerationContextModel(tasks);

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
});
