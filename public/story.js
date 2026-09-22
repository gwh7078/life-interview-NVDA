import { createTextDisclosure } from '/text-disclosure.js';
import { requestJson } from './http.js';

const elements = {
  profileWrap: document.querySelector('.profile-wrap'),
  profileEntry: document.querySelector('#profile-entry'),
  profilePopover: document.querySelector('#profile-popover'),
  profileName: document.querySelector('#profile-name'),
  profilePopoverName: document.querySelector('#profile-popover-name'),
  profileAvatar: document.querySelector('#profile-avatar'),
  loginNotice: document.querySelector('#login-notice'),
  loginLink: document.querySelector('#login-link'),
  pageNotice: document.querySelector('#page-notice'),
  pageRetry: document.querySelector('#page-retry'),
  retryButton: document.querySelector('#retry-button'),
  loadingState: document.querySelector('#loading-state'),
  storyContent: document.querySelector('#story-content'),
  storyTitleHeading: document.querySelector('#story-title-heading'),
  storyStage: document.querySelector('#story-stage'),
  storyUpdatedAt: document.querySelector('#story-updated-at'),
  storyProgress: document.querySelector('#story-progress'),
  storyStatus: document.querySelector('#story-status'),
  storyStatusDescription: document.querySelector('#story-status-description'),
  storySummary: document.querySelector('#story-summary'),
  storySummaryToggle: document.querySelector('#story-summary-toggle'),
  gapsIntro: document.querySelector('#gaps-intro'),
  gapList: document.querySelector('#gap-list'),
  continueLink: document.querySelector('#continue-link'),
  polishLink: document.querySelector('#polish-link'),
  shareStoryButton: document.querySelector('#share-story-button'),
  shareLayer: document.querySelector('#story-share-layer'),
  shareDialog: document.querySelector('#story-share-dialog'),
  shareBackdrop: document.querySelector('#story-share-backdrop'),
  shareClose: document.querySelector('#story-share-close'),
  shareRelationship: document.querySelector('#story-share-relationship'),
  shareGenerate: document.querySelector('#story-share-generate'),
  shareFeedback: document.querySelector('#story-share-feedback'),
  shareResult: document.querySelector('#story-share-result'),
  shareUrl: document.querySelector('#story-share-url'),
  shareCopy: document.querySelector('#story-share-copy'),
  shareExpiry: document.querySelector('#story-share-expiry'),
  editStoryButton: document.querySelector('#edit-story-button'),
  editLayer: document.querySelector('#story-edit-layer'),
  editDrawer: document.querySelector('#story-edit-drawer'),
  editBackdrop: document.querySelector('#story-edit-backdrop'),
  editClose: document.querySelector('#story-edit-close'),
  editCancel: document.querySelector('#story-edit-cancel'),
  titleForm: document.querySelector('#title-form'),
  storyTitleInput: document.querySelector('#story-title-input'),
  saveTitleButton: document.querySelector('#save-title-button'),
  titleFeedback: document.querySelector('#title-feedback'),
  stageSelect: document.querySelector('#stage-select'),
  stageFeedback: document.querySelector('#stage-feedback'),
};

const storyStatuses = ['pending', 'interviewing', 'complete'];

const state = {
  storyId: readStoryId(),
  story: null,
  lifeStages: [],
  documents: [],
  dataLoaded: false,
  savingTitle: false,
  movingStage: false,
  editReturnFocus: null,
  shareReturnFocus: null,
  creatingShare: false,
};

const storySummaryDisclosure = createTextDisclosure({
  content: elements.storySummary,
  toggle: elements.storySummaryToggle,
});

