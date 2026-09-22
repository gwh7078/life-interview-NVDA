import { formatLifeStageYears, sortLifeStages } from './life-model.js';

const elements = {
  profileWrap: document.querySelector('.profile-wrap'),
  profileEntry: document.querySelector('#profile-entry'),
  profilePopover: document.querySelector('#profile-popover'),
  profileName: document.querySelector('#profile-name'),
  profilePopoverName: document.querySelector('#profile-popover-name'),
  profilePopoverPhone: document.querySelector('#profile-popover-phone'),
  profileAvatar: document.querySelector('#profile-avatar'),
  lifeContent: document.querySelector('#life-content'),
  pageNotice: document.querySelector('#page-notice'),
  pageRetry: document.querySelector('#page-retry'),
  retryButton: document.querySelector('#retry-button'),
  loginNotice: document.querySelector('#login-notice'),
  loadingState: document.querySelector('#loading-state'),
  emptyState: document.querySelector('#empty-state'),
  timelineList: document.querySelector('#timeline-list'),
  drawerLayer: document.querySelector('#drawer-layer'),
  drawer: document.querySelector('#life-drawer'),
  drawerTitle: document.querySelector('#drawer-title'),
  drawerClose: document.querySelector('#drawer-close'),
  drawerBackdrop: document.querySelector('#drawer-backdrop'),
  drawerCancel: document.querySelector('#drawer-cancel'),
  stageForm: document.querySelector('#stage-form'),
  stageTitle: document.querySelector('#stage-title'),
  startYear: document.querySelector('#stage-start-year'),
  endYear: document.querySelector('#stage-end-year'),
  endNow: document.querySelector('#stage-end-now'),
  formFeedback: document.querySelector('#form-feedback'),
  saveStage: document.querySelector('#save-stage'),
  deleteArea: document.querySelector('#delete-area'),
  deleteStage: document.querySelector('#delete-stage'),
  deleteConfirmation: document.querySelector('#delete-confirmation'),
  deleteConfirmationCopy: document.querySelector('#delete-confirmation-copy'),
  cancelDelete: document.querySelector('#cancel-delete'),
  confirmDelete: document.querySelector('#confirm-delete'),
  deleteFeedback: document.querySelector('#delete-feedback'),
};

const state = {
  profile: null,
  lifeStages: [],
  stories: [],
  dataLoaded: false,
  drawerMode: null,
  activeStage: null,
  returnFocus: null,
  isSaving: false,
  isDeleting: false,
};

function makeElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

async function requestJson(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(url, { ...options, headers, cache: 'no-store' });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // Successful delete endpoints may return an empty body.
  }
  if (!response.ok) {
    const error = new Error(payload.error || `请求失败（${response.status}）`);
    error.errorCode = payload.errorCode;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function showPageError(message) {
  elements.pageNotice.textContent = message;
  elements.pageNotice.hidden = false;
  elements.pageRetry.hidden = false;
}

function hidePageError() {
  elements.pageNotice.hidden = true;
  elements.pageNotice.textContent = '';
  elements.pageRetry.hidden = true;
}

function setProfile(profile) {
  state.profile = profile;
  elements.profileWrap.hidden = false;
  const name = typeof profile?.name === 'string' && profile.name.trim()
    ? profile.name.trim()
    : '我的档案';
  const avatar = [...name][0] || '人';
  elements.profileName.textContent = name;
  elements.profilePopoverName.textContent = name;
  elements.profilePopoverPhone.textContent = typeof profile?.phone === 'string' && profile.phone.trim()
    ? `手机号：${profile.phone.trim()}`
    : '手机号：未绑定';
  elements.profileAvatar.textContent = avatar;
}

const storyStatuses = ['pending', 'interviewing', 'complete'];

function normaliseStoryStatus(status) {
  return storyStatuses.includes(status) ? status : 'pending';
}

function storyStatusLabel(status) {
  if (status === 'pending') return '资料较少';
  if (status === 'interviewing') return '正在完善';
  if (status === 'complete') return '已可成稿';
  return '资料较少';
}

async function loadTimelineData() {
  const hasSnapshot = state.dataLoaded;
  hidePageError();
  elements.loadingState.hidden = hasSnapshot;

  try {
    const [stagesPayload, storiesPayload] = await Promise.all([
      requestJson('/api/life-stages'),
      requestJson('/api/stories'),
    ]);
    if (!Array.isArray(stagesPayload.life_stages) || !Array.isArray(storiesPayload.stories)) {
      throw new Error('返回的人生阶段或故事数据格式不正确。');
    }

    state.lifeStages = stagesPayload.life_stages;
    state.stories = storiesPayload.stories;
    state.dataLoaded = true;
    renderTimeline();
  } catch (error) {
    elements.loadingState.hidden = true;
    const message = error instanceof Error ? error.message : '读取人生时间线失败，请稍后重试。';
    showPageError(message);
  }
}

async function initializePage() {
  hidePageError();
  elements.lifeContent.hidden = true;
  elements.loginNotice.hidden = true;
  elements.loadingState.hidden = false;
  try {
    const response = await fetch('/api/auth/me', { cache: 'no-store' });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      // The login notice below is the useful state when no session is present.
    }
    if (response.status === 401 || (response.ok && !payload.profile)) {
      state.profile = null;
      elements.profileWrap.hidden = true;
      elements.loadingState.hidden = true;
      elements.loginNotice.hidden = false;
      return;
    }
    if (!response.ok) throw new Error(payload.error || '读取登录状态失败。');

    setProfile(payload.profile);
    elements.loginNotice.hidden = true;
    elements.lifeContent.hidden = false;
    await loadTimelineData();
  } catch (error) {
    elements.loadingState.hidden = true;
    elements.lifeContent.hidden = true;
    const message = error instanceof Error ? error.message : '无法连接到本机服务。';
    showPageError(message);
  }
}

