try {
  const panel = document.getElementById('tech-observer');
  const layout = document.getElementById('workspace-layout');
  const toggle = document.getElementById('tech-observer-toggle');
  const compactBar = document.getElementById('tech-observer-compact-bar');
  const compactDot = document.getElementById('tech-observer-compact-dot');
  const compactState = document.getElementById('tech-observer-compact-state');
  const compactLabel = document.getElementById('tech-observer-compact-label');
  const backdrop = document.getElementById('tech-observer-backdrop');
  const sheetClose = document.getElementById('tech-observer-sheet-close');
  const recentList = document.getElementById('tech-observer-recent-events');
  const fullList = document.getElementById('tech-observer-events');
  if (panel && layout && toggle && recentList && fullList && typeof EventSource === 'function') {
    const ids = (names) => Object.fromEntries(names.map((name) => [name, document.getElementById(`tech-${name}`)]));
    const live = document.getElementById('tech-observer-live');
    const empty = document.getElementById('tech-observer-empty');
    const environmentLabel = document.getElementById('tech-observer-environment');
    const turnLabel = document.getElementById('tech-observer-turn');
    const modelLabel = document.getElementById('tech-observer-model');
    const voiceModelLabel = document.getElementById('tech-node-voice-model');
    const slowStatusLabel = document.getElementById('tech-observer-slow-status');
    const sessionLabel = document.getElementById('tech-observer-session');
    const traceLabel = document.getElementById('tech-observer-trace');
    const eventCountLabel = document.getElementById('tech-observer-count');
    const recentCountLabel = document.getElementById('tech-observer-recent-count');
    const nodeCards = Object.fromEntries(['user', 'voice', 'assistant', 'trigger', 'retriever', 'coach', 'context']
      .map((name) => [name, document.getElementById(`tech-node-${name}`)]));
    const nodeStates = Object.fromEntries(['user', 'voice', 'assistant', 'trigger', 'retriever', 'coach', 'context']
      .map((name) => [name, document.getElementById(`tech-node-${name}-state`)]));
    const edges = ids(['edge-user-voice', 'edge-voice-assistant', 'edge-voice-trigger', 'edge-trigger-retriever', 'edge-retriever-coach', 'edge-coach-context', 'edge-context-voice']);
    const metrics = ids(['metric-first-audio', 'metric-slow-latency', 'metric-evidence', 'metric-tool-count']);
    const detailFields = {
      environment: document.getElementById('tech-detail-environment'),
      provider: document.getElementById('tech-observer-provider'),
      memoryTriggerMode: document.getElementById('tech-observer-memory-trigger'),
      agent: document.getElementById('tech-observer-agent'),
      runtime: document.getElementById('tech-observer-runtime'),
      modelSkill: document.getElementById('tech-observer-skill'),
      tool: document.getElementById('tech-observer-tool'),
      tokens: document.getElementById('tech-observer-tokens'),
      fallback: document.getElementById('tech-observer-fallback'),
      error: document.getElementById('tech-observer-error'),
    };

    const allowedCategories = new Set(['realtime', 'runtime', 'agent', 'skill', 'tool', 'retriever', 'evidence', 'validator', 'persistence', 'system']);
    const providerLabels = {
      stepaudio3_quality: 'StepAudio 3 Realtime',
      stepaudio2_mini: 'Step-Audio 2 mini Realtime',
      stepfun: 'Step-Audio 2 mini Realtime',
      modelbest: 'MiniCPM-o 4.5 Realtime · Experimental',
      qwen: 'Qwen Realtime',
    };
    const titles = {
      'runtime.started': 'SESSION STARTED', 'runtime.ended': 'SESSION ENDED',
      'coach.gate.started': 'COACH GATE STARTED', 'coach.gate.completed': 'COACH GATE COMPLETE',
      'coach.gate.timeout': 'COACH GATE TIMEOUT', 'coach.gate.failed': 'COACH GATE FAILED',
      'coach.retrieval.started': 'COACH MEMORY RETRIEVER RUNNING', 'coach.retrieval.completed': 'COACH MEMORY RETRIEVER COMPLETE',
      'coach.retrieval.timeout': 'COACH MEMORY RETRIEVER TIMEOUT', 'coach.retrieval.failed': 'COACH MEMORY RETRIEVER FAILED',
      'coach.retrieval.skipped': 'COACH MEMORY RETRIEVER SKIPPED',
      'coach.era_retrieval.started': 'COACH ERA RETRIEVER RUNNING', 'coach.era_retrieval.completed': 'COACH ERA RETRIEVER COMPLETE',
      'coach.era_retrieval.timeout': 'COACH ERA RETRIEVER TIMEOUT', 'coach.era_retrieval.failed': 'COACH ERA RETRIEVER FAILED',
      'coach.era_retrieval.skipped': 'COACH ERA RETRIEVER SKIPPED',
      'coach.pipeline.timeout': 'COACH PIPELINE TIMEOUT',
      'coach.resolve.started': 'COACH RESOLVE STARTED', 'coach.resolve.completed': 'COACH RESOLVE COMPLETE',
      'coach.resolve.timeout': 'COACH RESOLVE TIMEOUT', 'coach.resolve.failed': 'COACH RESOLVE FAILED',
      'coach.applied': 'COACH APPLIED', 'coach.skipped': 'COACH SKIPPED',
      'realtime.connected': 'REALTIME CONNECTED', 'realtime.user_speaking': 'USER SPEAKING',
      'realtime.turn_committed': 'USER TURN COMMITTED',
      'realtime.listening': 'LISTENING', 'realtime.model_thinking': 'AI THINKING',
      'realtime.interrupted': 'INTERRUPTED', 'realtime.hold': 'HOLD', 'realtime.resume': 'RESUME',
      'realtime.resumed': 'AI RESUMED', 'realtime.first_audio': 'FIRST AUDIO',
      'realtime.responding': 'AI SPEAKING', 'realtime.slow_deadline_exceeded': 'SLOW PATH DEADLINE EXCEEDED',
      'tool.received': 'TOOL CALL', 'tool.started': 'TOOL CALL', 'tool.completed': 'TOOL RESULT',
      'tool.failed': 'TOOL FAILED', 'retriever.started': 'RETRIEVER STARTED',
      'retriever.completed': 'RETRIEVER COMPLETE', 'retriever.failed': 'RETRIEVER FAILED',
      'retriever.skipped': 'RETRIEVER SKIPPED', 'evidence.ready': 'CONTEXT INJECTION READY',
      'evidence.injected': 'CONTEXT INJECTED', 'evidence.injection_failed': 'CONTEXT INJECTION FAILED',
      'evidence.no_context': 'NO CONTEXT', 'agent.started': 'AGENT STARTED',
      'agent.completed': 'AGENT COMPLETE', 'agent.failed': 'AGENT FAILED',
      'agent.timeout': 'AGENT TIMEOUT', 'agent.skipped': 'AGENT SKIPPED',
      'agent.metrics': 'AGENT METRICS', 'skill.started': 'SKILL STARTED',
      'skill.completed': 'SKILL COMPLETE', 'skill.failed': 'SKILL FAILED',
      'validator.passed': 'VALIDATION PASSED', 'validator.failed': 'VALIDATION FAILED',
      'database.write.started': 'DATABASE WRITE STARTED', 'database.write.completed': 'DATABASE WRITE COMPLETE',
      'database.write.failed': 'DATABASE WRITE FAILED',
    };
    const metricLabels = {
      candidateCount: '候选', evidenceCount: '证据', selectedEvidenceCount: '采用',
      action: 'Coach Action', retrieve_memory: 'Memory 检索', retrieve_era: 'Era 检索', gateMs: 'Gate', memoryRetrievalMs: 'Memory', eraRetrievalMs: 'Era',
      resolveMs: 'Resolve', totalMs: '总耗时', packetChars: 'Packet 字符',
      promptTokens: 'Prompt tokens', completionTokens: 'Completion tokens', totalTokens: 'Total tokens',
      fallbackUsed: '降级', fallbackType: '降级方式', skipReason: '跳过原因', errorCode: '错误码', resultStatus: '结果', sent: '已发送',
      model: 'Model', skill: 'Skill', resumeLatencyMs: 'Resume→回复', toolResultLatencyMs: 'Tool Result',
      firstAudioLatencyMs: 'Tool→首段语音', responseBFirstAudioMs: '回复→首段语音', toolCallCount: 'Tool calls',
    };
    const skipReasons = {
      no_evidence: '无检索证据', NO_EVIDENCE: '无检索证据', agent_disabled: 'Agent 未启用',
      agent_unavailable: 'Agent 不可用', agent_not_configured: 'Agent 未配置',
      RETRIEVER_UNAVAILABLE: 'Memory Retriever 不可用', ERA_CONTEXT_UNAVAILABLE: 'Era Retriever 不可用',
      RETRIEVAL_NOT_REQUESTED: '本路未请求',
    };
    const numericMetricKeys = new Set([
      'candidateCount', 'evidenceCount', 'selectedEvidenceCount', 'promptTokens', 'completionTokens', 'totalTokens',
      'resumeLatencyMs', 'toolResultLatencyMs', 'firstAudioLatencyMs', 'responseBFirstAudioMs', 'toolCallCount',
      'gateMs', 'memoryRetrievalMs', 'eraRetrievalMs', 'resolveMs', 'totalMs', 'packetChars',
    ]);
    const state = {
      sessionId: '',
      authenticatedUserId: null,
      voiceModel: '',
      provider: '',
      environment: '',
      memoryTriggerMode: '',
      agent: '',
      runtime: '',
      model: '',
      skill: '',
      tool: '',
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      errorCode: '',
      traceLinked: false,
      turnNumber: 0,
      turn: createTurn(0),
      events: [],
    };
    const eventIds = new Set();
    const toolCallTurns = new Map();
    const responseTurns = new Map();
    let source;
    let observerEnabled = false;
    let sheetOpen = false;
    let sheetPreviousFocus;

    function createTurn(number) {
      return {
        number,
        turnKey: '', fallback: '', contextResultReady: false,
        user: 'waiting', userLabel: '等待',
        voice: 'waiting', voiceLabel: '等待', fastState: 'waiting',
        assistant: 'waiting', assistantLabel: '等待',
        trigger: 'waiting', triggerLabel: '等待', triggerDetail: '',
        retriever: 'waiting', retrieverLabel: '等待', retrieverDetail: '',
        memoryRetriever: 'waiting', memoryRetrieverLabel: '等待', memoryRetrieverDetail: '', memoryRetrievalMs: null, memoryRetrieverRequested: false,
        eraRetriever: 'waiting', eraRetrieverLabel: '等待', eraRetrieverDetail: '', eraRetrievalMs: null, eraRetrieverRequested: false,
        coach: 'waiting', coachLabel: '等待', coachDetail: '',
        context: 'waiting', contextLabel: '等待', contextDetail: '',
        userVoiceEdge: 'waiting', voiceAssistantEdge: 'waiting', voiceTriggerEdge: 'waiting',
        triggerRetrieverEdge: 'waiting', retrieverCoachEdge: 'waiting', coachContextEdge: 'waiting', contextVoiceEdge: 'waiting',
        slowStatus: '等待本轮信号', slowTriggered: false, assistantActive: false, awaitingUser: false,
        firstAudioMs: null, slowLatencyMs: null, evidenceCount: null, selectedEvidenceCount: null, toolCount: 0,
      };
    }

    const safeLabel = (value) => typeof value === 'string'
      && /^[A-Za-z0-9_][A-Za-z0-9_ .:/+-]{0,63}$/u.test(value.trim())
      && !/(?:\b(?:bearer|token|api[ _-]?key|cookie|authorization|secret)\b|^sk[-_]|^(?:session|sess|story|call|response|run|trace|span)[_:-]|^[0-9a-f]{8}-[0-9a-f-]{27,}$)/iu.test(value.trim())
      ? value.trim()
      : '';
    const safeErrorCode = (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : '';
    const setLive = (status, label) => {
      if (!live) return;
      live.dataset.state = status;
      live.textContent = label;
      if (compactState && (status === 'live' || status === 'reconnecting')) compactState.textContent = label;
      if (compactDot && (status === 'live' || status === 'reconnecting')) compactDot.dataset.state = status;
    };
    const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const displayDuration = (value) => {
      const ms = finite(value);
      if (ms === null) return '—';
      if (ms < 1000) return `${Math.round(ms)} ms`;
      return `${(ms / 1000).toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '')} s`;
    };
    const providerLabel = (value) => safeLabel(value) ? providerLabels[value] || safeLabel(value) : '';
    const eventTitle = (event) => {
      if (event.component === 'realtime-context-agent') {
        const timeout = event.eventType === 'agent.timeout'
          || event.eventType === 'agent.failed' && String(event.metrics?.errorCode || '').includes('TIMEOUT');
        if (timeout) return 'CONTEXT HINT AGENT TIMEOUT';
        return `CONTEXT HINT ${titles[event.eventType] || 'AGENT EVENT'}`;
      }
      if (event.eventType.startsWith('realtime.slow_path.result.')) {
        const result = event.eventType.slice('realtime.slow_path.result.'.length).toUpperCase();
        return ['COMPLETED', 'TIMEOUT', 'FAILED', 'ABORTED', 'STALE', 'UNKNOWN'].includes(result)
          ? `SLOW PATH ${result}` : 'SLOW PATH RESULT';
      }
      if (event.eventType === 'realtime.responding') return event.component === 'realtime-tool-cycle' ? 'AI RESUMED' : 'AI SPEAKING';
      if (event.eventType === 'realtime.listening' && event.status === 'success') return 'RESPONSE COMPLETE';
      return titles[event.eventType] || 'RUNTIME EVENT';
    };
    const expectedMetrics = (event) => {
      if (event.component === 'realtime-coach-gate') return ['action', 'retrieve_memory', 'retrieve_era', 'gateMs', 'errorCode'];
      if (event.component === 'realtime-coach-retriever') return ['candidateCount', 'evidenceCount', 'memoryRetrievalMs', 'skipReason', 'errorCode'];
      if (event.component === 'realtime-coach-era-retriever') return ['candidateCount', 'evidenceCount', 'eraRetrievalMs', 'skipReason', 'errorCode'];
      if (event.component === 'realtime-coach-pipeline') return ['totalMs', 'errorCode'];
      if (event.component === 'realtime-coach-resolve') return event.eventType === 'coach.resolve.skipped'
        ? ['evidenceCount', 'resolveMs', 'skipReason', 'errorCode']
        : ['evidenceCount', 'resolveMs', 'errorCode'];
      if (event.component === 'realtime-coach') return ['action', 'packetChars', 'totalMs'];
      if (event.category === 'retriever') return ['candidateCount', 'evidenceCount', 'errorCode'];
      if (event.component === 'realtime-context-agent') {
        if (event.eventType === 'agent.started') return ['model', 'skill'];
        if (event.eventType === 'agent.skipped') return ['skipReason', 'fallbackUsed', 'fallbackType'];
        return ['model', 'skill', 'promptTokens', 'completionTokens', 'totalTokens', 'selectedEvidenceCount', 'errorCode', 'fallbackUsed', 'fallbackType'];
      }
      if (event.eventType === 'evidence.ready') return ['selectedEvidenceCount', 'fallbackUsed', 'fallbackType'];
      if (event.eventType === 'evidence.injected' || event.eventType === 'evidence.injection_failed') return ['sent'];
      if (event.eventType.startsWith('realtime.slow_path.result.')) return ['evidenceCount', 'fallbackUsed', 'fallbackType', 'errorCode'];
      if (event.eventType === 'realtime.responding' && event.component === 'realtime-tool-cycle') return ['resumeLatencyMs'];
      if (event.eventType === 'realtime.resume') return ['resumeLatencyMs'];
      if (event.eventType === 'realtime.first_audio') return ['firstAudioLatencyMs', 'responseBFirstAudioMs'];
      if (event.eventType === 'tool.completed' && event.component === 'realtime-tool') return ['resultStatus', 'sent', 'toolResultLatencyMs'];
      if (event.eventType === 'agent.completed') return ['toolCallCount'];
      return [];
    };
    const metricValue = (key, value) => {
      if (numericMetricKeys.has(key)) {
        const number = finite(value);
        return number === null ? '—' : `${Math.round(number)}${key.endsWith('Ms') || key.endsWith('LatencyMs') ? ' ms' : ''}`;
      }
      if (key === 'retrieve_memory' || key === 'retrieve_era' || key === 'fallbackUsed' || key === 'sent') return typeof value === 'boolean' ? value ? '是' : '否' : '—';
      if (key === 'fallbackType') return value === 'direct_retrieval' ? '直接使用检索结果' : '—';
      if (key === 'skipReason') return skipReasons[value] || '—';
      if (key === 'errorCode') return safeErrorCode(value) || '—';
      return safeLabel(value) || '—';
    };

    const setNode = (key, status, label, detail = '') => {
      const card = nodeCards[key];
      if (card) card.dataset.state = status;
      if (nodeStates[key]) nodeStates[key].textContent = label;
      const detailKey = key === 'voice' ? 'node-voice-detail'
        : key === 'trigger' ? 'node-trigger-detail'
          : key === 'retriever' ? 'node-retriever-detail'
            : key === 'coach' ? 'node-coach-detail'
              : key === 'context' ? 'node-context-detail' : '';
      if (detailKey && document.getElementById(`tech-${detailKey}`)) document.getElementById(`tech-${detailKey}`).textContent = detail;
    };
    const setEdge = (key, value) => { if (edges[key]) edges[key].dataset.state = value; };
    const isTimeout = (event) => event.eventType.includes('timeout')
      || typeof event.metrics?.errorCode === 'string' && event.metrics.errorCode.includes('TIMEOUT');
    const eventState = (event) => event.status === 'error' ? 'error'
      : event.status === 'warning' ? 'warning'
        : event.status === 'skip' ? 'skipped'
          : event.status === 'success' ? 'complete' : 'active';
    const routeStatusLabel = (status, event) => isTimeout(event) ? 'Timeout'
      : status === 'active' ? '检索中'
        : status === 'complete' ? '已完成'
          : status === 'skipped' ? skipReasons[event.metrics?.skipReason] || '跳过'
            : status === 'warning' ? '注意' : status === 'error' ? '失败' : '等待';
    const syncRetrieverNode = () => {
      const turn = state.turn;
      const routes = [
        { key: 'memoryRetriever', label: 'Memory', duration: turn.memoryRetrievalMs, detail: turn.memoryRetrieverDetail, requested: turn.memoryRetrieverRequested },
        { key: 'eraRetriever', label: 'Era', duration: turn.eraRetrievalMs, detail: turn.eraRetrieverDetail, requested: turn.eraRetrieverRequested },
      ];
      const visible = routes.filter((route) => route.requested || turn[route.key] !== 'waiting');
      const errors = visible.filter((route) => turn[route.key] === 'error');
      const warnings = visible.filter((route) => turn[route.key] === 'warning');
      const active = visible.filter((route) => turn[route.key] === 'active' || route.requested && turn[route.key] === 'waiting');
      const finished = visible.length > 0 && visible.every((route) => ['complete', 'error', 'warning', 'skipped'].includes(turn[route.key]));
      const completed = visible.some((route) => turn[route.key] === 'complete');
      const aggregate = errors.length ? 'error' : warnings.length ? 'warning' : active.length ? 'active'
        : finished && completed ? 'complete' : finished ? 'skipped' : 'waiting';
      turn.retriever = aggregate;
      turn.retrieverLabel = aggregate === 'active' ? '检索中' : aggregate === 'complete' ? '已完成'
        : aggregate === 'error' ? '失败' : aggregate === 'warning' ? 'Timeout' : aggregate === 'skipped' ? '跳过' : '等待';
      turn.retrieverDetail = visible.map((route) => {
        const duration = route.duration === null ? '' : displayDuration(route.duration);
        const suffix = duration || route.detail || '';
        return `${route.label} · ${routeStatusLabel(turn[route.key], { metrics: { skipReason: turn[`${route.key}SkipReason`] }, eventType: '', status: turn[route.key] })}${suffix ? ` · ${suffix}` : ''}`;
      }).join(' / ');
      turn.triggerRetrieverEdge = aggregate === 'active' ? 'active' : aggregate === 'complete' ? 'complete' : aggregate;
      turn.retrieverCoachEdge = aggregate === 'complete' ? 'complete' : aggregate === 'active' ? 'active' : aggregate;
    };
    const updateRetrieverRoute = (routeKey, event, status) => {
      const turn = state.turn;
      turn[routeKey] = status;
      turn[`${routeKey}Label`] = routeStatusLabel(status, event);
      turn[`${routeKey}Requested`] = event.metrics?.skipReason !== 'RETRIEVAL_NOT_REQUESTED';
      const duration = finite(event.durationMs)
        ?? finite(event.metrics?.[routeKey === 'memoryRetriever' ? 'memoryRetrievalMs' : 'eraRetrievalMs']);
      if (routeKey === 'memoryRetriever' && duration !== null) turn.memoryRetrievalMs = duration;
      if (routeKey === 'eraRetriever' && duration !== null) turn.eraRetrievalMs = duration;
      const evidence = finite(event.metrics?.evidenceCount);
      const detail = finite(event.metrics?.[routeKey === 'memoryRetriever' ? 'memoryEvidenceCount' : 'eraEvidenceCount']);
      turn[`${routeKey}Detail`] = duration !== null ? displayDuration(duration)
        : detail !== null ? `命中 ${Math.round(detail)} 条`
          : evidence !== null ? `命中 ${Math.round(evidence)} 条` : '';
      turn[`${routeKey}SkipReason`] = event.metrics?.skipReason || '';
      syncRetrieverNode();
    };
    const updateFallback = (event) => {
      if (event.metrics?.fallbackUsed !== true && event.metrics?.fallbackType !== 'direct_retrieval') return false;
      state.turn.fallback = event.metrics.fallbackType === 'direct_retrieval' ? '直接使用检索结果' : '已启用降级';
      return true;
    };
    const skipPendingSlowNodes = (message) => {
      const turn = state.turn;
      for (const [key, current, label] of [
        ['trigger', turn.trigger, '跳过'], ['retriever', turn.retriever, '跳过'],
        ['coach', turn.coach, '跳过'], ['context', turn.context, '跳过'],
      ]) {
        if (current === 'waiting') {
          turn[key] = 'skipped';
          turn[`${key}Label`] = label;
          if (key === 'retriever' || key === 'context') turn[`${key}Detail`] = message;
        }
      }
      if (turn.memoryRetriever === 'waiting') turn.memoryRetriever = 'skipped';
      if (turn.eraRetriever === 'waiting') turn.eraRetriever = 'skipped';
      syncRetrieverNode();
      turn.slowStatus = message;
      for (const edge of ['voiceTriggerEdge', 'triggerRetrieverEdge', 'retrieverCoachEdge', 'coachContextEdge']) {
        if (turn[edge] === 'waiting') turn[edge] = 'skipped';
      }
    };
    const markSlowTimeout = (message, failed = false) => {
      const turn = state.turn;
      for (const key of ['trigger', 'retriever', 'coach', 'context']) {
        if (turn[key] === 'waiting' || turn[key] === 'active') {
          turn[key] = failed ? 'error' : 'warning';
          turn[`${key}Label`] = failed ? '失败' : 'Timeout';
        }
      }
      for (const key of ['memoryRetriever', 'eraRetriever']) {
        if ((turn[`${key}Requested`] || turn[key] === 'active') && (turn[key] === 'waiting' || turn[key] === 'active')) {
          turn[key] = failed ? 'error' : 'warning';
          turn[`${key}Label`] = failed ? '失败' : 'Timeout';
        }
      }
      syncRetrieverNode();
      turn.slowStatus = turn.fallback ? `Agent Timeout · ${turn.fallback}` : message;
    };
    const beginTurn = () => {
      state.turnNumber += 1;
      state.turn = createTurn(state.turnNumber);
    };
    const updateIdentity = (event) => {
      const metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
      state.environment ||= safeLabel(metadata.environment);
      state.provider ||= providerLabel(metadata.provider);
      state.memoryTriggerMode ||= safeLabel(metadata.memoryTriggerMode || metadata.triggerMode);
      state.agent ||= safeLabel(metadata.agent);
      state.runtime ||= safeLabel(metadata.runtime);
      state.skill ||= safeLabel(metadata.skill || event.metrics?.skill);
      state.model ||= safeLabel(event.metrics?.model || metadata.coachModel);
      if (event.category === 'tool' && event.component === 'realtime-tool' && event.summary === 'memory_recall') state.tool = 'memory_recall';
      state.voiceModel ||= safeLabel(metadata.voiceModel);
      if (typeof event.traceId === 'string' && (typeof event.spanId === 'string' || typeof event.parentSpanId === 'string')) state.traceLinked = true;
      if (typeof event.metrics?.promptTokens === 'number') state.promptTokens = finite(event.metrics.promptTokens);
      if (typeof event.metrics?.completionTokens === 'number') state.completionTokens = finite(event.metrics.completionTokens);
      if (typeof event.metrics?.totalTokens === 'number') state.totalTokens = finite(event.metrics.totalTokens);
      const errorCode = safeErrorCode(event.metrics?.errorCode);
      if (errorCode) state.errorCode = errorCode;
    };

    const applyEvent = (event) => {
      const turn = state.turn;
      const { eventType, metrics: eventMetrics = {} } = event;
      if (eventType === 'realtime.user_speaking') {
        if (turn.number === 0 || turn.awaitingUser || turn.assistantActive) beginTurn();
        state.turn.user = 'active';
        state.turn.userLabel = '正在说话';
        state.turn.fastState = 'user_speaking';
        state.turn.awaitingUser = false;
        state.turn.assistantActive = false;
        state.turn.userVoiceEdge = 'active';
      } else if (eventType === 'realtime.turn_committed') {
        const turnKey = event.metadata?.turnKey;
        if (typeof turnKey === 'string') turn.turnKey = turnKey;
        if (turn.user === 'active') turn.userLabel = '已提交';
      } else if (eventType === 'realtime.connected') {
        turn.voice = 'complete'; turn.voiceLabel = 'Listening'; turn.fastState = 'listening';
      } else if (eventType === 'realtime.model_thinking') {
        turn.user = turn.user === 'active' ? 'complete' : turn.user;
        turn.userLabel = turn.user === 'complete' ? '已提交' : turn.userLabel;
        turn.voice = 'active'; turn.voiceLabel = 'Thinking'; turn.fastState = 'thinking';
        turn.userVoiceEdge = 'complete';
      } else if (eventType === 'realtime.responding') {
        turn.voice = 'active'; turn.voiceLabel = 'Speaking'; turn.fastState = 'responding';
        turn.assistant = 'active'; turn.assistantLabel = '正在回复'; turn.assistantActive = true;
        turn.voiceAssistantEdge = 'active';
        if (event.component === 'realtime-tool-cycle' && turn.context !== 'skipped') {
          if (turn.contextResultReady) {
            turn.context = 'complete'; turn.contextLabel = '已回注';
            turn.contextDetail = turn.fallback || '上下文已回到 Voice Model';
            turn.contextVoiceEdge = 'complete';
          }
        }
      } else if (eventType === 'realtime.listening') {
        if (event.status === 'success') {
          turn.voice = 'complete'; turn.voiceLabel = 'Listening'; turn.fastState = 'listening';
          turn.assistant = 'complete'; turn.assistantLabel = '回复完成'; turn.assistantActive = false; turn.awaitingUser = true;
          turn.voiceAssistantEdge = 'complete';
          if (!turn.slowTriggered) skipPendingSlowNodes('本轮无需检索');
        } else {
          turn.user = turn.user === 'active' ? 'complete' : turn.user;
          turn.userLabel = turn.user === 'complete' ? '已提交' : turn.userLabel;
          turn.voice = 'active'; turn.voiceLabel = 'Listening'; turn.fastState = 'listening';
        }
      } else if (eventType === 'realtime.interrupted') {
        turn.voice = 'warning'; turn.voiceLabel = 'Interrupted'; turn.fastState = 'interrupted';
        turn.assistant = 'warning'; turn.assistantLabel = '已打断'; turn.assistantActive = true;
      } else if (eventType === 'realtime.hold') {
        turn.slowTriggered = true;
        turn.voice = 'active'; turn.voiceLabel = 'Hold'; turn.fastState = 'hold';
        turn.trigger = 'complete'; turn.triggerLabel = '已触发';
        turn.slowStatus = '慢系统运行中';
      } else if (eventType === 'realtime.resume' || eventType === 'realtime.resumed') {
        const sent = event.status === 'success';
        turn.voice = sent ? 'active' : 'error'; turn.voiceLabel = sent ? 'Resuming' : 'Resume 失败'; turn.fastState = sent ? 'resuming' : 'error';
        turn.assistant = sent ? 'active' : 'error'; turn.assistantLabel = sent ? '正在恢复' : '恢复失败'; turn.assistantActive = sent;
        if (sent && turn.contextResultReady) {
          turn.context = 'complete'; turn.contextLabel = '已回注';
          turn.contextDetail = turn.fallback || '上下文已回到 Voice Model';
          turn.contextVoiceEdge = 'complete';
        } else if (!sent && turn.context !== 'skipped') {
          turn.context = 'error'; turn.contextLabel = '注入失败';
          turn.contextDetail = 'Resume 写入失败'; turn.contextVoiceEdge = 'error';
        }
      } else if (eventType === 'realtime.first_audio') {
        const latency = finite(eventMetrics.firstAudioLatencyMs ?? eventMetrics.responseBFirstAudioMs ?? event.durationMs);
        if (latency !== null) turn.firstAudioMs = latency;
        turn.assistant = 'active'; turn.assistantLabel = '首段语音已到'; turn.assistantActive = true;
        turn.voiceAssistantEdge = 'active';
        if (event.component === 'realtime-tool-cycle' && turn.context === 'complete') turn.contextVoiceEdge = 'complete';
        if (!turn.slowTriggered) skipPendingSlowNodes('本轮无需检索');
      }

      if (eventType === 'tool.received' || eventType === 'tool.started') {
        turn.slowTriggered = true;
        turn.trigger = 'active'; turn.triggerLabel = 'Tool Call';
        turn.triggerDetail = event.summary === 'memory_recall' ? 'memory_recall' : 'Tool Call';
        turn.voiceTriggerEdge = 'active'; turn.slowStatus = '等待检索';
        if (eventType === 'tool.started') turn.toolCount += 1;
      } else if (eventType === 'tool.completed') {
        turn.trigger = 'complete'; turn.triggerLabel = 'Tool Result';
        turn.triggerDetail = event.summary === 'memory_recall' ? 'memory_recall' : turn.triggerDetail || 'Tool Result';
        turn.voiceTriggerEdge = 'complete';
        updateFallback(event);
        if (event.status === 'error' || eventMetrics.sent === false || eventMetrics.resultStatus === 'failed') {
          turn.context = 'error'; turn.contextLabel = '结果发送失败'; turn.contextDetail = 'Tool Result 未发送';
          turn.contextResultReady = false; turn.contextVoiceEdge = 'error';
        } else if (eventMetrics.resultStatus === 'no_context') {
          turn.context = 'skipped'; turn.contextLabel = '无上下文'; turn.contextDetail = '无可用上下文';
          turn.contextResultReady = false; turn.contextVoiceEdge = 'skipped'; turn.slowStatus = '无可用上下文';
        } else if (eventMetrics.resultStatus === 'timeout') {
          turn.context = 'warning'; turn.contextLabel = 'Timeout'; turn.contextDetail = '超时，未确认有上下文';
          turn.contextResultReady = false; turn.contextVoiceEdge = 'warning';
        } else if (eventMetrics.resultStatus === 'completed') {
          turn.contextResultReady = true;
          turn.context = 'active'; turn.contextLabel = '等待 Resume';
          turn.contextDetail = `${turn.fallback ? `${turn.fallback} · ` : ''}结果已发送，等待 Resume`;
          turn.coachContextEdge = 'complete'; turn.contextVoiceEdge = 'active';
        }
      } else if (eventType === 'tool.failed') {
        turn.trigger = event.status === 'warning' ? 'warning' : 'error';
        turn.triggerLabel = isTimeout(event) ? 'Timeout' : '失败';
        turn.triggerDetail = safeErrorCode(eventMetrics.errorCode);
        if (turn.context !== 'skipped') {
          turn.context = 'error'; turn.contextLabel = '结果发送失败'; turn.contextDetail = 'Tool Result 未发送';
          turn.contextResultReady = false; turn.contextVoiceEdge = 'error';
        }
      }

      const memoryRetrieverEvent = eventType.startsWith('coach.retrieval.');
      const eraRetrieverEvent = eventType.startsWith('coach.era_retrieval.');
      if (memoryRetrieverEvent || eraRetrieverEvent) {
        turn.slowTriggered = true;
        const status = eventState(event);
        const evidence = finite(eventMetrics.evidenceCount);
        const selected = finite(eventMetrics.selectedEvidenceCount);
        if (evidence !== null) turn.evidenceCount = evidence;
        if (selected !== null) turn.selectedEvidenceCount = selected;
        updateRetrieverRoute(eraRetrieverEvent ? 'eraRetriever' : 'memoryRetriever', event, status);
        turn.trigger = turn.trigger === 'waiting' ? 'complete' : turn.trigger;
        turn.triggerLabel = turn.trigger === 'complete' && turn.triggerLabel === '等待' ? '已触发' : turn.triggerLabel;
      }
      if (eventType.startsWith('retriever.') && state.turn.memoryRetriever === 'waiting' && state.turn.eraRetriever === 'waiting') {
        const status = eventState(event);
        turn.retriever = status;
        turn.retrieverLabel = isTimeout(event) ? 'Timeout' : status === 'active' ? '检索中'
          : status === 'complete' ? '已完成' : status === 'skipped' ? '跳过'
            : status === 'warning' ? '注意' : status === 'error' ? '失败' : '等待';
        const evidence = finite(eventMetrics.evidenceCount);
        if (evidence !== null) turn.evidenceCount = evidence;
        turn.retrieverDetail = event.durationMs !== undefined ? displayDuration(event.durationMs)
          : evidence !== null ? `命中 ${Math.round(evidence)} 条` : '';
        turn.trigger = turn.trigger === 'waiting' ? 'complete' : turn.trigger;
        turn.triggerLabel = turn.trigger === 'complete' && turn.triggerLabel === '等待' ? '已触发' : turn.triggerLabel;
        turn.triggerRetrieverEdge = status === 'active' ? 'active' : status === 'complete' ? 'complete' : status;
      }

      const contextAgent = event.component === 'realtime-context-agent';
      const coachRetriever = event.component === 'realtime-coach-retriever' || event.component === 'realtime-coach-era-retriever';
      const coachRuntime = typeof event.component === 'string' && event.component.startsWith('realtime-coach') && !coachRetriever;
      if (contextAgent || coachRuntime || eventType.startsWith('coach.gate.') || eventType.startsWith('coach.resolve.')) {
        turn.slowTriggered = true;
        const status = eventState(event);
        if (eventType === 'coach.gate.completed') {
          if (typeof eventMetrics.retrieve_memory === 'boolean') turn.memoryRetrieverRequested = eventMetrics.retrieve_memory;
          if (typeof eventMetrics.retrieve_era === 'boolean') turn.eraRetrieverRequested = eventMetrics.retrieve_era;
        }
        if (eventType === 'coach.gate.started') {
          turn.trigger = 'complete'; turn.triggerLabel = '已触发';
          turn.coach = 'active'; turn.coachLabel = '判断检索';
          turn.coachContextEdge = 'active';
        } else if (eventType === 'coach.gate.completed' && eventMetrics.retrieve_memory === false && eventMetrics.retrieve_era === false) {
          turn.memoryRetrieverRequested = false;
          turn.eraRetrieverRequested = false;
          turn.coach = 'complete'; turn.coachLabel = '无需检索';
          turn.retriever = 'skipped'; turn.retrieverLabel = '跳过'; turn.retrieverDetail = '本轮无需检索';
          turn.memoryRetriever = 'skipped'; turn.eraRetriever = 'skipped'; syncRetrieverNode();
          turn.context = 'skipped'; turn.contextLabel = '跳过'; turn.contextDetail = '本轮无需检索';
          turn.slowStatus = '本轮无需检索';
        } else if (eventType === 'coach.pipeline.timeout') {
          markSlowTimeout('Coach Pipeline Timeout');
          turn.slowStatus = 'Coach Pipeline Timeout';
        } else if (eventType === 'coach.applied') {
          turn.coach = 'complete'; turn.coachLabel = '提示已生成';
          turn.coachContextEdge = 'complete';
          if (event.metadata?.triggerMode === 'voice_tool') {
            turn.contextResultReady = true; turn.context = 'active'; turn.contextLabel = '等待 Resume';
            turn.contextDetail = 'Coach 提示已就绪，等待 Resume'; turn.contextVoiceEdge = 'active';
          } else {
            turn.context = 'complete'; turn.contextLabel = '已注入'; turn.contextDetail = 'Coach 提示已回到 Voice Model';
            turn.contextVoiceEdge = 'complete';
          }
        } else if (eventType === 'coach.skipped') {
          turn.coach = 'skipped'; turn.coachLabel = '跳过';
          turn.memoryRetrieverRequested = false;
          turn.eraRetrieverRequested = false;
          if (turn.retriever === 'waiting') turn.retriever = 'skipped';
          if (turn.memoryRetriever === 'waiting') turn.memoryRetriever = 'skipped';
          if (turn.eraRetriever === 'waiting') turn.eraRetriever = 'skipped';
          syncRetrieverNode();
          if (turn.context === 'waiting') { turn.context = 'skipped'; turn.contextDetail = '本轮无需检索'; }
          turn.contextLabel = '跳过'; turn.slowStatus = '本轮无需检索';
        } else {
          turn.coach = status;
          turn.coachLabel = isTimeout(event) ? 'Timeout' : status === 'active' ? '分析中'
            : status === 'complete' ? '已完成' : status === 'warning' ? '注意'
              : status === 'error' ? '失败' : status === 'skipped' ? '跳过' : '等待';
          if (safeLabel(eventMetrics.model)) state.model = safeLabel(eventMetrics.model);
          if (safeLabel(eventMetrics.skill)) state.skill = safeLabel(eventMetrics.skill);
          if (event.durationMs !== undefined) turn.coachDetail = displayDuration(event.durationMs);
          const selected = finite(eventMetrics.selectedEvidenceCount);
          if (selected !== null) turn.selectedEvidenceCount = selected;
          turn.coachContextEdge = status === 'complete' ? 'complete' : status;
        }
        if (updateFallback(event)) {
          turn.coachDetail = turn.coachDetail || 'Agent 超时';
          turn.slowStatus = isTimeout(event) ? `Agent Timeout · ${turn.fallback}` : `已回退 · ${turn.fallback}`;
        }
      }

      if (eventType === 'evidence.ready') {
        turn.slowTriggered = true;
        const selected = finite(eventMetrics.selectedEvidenceCount);
        if (selected !== null) turn.selectedEvidenceCount = selected;
        updateFallback(event);
        turn.context = 'active'; turn.contextLabel = '提示已就绪';
        turn.contextDetail = `${turn.fallback ? `${turn.fallback} · ` : ''}${selected === null ? '等待注入' : `${Math.round(selected)} 条提示已就绪 · 等待注入`}`;
        turn.coachContextEdge = 'complete'; turn.slowStatus = turn.fallback ? `已回退 · ${turn.fallback}` : 'Context Hint 已就绪 · 等待注入';
      } else if (eventType === 'evidence.injected') {
        turn.context = event.status === 'success' ? 'complete' : 'error';
        turn.contextLabel = event.status === 'success' ? '已注入' : '注入失败';
        turn.contextDetail = event.status === 'success' ? turn.fallback || '上下文已发送' : '上下文发送失败';
        turn.contextVoiceEdge = event.status === 'success' ? 'complete' : 'error';
        turn.slowStatus = event.status === 'success' ? 'Context Hint 已注入' : 'Context Hint 注入失败';
      } else if (eventType === 'evidence.injection_failed') {
        turn.context = 'error'; turn.contextLabel = '注入失败'; turn.contextDetail = '上下文发送失败';
        turn.contextVoiceEdge = 'error'; turn.slowStatus = 'Context Hint 注入失败';
      } else if (eventType === 'evidence.no_context') {
        turn.context = 'skipped'; turn.contextLabel = '无上下文'; turn.contextDetail = '无可用上下文';
        turn.contextResultReady = false; turn.contextVoiceEdge = 'skipped'; turn.slowStatus = '无可用上下文';
      }

      if (eventType.startsWith('realtime.slow_path.result.')) {
        const result = eventType.slice('realtime.slow_path.result.'.length);
        const duration = finite(event.durationMs ?? eventMetrics.totalMs);
        if (duration !== null) turn.slowLatencyMs = duration;
        if (result === 'timeout') markSlowTimeout('Slow Coach Timeout');
        else if (result === 'failed') markSlowTimeout('Slow Coach 失败 · 快速语音继续', true);
        else if (result === 'aborted' || result === 'stale') turn.slowStatus = `慢系统已${result === 'stale' ? '丢弃过期结果' : '中止'}`;
        else if (result === 'completed' && turn.slowStatus === '等待本轮信号') turn.slowStatus = '慢系统已完成';
      } else if (coachRuntime && finite(eventMetrics.totalMs ?? event.durationMs) !== null) {
        turn.slowLatencyMs = finite(eventMetrics.totalMs ?? event.durationMs);
      }

      const directSlowLatency = finite(eventMetrics.totalMs);
      if (directSlowLatency !== null && (event.component === 'realtime-coach' || eventType === 'coach.applied' || eventType === 'coach.skipped')) {
        turn.slowLatencyMs = directSlowLatency;
      }
      const error = safeErrorCode(eventMetrics.errorCode);
      if (error) state.errorCode = error;
    };

    const renderNode = (key, stateKey, labelKey, detailKey) => {
      const turn = state.turn;
      setNode(key, turn[stateKey], turn[labelKey], detailKey ? turn[detailKey] : '');
    };
    const getCompactObserverStatus = () => {
      const turn = state.turn;
      const failure = [
        ['context', turn.context, 'Context', turn.contextLabel || turn.contextDetail],
        ['coach', turn.coach, 'Coach Agent', turn.coachLabel || turn.coachDetail],
        ['memory', turn.memoryRetriever, 'Memory Retriever', turn.memoryRetrieverLabel || turn.memoryRetrieverDetail],
        ['era', turn.eraRetriever, 'Era Retriever', turn.eraRetrieverLabel || turn.eraRetrieverDetail],
        ['retriever', turn.retriever, 'Retriever', turn.retrieverLabel || turn.retrieverDetail],
        ['trigger', turn.trigger, 'Tool Call', turn.triggerLabel || turn.triggerDetail],
        ['voice', turn.voice, 'Voice', turn.voiceLabel],
      ].find(([, status]) => status === 'error' || status === 'warning');
      if (failure) return {
        state: failure[1] === 'error' ? 'error' : 'warning', label: failure[2], detail: failure[3] || '需要关注',
      };

      if (turn.context === 'active') return { state: 'live', label: 'Context', detail: turn.contextDetail || '正在回注' };
      if (turn.coach === 'active') return { state: 'live', label: 'Coach Agent', detail: turn.coachDetail || '分析中' };
      const activeRoutes = [
        ['Memory', turn.memoryRetriever], ['Era', turn.eraRetriever],
      ].filter(([, status]) => status === 'active');
      if (activeRoutes.length) return {
        state: 'live', label: activeRoutes.length === 2 ? 'Memory + Era' : `${activeRoutes[0][0]} Retriever`, detail: '检索中',
      };
      if (turn.retriever === 'active') return { state: 'live', label: 'Retriever', detail: turn.retrieverDetail || '检索中' };
      if (turn.trigger === 'active') return { state: 'live', label: 'Tool Call', detail: turn.triggerDetail || 'memory_recall' };
      if (turn.fastState === 'user_speaking') return { state: 'live', label: 'Voice', detail: 'User speaking' };
      if (turn.fastState === 'resuming') return { state: 'live', label: 'Voice', detail: 'Resuming' };
      if (turn.fastState === 'responding') return { state: 'live', label: 'Voice', detail: 'Speaking' };
      if (turn.fastState === 'thinking') return { state: 'live', label: 'Voice', detail: 'Thinking' };
      if (turn.fastState === 'listening') return { state: 'live', label: 'Voice', detail: 'Listening' };
      return state.sessionId
        ? { state: 'live', label: 'LIVE', detail: '等待下一轮' }
        : { state: 'waiting', label: '技术观测', detail: '等待采访' };
    };
    const buildEventRow = (event, detailed) => {
      const row = document.createElement('li');
      row.className = 'tech-event';
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
      const timingEvent = event.component === 'nemo-retriever' || event.component === 'realtime-context-agent'
        || event.component?.startsWith('realtime-coach') || event.component === 'realtime-slow-path'
        || event.component === 'realtime-tool-cycle' || event.component === 'realtime-tool'
        || event.eventType === 'realtime.resume';
      const duration = document.createElement('span');
      duration.textContent = finite(event.durationMs) !== null ? displayDuration(event.durationMs) : timingEvent ? '—' : '';
      title.append(titleText, duration);
      content.append(title);
      const summary = event.category === 'tool' && event.component === 'realtime-tool' && event.summary === 'memory_recall' ? 'memory_recall' : '';
      if (summary) {
        const detail = document.createElement('p');
        detail.className = 'tech-event-summary';
        detail.textContent = summary;
        content.append(detail);
      }
      if (detailed) {
        const keys = expectedMetrics(event);
        if (keys.length) {
          const detail = document.createElement('p');
          detail.className = 'tech-event-metrics';
          detail.textContent = keys.map((key) => `${metricLabels[key]}: ${metricValue(key, event.metrics?.[key])}`).join(' · ');
          content.append(detail);
        }
      }
      row.append(time, content);
      return row;
    };
    const render = () => {
      const turn = state.turn;
      if (turnLabel) turnLabel.textContent = turn.number > 0 ? `TURN #${turn.number}` : 'TURN —';
      if (environmentLabel) environmentLabel.textContent = state.environment ? `LOCAL / ${state.environment}` : 'LOCAL';
      if (modelLabel) modelLabel.textContent = state.voiceModel || 'Voice Model';
      if (voiceModelLabel) voiceModelLabel.textContent = state.voiceModel || 'Voice Model';
      if (slowStatusLabel) {
        slowStatusLabel.textContent = turn.slowStatus;
        slowStatusLabel.dataset.state = turn.slowStatus.includes('Timeout') || turn.slowStatus.includes('失败') ? 'warning' : 'waiting';
      }
      renderNode('user', 'user', 'userLabel');
      renderNode('voice', 'voice', 'voiceLabel');
      renderNode('assistant', 'assistant', 'assistantLabel');
      renderNode('trigger', 'trigger', 'triggerLabel', 'triggerDetail');
      renderNode('retriever', 'retriever', 'retrieverLabel', 'retrieverDetail');
      renderNode('coach', 'coach', 'coachLabel', 'coachDetail');
      renderNode('context', 'context', 'contextLabel', 'contextDetail');
      setEdge('edge-user-voice', turn.userVoiceEdge);
      setEdge('edge-voice-assistant', turn.voiceAssistantEdge);
      setEdge('edge-voice-trigger', turn.voiceTriggerEdge);
      setEdge('edge-trigger-retriever', turn.triggerRetrieverEdge);
      setEdge('edge-retriever-coach', turn.retrieverCoachEdge);
      setEdge('edge-coach-context', turn.coachContextEdge);
      setEdge('edge-context-voice', turn.contextVoiceEdge);
      if (metrics['metric-first-audio']) metrics['metric-first-audio'].textContent = displayDuration(turn.firstAudioMs);
      if (metrics['metric-slow-latency']) metrics['metric-slow-latency'].textContent = displayDuration(turn.slowLatencyMs);
      if (metrics['metric-evidence']) {
        const recalled = turn.evidenceCount === null ? '' : String(Math.round(turn.evidenceCount));
        const selected = turn.selectedEvidenceCount === null ? '' : String(Math.round(turn.selectedEvidenceCount));
        metrics['metric-evidence'].textContent = recalled && selected ? `${recalled} → ${selected}` : recalled || selected || '—';
      }
      if (metrics['metric-tool-count']) metrics['metric-tool-count'].textContent = turn.number > 0 ? String(turn.toolCount) : '—';
      if (empty) empty.hidden = state.events.length > 0;
      if (sessionLabel) sessionLabel.textContent = state.sessionId ? '当前采访' : '—';
      if (traceLabel) traceLabel.textContent = state.traceLinked ? '已关联' : '—';
      if (eventCountLabel) eventCountLabel.textContent = String(state.events.length);
      const recent = state.events.slice(-6);
      if (recentCountLabel) recentCountLabel.textContent = String(recent.length);
      recentList.replaceChildren(...recent.map((event) => buildEventRow(event, false)));
      fullList.replaceChildren(...state.events.map((event) => buildEventRow(event, true)));
      if (detailFields.environment) detailFields.environment.textContent = state.environment || '—';
      if (detailFields.provider) detailFields.provider.textContent = state.provider || '—';
      if (detailFields.memoryTriggerMode) detailFields.memoryTriggerMode.textContent = state.memoryTriggerMode || '—';
      if (detailFields.agent) detailFields.agent.textContent = state.agent || '—';
      if (detailFields.runtime) detailFields.runtime.textContent = state.runtime || '—';
      if (detailFields.modelSkill) detailFields.modelSkill.textContent = [state.model, state.skill].filter(Boolean).join(' · ') || '—';
      if (detailFields.tool) detailFields.tool.textContent = state.tool || turn.triggerDetail || '—';
      if (detailFields.tokens) {
        const tokenParts = [['Prompt', state.promptTokens], ['Completion', state.completionTokens], ['Total', state.totalTokens]]
          .filter(([, value]) => value !== null).map(([label, value]) => `${label} ${Math.round(value)}`);
        detailFields.tokens.textContent = tokenParts.join(' · ') || '—';
      }
      if (detailFields.fallback) detailFields.fallback.textContent = turn.fallback || '—';
      if (detailFields.error) detailFields.error.textContent = state.errorCode || '—';
      const compact = getCompactObserverStatus();
      if (compactState) compactState.textContent = compact.state === 'live' ? 'LIVE' : compact.state.toUpperCase();
      if (compactLabel) compactLabel.textContent = `${compact.label} · ${compact.detail}`;
      if (compactDot) compactDot.dataset.state = compact.state;
    };

    const displayEvent = (event) => {
      if (!event || typeof event !== 'object' || !allowedCategories.has(event.category) || typeof event.eventType !== 'string') return;
      if (typeof event.eventId === 'string') {
        if (eventIds.has(event.eventId)) return;
        eventIds.add(event.eventId);
      }
      const metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
      const eventTurnKey = typeof metadata.turnKey === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(metadata.turnKey) ? metadata.turnKey : '';
      const toolCallKey = typeof metadata.toolCallKey === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(metadata.toolCallKey) ? metadata.toolCallKey : '';
      const responseKey = typeof metadata.responseKey === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(metadata.responseKey) ? metadata.responseKey : '';
      if (event.eventType === 'realtime.turn_committed' && eventTurnKey) {
        if (state.turn.number === 0 || state.turn.awaitingUser || state.turn.assistantActive) beginTurn();
        state.turn.turnKey = eventTurnKey;
      }
      if ((event.eventType === 'tool.received' || event.eventType === 'tool.started') && eventTurnKey && toolCallKey) {
        toolCallTurns.set(toolCallKey, eventTurnKey);
        if (toolCallTurns.size > 100) toolCallTurns.delete(toolCallTurns.keys().next().value);
      }
      const isResponseStart = event.eventType === 'realtime.model_thinking' || event.eventType === 'realtime.responding';
      let unownedResponseStart = false;
      if (responseKey && isResponseStart && !responseTurns.has(responseKey)) {
        const owner = eventTurnKey || (toolCallKey ? toolCallTurns.get(toolCallKey) : '')
          || (toolCallKey ? '' : state.turn.turnKey);
        responseTurns.set(responseKey, owner || null);
        unownedResponseStart = !owner && !toolCallKey && !eventTurnKey;
        if (responseTurns.size > 100) responseTurns.delete(responseTurns.keys().next().value);
      }
      const responseTurnKey = responseKey && responseTurns.has(responseKey) ? responseTurns.get(responseKey) : '';
      const correlatedTurnKey = eventTurnKey || (toolCallKey ? toolCallTurns.get(toolCallKey) : '') || responseTurnKey;
      const requiresCorrelation = Boolean(eventTurnKey || toolCallKey || responseKey);
      const belongsToCurrentTurn = !requiresCorrelation
        || Boolean(correlatedTurnKey && state.turn.turnKey && correlatedTurnKey === state.turn.turnKey)
        || unownedResponseStart;
      if (belongsToCurrentTurn) {
        updateIdentity(event);
        applyEvent(event);
      }
      state.events.push(event);
      while (state.events.length > 100) {
        const removed = state.events.shift();
        if (typeof removed?.eventId === 'string') eventIds.delete(removed.eventId);
      }
      render();
    };

    const applyTechStatus = (message) => {
      if (!message || typeof message !== 'object' || message.stage !== 'fast_voice') return;
      const model = safeLabel(message.model);
      if (model && !state.voiceModel) state.voiceModel = model;
      if (safeLabel(message.skill)) state.skill ||= safeLabel(message.skill);
      const status = message.status === 'completed' || message.status === 'ready' ? 'complete'
        : message.status === 'failed' ? 'error' : message.status === 'skipped' ? 'skipped'
          : message.status === 'started' ? 'active' : '';
      const turn = state.turn;
      if (message.stage === 'fast_voice' && status) {
        turn.voice = status; turn.voiceLabel = status === 'complete' ? '就绪' : status === 'active' ? 'Thinking' : status === 'error' ? '失败' : '跳过';
      }
      const error = safeErrorCode(message.errorCode);
      if (error) state.errorCode = error;
      render();
    };

    const stopStream = () => { source?.close(); source = undefined; };
    const clearSession = () => {
      stopStream();
      eventIds.clear();
      toolCallTurns.clear();
      responseTurns.clear();
      state.events = [];
      state.voiceModel = ''; state.provider = ''; state.environment = ''; state.memoryTriggerMode = '';
      state.agent = ''; state.runtime = ''; state.model = ''; state.skill = ''; state.tool = '';
      state.promptTokens = null; state.completionTokens = null; state.totalTokens = null;
      state.errorCode = ''; state.traceLinked = false; state.turnNumber = 0; state.turn = createTurn(0);
    };
    const clearForAuthChange = (detail) => {
      const nextUserId = typeof detail?.userId === 'string' ? detail.userId : null;
      if (nextUserId === state.authenticatedUserId) return;
      state.authenticatedUserId = nextUserId;
      state.sessionId = '';
      clearSession();
      render();
      setLive('waiting', 'WAITING');
    };

    window.addEventListener('interview:auth-changed', (event) => clearForAuthChange(event.detail));
    window.addEventListener('interview:tech-status', (event) => applyTechStatus(event.detail));
    let authChannel;
    try {
      if (typeof BroadcastChannel === 'function') {
        authChannel = new BroadcastChannel('life-interview-auth');
        authChannel.addEventListener('message', (event) => clearForAuthChange(event.data));
        window.addEventListener('pagehide', () => authChannel.close(), { once: true });
      }
    } catch { /* Cross-tab observer cleanup is best effort. */ }

    const isCompactMode = () => window.matchMedia
      ? window.matchMedia('(max-width: 1080px)').matches : window.innerWidth <= 1080;
    const focusableInSheet = () => [...panel.querySelectorAll('button, a, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.disabled && !element.hidden);
    const syncPresentation = () => {
      const compact = isCompactMode();
      if (!compact) sheetOpen = false;
      panel.hidden = !observerEnabled;
      panel.classList.toggle('is-sheet-open', compact && observerEnabled && sheetOpen);
      panel.setAttribute('aria-hidden', String(compact && !sheetOpen));
      if (compact && sheetOpen && observerEnabled) {
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
      } else {
        panel.setAttribute('role', 'region');
        panel.removeAttribute?.('aria-modal');
      }
      layout.classList.toggle('has-tech-observer', observerEnabled);
      if (compactBar) compactBar.hidden = !observerEnabled || !compact;
      if (backdrop) backdrop.hidden = !compact || !observerEnabled || !sheetOpen;
      toggle.setAttribute('aria-expanded', String(observerEnabled && (!compact || sheetOpen)));
      toggle.setAttribute('aria-pressed', String(observerEnabled));
      if (document.body?.style) {
        document.body.style.overflow = compact && sheetOpen ? 'hidden' : '';
      }
    };
    const setSheetOpen = (open, restoreFocus = true) => {
      if (open && (!observerEnabled || !isCompactMode())) return;
      if (open) sheetPreviousFocus = document.activeElement;
      sheetOpen = open;
      syncPresentation();
      if (open) {
        requestAnimationFrame(() => (sheetClose || panel).focus());
      } else if (restoreFocus && sheetPreviousFocus && typeof sheetPreviousFocus.focus === 'function') {
        sheetPreviousFocus.focus();
        sheetPreviousFocus = undefined;
      }
    };
    const connect = () => {
      if (source) return;
      if (!state.sessionId || !observerEnabled) {
        setLive('waiting', state.sessionId ? 'PAUSED' : 'WAITING');
        return;
      }
      try {
        source = new EventSource(`/api/observability/events?sessionId=${encodeURIComponent(state.sessionId)}`);
        source.onopen = () => setLive('live', 'LIVE');
        source.onerror = () => setLive('reconnecting', 'RECONNECTING');
        source.addEventListener('observation', (message) => {
          try { displayEvent(JSON.parse(message.data)); } catch { /* Ignore malformed observer data only. */ }
        });
      } catch {
        setLive('reconnecting', 'OFFLINE');
      }
    };
    const setObserverEnabled = (enabled) => {
      observerEnabled = enabled;
      if (!enabled) {
        setSheetOpen(false, false);
        stopStream();
        setLive('waiting', state.sessionId ? 'PAUSED' : 'WAITING');
      }
      syncPresentation();
      if (enabled) connect();
    };

    toggle.addEventListener('click', () => setObserverEnabled(!observerEnabled));
    compactBar?.addEventListener('click', () => setSheetOpen(true));
    sheetClose?.addEventListener('click', () => setSheetOpen(false));
    backdrop?.addEventListener('click', () => setSheetOpen(false));
    window.addEventListener('keydown', (event) => {
      if (!sheetOpen || !isCompactMode()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setSheetOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableInSheet();
      if (!focusable.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    const mediaQuery = window.matchMedia?.('(max-width: 1080px)');
    mediaQuery?.addEventListener?.('change', () => syncPresentation());
    window.addEventListener('resize', () => syncPresentation());
    window.addEventListener('pagehide', () => stopStream(), { once: true });
    window.addEventListener('interview:session', (event) => {
      const nextSessionId = typeof event.detail?.sessionId === 'string' ? event.detail.sessionId : '';
      if (nextSessionId === state.sessionId) return;
      state.sessionId = nextSessionId;
      clearSession();
      render();
      if (observerEnabled) connect();
    });

    render();
    setObserverEnabled(new URLSearchParams(window.location.search).get('demo') === 'tech');
  }
} catch {
  // The optional observer is isolated from interview controls and audio playback.
}
