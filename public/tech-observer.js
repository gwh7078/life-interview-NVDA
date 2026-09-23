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
    };
    const events = [];
    const eventIds = new Set();
    let sessionId = '';
    let authenticatedUserId = null;
    let source;
    let renderQueued = false;

    const setLive = (state, label) => {
      if (!live) return;
      live.dataset.state = state;
      live.textContent = label;
    };

    const updateFlow = (event) => {
      const category = event.category === 'realtime' && /^realtime\.(hold|resume)/u.test(event.eventType)
        ? 'tool'
        : event.category;
      const item = panel.querySelector(`.tech-observer-flow li[data-category="${category}"]`);
      if (!item) return;
      item.dataset.state = event.status === 'error' ? 'error' : 'active';
    };

    const displayEvent = (event) => {
      if (!event || typeof event !== 'object') return;
      if (typeof event.eventId === 'string') {
        if (eventIds.has(event.eventId)) return;
        eventIds.add(event.eventId);
      }
      if (event.metadata && typeof event.metadata === 'object') {
        for (const [key, target] of Object.entries(values)) {
          if (typeof event.metadata[key] === 'string' && target) target.textContent = event.metadata[key];
        }
        if (typeof event.metadata.tool === 'string' && values.tool) values.tool.textContent = event.metadata.tool;
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
      for (const event of events) {
        const row = document.createElement('li');
        row.className = 'tech-event';
        const time = document.createElement('time');
        const date = new Date(event.timestamp);
        time.textContent = Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour12: false });
        const content = document.createElement('div');
        content.className = 'tech-event-content';
        const title = document.createElement('div');
        title.className = 'tech-event-title';
        title.dataset.status = event.status || '';
        const titleText = document.createElement('span');
        titleText.textContent = typeof event.title === 'string' ? event.title : event.eventType || 'EVENT';
        const duration = document.createElement('span');
        duration.textContent = Number.isFinite(event.durationMs) ? `${Math.round(event.durationMs)} ms` : '';
        title.append(titleText, duration);
        content.append(title);
        if (typeof event.summary === 'string' && event.summary) {
          const summary = document.createElement('p');
          summary.className = 'tech-event-summary';
          summary.textContent = event.summary;
          content.append(summary);
        }
        if (event.metrics && typeof event.metrics === 'object') {
          const metrics = Object.entries(event.metrics)
            .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
            .slice(0, 4)
            .map(([key, value]) => `${key}: ${value}`)
            .join(' · ');
          if (metrics) {
            const detail = document.createElement('p');
            detail.className = 'tech-event-metrics';
            detail.textContent = metrics;
            content.append(detail);
          }
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
      if (sessionLabel) sessionLabel.textContent = '—';
      if (traceLabel) traceLabel.textContent = '—';
      for (const target of Object.values(values)) if (target) target.textContent = '—';
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
      if (sessionLabel) sessionLabel.textContent = sessionId || '—';
      if (traceLabel) traceLabel.textContent = sessionId || '—';
      for (const target of Object.values(values)) if (target) target.textContent = '—';
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
