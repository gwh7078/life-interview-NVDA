import { onboardingProcessingState, onboardingResultView } from '/onboarding-ui.js';

const byId = (id) => document.getElementById(id);
const sessionId = new URLSearchParams(window.location.search).get('session_id')?.trim() || '';

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function setStatus(status, title, description) {
  byId('status-indicator').dataset.state = status;
  byId('status-title').textContent = title;
  byId('status-description').textContent = description;
}

function renderStage(stage) {
  const card = make('article', 'stage-card');
  const heading = make('div', 'stage-heading');
  heading.append(make('h3', '', stage.title), make('span', 'stage-date', stage.dateRange));
  card.append(heading);

  const stories = make('ul', 'story-list');
  if (stage.stories.length === 0) {
    card.append(make('p', 'empty-copy', '目前没有单独列出的故事。'));
  } else {
    for (const story of stage.stories) {
      const item = make('li', 'story-item');
      item.append(make('strong', '', story.title));
      if (story.summary) item.append(make('p', '', story.summary));
      stories.append(item);
    }
    card.append(stories);
  }
  return card;
}

function showError(message, status = 'failed') {
  byId('page-error').textContent = message;
  byId('page-error').hidden = false;
  byId('result-content').hidden = true;
  setStatus(status, '暂时无法显示人生档案', '你的人生访谈记录会保留；完成后可以再次打开结果页。');
}

function render(payload) {
  const processingState = onboardingProcessingState(payload);
  if (processingState === 'processing') {
    window.location.assign(`/onboarding/processing?session_id=${encodeURIComponent(sessionId)}`);
    return;
  }
  if (processingState !== 'completed') {
    const processingError = payload.processing_error;
    const errorMessage = typeof processingError === 'string'
      ? processingError.trim()
      : processingError && typeof processingError.message === 'string'
        ? processingError.message.trim()
        : '';
    showError(processingState === 'failed'
      ? (errorMessage || '人生档案整理未完成。请返回继续建档。')
      : '没有找到已完成的这次人生建档。请返回继续建档。', processingState);
    return;
  }

  const view = onboardingResultView(payload);
  byId('page-error').hidden = true;
  byId('result-content').hidden = false;
  byId('profile-name').textContent = view.profile.name;
  byId('current-status').textContent = view.profile.currentStatus;
  byId('current-status-block').hidden = !view.profile.currentStatus;
  byId('profile-summary').textContent = view.profile.summary;
  byId('profile-summary-block').hidden = !view.profile.summary;

  const stages = byId('life-stages-list');
  stages.replaceChildren();
  if (view.stages.length === 0) {
    stages.append(make('p', 'empty-copy', '暂时没有可显示的人生阶段。'));
  } else {
    for (const stage of view.stages) stages.append(renderStage(stage));
  }
  setStatus('completed', '你的人生地图已整理完成', '人物档案、人生阶段和具体故事已准备好，之后可以继续深入讲述。');
}

async function loadResult() {
  if (!sessionId) {
    showError('链接中缺少 session_id。请从人生建档流程重新进入。', 'missing');
    return;
  }
  try {
    const response = await fetch(`/api/onboarding/result?session_id=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '无法读取人生档案。');
    render(payload);
  } catch (error) {
    showError(error instanceof Error ? error.message : '无法读取人生档案。');
  }
}

byId('finish-button').addEventListener('click', () => window.location.assign('/my-life'));
void loadResult();
