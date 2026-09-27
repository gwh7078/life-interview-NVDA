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
  content: document.querySelector('#documents-content'),
  storyLink: document.querySelector('#story-link'),
  footerStoryLink: document.querySelector('#footer-story-link'),
  storyReference: document.querySelector('#story-reference'),
  startGenerationButton: document.querySelector('#start-generation-button'),
  emptyState: document.querySelector('#empty-state'),
  emptyCopy: document.querySelector('#empty-copy'),
  emptyGenerateButton: document.querySelector('#empty-generate-button'),
  notReadyCopy: document.querySelector('#not-ready-copy'),
  notReadyContinueLink: document.querySelector('#not-ready-continue-link'),
  revisionNotice: document.querySelector('#revision-notice'),
  versionList: document.querySelector('#version-list'),
  dialog: document.querySelector('#generation-dialog'),
  generationForm: document.querySelector('#generation-form'),
  generationTitle: document.querySelector('#generation-title'),
  generationContext: document.querySelector('#generation-context'),
  generationStyle: document.querySelector('#generation-style'),
  generationStyleOptions: [...document.querySelectorAll('input[name="style"]')],
  generationInstruction: document.querySelector('#generation-instruction'),
  generationProgress: document.querySelector('#generation-progress'),
  generationFeedback: document.querySelector('#generation-feedback'),
  closeGenerationButton: document.querySelector('#close-generation-button'),
  cancelGenerationButton: document.querySelector('#cancel-generation-button'),
  submitGenerationButton: document.querySelector('#submit-generation-button'),
};

const state = {
  storyId: readStoryId(),
  story: null,
  documents: [],
  dataLoaded: false,
  baseDocumentId: null,
  baseVersion: null,
  isGenerating: false,
  returnFocus: null,
};

function readStoryId() {
  const match = window.location.pathname.match(/^\/stories\/([^/]+)\/documents\/?$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

async function requestJson(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...options, headers, cache: 'no-store' });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // Some successful mutation endpoints do not return a body.
  }
  if (!response.ok) {
    const message = typeof payload.error === 'string' ? payload.error : `请求失败（${response.status}）`;
    const error = new Error(message);
    error.status = response.status;
    error.errorCode = payload.errorCode;
    throw error;
  }
  return payload;
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
  elements.pageNotice.hidden = true;
  elements.pageNotice.textContent = '';
  elements.pageRetry.hidden = true;
}

function formatDate(value) {
  if (typeof value !== 'string' || !value.trim()) return '时间暂不可用';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间暂不可用';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function sortDocuments(documents) {
  return [...documents].sort((left, right) => {
    const versionDifference = (Number(right.version_number) || 0) - (Number(left.version_number) || 0);
    if (versionDifference !== 0) return versionDifference;
    return String(right.created_at || '').localeCompare(String(left.created_at || ''));
  });
}

function getVersionNumber(value, fallback = null) {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : fallback;
}

function renderVersions() {
  const documents = state.documents.filter((item) => item && typeof item.document_id === 'string');
  state.documents = sortDocuments(documents);
  elements.versionList.replaceChildren();
  const hasDocuments = state.documents.length > 0;
  const canGenerate = state.story.status === 'complete';
  elements.emptyState.hidden = hasDocuments;
  elements.versionList.hidden = !hasDocuments;
  elements.startGenerationButton.hidden = !hasDocuments || !canGenerate;
  elements.startGenerationButton.textContent = '基于最新版本再润色';
  elements.emptyCopy.textContent = canGenerate
    ? '这个故事已经可以整理成第一篇文章。'
    : '访谈完成后，你可以把这个故事整理成一篇文章。';
  elements.emptyGenerateButton.hidden = !canGenerate;
  elements.notReadyCopy.hidden = canGenerate;
  elements.notReadyContinueLink.hidden = canGenerate;
  elements.revisionNotice.hidden = !hasDocuments || canGenerate;
  elements.revisionNotice.textContent = '继续完成访谈后，就可以基于任意历史版本创建新的成稿版本。已有版本仍可阅读。';

  const fragment = document.createDocumentFragment();
  state.documents.forEach((item, index) => {
    const card = document.createElement('article');
    card.className = 'version-card';

    const main = document.createElement('div');
    main.className = 'version-main';
    const openLink = document.createElement('a');
    openLink.className = 'version-link';
    openLink.href = `${documentsPath()}/${encodeURIComponent(item.document_id)}`;
    const version = document.createElement('span');
    version.className = 'version-badge';
    const versionNumber = getVersionNumber(item.version_number, index + 1);
    version.textContent = `V${versionNumber}`;
    openLink.append(version);
    if (index === 0) {
      const latest = document.createElement('span');
      latest.className = 'latest-label';
      latest.textContent = '最新';
      openLink.append(latest);
    }

    const title = document.createElement('span');
    title.className = 'version-title';
    title.textContent = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : '未命名成稿';
    const date = document.createElement('time');
    date.className = 'version-date';
    date.dateTime = typeof item.created_at === 'string' ? item.created_at : '';
    date.textContent = `生成于 ${formatDate(item.created_at)}`;
    const copy = document.createElement('span');
    copy.className = 'version-link-copy';
    copy.append(title, date);
    openLink.append(copy);
    main.append(openLink);

    card.append(main);
    fragment.append(card);
  });
  elements.versionList.append(fragment);
}