function buildStoryCard(story) {
  const card = makeElement('a', 'story-card');
  card.href = `/stories/${encodeURIComponent(story.story_id)}`;
  const copy = makeElement('span', 'story-card-copy');
  const title = makeElement('span', 'story-card-title', story.title || '未命名故事');
  const summary = typeof story.summary === 'string' && story.summary.trim()
    ? story.summary.trim()
    : '这段经历还没有摘要，继续聊一会儿吧。';
  copy.append(title, makeElement('span', 'story-card-summary', summary));

  const meta = makeElement('span', 'story-card-meta');
  const status = makeElement('span', 'story-status status-chip', storyStatusLabel(story.status));
  status.dataset.status = normaliseStoryStatus(story.status);
  const arrow = makeElement('span', 'story-card-arrow', '›');
  arrow.setAttribute('aria-hidden', 'true');
  meta.append(status, arrow);
  card.append(copy, meta);
  return card;
}

function createStageSection(stage) {
  const section = makeElement('article', 'timeline-stage');
  const years = makeElement('div', 'stage-years', formatLifeStageYears(stage));
  const marker = makeElement('div', 'stage-marker');
  marker.setAttribute('aria-hidden', 'true');
  marker.append(makeElement('span'));

  const content = makeElement('div', 'stage-content');
  const heading = makeElement('button', 'stage-heading-button');
  heading.type = 'button';
  heading.dataset.stageId = stage.stage_id;
  heading.setAttribute('aria-label', `查看并编辑人生阶段：${stage.title}`);
  const copy = makeElement('span', 'stage-heading-copy');
  const title = makeElement('span', 'stage-heading-title', stage.title);
  title.setAttribute('role', 'heading');
  title.setAttribute('aria-level', '2');
  copy.append(title);
  heading.append(copy, makeElement('span', 'stage-open', '查看 ›'));

  const stageStories = state.stories.filter((story) => story.stage_id === stage.stage_id);
  const storyList = makeElement('div', 'story-list');
  if (stageStories.length === 0) {
    storyList.append(makeElement('p', 'stage-empty-copy', '这个阶段还没有故事。'));
  } else {
    for (const story of stageStories) storyList.append(buildStoryCard(story));
  }

  const addStory = makeElement('a', 'add-story-link');
  const plus = makeElement('span', '', '＋');
  plus.setAttribute('aria-hidden', 'true');
  addStory.append(plus, document.createTextNode('新增故事'));
  const query = new URLSearchParams({ mode: 'create', stage_id: stage.stage_id });
  addStory.href = `/interview?${query.toString()}`;
  addStory.setAttribute('aria-label', `在${stage.title}新增故事`);

  content.append(heading, storyList, addStory);
  section.append(years, marker, content);
  return section;
}

function renderTimeline() {
  const sortedStages = sortLifeStages(state.lifeStages);
  const fragment = document.createDocumentFragment();
  for (const stage of sortedStages) fragment.append(createStageSection(stage));
  elements.timelineList.replaceChildren(fragment);
  elements.emptyState.hidden = sortedStages.length !== 0;
  elements.loadingState.hidden = true;
  for (const button of document.querySelectorAll('[data-action="create-stage"]')) button.disabled = false;
}

function showFormFeedback(message) {
  elements.formFeedback.textContent = message;
  elements.formFeedback.hidden = false;
}

