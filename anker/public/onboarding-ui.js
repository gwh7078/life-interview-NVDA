export function onboardingHomeView(status) {
  if (status === 'not_started') return 'welcome';
  if (status === 'in_progress') return 'continue';
  if (status === 'completed') return 'my-life';
  return 'main';
}

export function isStoryInterviewRoute(pathname = '', search = '') {
  const normalizedPath = pathname === '/' ? '/' : pathname.replace(/\/+$/, '');
  if (normalizedPath === '/interview') return true;

  const params = new URLSearchParams(search);
  return params.has('story_id')
    || params.has('stage_id')
    || ['create', 'continue'].includes(params.get('mode') || '');
}

export function createOnboardingStartMessage(provider) {
  return {
    type: 'start',
    interview_type: 'onboarding',
    provider,
  };
}

export function onboardingEndUrl(message = {}) {
  const sessionId = typeof message.sessionId === 'string' ? message.sessionId.trim() : '';
  if (message.end_reason === 'model_complete' && sessionId) {
    return `/onboarding/processing?session_id=${encodeURIComponent(sessionId)}`;
  }
  return '/onboarding';
}

export function onboardingProcessingState(payload = {}) {
  const session = payload.session && typeof payload.session === 'object' ? payload.session : null;
  const closeoutStatus = typeof session?.closeout_status === 'string'
    ? session.closeout_status.toLowerCase()
    : '';
  if (payload.story_completion_pending === true) return 'processing';
  if (payload.onboarding_status === 'completed' || closeoutStatus === 'completed') return 'completed';
  if (payload.processing_error || closeoutStatus === 'failed') return 'failed';
  if (!session) return 'missing';
  return 'processing';
}

export function onboardingCanRetryCloseout(payload = {}) {
  return payload.processing_error?.retryable !== false;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function profileText(candidate) {
  const value = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate.value
    : candidate;
  return cleanText(value);
}

function formatYear(value) {
  return Number.isInteger(value) ? String(value) : '未填写';
}

function dateRange(stage) {
  const startYear = stage.start_year;
  const endYear = stage.end_year;
  const startMissing = startYear === null || startYear === undefined;
  const endMissing = endYear === null || endYear === undefined;
  if (startMissing && endMissing) return '年份未填写';
  const start = startMissing ? '未填写' : formatYear(startYear);
  const end = endYear === 'now' ? '至今' : endMissing ? '未填写' : formatYear(endYear);
  return `${start} — ${end}`;
}

export function onboardingResultView(payload = {}) {
  const profile = payload.profile && typeof payload.profile === 'object' ? payload.profile : {};
  const stories = Array.isArray(payload.stories) ? payload.stories : [];
  const lifeStages = Array.isArray(payload.life_stages) ? payload.life_stages : [];
  const orderedStages = lifeStages
    .map((stage, index) => ({ stage, index }))
    .sort((left, right) => {
      const leftOrder = Number.isFinite(Number(left.stage?.sort_order)) ? Number(left.stage.sort_order) : left.index;
      const rightOrder = Number.isFinite(Number(right.stage?.sort_order)) ? Number(right.stage.sort_order) : right.index;
      return leftOrder - rightOrder || left.index - right.index;
    });

  return {
    profile: {
      name: profileText(profile.name) || '人生档案',
      currentStatus: profileText(profile.current_status),
      summary: profileText(profile.profile_summary),
    },
    stages: orderedStages.map(({ stage }) => {
      const stageId = cleanText(stage?.stage_id);
      const stageStories = stories.filter((story) => cleanText(story?.stage_id) === stageId);
      return {
        title: cleanText(stage?.title) || '人生阶段',
        dateRange: dateRange(stage || {}),
        stories: (stageStories.length > 0 ? stageStories : (Array.isArray(stage?.stories) ? stage.stories : []))
          .map((story) => ({
            title: cleanText(story?.title) || '未命名故事',
            summary: cleanText(story?.summary),
          })),
      };
    }),
  };
}
