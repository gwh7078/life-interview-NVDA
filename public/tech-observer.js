try {
  const shell = document.querySelector('.app-shell');
  const panel = document.getElementById('tech-observer');
  const toggle = document.getElementById('tech-observer-toggle');
  const eventList = document.getElementById('tech-observer-events');
  if (shell && panel && toggle && eventList && typeof EventSource === 'function') {
    const live = document.getElementById('tech-observer-live');
    const sessionLabel = document.getElementById('tech-observer-session');
    const traceLabel = document.getElementById('tech-observer-trace');
    const countLabel = document.getElementById('tech-observer-count');
    const emptyLabel = document.getElementById('tech-observer-empty');
    const values = {
      environment: document.getElementById('tech-observer-environment'),
      provider: document.getElementById('tech-observer-provider'),
      agent: document.getElementById('tech-observer-agent'),
      runtime: document.getElementById('tech-observer-runtime'),
      skill: document.getElementById('tech-observer-skill'),
      tool: document.getElementById('tech-observer-tool'),
      model: document.getElementById('tech-observer-model'),
    };
    const eventTitles = {
      'runtime.started': 'SESSION STARTED', 'runtime.ended': 'SESSION ENDED',
      'realtime.connected': 'REALTIME CONNECTED', 'realtime.user_speaking': 'USER SPEAKING',
      'realtime.listening': 'LISTENING', 'realtime.model_thinking': 'AI THINKING',
      'realtime.interrupted': 'INTERRUPTED', 'realtime.hold': 'HOLD', 'realtime.resume': 'RESUME',
      'realtime.first_audio': 'FIRST AUDIO', 'tool.started': 'TOOL CALL', 'tool.completed': 'TOOL RESULT',
      'tool.failed': 'TOOL FAILED', 'retriever.started': 'RETRIEVER STARTED',
      'retriever.completed': 'RETRIEVER COMPLETE', 'retriever.failed': 'RETRIEVER FAILED',
      'retriever.skipped': 'RETRIEVER SKIPPED', 'evidence.ready': 'CONTEXT HINT READY',
      'agent.started': 'AGENT STARTED', 'agent.completed': 'AGENT COMPLETE',
      'agent.failed': 'AGENT FAILED', 'agent.timeout': 'AGENT TIMEOUT', 'agent.skipped': 'AGENT SKIPPED',
      'agent.metrics': 'AGENT METRICS',
      'skill.started': 'SKILL STARTED', 'skill.completed': 'SKILL COMPLETE', 'skill.failed': 'SKILL FAILED',
      'validator.passed': 'VALIDATION PASSED', 'validator.failed': 'VALIDATION FAILED',
      'database.write.started': 'DATABASE WRITE STARTED', 'database.write.completed': 'DATABASE WRITE COMPLETE',
      'database.write.failed': 'DATABASE WRITE FAILED',
    };
    const metricLabels = {
      candidateCount: '候选', evidenceCount: '证据', selectedEvidenceCount: '选中证据',
      promptTokens: 'Prompt tokens', completionTokens: 'Completion tokens', totalTokens: 'Total tokens',
      fallbackUsed: '降级', fallbackType: '降级方式', skipReason: '跳过原因', errorCode: '错误码',
      model: 'Model', skill: 'Skill', resumeLatencyMs: 'Resume→回复', toolResultLatencyMs: 'Tool Result',
      firstAudioLatencyMs: 'Tool→首段语音', responseBFirstAudioMs: '回复→首段语音', toolCallCount: 'Tool calls',
    };
    const skipReasons = {
      no_evidence: '无检索证据', agent_disabled: 'Agent 未启用',
      agent_unavailable: 'Agent 不可用', agent_not_configured: 'Agent 未配置',
    };
    const allowedCategories = new Set(['realtime', 'runtime', 'agent', 'skill', 'tool', 'retriever', 'evidence', 'validator', 'persistence', 'system']);
    const events = [];
    const eventIds = new Set();
    let sessionId = '';
    let authenticatedUserId = null;
    let source;
    let renderQueued = false;

    const safeDisplayLabel = (value) => typeof value === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9 .:/+-]{0,63}$/u.test(value.trim())
      && !/(?:\b(?:bearer|token|api[ _-]?key|cookie|authorization|secret)\b|^sk[-_]|^(?:session|sess|story|call|response|run|trace|span)[_:-]|^[0-9a-f]{8}-[0-9a-f-]{27,}$)/iu.test(value.trim())
      ? value.trim()
      : undefined;

    const eventTitle = (event) => {
      if (event.eventType === 'realtime.listening' && event.status === 'success') return 'RESPONSE COMPLETE';
      if (event.eventType === 'realtime.responding') return event.component === 'realtime-tool-cycle' ? 'AI RESUMED' : 'AI SPEAKING';
      if (event.component === 'realtime-context-agent') {
        return eventTitles[event.eventType] === 'AGENT TIMEOUT' || event.eventType === 'agent.timeout'
          || (event.eventType === 'agent.failed' && typeof event.metrics?.errorCode === 'string' && event.metrics.errorCode.includes('TIMEOUT'))
          ? 'CONTEXT HINT AGENT TIMEOUT'
          : `CONTEXT HINT ${eventTitles[event.eventType] || 'AGENT EVENT'}`;
      }
      if (event.eventType.startsWith('realtime.slow_path.result.')) {
        const result = event.eventType.slice('realtime.slow_path.result.'.length).toUpperCase();
        return ['COMPLETED', 'TIMEOUT', 'FAILED', 'ABORTED', 'STALE', 'UNKNOWN'].includes(result)
          ? `SLOW PATH ${result}` : 'SLOW PATH RESULT';
      }
      return eventTitles[event.eventType] || 'RUNTIME EVENT';
    };

    const expectedMetrics = (event) => {
      if (event.category === 'retriever') return ['candidateCount', 'evidenceCount', 'errorCode'];
      if (event.component === 'realtime-context-agent') {
        if (event.eventType === 'agent.started') return ['model', 'skill'];
        if (event.eventType === 'agent.skipped') return ['skipReason', 'fallbackUsed', 'fallbackType'];
        return ['model', 'skill', 'promptTokens', 'completionTokens', 'totalTokens', 'selectedEvidenceCount', 'errorCode', 'fallbackUsed', 'fallbackType'];
      }
      if (event.eventType === 'evidence.ready') return ['selectedEvidenceCount', 'fallbackUsed', 'fallbackType'];
      if (event.eventType.startsWith('realtime.slow_path.result.')) return ['evidenceCount', 'fallbackUsed', 'fallbackType', 'errorCode'];
      if (event.eventType === 'realtime.responding' && event.component === 'realtime-tool-cycle') return ['resumeLatencyMs'];
      if (event.eventType === 'realtime.resume') return ['resumeLatencyMs'];
      if (event.eventType === 'realtime.first_audio') return ['firstAudioLatencyMs', 'responseBFirstAudioMs'];
      if (event.eventType === 'tool.completed' && event.component === 'realtime-tool') return ['toolResultLatencyMs'];
      if (event.eventType === 'agent.completed') return ['toolCallCount'];
      return [];
    };

    const metricValue = (key, value) => {
      if (['candidateCount', 'evidenceCount', 'selectedEvidenceCount', 'promptTokens', 'completionTokens', 'totalTokens', 'resumeLatencyMs', 'toolResultLatencyMs', 'firstAudioLatencyMs', 'responseBFirstAudioMs', 'toolCallCount'].includes(key)) {
        return typeof value === 'number' && Number.isFinite(value) && value >= 0
          ? `${Math.round(value)}${key.endsWith('Ms') || key.endsWith('LatencyMs') ? ' ms' : ''}`
          : '暂无数据';
      }
      if (key === 'fallbackUsed') return typeof value === 'boolean' ? (value ? '是' : '否') : '暂无数据';
      if (key === 'fallbackType') return value === 'direct_retrieval' ? '直接使用检索证据' : '暂无数据';
      if (key === 'skipReason') return skipReasons[value] || '暂无数据';
      if (key === 'errorCode') return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : '暂无数据';
      return safeDisplayLabel(value) || '暂无数据';
    };

    const setLive = (state, label) => {
      if (!live) return;
      live.dataset.state = state;
      live.textContent = label;
    };

    const updateFlow = (event) => {
      if (!allowedCategories.has(event.category)) return;
      const category = event.category === 'realtime' && /^realtime\.(hold|resume)/u.test(event.eventType)
        ? 'tool'
        : event.category;
      const item = [...panel.querySelectorAll('.tech-observer-flow li')].find((node) => node.dataset.category === category);
      if (!item) return;
      item.dataset.state = event.status === 'error' ? 'error'
        : event.status === 'warning' ? 'warning'
          : event.status === 'skip' ? 'skipped'
            : event.status === 'success' ? 'complete' : 'active';
    };

    const displayEvent = (event) => {
      if (!event || typeof event !== 'object' || !allowedCategories.has(event.category) || typeof event.eventType !== 'string') return;
      if (typeof event.eventId === 'string') {
        if (eventIds.has(event.eventId)) return;
        eventIds.add(event.eventId);
      }
      if (event.metadata && typeof event.metadata === 'object') {
        for (const [key, target] of Object.entries(values)) {
          const label = safeDisplayLabel(event.metadata[key]);
          if (label && target) target.textContent = label;
        }
      }
      if (event.metrics && typeof event.metrics === 'object') {
        for (const key of ['model', 'skill']) {
          const label = safeDisplayLabel(event.metrics[key]);
          if (label && values[key]) values[key].textContent = label;
        }
      }
      if (typeof event.traceId === 'string' && (typeof event.spanId === 'string' || typeof event.parentSpanId === 'string')) {
        if (traceLabel) traceLabel.textContent = '已关联';
      }
      events.push(event);
      while (events.length > 100) {
        const removed = events.shift();
        if (typeof removed?.eventId === 'string') eventIds.delete(removed.eventId);
      }
      updateFlow(event);
      if (!renderQueued) {
        renderQueued = true;
        requestAnimationFrame(render);
      }
    };

    function render() {
      renderQueued = false;
      if (!eventList) return;
      const fragment = document.createDocumentFragment();
      const orderedEvents = events.map((event, index) => ({ event, index, time: Date.parse(event.timestamp) }))
        .sort((left, right) => (Number.isFinite(left.time) ? left.time : 0) - (Number.isFinite(right.time) ? right.time : 0) || left.index - right.index);
      const seenSpans = new Set();
      for (const { event } of orderedEvents) {
        const row = document.createElement('li');
        row.className = 'tech-event';
        const related = (typeof event.spanId === 'string' && seenSpans.has(event.spanId))
          || (typeof event.parentSpanId === 'string' && seenSpans.has(event.parentSpanId));
        row.dataset.related = String(related);
        if (typeof event.spanId === 'string') seenSpans.add(event.spanId);
        const time = document.createElement('time');
        const date = new Date(event.timestamp);
        time.textContent = Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour12: false });
        const content = document.createElement('div');
        content.className = 'tech-event-content';
        const title = document.createElement('div');
        title.className = 'tech-event-title';
        title.dataset.status = ['start', 'running', 'success', 'warning', 'error', 'skip'].includes(event.status) ? event.status : '';
        const titleText = document.createElement('span');
        titleText.textContent = eventTitle(event);
        const duration = document.createElement('span');
        const timingEvent = event.component === 'nemo-retriever' || event.component === 'realtime-context-agent'
          || event.component === 'realtime-slow-path' || event.component === 'realtime-tool-cycle'
          || event.component === 'realtime-tool'
          || event.eventType === 'realtime.resume';
        duration.textContent = Number.isFinite(event.durationMs) && event.durationMs >= 0
          ? `${Math.round(event.durationMs)} ms`
          : timingEvent ? '暂无数据' : '';
        title.append(titleText, duration);
        content.append(title);
        const keys = expectedMetrics(event);
        if (keys.length) {
          const metrics = keys.map((key) => `${metricLabels[key]}: ${metricValue(key, event.metrics?.[key])}`).join(' · ');
          const detail = document.createElement('p');
          detail.className = 'tech-event-metrics';
          detail.textContent = metrics;
          content.append(detail);
        }
        row.append(time, content);
        fragment.append(row);
      }
      eventList.replaceChildren(fragment);
      if (countLabel) countLabel.textContent = String(events.length);
      if (emptyLabel) emptyLabel.hidden = events.length > 0;
    }

    const stopStream = () => {
      source?.close();
      source = undefined;
    };

    const clearForAuthChange = (detail) => {
      const nextUserId = typeof detail?.userId === 'string' ? detail.userId : null;
      if (nextUserId === authenticatedUserId) return;
      authenticatedUserId = nextUserId;
      stopStream();
      sessionId = '';
      events.length = 0;
      eventIds.clear();
      eventList.replaceChildren();
      if (sessionLabel) sessionLabel.textContent = '暂无数据';
      if (traceLabel) traceLabel.textContent = '暂无数据';
      for (const target of Object.values(values)) if (target) target.textContent = '暂无数据';
      for (const item of panel.querySelectorAll('.tech-observer-flow li')) delete item.dataset.state;
      render();
      setLive('waiting', 'WAITING');
    };

    window.addEventListener('interview:auth-changed', (event) => clearForAuthChange(event.detail));
    let authChannel;
    try {
      if (typeof BroadcastChannel === 'function') {
        authChannel = new BroadcastChannel('life-interview-auth');
        authChannel.addEventListener('message', (event) => clearForAuthChange(event.data));
        window.addEventListener('pagehide', () => authChannel.close(), { once: true });
      }
    } catch { /* Cross-tab observer cleanup is best effort. */ }

    const connect = () => {
      stopStream();
      if (!sessionId || panel.hidden) {
        setLive('waiting', sessionId ? 'PAUSED' : 'WAITING');
        return;
      }
      try {
        source = new EventSource(`/api/observability/events?sessionId=${encodeURIComponent(sessionId)}`);
        source.onopen = () => setLive('live', 'LIVE');
        source.onerror = () => setLive('reconnecting', 'RECONNECTING');
        source.addEventListener('observation', (message) => {
          try { displayEvent(JSON.parse(message.data)); } catch { /* Ignore malformed observer data only. */ }
        });
      } catch {
        setLive('reconnecting', 'OFFLINE');
      }
    };

    const setOpen = (open) => {
      panel.hidden = !open;
      shell.classList.toggle('tech-observer-active', open);
      toggle.setAttribute('aria-expanded', String(open));
      if (open) connect();
      else {
        stopStream();
        setLive('waiting', sessionId ? 'PAUSED' : 'WAITING');
      }
    };

    toggle.addEventListener('click', () => setOpen(panel.hidden));
    window.addEventListener('interview:session', (event) => {
      const nextSessionId = typeof event.detail?.sessionId === 'string' ? event.detail.sessionId : '';
      if (nextSessionId === sessionId) return;
      sessionId = nextSessionId;
      events.length = 0;
      eventIds.clear();
      eventList.replaceChildren();
      if (sessionLabel) sessionLabel.textContent = sessionId ? '当前采访' : '暂无数据';
      if (traceLabel) traceLabel.textContent = sessionId ? '等待事件' : '暂无数据';
      for (const target of Object.values(values)) if (target) target.textContent = '暂无数据';
      for (const item of panel.querySelectorAll('.tech-observer-flow li')) delete item.dataset.state;
      render();
      if (!panel.hidden) connect();
    });

    const demoMode = new URLSearchParams(window.location.search).get('demo') === 'tech';
    setOpen(demoMode);
  }
} catch {
  // The optional observer is isolated from interview controls and audio playback.
}
