import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(directory, file), 'utf8');

test('user-facing pages keep provider, model, token, session, and debug metadata behind debug-only UI', () => {
  const interview = read('index.html');
  const result = read('result.html');
  assert.doesNotMatch(interview, /LOCAL TEST|本机测试|本地数据库|继续使用本机旧档案/);
  assert.doesNotMatch(interview, /provider-select|<option value="doubao"/);
  assert.match(interview, /Step-Audio 2 Mini Realtime/);
  assert.match(interview, /id="call-controls"[^>]*hidden/);
  assert.match(result, /id="session-id"[^>]*class="[^"]*debug-only|class="[^"]*debug-only[^"]*"[^>]*id="session-id"/);
  assert.match(result, /id="model-metadata-block"[^>]*class="[^"]*debug-only|class="[^"]*debug-only[^"]*"[^>]*id="model-metadata-block"/);
  assert.doesNotMatch(`${interview}\n${result}`, /(?:api[_ -]?key|access[_ -]?token)\s*[:=]/i);
});

test('realtime UI defaults to Step-Audio and follows an explicitly configured server provider', () => {
  const interview = read('index.html');
  const interviewScript = read('client.js');
  const life = read('life.html');
  const lifeScript = read('life.js');
  assert.doesNotMatch(interview, /<option value="(?:qwen|doubao|stepfun)"/);
  assert.match(interview, /id="provider-label">Step-Audio 2 Mini Realtime/);
  assert.match(interviewScript, /resolveRealtimeProvider\(health\.defaultProvider\)/);
  assert.match(interviewScript, /provider: state\.realtimeProvider/);
  assert.match(interviewScript, /targetSampleRate = state\.realtimeProvider === 'qwen' \? 16000 : 24000/);
  assert.match(interviewScript, /noiseSuppression:\s*true/);
  assert.match(interviewScript, /autoGainControl:\s*false/);
  assert.match(life, /id="profile-popover-phone"/);
  assert.match(lifeScript, /手机号：/);
});

