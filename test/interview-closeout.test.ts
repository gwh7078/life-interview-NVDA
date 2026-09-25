import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessInterviewReadiness,
  STORY_INTERVIEW_COMPLETION_UTTERANCE,
  isAssistantFarewell,
  isExplicitEndIntent,
} from '../src/interview/closeout.js';
import { buildStoryCloseoutPrompt } from '../src/interview/closeout/prompt-builder.js';
import { StoryCloseoutValidator } from '../src/interview/closeout/validator.js';
import { storyCloseoutOutputSchema } from '../src/interview/closeout-schema.js';
import { closeoutResultSchema } from '../src/db/transcript.js';
import type { StoryCloseoutContext } from '../src/interview/closeout/context-builder.js';

test('ending intent recognizes direct requests and contextual no-more-detail replies', () => {
  assert.equal(isExplicitEndIntent('今天先到这里吧'), true);
  assert.equal(isExplicitEndIntent('没有什么要补的了', '你想先到这里，还是再补一个片段？'), true);
  assert.equal(isExplicitEndIntent('没有什么要补的了', '当时还有谁在场？'), false);
  assert.equal(isExplicitEndIntent('我后来再也没有去过那里', '后来呢？'), false);
  assert.equal(isAssistantFarewell(STORY_INTERVIEW_COMPLETION_UTTERANCE), true);
  assert.equal(isAssistantFarewell('本次先聊到这里，再见！'), true);
  assert.equal(isAssistantFarewell('好，这次采访就到这里，谢谢你愿意分享。'), false);
  assert.equal(isAssistantFarewell('谢谢你的分享。'), false);
  assert.equal(isAssistantFarewell('谢谢你的分享，你还记得谁在场吗？'), false);
});

test('readiness assessment is advisory and leaves ending control to the user', () => {
  const assessment = assessInterviewReadiness([
    { message_id: 'u1', role: 'user', text: '我只记得大概在学校演出，其他细节以后再补。' },
    { message_id: 'a1', role: 'assistant', text: '你想继续聊吗？' },
  ]);
  assert.equal(assessment.draft_readiness, 'needs_followup');
  assert.equal(assessment.requires_user_confirmation, true);
  assert.deepEqual(assessment.source_refs, ['u1']);
});

test('story closeout prompts allow a fuller skeletal summary without turning into transcript replay', () => {
  const base = {
    sessionId: 'session-1',
    userId: 'user-1',
    currentStageId: 'stage-1',
    lifeStages: [{ stage_id: 'stage-1', title: '学生时代', start_date: null, end_date: null }],
    otherStories: [],
    transcript: [{
      message_id: 'u1',
      role: 'user' as const,
      text: '那次比赛让我第一次意识到自己很喜欢做产品。',
      timestamp: '2026-09-16T00:00:00.000Z',
      provider: 'test' as const,
    }],
  };

  const continued = buildStoryCloseoutPrompt({
    ...base,
    mode: 'continue',
    currentStory: {
      story_id: 'story-1',
      title: '第一次产品比赛',
      summary: '我参加了一次比赛。',
      agent_memory: '【故事背景】我参加了一次比赛。',
      status: 'draft',
      stage_id: 'stage-1',
      updated_at: '2026-09-16T00:00:00.000Z',
    },
  });
  const created = buildStoryCloseoutPrompt({
    ...base,
    mode: 'create',
    targetStoryTitle: '第一次产品比赛',
    currentStory: null,
  });

  for (const systemPrompt of [continued.prompt.system, created.prompt.system]) {
    assert.match(systemPrompt, /summary/);
    assert.match(systemPrompt, /agent_memory/);
    assert.match(systemPrompt, /长期工作记忆/);
    assert.match(systemPrompt, /默认完整继承|长期工作记忆/);
    assert.match(systemPrompt, /不确定/);
    assert.match(systemPrompt, /8000/);
  }
  assert.match(continued.prompt.user, /agent_memory/);
  assert.match(continued.prompt.system, /memory_changes/);
  assert.match(continued.prompt.system, /add\/correct\/refine\/merge\/remove/);
  assert.match(continued.prompt.system, /Story Seed/);
  assert.match(continued.prompt.system, /最多 5 个/);
  assert.match(continued.prompt.system, /同一人生阶段不等于同一个 Story/);
});

