import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentToolTokenService } from '../../agent/tools/token.js';
import {
  AgentStoryCloseoutProcessor,
  type AgentTaskPort,
  type AgentTaskResultUnion,
  type AgentTaskRunOptions,
} from '../../src/agent-tasks/index.js';
import type { AgentTaskRequestUnion } from '../../src/agent-tasks/contracts/index.js';
import type { ProcessStoryCloseoutInput } from '../../src/interview/closeout/processor.js';
import type { StoryCloseoutContext } from '../../src/interview/closeout/context-builder.js';

class CapturingAgentTasks implements AgentTaskPort {
  options?: AgentTaskRunOptions;

  async run(request: AgentTaskRequestUnion, options: AgentTaskRunOptions = {}): Promise<AgentTaskResultUnion> {
    this.options = options;
    return {
      runId: request.runId,
      taskType: request.taskType,
      mode: request.mode,
      schemaVersion: request.schemaVersion,
      output: {
        current_story: {
          summary: '旧摘要',
          agent_memory: '旧的长期工作记忆',
          memory_changes: [],
          source_message_ids: [],
        },
        new_stories: [],
      },
      runtime: {
        runtime: 'test',
        skill: 'interview-closeout',
        provider: 'test-provider',
        model: 'test-model',
        latencyMs: 1,
      },
    } as AgentTaskResultUnion;
  }
}

test('story_continue receives a short-lived, Story-scoped retrieval script context', async () => {
  const context: StoryCloseoutContext = {
    sessionId: 'session-1',
    userId: 'owner-1',
    mode: 'continue',
    currentStageId: 'stage-1',
    currentStory: {
      story_id: 'story-1',
      title: '第一次工作',
      summary: '旧摘要',
      agent_memory: '旧的长期工作记忆',
      status: 'interviewing',
      stage_id: 'stage-1',
      updated_at: '2026-09-22T00:00:00.000Z',
    },
    lifeStages: [{
      stage_id: 'stage-1',
      title: '青年时期',
      start_date: '2010',
      end_date: '2020',
    }],
    otherStories: [],
    transcript: [{
      message_id: 'message-1',
      role: 'user',
      text: '我记得那次工作经历。',
      timestamp: '2026-09-22T00:00:00.000Z',
      provider: 'test',
    }],
  };
  const tokenService = new AgentToolTokenService('processor-test-secret-012345678901234567890');
  const tasks = new CapturingAgentTasks();
  const processor = new AgentStoryCloseoutProcessor(tasks, {
    baseUrl: 'http://backend.test',
    tokenService,
  });

  const input: ProcessStoryCloseoutInput = {
    context,
    config: { baseUrl: 'http://unused.test', apiKey: 'unused' },
    signal: new AbortController().signal,
    assertCurrentAttempt() {},
  };
  await processor.process(input);

  assert.equal(tasks.options?.scriptContext?.baseUrl, 'http://backend.test');
  assert.ok(tasks.options?.scriptContext?.token);
  const payload = tokenService.verify(tasks.options!.scriptContext!.token, {
    tool: 'memory_search',
    resourceType: 'story',
    resourceId: 'story-1',
  });
  assert.equal(payload.userId, 'owner-1');
});
