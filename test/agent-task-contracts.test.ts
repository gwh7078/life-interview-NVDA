import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NemoClawAgentTaskAdapter,
  StubAgentTaskAdapter,
  agentTaskDefinitions,
  agentTaskRequestEnvelopeSchema,
  contributorCloseoutTaskOutputSchema,
  createAgentTaskPort,
  getAgentTaskDefinition,
  interviewCloseoutTaskInputSchema,
  mapContributorCloseoutContextToTask,
  mapOnboardingCloseoutContextToTask,
  mapStoryCloseoutContextToTask,
  mapStoryCompletionContextToTask,
  mapStoryGenerationContextToTask,
  resolveAgentTaskRuntime,
  storyCompletionTaskOutputSchema,
  type ContributorCloseoutTaskRequest,
  type OnboardingCloseoutTaskRequest,
  type StoryCompletionTaskRequest,
  type StoryCreateCloseoutTaskRequest,
  type StoryGenerationTaskRequest,
} from '../src/agent-tasks/index.js';
import { AgentTaskContractError } from '../src/agent-tasks/errors.js';
import type { StoryCloseoutContext } from '../src/interview/closeout/context-builder.js';
import type { OnboardingCloseoutContext } from '../src/onboarding/types.js';
import type { StoryGenerationContext } from '../src/story/generation/types.js';

const timestamp = '2026-09-20T10:00:00Z';

function transcript(messageId = 'message-1', text = '这是一次有具体内容的回答。') {
  return [{
    message_id: messageId,
    role: 'user' as const,
    text,
    timestamp,
    provider: 'test' as const,
  }];
}

test('TaskDefinitionRegistry exposes four tasks and three interview.closeout modes', () => {
  assert.equal(agentTaskDefinitions.length, 6);
  assert.equal(getAgentTaskDefinition('onboarding.closeout').skill, 'onboarding-closeout');
  assert.equal(getAgentTaskDefinition('interview.closeout', 'story_create').skill, 'interview-closeout');
  assert.equal(getAgentTaskDefinition('interview.closeout', 'story_continue').skill, 'interview-closeout');
  assert.equal(getAgentTaskDefinition('interview.closeout', 'contributor').skill, 'interview-closeout');
  assert.equal(getAgentTaskDefinition('story.completion').modelProfile, 'reasoning-fast');
  assert.equal(getAgentTaskDefinition('story.generation').modelProfile, 'writing');
  assert.equal(getAgentTaskDefinition('story.completion').executionPolicy.maxAttempts, 3);
  assert.deepEqual(getAgentTaskDefinition('story.completion').executionPolicy.scriptCapabilities, []);
  assert.deepEqual(getAgentTaskDefinition('story.generation').executionPolicy.scriptCapabilities, []);
  assert.throws(
    () => getAgentTaskDefinition('interview.closeout'),
    (error: unknown) => error instanceof AgentTaskContractError
      && error.code === 'AGENT_TASK_DEFINITION_NOT_FOUND',
  );
});

test('contract schemas keep contributor and completion output boundaries strict', () => {
  contributorCloseoutTaskOutputSchema.parse({ summary: '第三者的独立回忆。' });
  assert.throws(() => contributorCloseoutTaskOutputSchema.parse({
    summary: 'x'.repeat(401),
  }));
  assert.throws(() => contributorCloseoutTaskOutputSchema.parse({
    summary: '合法摘要',
    story_summary: '不允许污染主人公 Story',
  }));

  storyCompletionTaskOutputSchema.parse({
    status: 'interviewing',
    gaps: ['当时还有哪个具体场景让你印象最深？'],
  });
  assert.throws(() => storyCompletionTaskOutputSchema.parse({
    status: 'interviewing',
    gaps: ['问题一？', '问题二？', '问题三？', '问题四？'],
  }));
  assert.throws(() => storyCompletionTaskOutputSchema.parse({
    status: 'interviewing',
    gaps: ['缺少更多细节'],
  }));
});

