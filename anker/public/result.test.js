import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';

const directory = path.dirname(fileURLToPath(import.meta.url));
const resultScript = readFileSync(path.join(directory, 'result.js'), 'utf8');
const resultHtml = readFileSync(path.join(directory, 'result.html'), 'utf8');
const elementIds = [...resultHtml.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);

class FakeElement {
  constructor(tagName = 'div', idRegistry = null) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.attributes = {};
    this.handlers = {};
    this.className = '';
    this.textContent = '';
    this._id = '';
    Object.defineProperty(this, 'id', {
      get: () => this._id,
      set: (value) => {
        this._id = value;
        if (value && idRegistry) idRegistry.set(value, this);
      },
    });
    this.classList = {
      toggle: (name, enabled) => {
        const tokens = new Set(this.className.split(/\s+/).filter(Boolean));
        if (enabled) tokens.add(name);
        else tokens.delete(name);
        this.className = [...tokens].join(' ');
      },
    };
  }

  append(...children) {
    for (const child of children) {
      if (child && typeof child === 'object') child.parentElement = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  addEventListener(type, handler) {
    this.handlers[type] = handler;
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  click() {
    if (!this.disabled) return this.handlers.click?.();
  }
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function createPage(responses) {
  const elements = new Map(elementIds.map((id) => [id, new FakeElement()]));
  const statusCard = new FakeElement('section');
  const timers = new Map();
  const calls = [];
  const navigations = [];
  const windowHandlers = new Map();
  let nextTimerId = 1;
  const window = {
    location: { search: '?session_id=session-123', assign(value) { navigations.push(value); } },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(type, handler) { windowHandlers.set(type, handler); },
  };
  const document = {
    getElementById(id) { return elements.get(id) ?? null; },
    createElement(tagName) { return new FakeElement(tagName, elements); },
    querySelector(selector) {
      assert.equal(selector, '.status-card');
      return statusCard;
    },
  };
  const fetch = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    assert.ok(next, `Unexpected fetch: ${options.method} ${url}`);
    return next;
  };
  vm.runInNewContext(resultScript, { document, window, fetch, URLSearchParams });

  return {
    elements,
    statusCard,
    timers,
    calls,
    navigations,
    windowHandlers,
    async settle() { await new Promise((resolve) => setImmediate(resolve)); },
    fireWindowEvent(type) { windowHandlers.get(type)?.(); },
    async fireNextTimer() {
      const [id, timer] = timers.entries().next().value ?? [];
      assert.ok(timer, 'Expected a scheduled poll');
      timers.delete(id);
      await timer.callback();
    },
  };
}

function processingResult() {
  return {
    status: 'ended',
    closeoutStatus: 'processing',
    session: { session_id: 'session-123', status: 'ended', closeout_status: 'processing' },
    transcript: [],
  };
}

test('processing stage comes from the result DTO and stays stable across polls', async () => {
  const page = createPage([
    response(processingResult()),
    response(processingResult()),
    response(processingResult()),
  ]);
  await page.settle();

  assert.equal(page.elements.has('cancel-button'), false);
  assert.equal(page.elements.get('processing-notice').hidden, false);
  assert.equal(page.elements.get('processing-stage').hidden, false);
  assert.equal(page.elements.get('processing-stage-text').textContent, '正在整理本次访谈');
  assert.equal(page.elements.get('status-indicator').dataset.state, 'processing');
  assert.equal(page.elements.get('finish-button').disabled, false);
  assert.equal(page.elements.get('finish-button').textContent, '先回到我的人生');
  assert.doesNotMatch([
    page.elements.get('status-title').textContent,
    page.elements.get('status-description').textContent,
    page.elements.get('processing-stage-text').textContent,
  ].join(' '), /\d+%/);

  await page.fireNextTimer();
  assert.equal(page.elements.get('processing-stage-text').textContent, '正在整理本次访谈');
  await page.fireNextTimer();
  assert.equal(page.elements.get('processing-stage-text').textContent, '正在整理本次访谈');
  assert.equal(page.calls.length, 3);
  assert.ok(page.calls.every(({ options }) => options.method === 'GET'));

  page.fireWindowEvent('pagehide');
  assert.equal(page.timers.size, 0, 'leaving the page only clears the pending poll');
  await page.elements.get('finish-button').click();
  assert.deepEqual(page.navigations, ['/my-life']);
  assert.equal(page.calls.length, 3, 'leaving the page does not call a closeout cancel endpoint');
});

test('result stage distinguishes transcript saving from Closeout and completion', async () => {
  const savingPage = createPage([response({
    status: 'processing',
    session: { session_id: 'session-123', status: 'active' },
    transcript: [],
  })]);
  await savingPage.settle();
  assert.equal(savingPage.elements.get('processing-stage-text').textContent, '正在保存访谈记录');

  const completionPage = createPage([
    response({
      status: 'ended', closeoutStatus: 'completed', storyCompletionPending: true,
      session: { session_id: 'session-123', status: 'ended', closeout_status: 'completed' },
      transcript: [],
    }),
    response({
      status: 'ended', closeoutStatus: 'completed', storyCompletionPending: false,
      session: { session_id: 'session-123', status: 'ended', closeout_status: 'completed' },
      transcript: [],
    }),
  ]);
  await completionPage.settle();
  assert.equal(completionPage.elements.get('processing-stage-text').textContent, '正在更新故事状态');
  assert.equal(completionPage.elements.get('status-indicator').dataset.state, 'processing');

  await completionPage.fireNextTimer();
  assert.equal(completionPage.elements.get('processing-stage').hidden, true);
  assert.equal(completionPage.elements.get('status-indicator').dataset.state, 'completed');
  assert.equal(completionPage.elements.get('status-title').textContent, '访谈整理已完成');
});

test('completed and ordinary failed layouts keep their existing controls without a cancel control', async () => {
  const completedPage = createPage([response({
    ...processingResult(),
    status: 'completed',
    closeoutStatus: 'completed',
  })]);
  await completedPage.settle();
  assert.equal(completedPage.elements.has('cancel-button'), false);
  assert.equal(completedPage.elements.get('processing-notice').hidden, true);
  assert.equal(completedPage.elements.get('status-title').textContent, '访谈整理已完成');

  const failedPage = createPage([response({
    ...processingResult(),
    closeoutStatus: 'failed',
    errorCode: 'MODEL_TIMEOUT',
    retryable: true,
  })]);
  await failedPage.settle();
  assert.equal(failedPage.elements.get('status-title').textContent, '访谈整理未完成');
  assert.equal(failedPage.elements.get('retry-panel').hidden, false);
  assert.equal(failedPage.elements.has('cancel-button'), false);
  assert.equal(failedPage.elements.get('processing-notice').hidden, true);
});

test('completed result shows Story summaries and Transcript without a source-quote section', async () => {
  const message = {
    message_id: 'msg-user-current',
    role: 'user',
    text: '我在南京组织过一次社区义卖。',
    timestamp: '2026-09-13T03:00:00.000Z',
  };
  const page = createPage([response({
    status: 'ended',
    closeoutStatus: 'completed',
    session: { session_id: 'session-123', status: 'ended', closeout_status: 'completed' },
    story: {
      story_id: 'story-123', title: '一次社区义卖', summary: '我在南京组织了一次社区义卖。',
    },
    newStories: [{
      story_id: 'story-456', title: '陪母亲术后康复', summary: '2019年我陪母亲做手术康复。',
      stage_title: '家庭生活', source_message_ids: ['msg-user-current'],
    }],
    currentStorySourceMessageIds: ['msg-user-current'],
    modelMetadata: {
      provider: 'volcengine-agent-plan', model: 'deepseek-v4-flash', latency_ms: 10658,
      usage: { prompt_tokens: 1414, completion_tokens: 284, total_tokens: 1698 }, repair_attempt_count: 0,
    },
    transcript: [message],
  })]);
  await page.settle();

  assert.doesNotMatch(resultHtml, /证据回溯|来源原话|sources-list/);
  assert.equal(page.elements.has('sources-list'), false);
  assert.equal(page.elements.get('story-title').textContent, '一次社区义卖');
  assert.equal(page.elements.get('story-summary').textContent, '我在南京组织了一次社区义卖。');
  assert.equal(page.elements.get('new-stories-list').children.length, 1);
  assert.match(page.elements.get('new-stories-list').children[0].children[0].textContent, /陪母亲术后康复/);
  assert.equal(page.elements.get('transcript-list').children.length, 1, 'the full Transcript remains available');
  assert.equal(page.elements.get('status-indicator').dataset.state, 'completed');
  await page.elements.get('finish-button').click();
  assert.deepEqual(page.navigations, ['/my-life']);
});

test('result completion without a primary Story returns to My Life', async () => {
  const page = createPage([response({
    status: 'ended',
    closeoutStatus: 'completed',
    session: { session_id: 'session-123', status: 'ended', closeout_status: 'completed' },
    transcript: [],
  })]);
  await page.settle();
  await page.elements.get('finish-button').click();
  assert.deepEqual(page.navigations, ['/my-life']);
});

test('completed Closeout keeps a processing spinner while Story Completion runs and still allows leaving', async () => {
  const page = createPage([
    response({
      status: 'ended', closeoutStatus: 'completed', storyCompletionPending: true,
      session: { session_id: 'session-123', status: 'ended', closeout_status: 'completed' },
      story: { story_id: 'story-123', title: '一次社区义卖', summary: '故事摘要' },
      transcript: [],
    }),
    response({
      status: 'ended', closeoutStatus: 'completed', storyCompletionPending: false,
      session: { session_id: 'session-123', status: 'ended', closeout_status: 'completed' },
      story: { story_id: 'story-123', title: '一次社区义卖', summary: '故事摘要' },
      transcript: [],
    }),
  ]);
  await page.settle();

  const finishButton = page.elements.get('finish-button');
  assert.equal(page.elements.get('status-indicator').dataset.state, 'processing');
  assert.equal(page.elements.get('processing-notice').hidden, false);
  assert.equal(finishButton.disabled, false);
  assert.equal(finishButton.textContent, '先回到我的人生');
  assert.match(page.elements.get('status-description').textContent, /正在更新故事状态/);
  assert.equal(page.timers.size, 1, 'the result page keeps polling while Completion runs');
  await finishButton.click();
  assert.deepEqual(page.navigations, ['/my-life']);
  assert.equal(page.timers.size, 0, 'leaving the page stops further result polling');
});

test('pending and running display summary loading; failed and error statuses stop the spinner', async () => {
  for (const closeoutStatus of ['pending', 'running']) {
    const page = createPage([response({
      ...processingResult(),
      closeoutStatus,
      session: { session_id: 'session-123', status: 'ended', closeout_status: closeoutStatus },
    })]);
    await page.settle();
    assert.equal(page.elements.get('status-title').textContent, '正在总结本次对话…');
    assert.equal(page.elements.get('status-indicator').dataset.state, 'processing');
    assert.equal(page.elements.get('processing-notice').hidden, false);
    assert.equal(page.elements.has('cancel-button'), false);
    assert.equal(page.timers.size, 1);
  }

  for (const closeoutStatus of ['failed', 'error']) {
    const page = createPage([response({
      ...processingResult(),
      closeoutStatus,
      errorCode: 'MODEL_TIMEOUT',
      retryable: true,
      session: { session_id: 'session-123', status: 'ended', closeout_status: closeoutStatus },
    })]);
    await page.settle();
    assert.equal(page.elements.get('status-title').textContent, '访谈整理未完成');
    assert.equal(page.elements.get('status-indicator').dataset.state, 'failed');
    assert.equal(page.elements.get('processing-notice').hidden, true);
    assert.equal(page.elements.has('cancel-button'), false);
    assert.equal(page.timers.size, 0);
  }
});
