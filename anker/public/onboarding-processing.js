import { onboardingCanRetryCloseout, onboardingProcessingState } from '/onboarding-ui.js';

const byId = (id) => document.getElementById(id);
const sessionId = new URLSearchParams(window.location.search).get('session_id')?.trim() || '';
const state = { timer: null, retrying: false, stopped: false };

function setStatus(status, title, description) {
  const indicator = byId('status-indicator');
  const titleElement = byId('status-title');
  const descriptionElement = byId('status-description');
  if (indicator.dataset.state !== status) indicator.dataset.state = status;
  if (titleElement.textContent !== title) titleElement.textContent = title;
  if (descriptionElement.textContent !== description) descriptionElement.textContent = description;
}

function setError(message) {
  const error = byId('page-error');
  error.textContent = message;
  error.hidden = !message;
}

function updateProcessingStep(id, markId, detailId, status, detail) {
  const step = byId(id);
  const mark = byId(markId);
  const copy = byId(detailId);
  if (step) step.dataset.state = status;
  if (mark) mark.textContent = status === 'done' ? '✓' : status === 'active' ? '…' : status === 'failed' ? '!' : '·';
  if (copy) copy.textContent = detail;
}

function renderProcessingSteps(payload, status) {
  const steps = byId('processing-steps');
  const visible = status === 'processing' || status === 'failed';
  steps.hidden = !visible;
  if (!visible) return;

  const session = payload.session && typeof payload.session === 'object' ? payload.session : {};
  const sessionSaved = session.status === 'ended' || Array.isArray(payload.transcript) && payload.transcript.length > 0;
  const closeoutCompleted = payload.onboarding_status === 'completed' || session.closeout_status === 'completed';
  const storyCompletionPending = payload.story_completion_pending === true;
  const failed = status === 'failed';

  updateProcessingStep(
    'processing-step-transcript',
    'processing-step-transcript-mark',
    'processing-step-transcript-detail',
    failed || sessionSaved ? 'done' : 'active',
    failed || sessionSaved ? '已保存，可以放心离开' : '正在确认最后一段字幕',
  );
  updateProcessingStep(
    'processing-step-closeout',
    'processing-step-closeout-mark',
    'processing-step-closeout-detail',
    failed ? 'failed' : closeoutCompleted ? 'done' : sessionSaved ? 'active' : 'pending',
    failed ? '整理遇到问题，可以重新整理' : closeoutCompleted ? '人物档案已经整理好' : sessionSaved ? '正在整理人物档案' : '等待访谈记录保存',
  );
  updateProcessingStep(
    'processing-step-story',
    'processing-step-story-mark',
    'processing-step-story-detail',
    failed ? 'pending' : closeoutCompleted ? 'done' : 'pending',
    failed ? '等待重新整理' : closeoutCompleted ? '人生阶段与故事已经建立' : '等待人物档案完成',
  );
  updateProcessingStep(
    'processing-step-completion',
    'processing-step-completion-mark',
    'processing-step-completion-detail',
    failed ? 'pending' : closeoutCompleted && storyCompletionPending ? 'active' : closeoutCompleted ? 'done' : 'pending',
    failed ? '等待重新整理' : closeoutCompleted && storyCompletionPending ? '正在分析后续主题' : closeoutCompleted ? '本轮分析已经完成' : '等待人生阶段建立',
  );
}

function processingError(payload) {
  const error = payload.processing_error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  return '整理人生档案时遇到问题。访谈记录仍会保留，可以安全重试。';
}

function showPayload(payload) {
  const result = onboardingProcessingState(payload);
  renderProcessingSteps(payload, result);
  if (result === 'completed') {
    window.location.assign(`/onboarding/result?session_id=${encodeURIComponent(sessionId)}`);
    return result;
  }
  if (result === 'failed') {
    const retryable = onboardingCanRetryCloseout(payload);
    setStatus('failed', '整理暂时没有完成', retryable
      ? '访谈记录仍然保留。你可以重试整理，不会重新开始采访。'
      : '最后一轮字幕未能确认完整。访谈记录仍然保留，请返回继续建档后再完成整理。');
    setError(processingError(payload));
    byId('retry-panel').hidden = !retryable;
    byId('continue-panel').hidden = retryable;
    byId('retry-button').disabled = state.retrying;
    return result;
  }
  if (result === 'missing') {
    setStatus('missing', '没有找到这次建档访谈', '请检查链接中的 session_id，或返回继续首次建档。');
    setError('暂时无法读取这次人生档案整理记录。');
    byId('retry-panel').hidden = true;
    byId('continue-panel').hidden = false;
    return result;
  }
  setStatus('processing', '正在生成你的人生地图…', '正在把刚才的访谈整理成人物档案、人生阶段和故事，请稍候。');
  setError('');
  byId('retry-panel').hidden = true;
  byId('continue-panel').hidden = true;
  return result;
}

function schedulePoll(delay = 1500) {
  if (state.stopped || state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    void poll();
  }, delay);
}

async function poll() {
  if (!sessionId) {
    showPayload({});
    return;
  }
  try {
    const response = await fetch(`/api/onboarding/result?session_id=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '暂时无法读取人生档案整理进度。');
    const result = showPayload(payload);
    if (result === 'processing') schedulePoll();
  } catch (error) {
    setStatus('loading', '暂时无法读取整理进度', '请稍候，页面会继续尝试连接。');
    setError(error instanceof Error ? error.message : '暂时无法读取人生档案整理进度。');
    schedulePoll(2500);
  }
}

async function retryCloseout() {
  if (!sessionId || state.retrying) return;
  state.retrying = true;
  byId('retry-button').disabled = true;
  byId('retry-button').textContent = '正在重新整理…';
  setStatus('processing', '正在生成你的人生地图…', '正在继续整理访谈记录，请稍候。');
  try {
    const response = await fetch(`/api/onboarding/sessions/${encodeURIComponent(sessionId)}/closeout`, {
      method: 'POST',
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '无法重新整理，请稍后再试。');
    setError('');
    byId('retry-panel').hidden = true;
    setStatus('processing', '正在重新整理你的人生档案', '访谈记录会继续作为本次建档依据。');
    const result = showPayload(payload);
    if (result !== 'completed') schedulePoll(800);
  } catch (error) {
    setStatus('failed', '整理暂时没有完成', '访谈记录仍然保留。你可以检查提示后重试，不需要重新开始采访。');
    setError(error instanceof Error ? error.message : '无法重新整理，请稍后再试。');
    byId('retry-panel').hidden = false;
  } finally {
    state.retrying = false;
    byId('retry-button').disabled = false;
    byId('retry-button').textContent = '重试整理';
  }
}

byId('retry-button').addEventListener('click', () => void retryCloseout());
window.addEventListener('pagehide', () => {
  state.stopped = true;
  if (state.timer) clearTimeout(state.timer);
}, { once: true });

void poll();