function storyPath() {
  return `/stories/${encodeURIComponent(state.storyId)}`;
}

function documentsPath() {
  return `${storyPath()}/documents`;
}

function renderPage() {
  const title = typeof state.story.title === 'string' && state.story.title.trim() ? state.story.title.trim() : '未命名故事';
  const continueQuery = new URLSearchParams({ mode: 'continue', story_id: state.storyId });
  elements.storyReference.textContent = `故事：${title}`;
  elements.storyLink.href = storyPath();
  elements.footerStoryLink.href = storyPath();
  elements.notReadyContinueLink.href = `/interview?${continueQuery.toString()}`;
  renderVersions();
  elements.loadingState.hidden = true;
  elements.content.hidden = false;
  state.dataLoaded = true;
}

async function loadDocuments() {
  const hasSnapshot = state.dataLoaded;
  hidePageError();
  elements.loadingState.hidden = hasSnapshot;
  if (!state.storyId) {
    elements.loadingState.hidden = true;
    showPageError('成稿地址无效，请从故事详情重新打开。');
    return;
  }
  try {
    const encodedId = encodeURIComponent(state.storyId);
    const [storyPayload, documentsPayload] = await Promise.all([
      requestJson(`/api/stories/${encodedId}`),
      requestJson(`/api/stories/${encodedId}/documents`),
    ]);
    if (!storyPayload.story || !Array.isArray(documentsPayload.documents)) {
      throw new Error('返回的故事或成稿版本数据格式不正确。');
    }
    state.story = storyPayload.story;
    state.documents = documentsPayload.documents;
    renderPage();
  } catch (error) {
    elements.loadingState.hidden = true;
    showPageError(error instanceof Error ? error.message : '读取成稿版本失败，请稍后重试。');
  }
}

