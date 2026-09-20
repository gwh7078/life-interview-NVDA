import { canMoveBookItem, countIncluded, mergeBookItems, moveBookItem } from './book-model.js';

export function normalizeWorkspace(payload) {
  const availableStories = Array.isArray(payload?.available_stories) ? payload.available_stories : [];
  const book = payload?.book && typeof payload.book === 'object' ? payload.book : null;
  const items = mergeBookItems(payload?.items, availableStories);
  return { book, availableStories, items };
}

if (typeof document !== 'undefined') {
  const elements = {
    shell: document.querySelector('.page-shell'),
    loading: document.querySelector('#book-loading'),
    empty: document.querySelector('#book-empty'),
    flow: document.querySelector('#book-flow'),
    notice: document.querySelector('#book-notice'),
    title: document.querySelector('#book-title'),
    author: document.querySelector('#book-author'),
    coverOptions: document.querySelector('#cover-options'),
    arrangement: document.querySelector('#arrangement-list'),
    deliveryTitle: document.querySelector('#delivery-title-copy'),
    deliveryAuthor: document.querySelector('#delivery-author-copy'),
    deliveryCount: document.querySelector('#delivery-count-copy'),
    previewLayer: document.querySelector('#preview-layer'),
    previewTitle: document.querySelector('#preview-title'),
    previewContent: document.querySelector('#preview-content'),
    demoDialog: document.querySelector('#demo-dialog'),
    demoTitle: document.querySelector('#demo-dialog-title'),
    demoMessage: document.querySelector('#demo-dialog-message'),
  };

  const state = {
    book: null,
    availableStories: [],
    items: [],
    coverStyle: 'paper',
    step: 'information',
    previewOriginStep: 'arrangement',
    busy: false,
  };

  function showNotice(message) {
    elements.notice.textContent = message;
    elements.notice.hidden = !message;
  }

  function clearNotice() { showNotice(''); }

  async function requestJson(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(url, { ...options, headers, cache: 'no-store' });
    let payload = {};
    try { payload = await response.json(); } catch { /* PDF and empty responses are handled by their caller. */ }
    if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
    return payload;
  }

  function findStory(storyId) {
    return state.availableStories.find((story) => story.story_id === storyId) ?? null;
  }

  function syncFormState() {
    if (state.book && elements.title.value === '') elements.title.value = state.book.title || '';
    if (state.book && elements.author.value === '') elements.author.value = state.book.author_name || '';
    if (state.book?.cover_config?.style) state.coverStyle = state.book.cover_config.style;
    for (const option of elements.coverOptions.querySelectorAll('[data-cover-style]')) {
      option.classList.toggle('is-selected', option.dataset.coverStyle === state.coverStyle);
    }
  }

  function renderStepper() {
    const steps = ['information', 'arrangement', 'delivery'];
    const currentIndex = steps.indexOf(state.step);
    for (const button of document.querySelectorAll('[data-step-target]')) {
      const index = steps.indexOf(button.dataset.stepTarget);
      button.classList.toggle('is-active', button.dataset.stepTarget === state.step);
      button.classList.toggle('is-done', index < currentIndex);
    }
  }

  function renderArrangement() {
    const groups = new Map();
    for (const item of [...state.items].sort((a, b) => a.sort_order - b.sort_order)) {
      const story = findStory(item.story_id);
      if (!story) continue;
      const key = story.stage_id || 'unknown';
      if (!groups.has(key)) groups.set(key, { title: story.stage_title || '未命名人生阶段', items: [] });
      groups.get(key).items.push({ item, story });
    }
    elements.arrangement.replaceChildren();
    for (const group of groups.values()) {
      const section = document.createElement('section');
      section.className = 'arrangement-group';
      const heading = document.createElement('h3');
      heading.className = 'arrangement-stage';
      heading.textContent = group.title;
      section.append(heading);
      for (const { item, story } of group.items) {
        const card = document.createElement('article');
        card.className = `arrangement-card${item.included ? '' : ' is-excluded'}`;
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.className = 'arrangement-check'; checkbox.checked = Boolean(item.included);
        checkbox.dataset.action = 'toggle-item'; checkbox.dataset.storyId = item.story_id;
        const copy = document.createElement('div');
        const title = document.createElement('h3'); title.textContent = story.title || '未命名故事';
        const summary = document.createElement('p'); summary.textContent = story.summary || '这段故事还没有摘要。';
        copy.append(title, summary);
        const meta = document.createElement('div'); meta.className = 'arrangement-meta';
        const select = document.createElement('select'); select.className = 'version-select'; select.dataset.action = 'select-version'; select.dataset.storyId = item.story_id;
        for (const documentOption of story.documents ?? []) {
          const option = document.createElement('option'); option.value = documentOption.document_id;
          option.textContent = `V${documentOption.version_number} · ${documentOption.title || '成稿'}`;
          option.selected = documentOption.document_id === item.document_id;
          select.append(option);
        }
        const move = document.createElement('div'); move.className = 'move-buttons';
        for (const [label, delta] of [['↑', -1], ['↓', 1]]) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'move-button'; button.textContent = label;
          button.dataset.action = 'move-item'; button.dataset.storyId = item.story_id; button.dataset.delta = String(delta);
          const itemIndex = state.items.findIndex((entry) => entry.story_id === item.story_id);
          button.disabled = !canMoveBookItem(state.items, itemIndex, delta, state.availableStories);
          move.append(button);
        }
        meta.append(select, move);
        card.append(checkbox, copy, meta);
        section.append(card);
      }
      elements.arrangement.append(section);
    }
    if (!groups.size) {
      const empty = document.createElement('p'); empty.className = 'stage-empty-copy'; empty.textContent = '目前没有可编排的故事。';
      elements.arrangement.append(empty);
    }
  }

  function renderDelivery() {
    elements.deliveryTitle.textContent = elements.title.value.trim() || '我的人生书';
    elements.deliveryAuthor.textContent = `作者：${elements.author.value.trim() || '未填写'}`;
    elements.deliveryCount.textContent = `已收录 ${countIncluded(state.items)} 个故事`;
  }

  function renderStep() {
    renderStepper();
    for (const panel of document.querySelectorAll('[data-step-panel]')) panel.hidden = panel.dataset.stepPanel !== state.step;
    if (state.step === 'information') syncFormState();
    if (state.step === 'arrangement') renderArrangement();
    if (state.step === 'delivery') renderDelivery();
  }

  function readForm() {
    const title = elements.title.value.trim();
    const authorName = elements.author.value.trim();
    if (!title || !authorName) {
      showNotice('请先填写书名和作者。');
      return null;
    }
    if (title.length > 200 || authorName.length > 200) {
      showNotice('书名和作者不能超过 200 个字符。');
      return null;
    }
    return { title, author_name: authorName, cover_config: { style: state.coverStyle } };
  }

  async function saveWorkspace() {
    const details = readForm();
    if (!details) return false;
    state.busy = true;
    try {
      const payload = await requestJson('/api/book', {
        method: 'PUT',
        body: JSON.stringify({
          ...details,
          ...(state.book?.book_id ? { book_id: state.book.book_id } : {}),
          items: state.items.map((item, index) => ({
            story_id: item.story_id,
            document_id: item.document_id,
            included: Boolean(item.included),
            sort_order: index,
          })),
        }),
      });
      const normalized = normalizeWorkspace(payload);
      state.book = normalized.book;
      state.availableStories = normalized.availableStories;
      state.items = normalized.items;
      clearNotice();
      return true;
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '保存人生书失败，请重试。');
      return false;
    } finally {
      state.busy = false;
    }
  }

  function renderPreview(preview) {
    elements.previewTitle.textContent = preview.title || '整本书预览';
    elements.previewContent.replaceChildren();
    const cover = document.createElement('section'); cover.className = 'preview-cover';
    const label = document.createElement('small'); label.textContent = '人生采访局 · 成书';
    const title = document.createElement('h3'); title.textContent = preview.title || '我的人生书';
    const author = document.createElement('p'); author.textContent = `作者：${preview.authorName || '未填写'}`;
    cover.append(label, title, author);
    elements.previewContent.append(cover);
    const toc = document.createElement('section'); toc.className = 'preview-toc';
    const tocTitle = document.createElement('h3'); tocTitle.textContent = '目录'; toc.append(tocTitle);
    for (const chapter of preview.chapters ?? []) { const line = document.createElement('p'); line.textContent = `${chapter.stageTitle} · ${chapter.storyTitle}`; toc.append(line); }
    elements.previewContent.append(toc);
    for (const chapter of preview.chapters ?? []) {
      const section = document.createElement('article'); section.className = 'preview-chapter';
      const stage = document.createElement('small'); stage.textContent = `${chapter.stageTitle} · 成稿版本 ${chapter.documentVersionNumber}`;
      const heading = document.createElement('h3'); heading.textContent = chapter.storyTitle;
      const content = document.createElement('p'); content.textContent = chapter.content || '暂无正文。';
      section.append(stage, heading, content); elements.previewContent.append(section);
    }
  }

  async function openPreview({ updateHistory = true } = {}) {
    if (!(await saveWorkspace()) || !state.book?.book_id) return;
    state.previewOriginStep = state.step;
    state.busy = true;
    try {
      const payload = await requestJson(`/api/book/preview?book_id=${encodeURIComponent(state.book.book_id)}`);
      renderPreview(payload.preview);
      elements.previewLayer.hidden = false;
      if (updateHistory) {
        history.pushState({ bookPreview: true }, '', `/book/preview?book_id=${encodeURIComponent(state.book.book_id)}`);
      }
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '无法打开成书预览。');
    } finally { state.busy = false; }
  }

  function closePreview({ updateHistory = true } = {}) {
    elements.previewLayer.hidden = true;
    state.step = state.previewOriginStep || 'arrangement';
    if (updateHistory && state.book?.book_id) {
      history.replaceState({}, '', `/book?book_id=${encodeURIComponent(state.book.book_id)}`);
    }
    renderStep();
  }

  function openDemo(kind) {
    elements.demoTitle.textContent = kind === 'publisher' ? '出版社出版服务' : '打印纸质书';
    elements.demoMessage.textContent = kind === 'publisher'
      ? '出版社出版服务将在比赛 Demo 中展示，暂不创建真实出版流程。'
      : '打印纸质书将在比赛 Demo 中展示，暂不创建真实订单、支付或物流。';
    if (typeof elements.demoDialog.showModal === 'function') elements.demoDialog.showModal();
    else elements.demoDialog.hidden = false;
  }

  async function changeStep(step) {
    if (state.busy) return;
    if (step === 'arrangement' || step === 'delivery') {
      if (!(await saveWorkspace())) return;
    }
    state.step = step;
    renderStep();
    window.scrollTo(0, 0);
  }

  async function handleAction(target) {
    const action = target.dataset.action;
    if (action === 'to-arrangement') return changeStep('arrangement');
    if (action === 'to-information') return changeStep('information');
    if (action === 'to-delivery') return changeStep('delivery');
    if (action === 'open-preview') return openPreview();
    if (action === 'close-preview') return closePreview();
    if (action === 'export-pdf') {
      if (!(await saveWorkspace()) || !state.book?.book_id) return;
      window.location.href = `/api/book/export.pdf?book_id=${encodeURIComponent(state.book.book_id)}`;
    }
    if (action === 'close-demo') {
      if (typeof elements.demoDialog.close === 'function') elements.demoDialog.close();
      else elements.demoDialog.hidden = true;
    }
  }

  elements.coverOptions.addEventListener('click', (event) => {
    const option = event.target.closest('[data-cover-style]');
    if (!option) return;
    state.coverStyle = option.dataset.coverStyle || 'paper';
    syncFormState();
  });
  elements.arrangement.addEventListener('change', (event) => {
    const target = event.target;
    if (target.dataset.action === 'toggle-item') {
      const item = state.items.find((entry) => entry.story_id === target.dataset.storyId);
      if (item) item.included = target.checked;
      renderArrangement();
    }
    if (target.dataset.action === 'select-version') {
      const item = state.items.find((entry) => entry.story_id === target.dataset.storyId);
      if (item) item.document_id = target.value;
    }
  });
  elements.arrangement.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action="move-item"]');
    if (!target) return;
    const index = state.items.findIndex((entry) => entry.story_id === target.dataset.storyId);
    state.items = moveBookItem(state.items, index, Number(target.dataset.delta), state.availableStories);
    renderArrangement();
  });
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action], [data-step-target], [data-demo]');
    if (!target) return;
    if (target.dataset.stepTarget) return changeStep(target.dataset.stepTarget);
    if (target.dataset.demo) return openDemo(target.dataset.demo);
    return handleAction(target);
  });
  window.addEventListener('popstate', () => {
    if (window.location.pathname === '/book/preview') openPreview({ updateHistory: false });
    else if (!elements.previewLayer.hidden) closePreview({ updateHistory: false });
  });

  async function initialize() {
    try {
      const payload = await requestJson('/api/book');
      const normalized = normalizeWorkspace(payload);
      state.book = normalized.book;
      state.availableStories = normalized.availableStories;
      state.items = normalized.items;
      elements.loading.hidden = true;
      if (!state.availableStories.length) {
        elements.empty.hidden = false;
        return;
      }
      elements.flow.hidden = false;
      syncFormState();
      renderStep();
      if (window.location.pathname === '/book/preview' && state.book?.book_id) {
        state.step = 'delivery';
        await openPreview({ updateHistory: false });
      }
    } catch (error) {
      elements.loading.hidden = true;
      showNotice(error instanceof Error ? error.message : '无法读取人生书数据。');
    }
  }

  initialize();
}