test('call speech state is announced through one dedicated live region', () => {
  const interview = read('index.html');
  assert.match(interview, /id="call-stage"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(interview, /id="call-status"[^>]*data-state="idle"(?![^>]*(?:role="status"|aria-live))/);
});

test('Story precall puts the latest gap under the primary prompt and keeps later gaps secondary', () => {
  const interviewScript = read('client.js');
  assert.match(interviewScript, /const primaryGap = gaps\[0\] \|\| ''/);
  assert.match(interviewScript, /precallTopic\.textContent[\s\S]*primaryGap/);
  assert.match(interviewScript, /primaryGap[\s\S]*gaps\.slice\(1\)/);
  assert.doesNotMatch(interviewScript, /不必重新讲一遍已经说过的内容，我们会接着往下听/);
});

test('manual Story and external contributor ends leave the call UI after the server acknowledges ending', () => {
  const interviewScript = read('client.js');
  assert.match(interviewScript, /message\.type === 'status' && message\.status === 'ending'/);
  assert.match(interviewScript, /state\.interviewType === 'story' && message\.reason === 'user' && state\.sessionId/);
  assert.match(interviewScript, /\/interview\/result\?session_id=/);
  assert.match(interviewScript, /state\.interviewType === 'external_contributor' && message\.reason === 'user' && state\.shareToken/);
  assert.match(interviewScript, /\/share\/story\/.*\?processing=1/);
});

test('the core user path keeps My Life, Story, Documents, and Book entry points', () => {
  const life = read('life.html');
  const story = read('story.html');
  const storyScript = read('story.js');
  const documents = read('documents.html');
  const book = read('book.html');
  assert.match(life, /我的人生/);
  assert.match(life, /href="\/book"/);
  assert.match(story, /故事详情/);
  assert.match(storyScript, /\/stories\/\$\{encodedStoryId\}\/documents/);
  assert.match(documents, /成稿与版本/);
  assert.match(book, /制作我的人生书/);
});

test('My Life and Story use fixed status labels without a progress meter', () => {
  const life = read('life.html');
  const lifeScript = read('life.js');
  const story = read('story.html');
  const storyScript = read('story.js');
  assert.match(life, /id="timeline-list"/);
  assert.match(lifeScript, /status-chip/);
  assert.match(story, /id="story-status-description"/);
  assert.doesNotMatch(story, /progress-track|progress-segment|progress-labels/);
  assert.doesNotMatch(storyScript, /progressTrack|progressSegments|data-progress-step/);
  for (const label of ['资料较少', '正在完善', '已可成稿']) {
    assert.match(`${lifeScript}\n${storyScript}`, new RegExp(label));
  }
});

test('Documents and the reader use the shared design system while preserving generation controls', () => {
  const documents = read('documents.html');
  const document = read('document.html');
  const styles = read('documents.css');
  assert.match(documents, /href="\/ui\.css"/);
  assert.match(document, /href="\/ui\.css"/);
  assert.match(documents, /id="generation-dialog"/);
  for (const style of ['documentary', 'warm', 'restrained', 'literary']) {
    assert.match(documents, new RegExp(`value="${style}"`));
  }
  assert.match(document, /id="document-body"/);
  assert.match(styles, /\.document-body[\s\S]*max-width: 680px/);
  assert.match(styles, /\.generation-dialog[\s\S]*border-radius/);
});

test('all user-facing product pages load the shared design system', () => {
  for (const file of [
    'index.html',
    'result.html',
    'onboarding-processing.html',
    'onboarding-result.html',
    'life.html',
    'story.html',
    'documents.html',
    'document.html',
    'share.html',
    'book.html',
  ]) {
    assert.match(read(file), /href="\/ui\.css"/, `${file} should load ui.css`);
  }
});

test('Book keeps three steps and an independent on-demand Preview layer', () => {
  const book = read('book.html');
  for (const stepId of ['step-information', 'step-arrangement', 'step-delivery']) {
    assert.match(book, new RegExp(`id="${stepId}"`));
  }

  const flowStart = book.indexOf('id="book-flow"');
  const flowEnd = book.indexOf('</section>\n    </main>', flowStart);
  const previewStart = book.indexOf('<div class="preview-layer" id="preview-layer"');
  assert.ok(flowStart >= 0);
  assert.ok(flowEnd > flowStart);
  assert.ok(previewStart > flowEnd, 'Preview must stay outside the three configuration steps');
});


test('Story sharing keeps a simple public contributor surface without internal identity metadata', () => {
  const story = read('story.html');
  const storyScript = read('story.js');
  const share = read('share.html');
  const shareScript = read('share.js');
  const interview = read('index.html');
  const interviewScript = read('client.js');

  assert.match(story, /id="share-story-button"/);
  assert.match(story, /分享给亲友/);
  assert.match(story, /id="story-share-relationship"/);
  assert.match(storyScript, /生成 7 天分享链接/);
  assert.match(storyScript, /同一个人/);

  assert.match(share, /亲友补充采访/);
  assert.match(share, /id="story-summary"/);
  assert.match(share, /id="story-gaps"/);
  assert.match(share, /id="interview-link"/);
  assert.match(share, /id="processing-note"/);
  assert.match(share, /id="share-retry-closeout"/);
  assert.match(share, /href="\/ui\.css"/);
  assert.doesNotMatch(share, /user[_ -]?id|share[_ -]?id|session[_ -]?id|provider|model/i);
  assert.doesNotMatch(shareScript, /contributor_summary|user_id|share_id|session_id/);

  assert.match(interviewScript, /external_contributor/);
  assert.match(interviewScript, /从你的视角补充这段故事/);
  assert.match(interviewScript, /share_token=/);
  assert.match(interview, /id="external-closeout-retry-button"/);
  assert.match(interviewScript, /externalCloseoutCompleted/);
  assert.match(interviewScript, /retry-closeout/);
});