function readStoryId() {
  const match = window.location.pathname.match(/^\/stories\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function setProfile(profile) {
  elements.profileWrap.hidden = false;
  const name = typeof profile?.name === 'string' && profile.name.trim() ? profile.name.trim() : '我的档案';
  elements.profileName.textContent = name;
  elements.profilePopoverName.textContent = name;
  elements.profileAvatar.textContent = [...name][0] || '人';
}

function showPageError(message) {
  elements.pageNotice.textContent = message;
  elements.pageNotice.hidden = false;
  elements.pageRetry.hidden = false;
}

function hidePageError() {
  elements.pageNotice.textContent = '';
  elements.pageNotice.hidden = true;
  elements.pageRetry.hidden = true;
}

function setFeedback(element, message) {
  element.textContent = message;
  element.hidden = !message;
}

function normaliseStatus(status) {
  return storyStatuses.includes(status) ? status : 'pending';
}

function statusLabel(status) {
  if (status === 'pending') return '资料较少';
  if (status === 'interviewing') return '正在完善';
  if (status === 'complete') return '已可成稿';
  return '资料较少';
}

function statusDescription(status) {
  if (status === 'pending') return '这段故事还在收集阶段，继续聊一两次，会更容易看见完整脉络。';
  if (status === 'interviewing') return '已经整理出一部分内容，下一次可以接着当前线索继续。';
  if (status === 'complete') return '目前的资料已经足够生成一篇故事成稿。';
  return '这段故事还在收集阶段，继续聊一会儿就好。';
}

function formatDate(value) {
  if (typeof value !== 'string' || !value.trim()) return '更新时间暂不可用';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '更新时间暂不可用';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

function renderStageOptions() {
  const stages = Array.isArray(state.lifeStages) ? [...state.lifeStages] : [];
  if (state.story?.stage_id && !stages.some((stage) => stage.stage_id === state.story.stage_id)) {
    stages.unshift({ stage_id: state.story.stage_id, title: state.story.stage_title || '当前人生阶段' });
  }
  const fragment = document.createDocumentFragment();
  for (const stage of stages) {
    if (typeof stage?.stage_id !== 'string' || typeof stage?.title !== 'string') continue;
    const option = document.createElement('option');
    option.value = stage.stage_id;
    option.textContent = stage.title;
    option.selected = stage.stage_id === state.story?.stage_id;
    fragment.append(option);
  }
  elements.stageSelect.replaceChildren(fragment);
  elements.stageSelect.disabled = state.movingStage || stages.length === 0;
}

function renderProgress() {
  const status = normaliseStatus(state.story.status);
  elements.storyProgress.dataset.status = status;
  elements.storyStatus.textContent = statusLabel(status);
  elements.storyStatus.dataset.status = status;
  elements.storyStatusDescription.textContent = statusDescription(status);
}

function renderGaps() {
  const gaps = Array.isArray(state.story.gaps)
    ? state.story.gaps.filter((gap) => typeof gap === 'string' && gap.trim()).slice(0, 3)
    : [];
  elements.gapList.replaceChildren();
  if (gaps.length === 0) {
    elements.gapsIntro.textContent = '从你想说的地方开始就好，这里暂时没有额外线索。';
    const empty = document.createElement('p');
    empty.className = 'gap-empty';
    empty.textContent = '你可以按自己的节奏继续讲述，不需要逐项完成任何内容。';
    elements.gapList.append(empty);
    return;
  }

  elements.gapsIntro.textContent = normaliseStatus(state.story.status) === 'complete'
    ? '当前资料已经足够整理成一篇完整文章。如果还想继续丰富，可以从下面的问题里选一个聊。'
    : '下次续访可以优先从下面的问题继续；它们不是待办清单，是否继续由你决定。';
  gaps.forEach((gap, index) => {
    const item = document.createElement('div');
    item.className = 'gap-item';
    const number = document.createElement('span');
    number.className = 'gap-index';
    number.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('p');
    copy.textContent = gap.trim();
    item.append(number, copy);
    elements.gapList.append(item);
  });
}

function renderActions() {
  const encodedStoryId = encodeURIComponent(state.storyId);
  const documentsPath = `/stories/${encodedStoryId}/documents`;
  const isComplete = normaliseStatus(state.story.status) === 'complete';
  elements.continueLink.href = `/interview?mode=continue&story_id=${encodedStoryId}&precall=1`;
  elements.polishLink.dataset.href = documentsPath;
  elements.polishLink.disabled = !isComplete;
  elements.polishLink.className = `button polish-link ${isComplete ? 'button-primary' : 'button-disabled'}`;
  elements.polishLink.setAttribute('aria-label', isComplete ? '打开润色成稿' : '资料完整后可润色成稿');
}

function renderStory() {
  const story = state.story;
  if (!story) return;
  const title = typeof story.title === 'string' && story.title.trim() ? story.title.trim() : '未命名故事';
  elements.storyTitleHeading.textContent = title;
  elements.storyStage.textContent = typeof story.stage_title === 'string' && story.stage_title.trim()
    ? story.stage_title.trim()
    : '未归类人生阶段';
  elements.storyUpdatedAt.textContent = `${formatDate(story.updated_at)}更新`;
  elements.storySummary.textContent = typeof story.summary === 'string' && story.summary.trim()
    ? story.summary.trim()
    : '这个故事还没有摘要。继续聊一会儿，等内容更完整后这里会慢慢长出来。';
  renderProgress();
  renderStageOptions();
  renderGaps();
  renderActions();
  elements.loadingState.hidden = true;
  elements.storyContent.hidden = false;
  storySummaryDisclosure.setExpanded(false);
  storySummaryDisclosure.refresh();
  elements.storyTitleInput.value = typeof story.title === 'string' ? story.title : '';
  state.dataLoaded = true;
}

async function loadStory() {
  const hasSnapshot = state.dataLoaded;
  hidePageError();
  elements.loadingState.hidden = hasSnapshot;
  if (!state.storyId) {
    elements.loadingState.hidden = true;
    showPageError('故事地址无效，请从我的人生时间线重新打开。');
    return;
  }

  try {
    const encodedId = encodeURIComponent(state.storyId);
    const [storyPayload, stagesPayload, documentsPayload] = await Promise.all([
      requestJson(`/api/stories/${encodedId}`),
      requestJson('/api/life-stages'),
      requestJson(`/api/stories/${encodedId}/documents`),
    ]);
    if (!storyPayload.story || !Array.isArray(stagesPayload.life_stages) || !Array.isArray(documentsPayload.documents)) {
      throw new Error('返回的故事、人生阶段或成稿数据格式不正确。');
    }
    state.story = storyPayload.story;
    state.lifeStages = stagesPayload.life_stages;
    state.documents = documentsPayload.documents;
    renderStory();
  } catch (error) {
    elements.loadingState.hidden = true;
    showPageError(error instanceof Error ? error.message : '读取故事失败，请稍后重试。');
  }
}

async function checkAuthentication() {
  try {
    const response = await fetch('/api/auth/me', { cache: 'no-store' });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      // The login state below is enough when there is no session.
    }
    if (response.status === 401 || (response.ok && !payload.profile)) {
      const returnTo = `${window.location.pathname}${window.location.search}`;
      elements.loginLink.href = `/interview?return_to=${encodeURIComponent(returnTo)}`;
      elements.loadingState.hidden = true;
      elements.loginNotice.hidden = false;
      elements.storyContent.hidden = true;
      return false;
    }
    if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : '读取登录状态失败。');
    setProfile(payload.profile);
    elements.loginNotice.hidden = true;
    return true;
  } catch (error) {
    elements.loadingState.hidden = true;
    showPageError(error instanceof Error ? error.message : '无法连接到本机服务。');
    return false;
  }
}

async function saveTitle(event) {
  event.preventDefault();
  if (state.savingTitle || !state.story) return;
  const title = elements.storyTitleInput.value.trim();
  if (!title) {
    setFeedback(elements.titleFeedback, '标题不能为空。');
    elements.storyTitleInput.focus();
    return;
  }
  if (title === state.story.title) {
    setFeedback(elements.titleFeedback, '标题没有变化。');
    return;
  }

  state.savingTitle = true;
  elements.storyTitleInput.disabled = true;
  elements.saveTitleButton.disabled = true;
  elements.saveTitleButton.textContent = '保存中…';
  setFeedback(elements.titleFeedback, '');
  try {
    const payload = await requestJson(`/api/stories/${encodeURIComponent(state.storyId)}/title`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
    const updatedStory = payload.story && typeof payload.story === 'object' ? payload.story : {};
    state.story = { ...state.story, ...updatedStory, title };
    renderStory();
    setFeedback(elements.titleFeedback, '标题已保存。');
  } catch (error) {
    setFeedback(elements.titleFeedback, error instanceof Error ? error.message : '保存标题失败，请重试。');
  } finally {
    state.savingTitle = false;
    elements.storyTitleInput.disabled = false;
    elements.saveTitleButton.disabled = false;
    elements.saveTitleButton.textContent = '保存';
  }
}

async function moveStoryToStage() {
  if (state.movingStage || !state.story) return;
  const nextStageId = elements.stageSelect.value;
  if (!nextStageId || nextStageId === state.story.stage_id) return;
  const previousStageId = state.story.stage_id;
  const stage = state.lifeStages.find((item) => item.stage_id === nextStageId);

  state.movingStage = true;
  elements.stageSelect.disabled = true;
  setFeedback(elements.stageFeedback, '');
  try {
    await requestJson(`/api/stories/${encodeURIComponent(state.storyId)}/stage`, {
      method: 'PATCH',
      body: JSON.stringify({ stage_id: nextStageId }),
    });
    state.story = {
      ...state.story,
      stage_id: nextStageId,
      stage_title: stage?.title || state.story.stage_title,
    };
    renderStory();
    setFeedback(elements.stageFeedback, stage ? `已移动到「${stage.title}」。` : '人生阶段已更新。');
  } catch (error) {
    elements.stageSelect.value = previousStageId;
    setFeedback(elements.stageFeedback, error instanceof Error ? error.message : '移动人生阶段失败，请重试。');
  } finally {
    state.movingStage = false;
    elements.stageSelect.disabled = false;
  }
}

function openEditDrawer(returnFocus = document.activeElement) {
  if (!state.story) return;
  state.editReturnFocus = returnFocus;
  elements.storyTitleInput.value = typeof state.story.title === 'string' ? state.story.title : '';
  setFeedback(elements.titleFeedback, '');
  setFeedback(elements.stageFeedback, '');
  renderStageOptions();
  elements.editLayer.hidden = false;
  document.body.classList.add('story-edit-open');
  elements.profilePopover.hidden = true;
  elements.profileEntry.setAttribute('aria-expanded', 'false');
  elements.storyTitleInput.focus();
}

function closeEditDrawer() {
  if (state.savingTitle || state.movingStage) return;
  elements.editLayer.hidden = true;
  document.body.classList.remove('story-edit-open');
  const target = state.editReturnFocus instanceof HTMLElement && state.editReturnFocus.isConnected
    ? state.editReturnFocus
    : elements.editStoryButton;
  state.editReturnFocus = null;
  target?.focus();
}

function trapDialogFocus(container, event) {
  const focusable = [...container.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')]
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

function openShareDialog(returnFocus = document.activeElement) {
  if (!state.story) return;
  state.shareReturnFocus = returnFocus;
  state.creatingShare = false;
  elements.shareGenerate.disabled = false;
  elements.shareGenerate.textContent = '生成 7 天分享链接';
  elements.shareResult.hidden = true;
  elements.shareUrl.value = '';
  elements.shareExpiry.textContent = '';
  setFeedback(elements.shareFeedback, '');
  elements.shareLayer.hidden = false;
  document.body.classList.add('story-share-open');
  elements.profilePopover.hidden = true;
  elements.profileEntry.setAttribute('aria-expanded', 'false');
  elements.shareRelationship.focus();
}

function closeShareDialog() {
  if (state.creatingShare) return;
  elements.shareLayer.hidden = true;
  document.body.classList.remove('story-share-open');
  const target = state.shareReturnFocus instanceof HTMLElement && state.shareReturnFocus.isConnected
    ? state.shareReturnFocus
    : elements.shareStoryButton;
  state.shareReturnFocus = null;
  target?.focus();
}

async function createStoryShareLink() {
  if (state.creatingShare || !state.storyId) return;
  state.creatingShare = true;
  elements.shareGenerate.disabled = true;
  elements.shareGenerate.textContent = '生成中…';
  elements.shareResult.hidden = true;
  setFeedback(elements.shareFeedback, '');
  try {
    const payload = await requestJson(`/api/stories/${encodeURIComponent(state.storyId)}/share-links`, {
      method: 'POST',
      body: JSON.stringify({ relationship: elements.shareRelationship.value }),
    });
    if (typeof payload.share_url !== 'string' || !payload.share_url) {
      throw new Error('分享链接生成失败。');
    }
    const absoluteUrl = new URL(payload.share_url, window.location.origin).toString();
    elements.shareUrl.value = absoluteUrl;
    const expiresAt = new Date(payload.expires_at);
    elements.shareExpiry.textContent = Number.isNaN(expiresAt.getTime())
      ? '链接将在创建 7 天后失效。'
      : `有效至 ${expiresAt.toLocaleString('zh-CN', { hour12: false })}`;
    elements.shareResult.hidden = false;
    elements.shareGenerate.textContent = '链接已生成';
    elements.shareGenerate.disabled = true;
    setFeedback(elements.shareFeedback, '请把这个链接持续发给同一个人；再次打开时会接着之前的采访继续。');
  } catch (error) {
    setFeedback(elements.shareFeedback, error instanceof Error ? error.message : '生成分享链接失败，请重试。');
    elements.shareGenerate.textContent = '生成 7 天分享链接';
  } finally {
    state.creatingShare = false;
    if (elements.shareResult.hidden) elements.shareGenerate.disabled = false;
  }
}

async function copyStoryShareLink() {
  const value = elements.shareUrl.value.trim();
  if (!value) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      elements.shareUrl.focus();
      elements.shareUrl.select();
      document.execCommand('copy');
    }
    elements.shareCopy.textContent = '已复制';
    setTimeout(() => { elements.shareCopy.textContent = '复制'; }, 1200);
  } catch {
    elements.shareUrl.focus();
    elements.shareUrl.select();
    setFeedback(elements.shareFeedback, '无法自动复制，请长按或手动复制链接。');
  }
}

function toggleProfile() {
  const isOpen = elements.profileEntry.getAttribute('aria-expanded') === 'true';
  elements.profileEntry.setAttribute('aria-expanded', String(!isOpen));
  elements.profilePopover.hidden = isOpen;
}

elements.titleForm.addEventListener('submit', saveTitle);
elements.stageSelect.addEventListener('change', moveStoryToStage);
elements.editStoryButton.addEventListener('click', () => openEditDrawer(elements.editStoryButton));
elements.shareStoryButton.addEventListener('click', () => openShareDialog(elements.shareStoryButton));
elements.shareClose.addEventListener('click', closeShareDialog);
elements.shareBackdrop.addEventListener('click', closeShareDialog);
elements.shareGenerate.addEventListener('click', () => void createStoryShareLink());
elements.shareCopy.addEventListener('click', () => void copyStoryShareLink());
elements.editClose.addEventListener('click', closeEditDrawer);
elements.editCancel.addEventListener('click', closeEditDrawer);
elements.editBackdrop.addEventListener('click', closeEditDrawer);
elements.polishLink.addEventListener('click', () => {
  if (elements.polishLink.disabled) return;
  const target = elements.polishLink.dataset.href;
  if (target) window.location.assign(target);
});
elements.retryButton.addEventListener('click', loadStory);
elements.profileEntry.addEventListener('click', toggleProfile);
document.addEventListener('click', (event) => {
  if (!elements.profileWrap.contains(event.target)) {
    elements.profileEntry.setAttribute('aria-expanded', 'false');
    elements.profilePopover.hidden = true;
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!elements.shareLayer.hidden) closeShareDialog();
    else if (!elements.editLayer.hidden) closeEditDrawer();
    else {
      elements.profileEntry.setAttribute('aria-expanded', 'false');
      elements.profilePopover.hidden = true;
    }
  }
  if (event.key === 'Tab') {
    if (!elements.shareLayer.hidden) trapDialogFocus(elements.shareDialog, event);
    else if (!elements.editLayer.hidden) trapDialogFocus(elements.editDrawer, event);
  }
});

const profileCheck = await checkAuthentication();
if (profileCheck) await loadStory();
