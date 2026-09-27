import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOnboardingStartMessage,
  onboardingEndUrl,
  onboardingCanRetryCloseout,
  onboardingHomeView,
  onboardingProcessingState,
  onboardingResultView,
  isStoryInterviewRoute,
} from './onboarding-ui.js';

test('profile onboarding status routes to welcome, continue, or My Life', () => {
  assert.equal(onboardingHomeView('not_started'), 'welcome');
  assert.equal(onboardingHomeView('in_progress'), 'continue');
  assert.equal(onboardingHomeView('completed'), 'my-life');
  assert.equal(onboardingHomeView(undefined), 'main');
});

test('completed onboarding preserves existing Story interview routes', () => {
  assert.equal(isStoryInterviewRoute('/interview', ''), true);
  assert.equal(isStoryInterviewRoute('/interview/', ''), true);
  assert.equal(isStoryInterviewRoute('/', '?mode=create&stage_id=stage-1'), true);
  assert.equal(isStoryInterviewRoute('/', '?mode=continue&story_id=story-1'), true);
  assert.equal(isStoryInterviewRoute('/', ''), false);
  assert.equal(isStoryInterviewRoute('/onboarding', ''), false);
});

test('onboarding start keeps the shared realtime protocol discriminated and Story-compatible', () => {
  assert.deepEqual(createOnboardingStartMessage('qwen'), {
    type: 'start',
    interview_type: 'onboarding',
    provider: 'qwen',
  });
});

test('onboarding end routes only model completion to processing and manual ends back to welcome', () => {
  assert.equal(onboardingEndUrl({ sessionId: 'session / 1', end_reason: 'model_complete' }),
    '/onboarding/processing?session_id=session%20%2F%201');
  assert.equal(onboardingEndUrl({ sessionId: 'session-2', end_reason: 'user' }), '/onboarding');
  assert.equal(onboardingEndUrl({ sessionId: 'session-3', end_reason: 'disconnect' }), '/onboarding');
});

test('processing state follows the snake_case onboarding result contract', () => {
  assert.equal(onboardingProcessingState({ session: { closeout_status: 'processing' } }), 'processing');
  assert.equal(onboardingProcessingState({ session: { closeout_status: 'failed' }, processing_error: { message: 'timeout' } }), 'failed');
  assert.equal(onboardingProcessingState({
    onboarding_status: 'completed',
    story_completion_pending: true,
    session: { closeout_status: 'completed' },
  }), 'processing');
  assert.equal(onboardingProcessingState({ onboarding_status: 'completed', session: { closeout_status: 'completed' } }), 'completed');
  assert.equal(onboardingProcessingState({ session: null }), 'missing');
  assert.equal(onboardingCanRetryCloseout({ processing_error: { retryable: true } }), true);
  assert.equal(onboardingCanRetryCloseout({ processing_error: { retryable: false } }), false);
});

test('onboarding result view renders ordered year ranges and stage-linked Stories without LifeStage summaries', () => {
  const result = onboardingResultView({
    profile: {
      name: { value: '林晓', source_refs: [] },
      birth_year: { value: 1992, source_refs: [] },
      current_status: { value: '目前在杭州生活，准备职业转型。', source_refs: [] },
      profile_summary: { value: '在南方长大，后来到外地求学。', source_refs: [] },
    },
    life_stages: [
      { stage_id: 'stage-later', title: '职业转型', start_year: 2020, end_year: null, date_precision: 'exact', sort_order: 2, summary: '不应显示的阶段摘要。' },
      { stage_id: 'stage-early', title: '求学时光', start_year: 2001, end_year: 2005, sort_order: 1, summary: '不应显示的阶段摘要。' },
      { stage_id: 'stage-now', title: '当前生活', start_year: 2024, end_year: 'now', sort_order: 3 },
      { stage_id: 'stage-unknown', title: '时间不详', start_year: null, end_year: null, sort_order: 4 },
      { stage_id: 'stage-end-only', title: '结束年份已知', start_year: null, end_year: 2018, sort_order: 5 },
    ],
    stories: [
      { story_id: 'story-1', stage_id: 'stage-early', title: '第一次独自去杭州', summary: '为了上大学，一个人坐火车来到杭州。' },
      { story_id: 'story-2', stage_id: 'stage-later', title: '做出转型决定', summary: '一次项目结束后开始重新考虑职业方向。' },
    ],
  });

  assert.deepEqual(result.profile, {
    name: '林晓',
    currentStatus: '目前在杭州生活，准备职业转型。',
    summary: '在南方长大，后来到外地求学。',
  });
  assert.deepEqual(result.stages.map((stage) => [stage.title, stage.dateRange]), [
    ['求学时光', '2001 — 2005'],
    ['职业转型', '2020 — 未填写'],
    ['当前生活', '2024 — 至今'],
    ['时间不详', '年份未填写'],
    ['结束年份已知', '未填写 — 2018'],
  ]);
  assert.equal('summary' in result.stages[0], false);
  assert.equal('summary' in result.stages[1], false);
  assert.equal(result.stages[0].stories[0].title, '第一次独自去杭州');
  assert.equal(result.stages[1].stories[0].summary, '一次项目结束后开始重新考虑职业方向。');
});