test('request envelope and interview mode schemas are strict at runtime', () => {
  agentTaskRequestEnvelopeSchema.parse({
    runId: 'run-envelope',
    taskType: 'story.completion',
    ownerId: 'owner-1',
    resource: { type: 'story', id: 'story-1' },
    schemaVersion: 'v1',
    payload: {},
  });
  assert.throws(() => agentTaskRequestEnvelopeSchema.parse({
    runId: 'run-envelope',
    taskType: 'story.completion',
    ownerId: 'owner-1',
    resource: { type: 'story', id: 'story-1' },
    schemaVersion: 'v1',
    payload: {},
    unexpected: true,
  }));

  const createDefinition = getAgentTaskDefinition('interview.closeout', 'story_create');
  assert.throws(() => createDefinition.inputSchema.parse({
    mode: 'contributor',
    relationship: '女儿',
    previous_contributor_summary: null,
    transcript: [{
      message_id: 'm1',
      role: 'user',
      text: '内容',
      timestamp,
    }],
  }));

  
  interviewCloseoutTaskInputSchema.parse({
    mode: 'contributor',
    relationship: '女儿',
    previous_contributor_summary: null,
    transcript: [{
      message_id: 'm1',
      role: 'user',
      text: '我记得当时他很紧张。',
      timestamp,
    }],
  });

  assert.throws(() => interviewCloseoutTaskInputSchema.parse({
    mode: 'contributor',
    relationship: '女儿',
    previous_contributor_summary: null,
    current_story: { title: '不该出现' },
    transcript: [{
      message_id: 'm1',
      role: 'user',
      text: '内容',
      timestamp,
    }],
  }));
});

test('context mappers create prompt-safe aliases and preserve backend-only reference maps', () => {
  const onboardingContext = {
    sessionId: 'session-onboarding',
    userId: 'owner-1',
    profile: {
      name: '张三',
      birthDate: '1990-01-01',
      gender: null,
      birthPlace: null,
      currentLocation: null,
      currentStatus: null,
      profileSummary: null,
    } as OnboardingCloseoutContext['profile'],
    transcripts: [{
      sessionId: 'session-onboarding',
      startedAt: timestamp,
      messages: transcript('raw-message-1', '我叫张三。'),
      status: 'ended',
      closeoutStatus: 'pending',
      provider: 'test',
    }],
  } satisfies OnboardingCloseoutContext;

  const onboarding = mapOnboardingCloseoutContextToTask(onboardingContext, 'run-onboarding');
  assert.equal(onboarding.request.payload.interviews[0]?.transcript[0]?.role, 'user');
  assert.equal(
    onboarding.references.onboardingSources?.source_1?.message_id,
    'raw-message-1',
  );
  assert.equal(
    JSON.stringify(onboarding.request.payload).includes('raw-message-1'),
    false,
  );

  const storyContext: StoryCloseoutContext = {
    sessionId: 'session-story',
    userId: 'owner-1',
    mode: 'continue',
    currentStageId: 'stage-real',
    currentStory: {
      story_id: 'story-real',
      title: '第一次登台',
      summary: '旧摘要',
      agent_memory: '旧的长期工作记忆',
      status: 'interviewing',
      stage_id: 'stage-real',
      updated_at: timestamp,
    },
    lifeStages: [{
      stage_id: 'stage-real',
      title: '学生时期',
      start_date: '2005',
      end_date: '2008',
    }],
    otherStories: [],
    transcript: transcript('raw-message-2'),
  };
  const mappedStory = mapStoryCloseoutContextToTask(storyContext, 'run-story');
  assert.equal(mappedStory.request.mode, 'story_continue');
  assert.equal(mappedStory.request.payload.transcript[0]?.message_id, 'm1');
  assert.equal(mappedStory.references.messageIds?.m1, 'raw-message-2');
  assert.equal(mappedStory.request.payload.current_stage.stage_id, 's1');
  assert.equal(mappedStory.references.stageIds?.s1, 'stage-real');
  assert.equal(mappedStory.request.resource.version, timestamp);
});

