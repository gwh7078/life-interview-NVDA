const loading = document.querySelector('#loading');
const errorCard = document.querySelector('#error');
const errorMessage = document.querySelector('#error-message');
const content = document.querySelector('#content');
const inviteCopy = document.querySelector('#invite-copy');
const title = document.querySelector('#story-title');
const status = document.querySelector('#story-status');
const summary = document.querySelector('#story-summary');
const gapsSection = document.querySelector('#gaps-section');
const gaps = document.querySelector('#story-gaps');
const continuityNote = document.querySelector('#continuity-note');
const processingNote = document.querySelector('#processing-note');
const completedNote = document.querySelector('#completed-note');
const failedNote = document.querySelector('#failed-note');
const retryCloseoutButton = document.querySelector('#share-retry-closeout');
const interviewLink = document.querySelector('#interview-link');
const expiresCopy = document.querySelector('#expires-copy');

const relationshipLabels = {
  wife: '妻子',
  husband: '丈夫',
  daughter: '女儿',
  son: '儿子',
  father: '父亲',
  mother: '母亲',
  sibling: '兄弟姐妹',
  friend: '朋友',
  classmate: '同学',
  colleague: '同事',
  other: '亲友',
};

const statusLabels = {
  pending: '资料较少',
  interviewing: '正在完善',
  complete: '已可成稿',
};

function shareToken() {
  const match = window.location.pathname.match(/^\/share\/story\/([^/]+)\/?$/);
  return match ? match[1] : '';
}

function showError(message) {
  loading.hidden = true;
  content.hidden = true;
  errorCard.hidden = false;
  errorMessage.textContent = message || '链接可能已经过期或被撤销。';
}

function closeoutView(payload) {
  const params = new URLSearchParams(window.location.search);
  const processingRequested = params.get('processing') === '1';
  const completedRequested = params.get('completed') === '1';
  const closeoutStatus = payload.contributor_closeout_status;
  const sessionStatus = payload.contributor_session_status;
  const completed = completedRequested || (processingRequested && closeoutStatus === 'completed');
  const failed = processingRequested && closeoutStatus === 'failed';
  const processing = processingRequested && !completed && !failed
    && (sessionStatus === 'active' || closeoutStatus === 'pending' || closeoutStatus === 'processing' || !closeoutStatus);

  processingNote.hidden = !processing;
  completedNote.hidden = !completed;
  failedNote.hidden = !failed;
  if (completed && processingRequested) {
    const next = new URL(window.location.href);
    next.searchParams.delete('processing');
    next.searchParams.set('completed', '1');
    window.history.replaceState(null, '', `${next.pathname}${next.search}`);
  }
  return { processing, completed, failed };
}

async function fetchSharePayload(token) {
  const response = await fetch(`/api/public/story-share/${encodeURIComponent(token)}`, { cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '该分享链接已不可用。');
  return payload;
}

async function pollCloseout(token) {
  try {
    const payload = await fetchSharePayload(token);
    const view = closeoutView(payload);
    continuityNote.hidden = payload.has_previous_interview !== true;
    if (view.processing) {
      window.setTimeout(() => void pollCloseout(token), 1_000);
    }
  } catch (error) {
    processingNote.hidden = true;
    failedNote.hidden = false;
  }
}

async function load() {
  const token = shareToken();
  if (!token) {
    showError('分享链接格式不正确。');
    return;
  }
  try {
    const payload = await fetchSharePayload(token);

    const story = payload.story || {};
    const relationship = relationshipLabels[payload.relationship] || '亲友';
    inviteCopy.textContent = payload.owner_name
      ? `${payload.owner_name} 邀请你以「${relationship}」的视角，补充这段人生故事。`
      : `有人邀请你以「${relationship}」的视角，补充这段人生故事。`;
    title.textContent = story.title || '一段人生故事';
    const normalizedStatus = ['pending', 'interviewing', 'complete'].includes(story.status) ? story.status : '';
    status.dataset.status = normalizedStatus;
    status.textContent = statusLabels[normalizedStatus] || '';
    status.hidden = !normalizedStatus;
    summary.textContent = story.summary || '这段故事还没有整理出摘要，你可以从自己记得最清楚的地方开始补充。';

    const storyGaps = Array.isArray(story.gaps)
      ? story.gaps.filter((item) => typeof item === 'string' && item.trim()).slice(0, 3)
      : [];
    gaps.replaceChildren();
    for (const gap of storyGaps) {
      const item = document.createElement('li');
      item.textContent = gap;
      gaps.append(item);
    }
    gapsSection.hidden = storyGaps.length === 0;

    continuityNote.hidden = payload.has_previous_interview !== true;
    const view = closeoutView(payload);
    interviewLink.href = `/interview?share_token=${encodeURIComponent(token)}`;

    const expiresAt = new Date(payload.expires_at);
    expiresCopy.textContent = Number.isNaN(expiresAt.getTime())
      ? '这个链接将在创建 7 天后失效。'
      : `链接有效至 ${expiresAt.toLocaleString('zh-CN', { hour12: false })}`;

    loading.hidden = true;
    errorCard.hidden = true;
    content.hidden = false;
    if (view.processing) window.setTimeout(() => void pollCloseout(token), 1_000);
  } catch (error) {
    showError(error instanceof Error ? error.message : '无法读取这段故事。');
  }
}

retryCloseoutButton?.addEventListener('click', async () => {
  const token = shareToken();
  if (!token) return;
  retryCloseoutButton.disabled = true;
  retryCloseoutButton.textContent = '重新整理中…';
  failedNote.hidden = true;
  processingNote.hidden = false;
  try {
    const response = await fetch(
      `/api/public/story-share/${encodeURIComponent(token)}/retry-closeout`,
      { method: 'POST' },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok && response.status !== 202) {
      throw new Error(payload.error || '重新整理失败。');
    }
    const next = new URL(window.location.href);
    next.searchParams.delete('completed');
    next.searchParams.set('processing', '1');
    window.history.replaceState(null, '', `${next.pathname}${next.search}`);
    window.setTimeout(() => void pollCloseout(token), response.status === 202 ? 1_000 : 0);
  } catch {
    processingNote.hidden = true;
    failedNote.hidden = false;
  } finally {
    retryCloseoutButton.disabled = false;
    retryCloseoutButton.textContent = '重新整理';
  }
});

void load();