async function checkAuthentication() {
  try {
    const response = await fetch('/api/auth/me', { cache: 'no-store' });
    let payload = {};
    try { payload = await response.json(); } catch { /* The login state below is enough when there is no session. */ }
    if (response.status === 401 || (response.ok && !payload.profile)) {
      const returnTo = `${window.location.pathname}${window.location.search}`;
      elements.loginLink.href = `/interview?return_to=${encodeURIComponent(returnTo)}`;
      elements.loadingState.hidden = true;
      elements.loginNotice.hidden = false;
      elements.content.hidden = true;
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

function setGenerationFeedback(message) {
  elements.generationFeedback.textContent = message;
  elements.generationFeedback.hidden = !message;
}

function selectGenerationStyle(style = 'documentary') {
  const requestedStyle = elements.generationStyleOptions.some((option) => option.value === style)
    ? style
    : 'documentary';
  elements.generationStyleOptions.forEach((option) => {
    option.checked = option.value === requestedStyle;
  });
}

function selectedGenerationStyle() {
  return elements.generationStyleOptions.find((option) => option.checked)?.value || 'documentary';
}

function generationCopy(baseVersion) {
  if (baseVersion === null) {
    return '将根据这个故事已经完成的访谈资料生成第一版成稿。';
  }
  return `将基于 V${baseVersion} 并参考故事的访谈资料，创建一个新的成稿版本。历史版本会保留。`;
}

function openGeneration(baseDocumentId, baseVersion = null, trigger = document.activeElement) {
  if (state.isGenerating || elements.dialog.open) return;
  state.baseDocumentId = baseDocumentId;
  state.baseVersion = baseVersion;
  state.returnFocus = trigger instanceof HTMLElement ? trigger : null;
  elements.generationTitle.textContent = baseDocumentId ? '再次润色' : '生成第一版';
  elements.generationContext.textContent = generationCopy(baseVersion);
  selectGenerationStyle();
  elements.generationInstruction.value = '';
  elements.submitGenerationButton.textContent = baseDocumentId ? '开始润色' : '开始生成';
  elements.generationProgress.hidden = true;
  setGenerationFeedback('');
  elements.dialog.showModal();
  elements.generationStyleOptions[0]?.focus();
}

function closeGeneration() {
  if (state.isGenerating || !elements.dialog.open) return;
  elements.dialog.close();
  state.returnFocus?.focus();
}

function setGenerationBusy(isBusy) {
  state.isGenerating = isBusy;
  elements.generationStyleOptions.forEach((option) => { option.disabled = isBusy; });
  elements.generationInstruction.disabled = isBusy;
  elements.closeGenerationButton.disabled = isBusy;
  elements.cancelGenerationButton.disabled = isBusy;
  elements.submitGenerationButton.disabled = isBusy;
  elements.generationForm.setAttribute('aria-busy', String(isBusy));
  elements.generationProgress.hidden = !isBusy;
  elements.submitGenerationButton.textContent = isBusy ? '正在整理成稿…' : state.baseDocumentId ? '开始润色' : '开始生成';
}

async function submitGeneration(event) {
  event.preventDefault();
  if (state.isGenerating) return;
  const style = selectedGenerationStyle();
  const userInstruction = elements.generationInstruction.value.trim();
  setGenerationFeedback('');
  setGenerationBusy(true);
  try {
    const payload = await requestJson(`/api/stories/${encodeURIComponent(state.storyId)}/documents/generate`, {
      method: 'POST',
      body: JSON.stringify({
        style,
        user_instruction: userInstruction,
        base_document_id: state.baseDocumentId,
      }),
    });
    const newDocumentId = typeof payload.document?.document_id === 'string' ? payload.document.document_id : null;
    if (newDocumentId) {
      window.location.assign(`${documentsPath()}/${encodeURIComponent(newDocumentId)}`);
      return;
    }
    // The request succeeded, so return to the refreshed list instead of inviting a duplicate generation.
    window.location.assign(documentsPath());
  } catch (error) {
    setGenerationFeedback(error instanceof Error ? error.message : '生成失败，请检查网络后手动重试。');
    setGenerationBusy(false);
    elements.submitGenerationButton.focus();
  }
}

function onVersionListClick(event) {
  const button = event.target.closest('[data-revise-document]');
  if (!button || !elements.versionList.contains(button)) return;
  const version = getVersionNumber(button.dataset.versionNumber);
  openGeneration(button.dataset.reviseDocument, version, button);
}

function onStartGeneration(event) {
  const latest = state.documents[0];
  if (latest) {
    const version = getVersionNumber(latest.version_number);
    openGeneration(latest.document_id, version, event.currentTarget);
  } else {
    openGeneration(null, null, event.currentTarget);
  }
}

function toggleProfile() {
  const isOpen = elements.profileEntry.getAttribute('aria-expanded') === 'true';
  elements.profileEntry.setAttribute('aria-expanded', String(!isOpen));
  elements.profilePopover.hidden = isOpen;
}

elements.retryButton.addEventListener('click', loadDocuments);
elements.versionList.addEventListener('click', onVersionListClick);
elements.startGenerationButton.addEventListener('click', onStartGeneration);
elements.emptyGenerateButton.addEventListener('click', onStartGeneration);
elements.generationForm.addEventListener('submit', submitGeneration);
elements.closeGenerationButton.addEventListener('click', closeGeneration);
elements.cancelGenerationButton.addEventListener('click', closeGeneration);
elements.dialog.addEventListener('cancel', (event) => {
  if (state.isGenerating) event.preventDefault();
});
elements.dialog.addEventListener('click', (event) => {
  if (event.target === elements.dialog) closeGeneration();
});
elements.profileEntry.addEventListener('click', toggleProfile);
document.addEventListener('click', (event) => {
  if (!elements.profileWrap.contains(event.target)) {
    elements.profileEntry.setAttribute('aria-expanded', 'false');
    elements.profilePopover.hidden = true;
  }
});

const profileCheck = await checkAuthentication();
if (profileCheck) await loadDocuments();