test('completion, generation and contributor mappers expose only task-approved context', () => {
  const completion = mapStoryCompletionContextToTask({
    title: '第一次登台',
    agentMemory: '已经知道人物、地点和经过。',
    stageTitle: '学生时期',
    currentStatus: 'interviewing',
    previousGaps: ['当时老师具体说了什么？'],
    blockedDirections: ['用户明确表示具体年份已经记不清。'],
    sessionCount: 2,
    sourceUpdatedAt: timestamp,
  }, {
    runId: 'run-completion',
    ownerId: 'owner-1',
    storyId: 'story-1',
  });
  assert.equal(completion.request.payload.agent_memory, '已经知道人物、地点和经过。');
  assert.equal('transcript' in completion.request.payload, false);
  assert.equal(completion.request.resource.version, timestamp);

  const generationContext: StoryGenerationContext = {
    mode: 'initial',
    style: 'documentary',
    userInstruction: '',
    profile: { name: '张三', profileSummary: '工程师。' },
    lifeStage: { title: '学生时期', startDate: '2005', endDate: '2008' },
    transcript: [{
      sessionId: 'session-secret',
      messageId: 'message-secret',
      role: 'user',
      text: '我第一次登台时非常紧张。',
      timestamp,
    }],
    transcriptSessionIds: ['session-secret'],
    story: { title: '第一次登台', summary: '一次学生时期的演出。' },
    selectedDocument: null,
  };
  const generation = mapStoryGenerationContextToTask(generationContext, {
    runId: 'run-generation',
    ownerId: 'owner-1',
    storyId: 'story-1',
  });
  assert.deepEqual(generation.request.payload.transcript, [{
    role: 'user',
    text: '我第一次登台时非常紧张。',
  }]);
  assert.equal(JSON.stringify(generation.request.payload).includes('session-secret'), false);
  assert.equal(JSON.stringify(generation.request.payload).includes('message-secret'), false);

  const contributor = mapContributorCloseoutContextToTask({
    userId: 'owner-1',
    sessionId: 'contributor-session',
    relationship: '女儿',
    previousContributorSummary: '此前她提到父亲很重视这件事。',
    transcript: transcript('contributor-message', '我记得那天他很早就出门了。'),
  }, 'run-contributor');
  assert.equal(contributor.request.mode, 'contributor');
  assert.equal('current_story' in contributor.request.payload, false);
  assert.equal('agent_memory' in contributor.request.payload, false);
});