test('story closeout uses role aliases and restores only user source aliases to database IDs', () => {
  const context: StoryCloseoutContext = {
    sessionId: 'session-aliases',
    userId: 'user-1',
    mode: 'create',
    currentStageId: 'stage-db-1',
    targetStoryTitle: '第一次登台',
    currentStory: null,
    lifeStages: [{ stage_id: 'stage-db-1', title: '学生时代', start_date: null, end_date: null }],
    otherStories: [],
    transcript: [
      { message_id: 'db-user-message-1', role: 'user', text: '我第一次登台是在学校礼堂。', timestamp: '2026-09-20T00:00:00.000Z', provider: 'test' },
      { message_id: 'db-assistant-message-1', role: 'assistant', text: '当时是什么感受？', timestamp: '2026-09-20T00:00:01.000Z', provider: 'test' },
      { message_id: 'db-user-message-2', role: 'user', text: '我很紧张，但还是完成了演出。', timestamp: '2026-09-20T00:00:02.000Z', provider: 'test' },
    ],
  };
  const built = buildStoryCloseoutPrompt(context);
  const promptTranscript = (JSON.parse(built.prompt.user) as { transcript: Array<{ message_id: string; role: string }> }).transcript;
  assert.deepEqual(promptTranscript.map(({ message_id, role }) => [message_id, role]), [
    ['u1', 'user'], ['a1', 'assistant'], ['u2', 'user'],
  ]);
  assert.deepEqual([...built.references.sourceMessageIds], [
    ['u1', 'db-user-message-1'], ['u2', 'db-user-message-2'],
  ]);
  assert.match(built.prompt.system, /source_message_ids 只能引用输入 Transcript 中 role=user 的 u#/);

  const validator = new StoryCloseoutValidator();
  const candidate = {
    story: {
      title: '第一次登台',
      summary: '我第一次登台是在学校礼堂，虽然很紧张，还是完成了演出。',
      agent_memory: '【事件过程】我第一次登台是在学校礼堂，虽然很紧张，还是完成了演出。',
      source_message_ids: ['u1'],
    },
  };
  const validated = validator.validate(candidate, context, built.references);
  assert.deepEqual(validated.mode === 'create' ? validated.story.source_message_ids : [], ['db-user-message-1']);
  assert.throws(() => validator.validate({
    story: { ...candidate.story, source_message_ids: ['a1'] },
  }, context, built.references), (error: unknown) => Boolean(
    error && typeof error === 'object' && 'code' in error
      && (error as { code: string }).code === 'INVALID_SOURCE_MESSAGE_IDS'
  ));
});


test('Story Seed schema accepts five new Stories but rejects six', () => {
  const makeStory = (index: number) => ({
    title: `新故事 ${index}`,
    summary: `这是第 ${index} 个独立 Story Seed。`,
    stage_id: 'stage-1',
    source_message_ids: ['u1'],
  });
  const base = {
    current_story: {
      summary: '当前故事摘要。',
      agent_memory: '【故事背景】当前故事摘要。\n【已覆盖主题】已聊过核心经过。',
      memory_changes: [],
      source_message_ids: ['u1'],
    },
  };
  assert.equal(storyCloseoutOutputSchema.safeParse({
    ...base,
    new_stories: Array.from({ length: 5 }, (_, index) => makeStory(index + 1)),
  }).success, true);
  assert.equal(storyCloseoutOutputSchema.safeParse({
    ...base,
    new_stories: Array.from({ length: 6 }, (_, index) => makeStory(index + 1)),
  }).success, false);

  const makePersistedStory = (index: number) => ({
    story_id: `story-${index}`,
    source_message_ids: ['u1'],
  });
  assert.equal(closeoutResultSchema.safeParse({
    new_stories: Array.from({ length: 5 }, (_, index) => makePersistedStory(index + 1)),
  }).success, true, 'persisted Closeout metadata must accept the same five Story Seed limit');
  assert.equal(closeoutResultSchema.safeParse({
    new_stories: Array.from({ length: 6 }, (_, index) => makePersistedStory(index + 1)),
  }).success, false);
});


test('Agent Memory guard rejects silent information loss and accepts evidence-backed correction', () => {
  const context = {
    sessionId: 'session-memory-guard',
    userId: 'user-1',
    mode: 'continue' as const,
    currentStageId: 'stage-1',
    currentStory: {
      story_id: 'story-1',
      title: '第一次创业',
      summary: '2019年我和老王第一次创业，父亲当时反对。',
      agent_memory: '【故事背景】2019年我和老王第一次创业。\n【人物关系】合伙人是老王。父亲当时反对创业。',
      status: 'interviewing',
      stage_id: 'stage-1',
      updated_at: '2026-09-19T00:00:00.000Z',
    },
    lifeStages: [{ stage_id: 'stage-1', title: '工作阶段', start_date: null, end_date: null }],
    otherStories: [],
    transcript: [{
      message_id: 'u1',
      role: 'user' as const,
      text: '我刚才说错了，不是2019年，是2020年开始创业。老王还是合伙人，父亲当时确实反对。',
      timestamp: '2026-09-19T00:01:00.000Z',
      provider: 'test' as const,
    }],
  };
  const built = buildStoryCloseoutPrompt(context);
  const validator = new StoryCloseoutValidator();

  assert.throws(() => validator.validate({
    current_story: {
      summary: '2020年我开始第一次创业。',
      agent_memory: '【故事背景】2020年我开始第一次创业。',
      memory_changes: [{
        type: 'correct',
        previous_text: '2019年我和老王第一次创业。',
        new_text: '2020年我开始第一次创业。',
        source_message_ids: ['u1'],
      }],
      source_message_ids: ['u1'],
    },
    new_stories: [],
  }, context, built.references), (error: unknown) => Boolean(
    error && typeof error === 'object' && 'code' in error
      && (error as { code: string }).code === 'MEMORY_INFORMATION_LOSS'
  ));

  const validated = validator.validate({
    current_story: {
      summary: '2020年我和老王第一次创业，父亲当时反对。',
      agent_memory: '【故事背景】2020年我和老王第一次创业。\n【人物关系】合伙人是老王。父亲当时反对创业。',
      memory_changes: [{
        type: 'correct',
        previous_text: '2019年我和老王第一次创业。',
        new_text: '2020年我和老王第一次创业。',
        source_message_ids: ['u1'],
      }],
      source_message_ids: ['u1'],
    },
    new_stories: [],
  }, context, built.references);
  assert.equal(validated.mode, 'continue');
  if (validated.mode === 'continue') {
    assert.match(validated.current_story.agent_memory, /2020年/);
    assert.match(validated.current_story.agent_memory, /老王/);
    assert.match(validated.current_story.agent_memory, /父亲当时反对/);
    assert.equal('memory_changes' in validated.current_story, false,
      'memory_changes is validation-only and must not enter persistence');
  }
});

test('Agent Memory guard requires current-user evidence for destructive changes', () => {
  const context = {
    sessionId: 'session-memory-evidence',
    userId: 'user-1',
    mode: 'continue' as const,
    currentStageId: 'stage-1',
    currentStory: {
      story_id: 'story-1',
      title: '一次工作经历',
      summary: '父亲当时反对。',
      agent_memory: '【人物关系】父亲当时反对这个决定。',
      status: 'interviewing',
      stage_id: 'stage-1',
      updated_at: '2026-09-19T00:00:00.000Z',
    },
    lifeStages: [{ stage_id: 'stage-1', title: '工作阶段', start_date: null, end_date: null }],
    otherStories: [],
    transcript: [
      {
        message_id: 'u1',
        role: 'user' as const,
        text: '其实这件事跟父亲没有关系。',
        timestamp: '2026-09-19T00:01:00.000Z',
        provider: 'test' as const,
      },
      {
        message_id: 'a1',
        role: 'assistant' as const,
        text: '明白了。',
        timestamp: '2026-09-19T00:01:10.000Z',
        provider: 'test' as const,
      },
    ],
  };
  const built = buildStoryCloseoutPrompt(context);
  const validator = new StoryCloseoutValidator();
  assert.throws(() => validator.validate({
    current_story: {
      summary: '这次经历后来有了新的理解。',
      agent_memory: '【故事背景】这次经历后来有了新的理解。',
      memory_changes: [{
        type: 'remove',
        previous_text: '父亲当时反对这个决定。',
        new_text: '',
        source_message_ids: ['a1'],
      }],
      source_message_ids: ['u1'],
    },
    new_stories: [],
  }, context, built.references), (error: unknown) => Boolean(
    error && typeof error === 'object' && 'code' in error
      && (error as { code: string }).code === 'INVALID_SOURCE_MESSAGE_IDS'
  ));
});

test('Agent Memory rejects a real but unrelated source message for a new fact', () => {
  const context = {
    sessionId: 'session-memory-unrelated-evidence', userId: 'user-1', mode: 'continue' as const, currentStageId: 'stage-1',
    currentStory: { story_id: 'story-1', title: '一次工作经历', summary: '用户刚开始新的工作。', agent_memory: '【故事背景】用户刚开始新的工作。', status: 'interviewing', stage_id: 'stage-1', updated_at: '2026-09-19T00:00:00.000Z' },
    lifeStages: [{ stage_id: 'stage-1', title: '工作阶段', start_date: null, end_date: null }], otherStories: [],
    transcript: [{ message_id: 'u1', role: 'user' as const, text: '最近我只是更喜欢吃苹果了。', timestamp: '2026-09-19T00:01:00.000Z', provider: 'test' as const }],
  };
  const built = buildStoryCloseoutPrompt(context); const validator = new StoryCloseoutValidator();
  assert.throws(() => validator.validate({ current_story: {
    summary: '用户刚开始新的工作。', agent_memory: ['【故事背景】用户刚开始新的工作。', '【后续经历】后来在海边开了一家咖啡馆。'].join('\n'),
    memory_changes: [{ type: 'add', previous_text: '', new_text: '后来在海边开了一家咖啡馆。', source_message_ids: ['u1'] }], source_message_ids: ['u1'],
  }, new_stories: [] }, context, built.references), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
    && (error as { code: string }).code === 'INVALID_MEMORY_CHANGE' && 'diagnostics' in error
    && (error as { diagnostics?: Record<string, unknown> }).diagnostics?.reason === 'new_text_not_grounded_in_cited_messages'));
});
