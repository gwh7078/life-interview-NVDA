import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(directory, file), 'utf8');

test('page styles reuse shared tokens and exact shared component rules', () => {
  const storyCss = read('story.css');
  const lifeCss = read('life.css');
  const documentsCss = read('documents.css');
  const shareCss = read('share.css');
  for (const css of [storyCss, lifeCss]) {
    assert.doesNotMatch(css, /--(?:bg|paper|ink|muted|line):/);
    assert.doesNotMatch(css, /var\(--green\)/);
    assert.doesNotMatch(css, /\.loading-state\s*\{/);
    assert.doesNotMatch(css, /\.profile-entry\s*\{/);
    assert.doesNotMatch(css, /\.button\s*\{[^}]*\bdisplay\s*:/s);
    assert.doesNotMatch(css, /\.button-primary\s*\{[^}]*\bbackground\s*:/s);
    assert.doesNotMatch(css, /\.status-chip\s*\{/);
  }
  assert.doesNotMatch(documentsCss, /\.profile-entry(?:\s|\{|:)|\.panel\s*\{/);
  assert.doesNotMatch(documentsCss, /\.text-field\s*\{/);
  assert.doesNotMatch(documentsCss, /\.button\s*\{[^}]*\bdisplay\s*:/s);
  assert.match(documentsCss, /\.page-notice\s*\{[^}]*margin-bottom: 12px/s);
  assert.match(shareCss, /\.status-chip\s*\{\s*flex: none;\s*margin-top: 7px;\s*\}/);
  assert.match(read('story.html'), /class="profile-wrap profile-wrap-compact"/);
  assert.match(read('life.html'), /class="profile-wrap profile-wrap-compact"/);
  assert.match(read('ui.css'), /\.profile-wrap-compact \.profile-entry/);
});