function clearFormFeedback() {
  elements.formFeedback.textContent = '';
  elements.formFeedback.hidden = true;
}

function showDeleteFeedback(message) {
  elements.deleteFeedback.textContent = message;
  elements.deleteFeedback.hidden = false;
}

function clearDeleteFeedback() {
  elements.deleteFeedback.textContent = '';
  elements.deleteFeedback.hidden = true;
}

function syncEndNowState() {
  elements.endYear.disabled = elements.endNow.checked || state.isSaving;
}

function setFormBusy(isBusy) {
  state.isSaving = isBusy;
  elements.stageTitle.disabled = isBusy;
  elements.startYear.disabled = isBusy;
  elements.endNow.disabled = isBusy;
  elements.saveStage.disabled = isBusy;
  elements.drawerCancel.disabled = isBusy;
  elements.drawerClose.disabled = isBusy;
  elements.drawerBackdrop.disabled = isBusy;
  elements.deleteStage.disabled = isBusy || state.isDeleting;
  elements.cancelDelete.disabled = isBusy || state.isDeleting;
  elements.confirmDelete.disabled = isBusy || state.isDeleting;
  elements.saveStage.textContent = isBusy ? '保存中…' : state.drawerMode === 'edit' ? '保存' : '确认';
  syncEndNowState();
}

function openDrawer(mode, stage = null, returnFocus = document.activeElement) {
  state.drawerMode = mode;
  state.activeStage = mode === 'edit' ? stage : null;
  state.returnFocus = returnFocus;
  state.isSaving = false;
  state.isDeleting = false;
  elements.drawerTitle.textContent = mode === 'edit' ? '编辑人生阶段' : '新增人生阶段';
  elements.saveStage.textContent = mode === 'edit' ? '保存' : '确认';
  elements.stageTitle.value = stage?.title ?? '';
  elements.startYear.value = typeof stage?.start_year === 'number' ? String(stage.start_year) : '';
  elements.endNow.checked = stage?.end_year === 'now';
  elements.endYear.value = typeof stage?.end_year === 'number' ? String(stage.end_year) : '';
  elements.deleteArea.hidden = mode !== 'edit';
  elements.deleteConfirmation.hidden = true;
  clearFormFeedback();
  clearDeleteFeedback();
  setFormBusy(false);
  elements.drawerLayer.hidden = false;
  document.body.classList.add('drawer-open');
  elements.profilePopover.hidden = true;
  elements.profileEntry.setAttribute('aria-expanded', 'false');
  elements.stageTitle.focus();
}

function closeDrawer() {
  if (state.isSaving || state.isDeleting) return;
  elements.drawerLayer.hidden = true;
  document.body.classList.remove('drawer-open');
  state.drawerMode = null;
  state.activeStage = null;
  const target = state.returnFocus instanceof HTMLElement && state.returnFocus.isConnected
    ? state.returnFocus
    : document.querySelector('[data-action="create-stage"]');
  target?.focus();
}

function parseYearInput(input, label) {
  const rawValue = input.value.trim();
  if (!rawValue) return { value: null };
  if (!/^\d+$/.test(rawValue)) {
    return { error: `${label}请输入整数年份，或留空。`, input };
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 1 || value > 9999) {
    return { error: `${label}请输入 1–9999 之间的整数年份，或留空。`, input };
  }
  return { value };
}

function readStageForm() {
  const title = elements.stageTitle.value.trim();
  if (!title) return { error: '请填写人生阶段名称。', input: elements.stageTitle };

  const startYear = parseYearInput(elements.startYear, '开始年份');
  if (startYear.error) return startYear;
  let endYear = { value: null };
  if (!elements.endNow.checked) {
    endYear = parseYearInput(elements.endYear, '结束年份');
    if (endYear.error) return endYear;
  }

  return {
    value: {
      title,
      start_year: startYear.value,
      end_year: elements.endNow.checked ? 'now' : endYear.value,
    },
  };
}

async function saveStage(event) {
  event.preventDefault();
  clearFormFeedback();
  const result = readStageForm();
  if (result.error) {
    showFormFeedback(result.error);
    result.input.focus();
    return;
  }

  setFormBusy(true);
  try {
    const isEdit = state.drawerMode === 'edit';
    const url = isEdit
      ? `/api/life-stages/${encodeURIComponent(state.activeStage.stage_id)}`
      : '/api/life-stages';
    await requestJson(url, {
      method: isEdit ? 'PATCH' : 'POST',
      body: JSON.stringify(result.value),
    });
    state.isSaving = false;
    if (isEdit) state.returnFocus = null;
    closeDrawer();
    await loadTimelineData();
  } catch (error) {
    setFormBusy(false);
    const message = error instanceof Error ? error.message : '保存人生阶段失败，请重试。';
    showFormFeedback(message);
  }
}

