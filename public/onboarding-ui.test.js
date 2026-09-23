import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createOnboardingStartMessage,
  onboardingEndUrl,
  onboardingCanRetryCloseout,
  onboardingHomeView,
  onboardingProcessingState,
  onboardingResultView,
  isStoryInterviewRoute,
} from './onboarding-ui.js';

const directory = path.dirname(fileURLToPath(import.meta.url));

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

test('onboarding pages use dedicated assets and expose only Done as the result-page button', () => {
  const directoryFiles = ['index.html', 'onboarding-processing.html', 'onboarding-result.html'];
  const pages = Object.fromEntries(directoryFiles.map((file) => [
    file,
    readFileSync(path.join(directory, file), 'utf8'),
  ]));
  const client = readFileSync(path.join(directory, 'client.js'), 'utf8');
  const resultScript = readFileSync(path.join(directory, 'onboarding-result.js'), 'utf8');
  const onboardingUi = readFileSync(path.join(directory, 'onboarding-ui.js'), 'utf8');
  assert.match(pages['index.html'], /id="onboarding-welcome"/);
  assert.doesNotMatch(pages['index.html'], /<option value="qwen"/);
  assert.match(client, /startButtonLabel\.textContent = continuing \? '继续聊天' : '开始聊天'/);
  assert.match(client, /onboardingHomeView\(state\.onboardingStatus\)/);
  assert.match(client, /if \(homeView === 'my-life'\) \{[\s\S]*?const returnTo = new URLSearchParams\(window\.location\.search\)\.get\('return_to'\)/);
  assert.match(client, /if \(!isStoryInterviewRoute\(window\.location\.pathname, window\.location\.search\)\)/);
  assert.match(client, /window\.location\.assign\('\/my-life'\)/);
  assert.match(client, /requestedMode === 'create' \|\| requestedStageId/);
  assert.match(client, /requestedMode === 'continue' \|\| requestedStoryId/);
  assert.match(client, /elements\.startButton\.addEventListener\('click', \(\) => void startInterview\(\)\)/);
  assert.match(client, /createOnboardingStartMessage\(state\.realtimeProvider\)/);
  assert.doesNotMatch(client, /interview_type:\s*['"]story/);
  assert.match(pages['onboarding-processing.html'], /onboarding-processing\.js/);
  assert.match(pages['onboarding-result.html'], /onboarding-result\.js/);
  assert.match(pages['onboarding-result.html'], /id="finish-button" class="button button-primary"/);
  assert.equal([...pages['onboarding-result.html'].matchAll(/<button\b/g)].length, 1);
  assert.doesNotMatch(pages['onboarding-result.html'], /src="\/result\.js"|api\/interview-sessions/);
  assert.match(resultScript, /finish-button[\s\S]*?assign\('\/my-life'\)/);
  assert.doesNotMatch(resultScript, /stage\??\.(?:summary|date_precision|start_date|end_date)/);
  assert.doesNotMatch(onboardingUi, /stage\??\.(?:summary|date_precision|start_date|end_date)/);
});
