import assert from 'node:assert/strict';
import test from 'node:test';

import { createTextDisclosure } from './text-disclosure.js';

class FakeClassList {
  #classes = new Set();

  add(name) { this.#classes.add(name); }

  remove(name) { this.#classes.delete(name); }

  toggle(name, force) {
    const next = force === undefined ? !this.#classes.has(name) : Boolean(force);
    if (next) this.#classes.add(name);
    else this.#classes.delete(name);
    return next;
  }

  contains(name) { return this.#classes.has(name); }
}

class FakeElement {
  #listeners = new Map();

  constructor(text, fullHeight, collapsedHeight) {
    this.textContent = text;
    this.hidden = false;
    this.classList = new FakeClassList();
    this.attributes = new Map();
    this.fullHeight = fullHeight;
    this.collapsedHeight = collapsedHeight;
  }

  get scrollHeight() { return this.fullHeight; }

  get clientHeight() { return this.classList.contains('is-collapsed') ? this.collapsedHeight : this.fullHeight; }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }

  getAttribute(name) { return this.attributes.get(name); }

  addEventListener(type, listener) { this.#listeners.set(type, listener); }

  click() { this.#listeners.get('click')?.(); }
}

test('text disclosure collapses overflowing copy and toggles its accessible state', () => {
  const content = new FakeElement('一段足够长的故事摘要', 160, 96);
  const toggle = new FakeElement('', 0, 0);

  createTextDisclosure({ content, toggle });

  assert.equal(toggle.hidden, false);
  assert.equal(content.classList.contains('is-collapsed'), true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.textContent, '展开全文');

  toggle.click();
  assert.equal(content.classList.contains('is-collapsed'), false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.textContent, '收起');

  toggle.click();
  assert.equal(content.classList.contains('is-collapsed'), true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});

test('text disclosure hides itself for copy that fits the preview', () => {
  const content = new FakeElement('短摘要', 32, 96);
  const toggle = new FakeElement('', 0, 0);

  createTextDisclosure({ content, toggle });

  assert.equal(toggle.hidden, true);
  assert.equal(content.classList.contains('is-collapsed'), false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});

test('refresh resets an expanded disclosure when replacement copy fits', () => {
  const content = new FakeElement('长摘要', 160, 96);
  const toggle = new FakeElement('', 0, 0);
  const disclosure = createTextDisclosure({ content, toggle });

  toggle.click();
  content.textContent = '短摘要';
  content.fullHeight = 32;
  disclosure.refresh();

  assert.equal(toggle.hidden, true);
  assert.equal(content.classList.contains('is-collapsed'), false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});
