import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';

const directory = path.dirname(fileURLToPath(import.meta.url));
const shareScript = readFileSync(path.join(directory, 'share.js'), 'utf8');
const shareHtml = readFileSync(path.join(directory, 'share.html'), 'utf8');
const elementIds = [...shareHtml.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);

class FakeElement {
  constructor() {
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.handlers = {};
    this.children = [];
    this.textContent = '';
  }

  addEventListener(type, handler) { this.handlers[type] = handler; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
}

async function loadShareStory(storyStatus) {
  const elements = new Map(elementIds.map((id) => [id, new FakeElement()]));
  const payload = {
    story: { title: '一段故事', status: storyStatus },
    relationship: 'daughter',
    owner_name: '故事主人',
    expires_at: '2026-09-30T00:00:00.000Z',
  };
  const window = {
    location: { pathname: '/share/story/share-token', search: '', href: 'http://localhost/share/story/share-token' },
    history: { replaceState() {} },
    setTimeout() {},
  };
  const document = {
    querySelector(selector) {
      assert.match(selector, /^#/);
      return elements.get(selector.slice(1)) ?? null;
    },
    createElement() { return new FakeElement(); },
  };

  vm.runInNewContext(shareScript, {
    document,
    window,
    fetch: async () => ({ ok: true, async json() { return payload; } }),
    URL,
    URLSearchParams,
    Date,
  });
  await new Promise((resolve) => setImmediate(resolve));
  return elements.get('story-status');
}

test('share story status uses a known style state and hides unsupported values', async () => {
  for (const [value, label] of [
    ['pending', '资料较少'],
    ['interviewing', '正在完善'],
    ['complete', '已可成稿'],
  ]) {
    const status = await loadShareStory(value);
    assert.equal(status.dataset.status, value);
    assert.equal(status.textContent, label);
    assert.equal(status.hidden, false);
  }

  const unsupported = await loadShareStory('unexpected');
  assert.equal(unsupported.dataset.status, '');
  assert.equal(unsupported.textContent, '');
  assert.equal(unsupported.hidden, true);
});