test('StubAgentTaskAdapter returns schema-valid results for all four task families', async () => {
  const adapter = new StubAgentTaskAdapter();

  const onboardingRequest: OnboardingCloseoutTaskRequest = {
    runId: 'run-1',
    taskType: 'onboarding.closeout',
    ownerId: 'owner-1',
    resource: { type: 'interview_session', id: 'session-1' },
    schemaVersion: 'v1',
    payload: {
      current_profile: {
        name: '张三',
        birth_year: 1990,
        gender: null,
        birth_place: null,
        current_location: null,
        current_status: null,
        profile_summary: null,
      },
      interviews: [{
        interview_number: 1,
        transcript: [{
          role: 'user',
          source_ref: 'source_1',
          text: '我叫张三。',
          timestamp,
        }],
      }],
    },
  };
  const onboardingResult = await adapter.run(onboardingRequest);
  getAgentTaskDefinition(onboardingResult.taskType, onboardingResult.mode)
    .outputSchema.parse(onboardingResult.output);
  assert.equal(onboardingResult.runtime.runtime, 'stub');

  const storyCreateRequest: StoryCreateCloseoutTaskRequest = {
    runId: 'run-2',
    taskType: 'interview.closeout',
    mode: 'story_create',
    ownerId: 'owner-1',
    resource: { type: 'interview_session', id: 'session-2' },
    schemaVersion: 'v1',
    payload: {
      mode: 'story_create',
      target_stage: {
        stage_id: 's1',
        title: '学生时期',
        start_date: '2005',
        end_date: '2008',
      },
      target_story_title: '第一次登台',
      other_stories: [],
      transcript: [{
        message_id: 'm1',
        role: 'user',
        text: '我第一次登台是在学校礼堂。',
        timestamp,
      }],
    },
  };
  const storyCreateResult = await adapter.run(storyCreateRequest);
  getAgentTaskDefinition(storyCreateResult.taskType, storyCreateResult.mode)
    .outputSchema.parse(storyCreateResult.output);

  const contributorRequest: ContributorCloseoutTaskRequest = {
    runId: 'run-3',
    taskType: 'interview.closeout',
    mode: 'contributor',
    ownerId: 'owner-1',
    resource: { type: 'interview_session', id: 'session-3' },
    schemaVersion: 'v1',
    payload: {
      mode: 'contributor',
      relationship: '女儿',
      previous_contributor_summary: null,
      transcript: [{
        message_id: 'm1',
        role: 'user',
        text: '我记得他那天很紧张。',
        timestamp,
      }],
    },
  };
  const contributorResult = await adapter.run(contributorRequest);
  getAgentTaskDefinition(contributorResult.taskType, contributorResult.mode)
    .outputSchema.parse(contributorResult.output);

  const completionRequest: StoryCompletionTaskRequest = {
    runId: 'run-4',
    taskType: 'story.completion',
    ownerId: 'owner-1',
    resource: { type: 'story', id: 'story-1' },
    schemaVersion: 'v1',
    payload: {
      title: '第一次登台',
      agent_memory: '已有足够工作记忆。',
      stage_title: '学生时期',
      current_status: 'interviewing',
      previous_gaps: [],
      blocked_directions: [],
      session_count: 2,
    },
  };
  const completionResult = await adapter.run(completionRequest);
  getAgentTaskDefinition(completionResult.taskType, completionResult.mode)
    .outputSchema.parse(completionResult.output);

  const generationRequest: StoryGenerationTaskRequest = {
    runId: 'run-5',
    taskType: 'story.generation',
    ownerId: 'owner-1',
    resource: { type: 'story', id: 'story-1' },
    schemaVersion: 'v1',
    payload: {
      mode: 'initial',
      style: 'documentary',
      user_instruction: '',
      profile: { name: '张三' },
      life_stage: {
        title: '学生时期',
        start_date: '2005',
        end_date: '2008',
      },
      transcript: [{ role: 'user', text: '我第一次登台是在学校礼堂。' }],
      story: { title: '第一次登台', summary: '学生时期的一次经历。' },
      selected_document: null,
    },
  };
  const generationResult = await adapter.run(generationRequest);
  getAgentTaskDefinition(generationResult.taskType, generationResult.mode)
    .outputSchema.parse(generationResult.output);
});

test('AI_TASK_RUNTIME defaults to direct and supports explicit stub or agent composition', () => {
  assert.equal(resolveAgentTaskRuntime({} as NodeJS.ProcessEnv), 'direct');
  assert.equal(createAgentTaskPort({} as NodeJS.ProcessEnv), null);
  assert.equal(resolveAgentTaskRuntime({ AI_TASK_RUNTIME: 'stub' } as NodeJS.ProcessEnv), 'stub');
  assert.ok(createAgentTaskPort({ AI_TASK_RUNTIME: 'stub' } as NodeJS.ProcessEnv) instanceof StubAgentTaskAdapter);

  assert.throws(
    () => createAgentTaskPort({ AI_TASK_RUNTIME: 'agent' } as NodeJS.ProcessEnv),
    (error: unknown) => error instanceof AgentTaskContractError
      && error.code === 'AGENT_RUNTIME_CONFIG_INVALID',
  );

  const agent = createAgentTaskPort({
    AI_TASK_RUNTIME: 'agent',
    NEMOCLAW_SANDBOX: 'life-interview-agent',
    AGENT_PROVIDER: 'stepfun',
    AGENT_MODEL_REASONING: 'reasoning-model',
    AGENT_MODEL_REASONING_FAST: 'fast-model',
    AGENT_MODEL_WRITING: 'writing-model',
    DATABASE_PATH: ':memory:',
  } as NodeJS.ProcessEnv);
  assert.ok(agent instanceof NemoClawAgentTaskAdapter);

  assert.throws(
    () => resolveAgentTaskRuntime({ AI_TASK_RUNTIME: 'legacy' } as NodeJS.ProcessEnv),
    (error: unknown) => error instanceof AgentTaskContractError
      && error.code === 'AGENT_TASK_RUNTIME_INVALID',
  );
});
