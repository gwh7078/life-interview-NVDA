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
  content: document.querySelector('#document-content'),
  documentsLink: document.querySelector('#documents-link'),
  footerDocumentsLink: document.querySelector('#footer-documents-link'),
  documentTitle: document.querySelector('#document-title'),
  documentVersion: document.querySelector('#document-version'),
  documentCreatedAt: document.querySelector('#document-created-at'),
  storyReference: document.querySelector('#story-reference'),
  revisionNotice: document.querySelector('#revision-notice'),
  documentBody: document.querySelector('#document-body'),
  reviseButton: document.querySelector('#revise-button'),
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

const route = readRoute();
const state = {
  storyId: route?.storyId ?? null,
  documentId: route?.documentId ?? null,
  document: null,
  story: null,
  dataLoaded: false,
  isGenerating: false,
  returnFocus: null,
};

function readRoute() {
  const match = window.location.pathname.match(/^\/stories\/([^/]+)\/documents\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    return { storyId: decodeURIComponent(match[1]), documentId: decodeURIComponent(match[2]) };
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

function storyDocumentsPath() {
  return `/stories/${encodeURIComponent(state.storyId)}/documents`;
}

function getVersionNumber(value) {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : null;
}

function renderDocument() {
  const detail = state.document;
  const title = typeof detail.title === 'string' && detail.title.trim() ? detail.title.trim() : '未命名成稿';
  const version = getVersionNumber(detail.version_number);
  elements.documentTitle.textContent = title;
  elements.documentVersion.textContent = version === null ? '成稿版本' : `V${version}`;
  elements.documentCreatedAt.dateTime = typeof detail.created_at === 'string' ? detail.created_at : '';
  elements.documentCreatedAt.textContent = `生成于 ${formatDate(detail.created_at)}`;
  elements.storyReference.textContent = '正文只读。再次润色会创建新版本，保留当前版本。';
  const canRevise = state.story?.status === 'complete';
  elements.revisionNotice.hidden = canRevise;
  elements.revisionNotice.textContent = '继续完成访谈后，就可以基于这个版本创建新的成稿。当前版本仍可阅读。';
  elements.reviseButton.hidden = !canRevise;
  elements.documentBody.textContent = typeof detail.content === 'string' ? detail.content : '';
  elements.documentsLink.href = storyDocumentsPath();
  elements.footerDocumentsLink.href = storyDocumentsPath();
  elements.loadingState.hidden = true;
  elements.content.hidden = false;
  state.dataLoaded = true;
}

async function loadDocument() {
  const hasSnapshot = state.dataLoaded;
  hidePageError();
  elements.loadingState.hidden = hasSnapshot;
  if (!state.storyId || !state.documentId) {
    elements.loadingState.hidden = true;
    showPageError('成稿地址无效，请从成稿版本列表重新打开。');
    return;
  }
  try {
    const storyId = encodeURIComponent(state.storyId);
    const documentId = encodeURIComponent(state.documentId);
    const [payload, storyPayload] = await Promise.all([
      requestJson(`/api/stories/${storyId}/documents/${documentId}`),
      requestJson(`/api/stories/${storyId}`),
    ]);
    if (!payload.document || payload.document.document_id !== state.documentId || payload.document.story_id !== state.storyId || !storyPayload.story) {
      throw new Error('找不到这个成稿版本。');
    }
    state.document = payload.document;
    state.story = storyPayload.story;
    renderDocument();
  } catch (error) {
    elements.loadingState.hidden = true;
    showPageError(error instanceof Error ? error.message : '读取成稿失败，请稍后重试。');
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

function openGeneration(trigger = document.activeElement) {
  if (state.isGenerating || elements.dialog.open || !state.document) return;
  state.returnFocus = trigger instanceof HTMLElement ? trigger : null;
  const version = getVersionNumber(state.document.version_number);
  elements.generationTitle.textContent = '再次润色';
  elements.generationContext.textContent = version === null
    ? '将基于当前成稿并参考故事的访谈资料，创建一个新版本。历史版本会保留。'
    : `将基于 V${version} 并参考故事的访谈资料，创建一个新的成稿版本。历史版本会保留。`;
  selectGenerationStyle();
  elements.generationInstruction.value = '';
  elements.submitGenerationButton.textContent = '开始润色';
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
  elements.submitGenerationButton.textContent = isBusy ? '正在整理成稿…' : '开始润色';
}

async function submitGeneration(event) {
  event.preventDefault();
  if (state.isGenerating) return;
  setGenerationFeedback('');
  setGenerationBusy(true);
  try {
    const payload = await requestJson(`/api/stories/${encodeURIComponent(state.storyId)}/documents/generate`, {
      method: 'POST',
      body: JSON.stringify({
        style: selectedGenerationStyle(),
        user_instruction: elements.generationInstruction.value.trim(),
        base_document_id: state.documentId,
      }),
    });
    const newDocumentId = typeof payload.document?.document_id === 'string' ? payload.document.document_id : null;
    if (newDocumentId) {
      window.location.assign(`${storyDocumentsPath()}/${encodeURIComponent(newDocumentId)}`);
      return;
    }
    // The request succeeded, so return to the refreshed list instead of inviting a duplicate generation.
    window.location.assign(storyDocumentsPath());
  } catch (error) {
    setGenerationFeedback(error instanceof Error ? error.message : '润色失败，请检查网络后手动重试。');
    setGenerationBusy(false);
    elements.submitGenerationButton.focus();
  }
}

function toggleProfile() {
  const isOpen = elements.profileEntry.getAttribute('aria-expanded') === 'true';
  elements.profileEntry.setAttribute('aria-expanded', String(!isOpen));
  elements.profilePopover.hidden = isOpen;
}

elements.retryButton.addEventListener('click', loadDocument);
elements.reviseButton.addEventListener('click', (event) => openGeneration(event.currentTarget));
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
if (profileCheck) await loadDocument();