function deleteErrorMessage(error) {
  if (error?.errorCode === 'STAGE_HAS_STORIES') {
    return '这个人生阶段下还有故事。请先将这些故事移动到其他人生阶段，或者删除相关故事后，再删除这个人生阶段。';
  }
  return error instanceof Error ? error.message : '删除人生阶段失败，请重试。';
}

async function deleteStage() {
  if (!state.activeStage || state.drawerMode !== 'edit') return;
  clearDeleteFeedback();
  state.isDeleting = true;
  elements.stageTitle.disabled = true;
  elements.startYear.disabled = true;
  elements.endYear.disabled = true;
  elements.endNow.disabled = true;
  elements.saveStage.disabled = true;
  elements.deleteStage.disabled = true;
  elements.cancelDelete.disabled = true;
  elements.confirmDelete.disabled = true;
  elements.confirmDelete.textContent = '删除中…';
  elements.drawerClose.disabled = true;
  elements.drawerCancel.disabled = true;
  elements.drawerBackdrop.disabled = true;

  try {
    await requestJson(`/api/life-stages/${encodeURIComponent(state.activeStage.stage_id)}`, {
      method: 'DELETE',
    });
    state.isDeleting = false;
    elements.confirmDelete.textContent = '确认删除';
    state.returnFocus = null;
    closeDrawer();
    await loadTimelineData();
  } catch (error) {
    state.isDeleting = false;
    elements.stageTitle.disabled = false;
    elements.startYear.disabled = false;
    elements.endNow.disabled = false;
    elements.saveStage.disabled = false;
    syncEndNowState();
    elements.deleteStage.disabled = false;
    elements.cancelDelete.disabled = false;
    elements.confirmDelete.disabled = false;
    elements.confirmDelete.textContent = '确认删除';
    elements.drawerClose.disabled = false;
    elements.drawerCancel.disabled = false;
    elements.drawerBackdrop.disabled = false;
    showDeleteFeedback(deleteErrorMessage(error));
  }
}

function closeProfilePopover() {
  elements.profilePopover.hidden = true;
  elements.profileEntry.setAttribute('aria-expanded', 'false');
}

function toggleProfilePopover() {
  const willOpen = elements.profilePopover.hidden;
  elements.profilePopover.hidden = !willOpen;
  elements.profileEntry.setAttribute('aria-expanded', String(willOpen));
}

function trapDrawerFocus(event) {
  const focusable = [...elements.drawer.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href]')]
    .filter((element) => !element.closest('[hidden]'));
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

document.querySelectorAll('[data-action="create-stage"]').forEach((button) => {
  button.addEventListener('click', () => openDrawer('create', null, button));
});

elements.timelineList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-stage-id]');
  if (!button) return;
  const stage = state.lifeStages.find((item) => item.stage_id === button.dataset.stageId);
  if (stage) openDrawer('edit', stage, button);
});

elements.profileEntry.addEventListener('click', toggleProfilePopover);
document.addEventListener('click', (event) => {
  if (!elements.profileWrap.contains(event.target)) closeProfilePopover();
});

elements.stageForm.addEventListener('submit', saveStage);
elements.endNow.addEventListener('change', syncEndNowState);
elements.stageForm.addEventListener('input', clearFormFeedback);
elements.drawerClose.addEventListener('click', closeDrawer);
elements.drawerCancel.addEventListener('click', closeDrawer);
elements.drawerBackdrop.addEventListener('click', closeDrawer);
elements.deleteStage.addEventListener('click', () => {
  clearDeleteFeedback();
  elements.deleteConfirmationCopy.textContent = `确定要删除人生阶段「${state.activeStage?.title || ''}」吗？删除后无法恢复。`;
  elements.deleteConfirmation.hidden = false;
  elements.cancelDelete.focus();
});
elements.cancelDelete.addEventListener('click', () => {
  elements.deleteConfirmation.hidden = true;
  clearDeleteFeedback();
  elements.deleteStage.focus();
});
elements.confirmDelete.addEventListener('click', deleteStage);
elements.retryButton.addEventListener('click', initializePage);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!elements.drawerLayer.hidden) closeDrawer();
    else if (!elements.profilePopover.hidden) closeProfilePopover();
  }
  if (event.key === 'Tab' && !elements.drawerLayer.hidden) trapDrawerFocus(event);
});

initializePage();
