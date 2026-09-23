(() => {
  const byId = (id) => document.getElementById(id);
  const query = new URLSearchParams(window.location.search);
  const sessionId = query.get('session_id')?.trim() || '';
  if (query.get('debug') === '1') document.body?.classList?.add('debug-mode');
  const state = {
    pollTimer: null,
    lastPayload: null,
    isRetrying: false,
  };

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function pick(object, ...keys) {
    if (!isObject(object)) return undefined;
    for (const key of keys) {
      if (object[key] !== undefined && object[key] !== null) return object[key];
    }
    return undefined;
  }

  function make(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function resolveData(payload) {
    const source = isObject(payload) ? payload : {};
    const session = isObject(source.session) ? source.session : {};
    const closeoutStatus = pick(source, 'closeoutStatus', 'closeout_status') ?? session.closeout_status;
    return {
      session,
      story: isObject(source.story) ? source.story : {},
      transcript: Array.isArray(source.transcript) ? source.transcript : [],
      newStories: Array.isArray(source.newStories) ? source.newStories : [],
      metadata: isObject(source.modelMetadata) ? source.modelMetadata : null,
      status: typeof closeoutStatus === 'string' ? closeoutStatus.toLowerCase() : '',
      errorCode: typeof source.errorCode === 'string' ? source.errorCode : '',
      error: typeof source.error === 'string' ? source.error : '',
      retryable: source.retryable === true,
      storyCompletionPending: source.storyCompletionPending === true,
      source,
    };
  }

  function normalizeStatus(data) {
    if (data.errorCode === 'TRANSCRIPT_EMPTY') return 'empty';
    if (['processing', 'pending', 'running'].includes(data.status)) return 'processing';
    if (data.status === 'completed' || data.status === 'empty') return data.status;
    if (data.status === 'failed' || data.status === 'error') return 'failed';
    if (['ended', 'processing', 'active'].includes(data.session.status)) return 'processing';
    if (data.session.status === 'failed' || data.session.status === 'error') return 'failed';
    return 'empty';
  }

  function deriveProcessingStage(data, status) {
    if (status !== 'processing') return '';
    if (data.status === 'completed' && data.storyCompletionPending) return '正在更新故事状态';
    if (data.status === 'completed') return '访谈整理已完成';
    if (['ended', 'processing', 'completed'].includes(data.session.status)
      || ['pending', 'processing', 'running'].includes(data.status)) return '正在整理本次访谈';
    return '正在保存访谈记录';
  }

  function updateProcessingStage(status, data) {
    const processingStage = byId('processing-stage');
    const processing = status === 'processing';
    setVisible(processingStage, processing);
    if (!processing) return;
    byId('processing-stage-text').textContent = deriveProcessingStage(data, status);
  }

  function updateProcessingStep(id, markId, detailId, status, detail) {
    const step = byId(id);
    const mark = byId(markId);
    const copy = byId(detailId);
    if (step) step.dataset.state = status;
    if (mark) mark.textContent = status === 'done' ? '✓' : status === 'active' ? '…' : status === 'failed' ? '!' : '·';
    if (copy) copy.textContent = detail;
  }

  function renderProcessingSteps(data, status) {
    const visible = status === 'processing' || status === 'failed';
    setVisible(byId('processing-steps'), visible);
    if (!visible) return;

    const sessionSaved = ['ended', 'processing', 'completed'].includes(data.session.status)
      || data.transcript.length > 0;
    const closeoutCompleted = data.status === 'completed';
    const storyCompletionPending = data.storyCompletionPending;
    const failed = status === 'failed';

    updateProcessingStep(
      'processing-step-transcript',
      'processing-step-transcript-mark',
      'processing-step-transcript-detail',
      sessionSaved ? 'done' : 'active',
      sessionSaved ? '已保存，可以放心离开' : '正在确认最后一段字幕',
    );
    updateProcessingStep(
      'processing-step-closeout',
      'processing-step-closeout-mark',
      'processing-step-closeout-detail',
      failed ? 'failed' : closeoutCompleted ? 'done' : sessionSaved ? 'active' : 'pending',
      failed ? '整理遇到问题，可以重新整理' : closeoutCompleted ? '摘要已经整理好' : sessionSaved ? '正在提取故事摘要' : '等待访谈记录保存',
    );
    updateProcessingStep(
      'processing-step-story',
      'processing-step-story-mark',
      'processing-step-story-detail',
      failed ? 'pending' : closeoutCompleted ? 'done' : 'pending',
      failed ? '等待重新整理' : closeoutCompleted ? '故事资料已经更新' : '等待整理完成',
    );
    updateProcessingStep(
      'processing-step-completion',
      'processing-step-completion-mark',
      'processing-step-completion-detail',
      failed ? 'pending' : closeoutCompleted && storyCompletionPending ? 'active' : closeoutCompleted ? 'done' : 'pending',
      failed ? '等待重新整理' : closeoutCompleted && storyCompletionPending ? '正在分析后续主题' : closeoutCompleted ? '本轮分析已经完成' : '等待故事资料更新',
    );
  }

  function setStatus(status, description = '', data = resolveData(state.lastPayload)) {
    const titles = {
      loading: '正在读取访谈结果…',
      processing: '正在总结本次对话…',
      completed: '访谈整理已完成',
      failed: '访谈整理未完成',
      empty: '没有找到这次访谈',
    };
    const descriptions = {
      loading: '访谈记录和整理进度会显示在这里。',
      processing: '访谈记录已收到，正在整理本次聊天。你可以放心离开，页面会自动更新。',
      completed: '这次聊天已经整理好，新的故事会回到你的人生时间线。',
      failed: '整理过程中遇到问题。你可以重新尝试，访谈记录仍会保留。',
      empty: '这个链接暂时没有可显示的访谈记录。',
    };
    byId('status-indicator').dataset.state = status;
    byId('status-title').textContent = titles[status] || titles.loading;
    byId('status-description').textContent = description || descriptions[status] || '';
    updateProcessingStage(status, data);
    setVisible(byId('processing-notice'), status === 'processing');
  }

  function setVisible(element, visible) {
    element.hidden = !visible;
  }

  function setError(message) {
    const box = byId('page-error');
    box.textContent = message;
    setVisible(box, Boolean(message));
  }

  function displayName(message) {
    const role = pick(message, 'role', 'speaker', 'type');
    return role === 'user' || role === 'human' ? '你' : role === 'assistant' || role === 'agent' ? '采访官' : String(role || '说话人');
  }

  function messageText(message) {
    const value = pick(message, 'text', 'content', 'transcript', 'message');
    return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  }

  function messageId(message) {
    return String(pick(message, 'message_id', 'messageId', 'id') || '');
  }

  function formatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(date);
  }

  function renderTranscript(messages) {
    const container = byId('transcript-list');
    container.replaceChildren();
    byId('transcript-count').textContent = `${messages.length} 条记录`;
    if (!messages.length) {
      container.append(make('p', 'empty-copy', '目前没有保存的访谈对话。'));
      return;
    }
    messages.forEach((message, index) => {
      const row = make('article', 'transcript-row');
      const top = make('div', 'transcript-meta');
      const who = make('strong', 'transcript-speaker', displayName(message));
      const id = messageId(message);
      if (id) who.id = `transcript-${safeAnchor(id)}`;
      const time = make('time', '', formatTime(pick(message, 'timestamp', 'created_at', 'createdAt', 'time')) || `第 ${index + 1} 条`);
      top.append(who, time);
      const text = make('p', 'transcript-text', messageText(message) || '（空内容）');
      row.append(top, text);
      if (id) row.dataset.messageId = id;
      container.append(row);
    });
  }

  function safeAnchor(value) {
    return String(value).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100) || 'message';
  }

  function renderSummary(data) {
    const title = pick(data.story, 'title', 'story_title', 'storyTitle');
    const summary = pick(data.story, 'summary');
    setVisible(byId('story-heading'), Boolean(title));
    byId('story-title').textContent = title || '当前故事';
    byId('story-summary').textContent = typeof summary === 'string' && summary.trim() ? summary : '尚未生成故事摘要。';
    byId('story-summary').classList.toggle('empty-copy', !(typeof summary === 'string' && summary.trim()));
  }

  function renderNewStories(data) {
    const container = byId('new-stories-list');
    container.replaceChildren();
    if (!data.newStories.length) {
      container.append(make('p', 'empty-copy', '本次访谈没有新建独立故事。'));
      return;
    }
    data.newStories.forEach((story) => {
      const card = make('article', 'new-story-card');
      card.append(make('h3', '', story.title || '未命名故事'));
      const stage = pick(story, 'stage_title', 'stageTitle');
      if (stage) card.append(make('p', 'new-story-stage', `人生阶段：${stage}`));
      card.append(make('p', 'new-story-summary', story.summary || '暂无摘要。'));
      container.append(card);
    });
  }

  function renderModelMetadata(data) {
    const metadataBlock = byId('model-metadata-block');
    const list = byId('model-metadata-list');
    list.replaceChildren();
    const metadata = data.metadata;
    if (!isObject(metadata)) {
      setVisible(metadataBlock, false);
      return;
    }
    const entries = [];
    if (typeof metadata.provider === 'string') entries.push(['服务商', metadata.provider]);
    if (typeof metadata.model === 'string') entries.push(['模型', metadata.model]);
    if (typeof metadata.latency_ms === 'number') entries.push(['响应时间', `${metadata.latency_ms} ms`]);
    if (isObject(metadata.usage)) {
      const usage = metadata.usage;
      if (typeof usage.prompt_tokens === 'number') entries.push(['输入 Token', usage.prompt_tokens]);
      if (typeof usage.completion_tokens === 'number') entries.push(['输出 Token', usage.completion_tokens]);
      if (typeof usage.total_tokens === 'number') entries.push(['总 Token', usage.total_tokens]);
    }
    if (typeof metadata.repair_attempt_count === 'number') entries.push(['自动修复次数', metadata.repair_attempt_count]);
    entries.forEach(([label, value]) => {
      const term = make('dt', '', label);
      const description = make('dd', '', value);
      list.append(term, description);
    });
    setVisible(metadataBlock, entries.length > 0);
  }

  function closeoutErrorMessage(data) {
    const messages = {
      CLOSEOUT_CANCELLED: '整理已停止。访谈记录仍会保留，你可以手动重新整理。',
      MODEL_OUTPUT_INVALID: '整理模型返回的内容暂时无法解析。访谈原文和已有故事资料未被修改，可以稍后重新尝试。',
      MODEL_OUTPUT_TRUNCATED: '整理结果超出模型单次输出长度。访谈原文和已有故事资料未被修改，可以重新尝试。',
      MODEL_TIMEOUT: '整理模型响应超时。访谈原文和已有故事资料未被修改，可以稍后重试。',
      MODEL_NETWORK_ERROR: '暂时无法连接整理模型。访谈原文和已有故事资料未被修改，可以稍后重试。',
      MODEL_HTTP_ERROR: '整理模型暂时不可用。访谈原文和已有故事资料未被修改，可以稍后重试。',
    MODEL_KEY_REQUIRED: '尚未配置整理模型密钥。访谈原文和已有故事资料未被修改。',
    LLM_NOT_CONFIGURED: '尚未配置整理模型密钥。访谈原文和已有故事资料未被修改。',
      MODEL_ENDPOINT_INVALID: '整理模型连接配置无效。访谈原文和已有故事资料未被修改。',
    };
    if (messages[data.errorCode]) return messages[data.errorCode];
    const message = data.error;
    return typeof message === 'string' && message.trim()
      ? `整理失败：${message}`
      : '本次整理失败，可以重新尝试；访谈原文仍会保留。';
  }

  function renderResult(payload) {
    state.lastPayload = payload;
    const data = resolveData(payload);
    const status = normalizeStatus(data);
    const cancelled = status === 'failed' && data.errorCode === 'CLOSEOUT_CANCELLED';
    if (sessionId) byId('session-id').textContent = `Session · ${sessionId}`;
    const completionDescription = data.storyCompletionPending
      ? '访谈整理已完成，正在更新故事状态；你可以先回到我的人生，后台会继续完成。'
      : undefined;
    const effectiveStatus = status === 'completed' && data.storyCompletionPending
      ? 'processing'
      : status;
    setStatus(effectiveStatus, completionDescription, data);
    renderProcessingSteps(data, effectiveStatus);
    if (cancelled) {
      byId('status-title').textContent = '已停止整理';
      byId('status-description').textContent = '本次整理已停止。访谈记录仍会保留，你可以手动重新整理。';
    }
    setVisible(byId('empty-notice'), status === 'empty');
    if (status === 'empty' && data.errorCode === 'TRANSCRIPT_EMPTY') {
      byId('empty-notice').textContent = '这次访谈没有保存到可整理的用户发言，因此没有生成故事总结。';
    } else if (status === 'empty') {
      byId('empty-notice').textContent = '这个链接暂时没有可显示的访谈记录。';
    }
    setVisible(byId('result-content'), status === 'completed' || status === 'failed');
    setVisible(byId('retry-panel'), status === 'failed' && (data.retryable || cancelled));
    setError('');
    renderSummary(data);
    renderNewStories(data);
    renderTranscript(data.transcript);
    renderModelMetadata(data);
    const finishButton = byId('finish-button');
    finishButton.disabled = false;
    finishButton.textContent = effectiveStatus === 'processing' ? '先回到我的人生' : '回到我的人生';
    if (status === 'failed') {
      byId('retry-message').textContent = closeoutErrorMessage(data);
    }
    if (status === 'processing' || (status === 'completed' && data.storyCompletionPending)) schedulePoll();
    else clearPoll();
  }

  function clearPoll() {
    if (state.pollTimer) window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  function schedulePoll() {
    clearPoll();
    state.pollTimer = window.setTimeout(loadResult, 2500);
  }

  async function loadResult() {
    clearPoll();
    if (!sessionId) {
      setStatus('empty');
      setVisible(byId('empty-notice'), true);
      setVisible(byId('result-content'), false);
      return;
    }
    try {
      const response = await fetch(`/api/interview-sessions/${encodeURIComponent(sessionId)}/result`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      let payload;
      try { payload = await response.json(); }
      catch { payload = {}; }
      if (response.status === 404) {
        renderResult({ ...payload, closeoutStatus: 'empty' });
        return;
      }
      if (!response.ok && !pick(payload, 'status', 'closeoutStatus', 'closeout_status', 'session')) {
        const error = new Error(pick(payload, 'error', 'message') || `读取结果失败（HTTP ${response.status}）`);
        error.status = response.status;
        error.code = pick(payload, 'errorCode', 'error_code', 'code');
        throw error;
      }
      renderResult(payload);
      if (!response.ok && normalizeStatus(resolveData(payload)) !== 'failed') {
        setError(pick(payload, 'error', 'message') || `读取结果失败（HTTP ${response.status}）`);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : '暂时无法读取访谈结果。');
      const statusCode = Number(error?.status ?? 0);
      const deterministicClientError = statusCode >= 400 && statusCode < 500;
      setStatus('failed', deterministicClientError
        ? '这次聊天暂时无法读取，请回到采访页再试。'
        : '连接服务时遇到问题。网络恢复后页面会自动重试读取。');
      setVisible(byId('result-content'), Boolean(state.lastPayload));
      setVisible(byId('retry-panel'), false);
      if (deterministicClientError) clearPoll();
      else scheduleRecoveryPoll();
    }
  }

  function scheduleRecoveryPoll() {
    clearPoll();
    if (sessionId) state.pollTimer = window.setTimeout(loadResult, 4000);
  }

  async function retryCloseout() {
    if (!sessionId || state.isRetrying) return;
    state.isRetrying = true;
    const button = byId('retry-button');
    button.disabled = true;
    button.textContent = '正在重新整理…';
    setError('');
    try {
      const response = await fetch(`/api/interview-sessions/${encodeURIComponent(sessionId)}/closeout`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      let payload;
      try { payload = await response.json(); }
      catch { payload = {}; }
      if (!response.ok) {
        const message = pick(payload, 'error', 'message') || `重新整理失败（HTTP ${response.status}）`;
        setError(message);
        if (pick(payload, 'status', 'closeoutStatus', 'closeout_status', 'session')) renderResult(payload);
        return;
      }
      if (Object.keys(payload).length) renderResult(payload);
      if (normalizeStatus(resolveData(payload)) !== 'completed') {
        setStatus('processing');
        setVisible(byId('retry-panel'), false);
        schedulePoll();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : '重新整理时连接服务失败。');
    } finally {
      state.isRetrying = false;
      button.disabled = false;
      button.textContent = '重新整理';
    }
  }

  byId('finish-button').addEventListener('click', () => {
    clearPoll();
    window.location.assign('/my-life');
  });
  byId('retry-button').addEventListener('click', retryCloseout);
  window.addEventListener('pagehide', clearPoll, { once: true });
  loadResult();
})();
