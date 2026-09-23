import {
  canResumeRealtimeListening,
  canSchedulePlaybackSegment,
  createPlaybackScheduleQueue,
  decodePcmSamplesWithMetrics,
  isOutputAudioPlaybackPending,
  pcm16MonoDurationMs,
  shouldInterruptOutputAudioOnEnd,
} from '/audio-format.js';
import { automaticEndReason, realtimeCallStatus, resolveRealtimeProvider, shouldIgnoreAssistantResponseMessage } from '/interview-state.js';
import {
  createOnboardingStartMessage,
  isStoryInterviewRoute,
  onboardingEndUrl,
  onboardingHomeView,
} from '/onboarding-ui.js';
import { createTextDisclosure } from '/text-disclosure.js';

const pageParams = new URLSearchParams(window.location.search);
const debugMode = pageParams.get('debug') === '1';
const shareToken = pageParams.get('share_token')?.trim() || '';
if (debugMode) document.body.classList.add('debug-mode');

const elements = {
  authCard: document.querySelector('#auth-card'),
  authCopy: document.querySelector('#auth-copy'),
  authMessage: document.querySelector('#auth-message'),
  phoneInput: document.querySelector('#phone-input'),
  codeInput: document.querySelector('#code-input'),
  verificationControls: document.querySelector('#verification-controls'),
  developmentLogin: document.querySelector('#development-login'),
  legacyLoginButton: document.querySelector('#legacy-login-button'),
  requestCodeButton: document.querySelector('#request-code-button'),
  verifyButton: document.querySelector('#verify-button'),
  logoutButton: document.querySelector('#logout-button'),
  interviewCard: document.querySelector('.interview-card'),
  interviewKicker: document.querySelector('#interview-kicker'),
  conversationCard: document.querySelector('.conversation-card'),
  precallPanel: document.querySelector('#precall-panel'),
  precallLabel: document.querySelector('#precall-label'),
  precallStoryTitle: document.querySelector('#precall-story-title'),
  precallStage: document.querySelector('#precall-stage'),
  precallLast: document.querySelector('#precall-last'),
  precallLastToggle: document.querySelector('#precall-last-toggle'),
  precallTopic: document.querySelector('#precall-topic'),
  precallPrompts: document.querySelector('#precall-prompts'),
  onboardingWelcome: document.querySelector('#onboarding-welcome'),
  onboardingModeLabel: document.querySelector('#onboarding-mode-label'),
  onboardingTitle: document.querySelector('#onboarding-title'),
  onboardingCopy: document.querySelector('#onboarding-copy'),
  onboardingReassurance: document.querySelector('#onboarding-reassurance'),
  storyInterviewControls: document.querySelector('#story-interview-controls'),
  providerLabel: document.querySelector('#provider-label'),
  targetMode: document.querySelector('#interview-mode'),
  existingStoryControls: document.querySelector('#existing-story-controls'),
  newStoryControls: document.querySelector('#new-story-controls'),
  stageSelect: document.querySelector('#stage-select'),
  storyTitleInput: document.querySelector('#story-title-input'),
  privacyNote: document.querySelector('#privacy-note'),
  storySelect: document.querySelector('#story-select'),
  storyHeading: document.querySelector('#story-heading'),
  storyMeta: document.querySelector('#story-meta'),
  statusPill: document.querySelector('#status-pill'),
  statusText: document.querySelector('#status-text'),
  startButton: document.querySelector('#start-button'),
  startButtonLabel: document.querySelector('#start-button-label'),
  endButton: document.querySelector('#end-button'),
  duration: document.querySelector('#duration'),
  conversation: document.querySelector('#conversation'),
  emptyState: document.querySelector('#empty-state'),
  emptyStateTitle: document.querySelector('#empty-state-title'),
  liveLine: document.querySelector('#live-line'),
  liveSpeaker: document.querySelector('#live-speaker'),
  liveText: document.querySelector('#live-text'),
  callStoryTitle: document.querySelector('#call-story-title'),
  callContextCopy: document.querySelector('#call-context-copy'),
  callStage: document.querySelector('#call-stage'),
  callStateText: document.querySelector('#call-state-text'),
  callStageCopy: document.querySelector('#call-stage-copy'),
  callStatus: document.querySelector('#call-status'),
  callTimer: document.querySelector('#call-timer'),
  muteButton: document.querySelector('#mute-button'),
  speakerButton: document.querySelector('#speaker-button'),
  callControls: document.querySelector('#call-controls'),
  callEndButton: document.querySelector('#call-end-button'),
  connectionNote: document.querySelector('#connection-note'),
  externalCloseoutRetry: document.querySelector('#external-closeout-retry'),
  externalCloseoutRetryMessage: document.querySelector('#external-closeout-retry-message'),
  externalCloseoutRetryButton: document.querySelector('#external-closeout-retry-button'),
};

const state = {
  websocket: null,
  mediaStream: null,
  audioContext: null,
  audioSource: null,
  workletNode: null,
  muteNode: null,
  playbackGain: null,
  playbackCursor: 0,
  playbackNodes: new Set(),
  playbackScheduleQueue: createPlaybackScheduleQueue(),
  audioRemainders: new Map(),
  audioResumePromise: null,
  audioContextInfo: {},
  audioSetupGeneration: 0,
  startupTraceEvents: [],
  playbackReadySent: false,
  microphoneStreaming: false,
  sessionId: null,
  traceStartedAt: 0,
  activeResponseId: null,
  responseAudioStats: new Map(),
  traceTurn: {
    nextTurnId: 0,
    pendingSpeechTurn: null,
    latestUserTurn: null,
    latestAssistantTurn: null,
    responseTurns: new Map(),
  },
  microphonePacketCount: 0,
  lastMicrophonePacketAt: null,
  suppressedResponseIds: new Set(),
  pendingScrollEvents: 0,
  scrollTraceTimer: null,
  audioSettings: {},
  messageRows: new Map(),
  messageRowsByProviderId: new Map(),
  startedAt: 0,
  timer: null,
  lifecycle: 'idle',
  pendingAssistantRow: null,
  endTimer: null,
  endResolve: null,
  autoEndGeneration: 0,
  maxSessionMs: 20 * 60 * 1000,
  providerConfigured: false,
  realtimeProvider: 'stepfun',
  providers: {},
  databaseAvailable: false,
  stories: [],
  lifeStages: [],
  verificationChallengeId: null,
  authMode: 'sms',
  authenticatedProfile: null,
  onboardingStatus: null,
  interviewType: 'story',
  shareToken,
  sharedStory: null,
  debugMode,
  isMuted: false,
  isSpeakerOn: true,
};

const precallLastDisclosure = createTextDisclosure({
  content: elements.precallLast,
  toggle: elements.precallLastToggle,
});

const realtimeProviderLabels = {
  qwen: 'Qwen Realtime',
  stepfun: 'Step-Audio 2 Mini Realtime',
};

const PLAYBACK_SCHEDULE_AHEAD_SECONDS = 0.12;
const MAX_PLAYBACK_SCHEDULE_AHEAD_SECONDS = 0.85;
const PLAYBACK_SEGMENT_SAMPLES = 6_000;

function sendDiagnosticTrace(event, clientElapsedMs, details) {
  if (state.websocket?.readyState !== WebSocket.OPEN || !state.sessionId) return false;
  state.websocket.send(JSON.stringify({ type: 'diagnostic_trace', event, clientElapsedMs, details }));
  return true;
}

function flushStartupTraceEvents() {
  const pending = state.startupTraceEvents.splice(0);
  for (const entry of pending) {
    sendDiagnosticTrace(entry.event, entry.clientElapsedMs, entry.details);
  }
}

function traceClient(event, details = {}) {
  const now = performance.now();
  if (!state.traceStartedAt) state.traceStartedAt = now;
  const clientElapsedMs = Number((now - state.traceStartedAt).toFixed(2));
  const entry = {
    at: new Date().toISOString(),
    elapsed_ms: clientElapsedMs,
    session_id: state.sessionId || undefined,
    event,
    ...details,
  };
  console.info('[interview-trace]', JSON.stringify(entry));
  if (sendDiagnosticTrace(event, clientElapsedMs, details)) return;
  if (!state.sessionId && state.lifecycle === 'connecting' && state.startupTraceEvents.length < 100) {
    state.startupTraceEvents.push({ event, clientElapsedMs, details });
  }
}

function resetTraceTurnState() {
  state.traceTurn = {
    nextTurnId: 0,
    pendingSpeechTurn: null,
    latestUserTurn: null,
    latestAssistantTurn: null,
    responseTurns: new Map(),
  };
}

function roundTraceMilliseconds(value) {
  return Number(Math.max(0, value).toFixed(2));
}

function traceElapsedSince(startedAt, endedAt) {
  return startedAt === undefined || startedAt === null
    ? undefined
    : roundTraceMilliseconds(endedAt - startedAt);
}

function markTraceStage(stage, details = {}) {
  const at = performance.now();
  const traceTurn = state.traceTurn;
  const points = {
    speech_stopped: 'A',
    user_final: 'B',
    assistant_started: 'C',
    first_audio: 'D',
  };
  const responseId = typeof details.responseId === 'string' && details.responseId.trim()
    ? details.responseId
    : undefined;
  const createTurn = () => ({ id: ++traceTurn.nextTurnId });
  const annotate = (turn, extra = {}) => ({
    ...details,
    ...extra,
    tracePoint: points[stage],
    stage,
    turnId: turn.id,
  });

  if (stage === 'speech_stopped') {
    if (traceTurn.pendingSpeechTurn?.speechStoppedAt !== undefined
      && traceTurn.pendingSpeechTurn.userFinalAt === undefined) return { ...details };
    const turn = createTurn();
    turn.speechStoppedAt = at;
    traceTurn.pendingSpeechTurn = turn;
    traceTurn.latestUserTurn = turn;
    return annotate(turn);
  }

  if (stage === 'user_final') {
    const turn = traceTurn.pendingSpeechTurn
      || (traceTurn.latestUserTurn?.speechStoppedAt !== undefined
        && traceTurn.latestUserTurn.userFinalAt === undefined
        ? traceTurn.latestUserTurn
        : null);
    if (!turn) {
      if (traceTurn.latestUserTurn?.userFinalAt !== undefined) return { ...details };
      const created = createTurn();
      created.userFinalAt = at;
      traceTurn.latestUserTurn = created;
      return annotate(created);
    }
    turn.userFinalAt = at;
    traceTurn.pendingSpeechTurn = null;
    traceTurn.latestUserTurn = turn;
    const speechStoppedToUserFinalMs = traceElapsedSince(turn.speechStoppedAt, at);
    return annotate(turn, speechStoppedToUserFinalMs === undefined ? {} : { speechStoppedToUserFinalMs });
  }

  if (stage === 'assistant_started') {
    if (responseId && traceTurn.responseTurns.has(responseId)) return { ...details };
    if (!responseId && traceTurn.latestAssistantTurn?.assistantStartedAt !== undefined) return { ...details };
    const turn = traceTurn.latestUserTurn?.userFinalAt !== undefined
      && traceTurn.latestUserTurn.assistantStartedAt === undefined
      ? traceTurn.latestUserTurn
      : createTurn();
    turn.assistantStartedAt = at;
    turn.responseId = responseId;
    if (responseId) traceTurn.responseTurns.set(responseId, turn);
    traceTurn.latestAssistantTurn = turn;
    const userFinalToAssistantStartedMs = traceElapsedSince(turn.userFinalAt, at);
    return annotate(turn, userFinalToAssistantStartedMs === undefined ? {} : { userFinalToAssistantStartedMs });
  }

  const turn = (responseId ? traceTurn.responseTurns.get(responseId) : null)
    || (traceTurn.latestAssistantTurn
      && (!responseId || traceTurn.latestAssistantTurn.responseId === responseId)
      ? traceTurn.latestAssistantTurn
      : null)
    || createTurn();
  if (turn.firstAudioAt !== undefined) return { ...details };
  turn.firstAudioAt = at;
  if (responseId && !traceTurn.responseTurns.has(responseId)) traceTurn.responseTurns.set(responseId, turn);
  traceTurn.latestAssistantTurn = turn;
  const speechStoppedToUserFinalMs = turn.userFinalAt === undefined
    ? undefined
    : traceElapsedSince(turn.speechStoppedAt, turn.userFinalAt);
  const userFinalToAssistantStartedMs = turn.assistantStartedAt === undefined
    ? undefined
    : traceElapsedSince(turn.userFinalAt, turn.assistantStartedAt);
  const assistantStartedToFirstAudioMs = traceElapsedSince(turn.assistantStartedAt, at);
  return annotate(turn, {
    ...(speechStoppedToUserFinalMs === undefined ? {} : { speechStoppedToUserFinalMs }),
    ...(userFinalToAssistantStartedMs === undefined ? {} : { userFinalToAssistantStartedMs }),
    ...(assistantStartedToFirstAudioMs === undefined ? {} : { assistantStartedToFirstAudioMs }),
  });
}

function microphoneTimingDetails() {
  return {
    micPacketCount: state.microphonePacketCount,
    micPacketAgeMs: state.lastMicrophonePacketAt === null
      ? null
      : performance.now() - state.lastMicrophonePacketAt,
  };
}

function responseAudioStats(responseId = state.activeResponseId) {
  const key = responseId || 'unknown';
  let stats = state.responseAudioStats.get(key);
  if (!stats) {
    stats = {
      responseId: key,
      responseStartedAt: performance.now(),
      outputStartedAt: null,
      firstReceivedAt: null,
      lastReceivedAt: null,
      chunks: 0,
      bytes: 0,
      scheduledChunks: 0,
      droppedChunks: 0,
      pendingScheduleCount: 0,
      queuedAudioMs: 0,
      maxQueuedAudioMs: 0,
      pcmDurationMs: 0,
      playbackStartedAt: null,
      responseDoneAt: null,
      maxArrivalGapMs: 0,
      maxScheduleGapMs: 0,
      maxPlaybackDelayMs: 0,
      lastSample: null,
      maxBoundaryJump: 0,
      maxPeak: 0,
      maxRms: 0,
      terminalSampleAbs: 0,
      clippedSamples: 0,
      nonFiniteSamples: 0,
      completedStatus: null,
    };
    state.responseAudioStats.set(key, stats);
  }
  return stats;
}

function writeResponseAudioSummary(responseId, stats) {
  const key = responseId || 'unknown';
  traceClient('output_audio_summary', {
    responseId: key,
    status: stats.completedStatus || 'unknown',
    chunks: stats.chunks,
    bytes: stats.bytes,
    pcmDurationMs: stats.pcmDurationMs,
    maxQueuedAudioMs: stats.maxQueuedAudioMs,
    scheduledChunks: stats.scheduledChunks,
    droppedChunks: stats.droppedChunks,
    firstAudioMs: stats.firstReceivedAt === null
      ? null
      : stats.firstReceivedAt - (stats.outputStartedAt ?? stats.responseStartedAt),
    maxArrivalGapMs: stats.maxArrivalGapMs,
    maxScheduleGapMs: stats.maxScheduleGapMs,
    maxPlaybackDelayMs: stats.maxPlaybackDelayMs,
    maxBoundaryJump: stats.maxBoundaryJump,
    maxPeak: stats.maxPeak,
    maxRms: stats.maxRms,
    terminalSampleAbs: stats.terminalSampleAbs,
    clippedSamples: stats.clippedSamples,
    nonFiniteSamples: stats.nonFiniteSamples,
    contextState: state.audioContext?.state || 'missing',
    pendingNodes: state.playbackNodes.size,
  });
  state.responseAudioStats.delete(key);
  state.audioRemainders.delete(key);
}

function finishResponseAudioTrace(responseId, status) {
  const key = responseId || state.activeResponseId || 'unknown';
  const stats = responseAudioStats(key);
  stats.completedStatus = status || 'unknown';
  if (stats.pendingScheduleCount === 0) writeResponseAudioSummary(key, stats);
}

function updateRealtimeAvailability() {
  const provider = state.realtimeProvider;
  const providerState = state.providers[provider] || {};
  const config = providerState;
  const label = realtimeProviderLabels[provider];
  if (elements.providerLabel) elements.providerLabel.textContent = label;
  state.providerConfigured = Boolean(providerState.configured);
  if (elements.privacyNote) {
    elements.privacyNote.textContent = state.interviewType === 'onboarding'
      ? `点击开始后会通过麦克风与${label}开始人生建档对话；仅最终字幕写入 Transcript，不保存音频文件。`
      : `开始后会通过麦克风与${label}实时对话；仅最终字幕写入 Transcript，不保存音频文件。`;
  }

  if (state.lifecycle !== 'idle') return;
  elements.startButton.disabled = !canStartInterview();
  if (!state.databaseAvailable) return;
  if (!state.providerConfigured) {
    elements.connectionNote.textContent = `数据库已连接；尚未配置${label}凭证。`;
    setStatus('idle', `待配置${label}`);
    return;
  }
  elements.connectionNote.textContent = provider === 'qwen'
    ? `数据库已连接 · Qwen ${config.region || 'Realtime'}${config.model ? ` · ${config.model}` : ''}`
    : `数据库已连接 · StepFun ${config.model || 'step-audio-2-mini'} Realtime`;
  setStatus('idle', '未开始');
}

function canStartInterview() {
  if (!state.databaseAvailable || !state.providerConfigured || state.lifecycle !== 'idle') return false;
  if (state.interviewType === 'external_contributor') return Boolean(state.shareToken && state.sharedStory);
  if (!state.authenticatedProfile) return false;
  if (state.interviewType === 'onboarding') return true;
  return elements.targetMode?.value === 'create'
    ? state.lifeStages.length > 0
    : state.stories.length > 0;
}

function renderPrecall() {
  if (!elements.precallPanel) return;
  const isStoryInterview = state.interviewType === 'story';
  const isExternalContributor = state.interviewType === 'external_contributor';
  elements.precallPanel.hidden = !(isStoryInterview || isExternalContributor);
  if (!isStoryInterview && !isExternalContributor) return;

  if (isExternalContributor) {
    const story = state.sharedStory || {};
    const gaps = Array.isArray(story.gaps)
      ? story.gaps.filter((gap) => typeof gap === 'string' && gap.trim()).slice(0, 3)
      : [];
    elements.precallLabel.textContent = '补充这段故事';
    elements.precallStoryTitle.textContent = story.title || '这段人生故事';
    elements.precallStage.textContent = '从你的视角留下记忆';
    elements.precallLast.textContent = story.summary
      ? `目前整理到：${story.summary}`
      : '这段故事还没有整理出摘要，从你记得最清楚的地方开始就好。';
    precallLastDisclosure.setExpanded(false);
    precallLastDisclosure.refresh();
    elements.precallTopic.hidden = false;
    elements.precallTopic.textContent = gaps[0] || '从你最有印象的一个细节开始就好。';
    elements.precallPrompts.replaceChildren();
    const prompts = gaps.length > 1
      ? gaps.slice(1)
      : ['你当时看到了什么？', '有什么是主人公可能没有注意到的？'];
    for (const prompt of prompts) {
      const item = document.createElement('li');
      item.textContent = prompt;
      elements.precallPrompts.append(item);
    }
    return;
  }

  const creating = elements.targetMode?.value === 'create';
  const selected = state.stories.find((story) => story.story_id === elements.storySelect?.value)
    || state.stories[0];
  const stage = state.lifeStages.find((item) => item.stage_id === elements.stageSelect?.value)
    || state.lifeStages[0];
  const stageTitle = creating
    ? (stage?.title || '一个人生阶段')
    : (selected?.stage_title || '当前人生阶段');
  const title = creating ? '一段新故事' : (selected?.title || '这次想聊聊什么？');
  const summary = !creating && typeof selected?.summary === 'string' ? selected.summary.trim() : '';
  const gaps = !creating && Array.isArray(selected?.gaps)
    ? selected.gaps.filter((gap) => typeof gap === 'string' && gap.trim()).slice(0, 3)
    : [];

  elements.precallLabel.textContent = creating ? '开始一段新故事' : '继续一段故事';
  elements.precallStoryTitle.textContent = title;
  elements.precallStage.textContent = creating
    ? `记录在「${stageTitle}」里`
    : `属于「${stageTitle}」`;
  elements.precallLast.textContent = summary
    ? `上次聊到：${summary}`
    : (creating ? '你可以从一个具体的时刻、一个人，或一件改变你的事说起。' : '这里还没有上一段摘要，从你记得最清楚的地方开始就好。');
  precallLastDisclosure.setExpanded(false);
  precallLastDisclosure.refresh();
  const primaryGap = gaps[0] || '';
  elements.precallTopic.hidden = creating;
  elements.precallTopic.textContent = creating
    ? ''
    : (primaryGap || '从你还想补充的具体细节开始就好。');
  elements.precallPrompts.replaceChildren();
  const prompts = creating
    ? ['这件事大概发生在什么时候？', '当时谁和你在一起？', '现在回头看，它对你意味着什么？']
    : primaryGap
      ? gaps.slice(1)
      : ['最近还会想起哪个细节？', '那段经历后来怎样影响了你？', '还有谁的视角值得留下？'];
  for (const prompt of prompts) {
    const item = document.createElement('li');
    item.textContent = prompt;
    elements.precallPrompts.append(item);
  }
}

function updateInterviewTargetMode() {
  const creating = elements.targetMode?.value === 'create';
  elements.existingStoryControls.hidden = creating;
  elements.newStoryControls.hidden = !creating;
  if (creating) {
    elements.storyHeading.textContent = '采访并新建 Story';
    elements.storyMeta.textContent = '先讲述经历，整理成功后会在所选人生阶段下创建 Story。';
  } else {
    const selected = state.stories.find((story) => story.story_id === elements.storySelect?.value);
    elements.storyHeading.textContent = selected?.title || '选择一个已有故事';
    elements.storyMeta.textContent = selected
      ? `${selected.stage_title || '未分类'} · ${selected.summary || '采访结束后会整理故事摘要'} · 完整 Transcript 会保留`
      : '继续已有 Story；采访结束后会整理摘要并保留完整 Transcript。';
  }
  elements.startButton.disabled = !canStartInterview();
  renderPrecall();
}

const statusLabels = {
  idle: '准备开始',
  connecting: '连接中',
  active: '正在听',
  'user-speaking': '正在听你说',
  thinking: '正在理解',
  responding: '采访官正在说',
  ending: '正在结束',
  ended: '已结束',
  error: '连接失败',
};

const statusDescriptions = {
  idle: '准备好后，开始这次采访。',
  connecting: '正在建立连接，请稍候。',
  active: '从你记得最清楚的地方开始就好。',
  'user-speaking': '我在听，慢慢说就好。',
  thinking: '正在理解你刚才说的内容。',
  responding: '请听采访官的回应。',
  ending: '正在保存这次访谈。',
  ended: '这次访谈已经结束。',
  error: '连接遇到问题，请稍后重试。',
};

function setStatus(status, label = statusLabels[status] || status) {
  elements.statusPill.dataset.state = status;
  elements.statusText.textContent = label;
  if (elements.conversationCard) elements.conversationCard.dataset.state = status;
  if (elements.callStage) elements.callStage.dataset.state = status;
  if (elements.callStateText) elements.callStateText.textContent = label;
  if (elements.callStageCopy) elements.callStageCopy.textContent = statusDescriptions[status] || '';
  if (elements.callStatus) {
    elements.callStatus.dataset.state = status;
    elements.callStatus.textContent = label;
  }
}

function updateCallStatusFromEvent(message) {
  const nextStatus = realtimeCallStatus(message.type, state.lifecycle);
  if (nextStatus) setStatus(nextStatus.status, nextStatus.label);
}

function setLifecycle(lifecycle) {
  state.lifecycle = lifecycle;
  const microphoneStreaming = lifecycle === 'active' || lifecycle === 'responding';
  if (state.microphoneStreaming !== microphoneStreaming) {
    state.microphoneStreaming = microphoneStreaming;
    traceClient(microphoneStreaming ? 'microphone_stream_resumed' : 'microphone_stream_paused', {
      lifecycle,
      microphoneStreaming,
      mode: lifecycle === 'responding' ? 'barge_in_monitoring' : microphoneStreaming ? 'listening' : 'paused',
    });
  }
  if (elements.callControls) elements.callControls.hidden = !['active', 'responding'].includes(lifecycle);
  if (lifecycle === 'idle') {
    elements.startButton.disabled = !canStartInterview();
    elements.endButton.disabled = true;
    elements.targetMode.disabled = false;
    elements.storySelect.disabled = elements.targetMode.value === 'create' || state.stories.length === 0;
    elements.stageSelect.disabled = elements.targetMode.value !== 'create' || state.lifeStages.length === 0;
    elements.storyTitleInput.disabled = elements.targetMode.value !== 'create';
    if (elements.callEndButton) {
      elements.callEndButton.disabled = true;
      elements.callEndButton.hidden = true;
    }
  } else if (lifecycle === 'connecting') {
    elements.startButton.disabled = true;
    elements.endButton.disabled = true;
    elements.targetMode.disabled = true;
    elements.storySelect.disabled = true;
    elements.stageSelect.disabled = true;
    elements.storyTitleInput.disabled = true;
    if (elements.callEndButton) {
      elements.callEndButton.disabled = true;
      elements.callEndButton.hidden = true;
    }
  } else if (lifecycle === 'active' || lifecycle === 'responding') {
    elements.startButton.disabled = true;
    elements.endButton.disabled = false;
    elements.targetMode.disabled = true;
    elements.storySelect.disabled = true;
    elements.stageSelect.disabled = true;
    elements.storyTitleInput.disabled = true;
    if (elements.callEndButton) {
      elements.callEndButton.disabled = false;
      elements.callEndButton.hidden = false;
    }
  } else {
    elements.startButton.disabled = true;
    elements.endButton.disabled = true;
    elements.targetMode.disabled = true;
    elements.storySelect.disabled = true;
    elements.stageSelect.disabled = true;
    elements.storyTitleInput.disabled = true;
    if (elements.callEndButton) {
      elements.callEndButton.disabled = true;
      elements.callEndButton.hidden = true;
    }
  }
}

function showLive(speaker, text = '') {
  elements.liveLine.hidden = false;
  elements.liveSpeaker.textContent = speaker;
  elements.liveText.textContent = text;
}

function hideLive() {
  elements.liveLine.hidden = true;
  elements.liveText.textContent = '';
}

function clearEmptyState() {
  if (elements.emptyState?.isConnected) elements.emptyState.remove();
}

function removeAssistantQuestion() {
  elements.conversation.querySelectorAll('.message-row[data-role="assistant"]').forEach((row) => row.remove());
  state.pendingAssistantRow = null;
}

function addMessage(role, text, { providerMessageId, pending = false } = {}) {
  if (role === 'user') return null;
  removeAssistantQuestion();
  clearEmptyState();
  const row = document.createElement('article');
  row.className = `message-row${pending ? ' is-pending' : ''}`;
  row.dataset.role = role;
  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = role === 'user' ? '我' : '访';
  const content = document.createElement('div');
  content.className = 'message-content';
  const name = document.createElement('div');
  name.className = 'message-name';
  name.textContent = role === 'user' ? '你' : '采访官';
  const saved = document.createElement('span');
  saved.className = 'saved-mark';
  if (!pending) saved.textContent = '';
  name.append(saved);
  const paragraph = document.createElement('p');
  paragraph.className = 'message-text';
  paragraph.textContent = text;
  content.append(name, paragraph);
  row.append(avatar, content);
  elements.conversation.append(row);
  elements.conversation.scrollTop = elements.conversation.scrollHeight;

  const key = `${role}:${providerMessageId || `local-${Date.now()}-${Math.random()}`}`;
  state.messageRows.set(key, row);
  if (providerMessageId) state.messageRowsByProviderId.set(`${role}:${providerMessageId}`, row);
  return row;
}

function markSaved(role, providerMessageId, messageId) {
  const row = state.messageRowsByProviderId.get(`${role}:${providerMessageId}`);
  if (!row) return;
  row.classList.remove('is-pending');
  const saved = row.querySelector('.saved-mark');
  if (saved) saved.textContent = messageId ? '已保存' : '已写入';
}

function updateRowText(row, text) {
  if (!row) return;
  const paragraph = row.querySelector('.message-text');
  if (paragraph) paragraph.textContent = text;
  elements.conversation.scrollTop = elements.conversation.scrollHeight;
}

function markRowSavedById(role, providerMessageId, messageId) {
  const row = state.messageRowsByProviderId.get(`${role}:${providerMessageId}`);
  if (row) {
    markSaved(role, providerMessageId, messageId);
    return;
  }
  if (role === 'assistant' && state.pendingAssistantRow && state.pendingAssistantRow.dataset.providerId === providerMessageId) {
    state.pendingAssistantRow.classList.remove('is-pending');
    const saved = state.pendingAssistantRow.querySelector('.saved-mark');
    if (saved) saved.textContent = messageId ? '已保存' : '已写入';
  }
}

function stopPlayback(responseId) {
  state.playbackScheduleQueue.invalidate(responseId);
  const stoppedNodes = [...state.playbackNodes].filter((node) => !responseId || node.__interviewResponseId === responseId);
  for (const node of stoppedNodes) {
    state.playbackNodes.delete(node);
    try { node.stop(); } catch { /* already stopped */ }
  }
  state.playbackCursor = state.audioContext
    ? Math.max(
        state.audioContext.currentTime + PLAYBACK_SCHEDULE_AHEAD_SECONDS,
        ...[...state.playbackNodes].map((node) => node.__scheduledEndTime || 0),
      )
    : 0;
  if (responseId) state.audioRemainders.delete(responseId);
  else state.audioRemainders.clear();
}

function outputPlaybackState() {
  const pendingScheduleCount = [...state.responseAudioStats.values()].reduce(
    (total, stats) => total + Math.max(0, Number(stats.pendingScheduleCount) || 0),
    0,
  );
  const contextState = state.audioContext?.state || 'missing';
  const currentTime = state.audioContext?.currentTime || 0;
  const outputAudioPending = isOutputAudioPlaybackPending({
    contextState,
    currentTime,
    playbackCursor: state.playbackCursor,
    playbackNodeCount: state.playbackNodes.size,
    pendingScheduleCount,
  });
  return {
    outputAudioPending,
    pendingScheduleCount,
    contextState,
    currentTime,
    playbackCursor: state.playbackCursor,
    playbackNodeCount: state.playbackNodes.size,
  };
}

function base64ByteLength(value) {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function completePcmSamples(bytes, encoding, responseId) {
  const bytesPerSample = encoding === 'pcm_s16le' ? 2 : 0;
  if (!bytesPerSample) throw new Error(`不支持的语音音频格式：${encoding}`);
  let audioState = state.audioRemainders.get(responseId) || { encoding, remainder: new Uint8Array(0) };
  if (audioState.encoding !== encoding) audioState = { encoding, remainder: new Uint8Array(0) };

  let combined = bytes;
  if (audioState.remainder.byteLength > 0) {
    combined = new Uint8Array(audioState.remainder.byteLength + bytes.byteLength);
    combined.set(audioState.remainder);
    combined.set(bytes, audioState.remainder.byteLength);
  }
  const completeByteLength = combined.byteLength - (combined.byteLength % bytesPerSample);
  audioState.remainder = combined.slice(completeByteLength);
  state.audioRemainders.set(responseId, audioState);
  return combined.subarray(0, completeByteLength);
}

async function playPcmChunk(base64, encoding = 'pcm_s16le', responseId = 'unknown', chunk = 0, isCurrent = () => true) {
  if (!isCurrent() || state.suppressedResponseIds.has(responseId)) {
    return { scheduled: false, reason: 'response_interrupted' };
  }
  const context = state.audioContext;
  if (!context || !base64) return null;
  let decoded;
  let bytes;
  try {
    bytes = completePcmSamples(base64ToBytes(base64), encoding, responseId);
    if (bytes.byteLength === 0) return { scheduled: false, reason: 'incomplete_sample' };
    decoded = decodePcmSamplesWithMetrics(bytes, encoding);
  } catch (error) {
    traceClient('audio_decode_error', {
      reason: error instanceof Error ? error.name : 'unknown',
      bytes: typeof base64 === 'string' ? Math.floor(base64.length * 3 / 4) : 0,
      contextState: context.state,
    });
    showError(error instanceof Error ? error.message : '语音音频格式无法解码。');
    return { scheduled: false, reason: 'decode_error' };
  }
  const { samples } = decoded;
  if (samples.length === 0) return { scheduled: false, reason: 'empty_samples' };
  const stats = responseAudioStats(responseId);
  const boundaryJump = stats.lastSample === null ? 0 : Math.abs(stats.lastSample - decoded.firstSample);
  stats.lastSample = decoded.lastSample;
  stats.maxBoundaryJump = Math.max(stats.maxBoundaryJump, boundaryJump);
  stats.maxPeak = Math.max(stats.maxPeak, decoded.peak);
  stats.maxRms = Math.max(stats.maxRms, decoded.rms);
  stats.terminalSampleAbs = Math.abs(decoded.lastSample);
  stats.clippedSamples += decoded.clippedSamples;
  stats.nonFiniteSamples += decoded.nonFiniteSamples;
  if (context.state !== 'running') {
    if (!state.audioResumePromise) {
      state.audioResumePromise = context.resume().then(() => {
        traceClient('audio_context_resume', { contextState: context.state });
        return context.state === 'running';
      }).catch((error) => {
        traceClient('audio_context_resume_failed', {
          contextState: context.state,
          reason: error instanceof Error ? error.name : 'unknown',
        });
        return false;
      }).finally(() => {
        state.audioResumePromise = null;
      });
    }
    const resumed = await state.audioResumePromise;
    if (!resumed || context !== state.audioContext || context.state !== 'running') {
      return { scheduled: false, reason: 'context_not_running' };
    }
  }
  if (!isCurrent() || state.suppressedResponseIds.has(responseId)) {
    return { scheduled: false, reason: 'response_interrupted' };
  }
  let scheduledSegments = 0;
  let maxScheduleGapMs = 0;
  let maxPlaybackDelayMs = 0;
  for (let offset = 0, segment = 0; offset < samples.length; offset += PLAYBACK_SEGMENT_SAMPLES, segment += 1) {
    const segmentSamples = samples.subarray(offset, Math.min(samples.length, offset + PLAYBACK_SEGMENT_SAMPLES));
    while (context.state === 'running'
      && !canSchedulePlaybackSegment({
        currentTime: context.currentTime,
        playbackCursor: state.playbackCursor,
        segmentDurationSeconds: segmentSamples.length / 24_000,
        startLeadSeconds: PLAYBACK_SCHEDULE_AHEAD_SECONDS,
        maxAheadSeconds: MAX_PLAYBACK_SCHEDULE_AHEAD_SECONDS,
      })
      && isCurrent()
      && !state.suppressedResponseIds.has(responseId)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!isCurrent() || context !== state.audioContext || state.suppressedResponseIds.has(responseId)) {
      return {
        scheduled: scheduledSegments > 0,
        reason: 'response_interrupted',
        bytes: bytes.byteLength,
        samples: samples.length,
        segmentCount: scheduledSegments,
        maxScheduleGapMs,
        maxPlaybackDelayMs,
        boundaryJump,
      };
    }
    if (context.state !== 'running') {
      return {
        scheduled: scheduledSegments > 0,
        reason: 'context_not_running',
        bytes: bytes.byteLength,
        samples: samples.length,
        segmentCount: scheduledSegments,
        maxScheduleGapMs,
        maxPlaybackDelayMs,
        boundaryJump,
      };
    }
    const audioBuffer = context.createBuffer(1, segmentSamples.length, 24_000);
    audioBuffer.copyToChannel(segmentSamples, 0);
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(state.playbackGain || context.destination);
    const previousCursor = state.playbackCursor;
    const when = Math.max(context.currentTime + PLAYBACK_SCHEDULE_AHEAD_SECONDS, previousCursor);
    const scheduleGapMs = previousCursor > 0 ? Math.max(0, (when - previousCursor) * 1000) : 0;
    const playbackDelayMs = Math.max(0, (when - context.currentTime) * 1000);
    maxScheduleGapMs = Math.max(maxScheduleGapMs, scheduleGapMs);
    maxPlaybackDelayMs = Math.max(maxPlaybackDelayMs, playbackDelayMs);
    state.playbackCursor = when + audioBuffer.duration;
    source.__interviewResponseId = responseId;
    source.__scheduledEndTime = state.playbackCursor;
    state.playbackNodes.add(source);
    const startCalledAt = performance.now();
    source.addEventListener('ended', () => {
      const endedAt = performance.now();
      state.playbackNodes.delete(source);
      traceClient('output_audio_node_ended', {
        responseId,
        chunk,
        segment,
        contextTimeMs: context.currentTime * 1000,
        scheduledContextTimeMs: when * 1000,
        contextElapsedSinceScheduledStartMs: Math.max(0, context.currentTime - when) * 1000,
        nodeLifetimeMs: endedAt - startCalledAt,
        contextState: context.state,
        pendingNodes: state.playbackNodes.size,
      });
    }, { once: true });
    source.start(when);
    if (stats.playbackStartedAt === null) {
      stats.playbackStartedAt = performance.now();
      traceClient('playback_response_started', {
        responseId,
        chunk,
        segment,
        scheduledContextTimeMs: when * 1000,
        contextTimeMs: context.currentTime * 1000,
        pcmDurationMs: samples.length / 24_000 * 1000,
      });
    }
    traceClient('output_audio_node_start_called', {
      responseId,
      chunk,
      segment,
      contextTimeMs: context.currentTime * 1000,
      scheduledContextTimeMs: when * 1000,
      contextState: context.state,
      pendingNodes: state.playbackNodes.size,
    });
    scheduledSegments += 1;
  }
  return {
    scheduled: scheduledSegments > 0,
    bytes: bytes.byteLength,
    samples: samples.length,
    segmentCount: scheduledSegments,
    pcmDurationMs: samples.length / 24_000 * 1000,
    scheduleGapMs: maxScheduleGapMs,
    playbackDelayMs: maxPlaybackDelayMs,
    contextState: context.state,
    boundaryJump,
    peak: decoded.peak,
    rms: decoded.rms,
    terminalSampleAbs: Math.abs(decoded.lastSample),
    clippedSamples: decoded.clippedSamples,
    nonFiniteSamples: decoded.nonFiniteSamples,
  };
}

function updateDuration() {
  if (!state.startedAt) return;
  const seconds = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
  const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
  const remainder = String(seconds % 60).padStart(2, '0');
  const formatted = `${minutes}:${remainder}`;
  elements.duration.textContent = formatted;
  if (elements.callTimer) elements.callTimer.textContent = formatted;
}

function stopMicrophone() {
  if (state.workletNode) {
    state.workletNode.port.onmessage = null;
    state.workletNode.disconnect();
    state.workletNode = null;
  }
  if (state.audioSource) {
    state.audioSource.disconnect();
    state.audioSource = null;
  }
  if (state.muteNode) {
    state.muteNode.disconnect();
    state.muteNode = null;
  }
  if (state.mediaStream) {
    for (const track of state.mediaStream.getTracks()) track.stop();
    state.mediaStream = null;
  }
}

function cleanupAudio() {
  state.audioSetupGeneration += 1;
  state.autoEndGeneration += 1;
  state.playbackScheduleQueue.invalidate();
  stopMicrophone();
  if (state.audioContext) {
    void state.audioContext.close();
    state.audioContext = null;
  }
  state.playbackGain = null;
  state.playbackNodes.clear();
  state.playbackCursor = 0;
  state.audioRemainders.clear();
  state.suppressedResponseIds.clear();
  state.microphoneStreaming = false;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

function scheduleAutomaticEnd(reason, responseId, stats) {
  if (!['active', 'responding', 'ending'].includes(state.lifecycle)) return;
  if (state.lifecycle === 'active') setLifecycle('responding');
  setStatus('responding', reason === 'timeout' ? '正在播放收尾语音' : '告别语播放完将自动结束');
  const endGeneration = ++state.autoEndGeneration;
  void drainResponsePlayback(responseId, stats, { endReason: reason, endGeneration });
}

function waitForEnd(timeoutMs = 32_000) {
  if (state.endResolve) return Promise.resolve();
  return new Promise((resolve) => {
    state.endResolve = resolve;
    state.endTimer = setTimeout(() => {
      state.endResolve = null;
      state.endTimer = null;
      resolve();
    }, timeoutMs);
  });
}

function outputAudioState() {
  const context = state.audioContext;
  let pendingScheduleCount = 0;
  for (const [responseId, stats] of state.responseAudioStats) {
    if (!state.suppressedResponseIds.has(responseId)) {
      pendingScheduleCount += stats.pendingScheduleCount;
    }
  }
  return {
    contextState: context?.state || 'missing',
    currentTime: context?.currentTime || 0,
    playbackCursor: state.playbackCursor,
    playbackNodeCount: state.playbackNodes.size,
    pendingScheduleCount,
  };
}

async function waitForOutputAudioDrain(timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  while (isOutputAudioPlaybackPending(outputAudioState()) && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isOutputAudioPlaybackPending(outputAudioState());
}

async function drainResponsePlayback(responseId, stats, { endReason, endGeneration } = {}) {
  const responseDoneAt = stats.responseDoneAt ?? performance.now();
  const timeoutMs = endReason ? 25_000 : 30_000;
  traceClient('playback_response_draining', {
    responseId,
    lifecycle: state.lifecycle,
    chunks: stats.chunks,
    bytes: stats.bytes,
    pendingScheduleCount: outputAudioState().pendingScheduleCount,
    playbackNodes: state.playbackNodes.size,
    playbackCursorAheadMs: Math.max(0, (state.playbackCursor - (state.audioContext?.currentTime || 0)) * 1000),
    microphoneStreaming: state.microphoneStreaming,
  });
  const drained = await waitForOutputAudioDrain(timeoutMs);
  if (!drained) {
    state.suppressedResponseIds.add(responseId);
    if (state.activeResponseId === responseId) stopPlayback(responseId);
  }
  const playback = outputAudioState();
  const responseDoneToPlaybackDrainMs = performance.now() - responseDoneAt;
  traceClient(drained ? 'playback_response_drained' : 'playback_response_drain_timeout', {
    responseId,
    lifecycle: state.lifecycle,
    status: stats.completedStatus || 'unknown',
    drained,
    chunks: stats.chunks,
    bytes: stats.bytes,
    pcmDurationMs: stats.pcmDurationMs,
    maxQueuedAudioMs: stats.maxQueuedAudioMs,
    pendingScheduleCount: playback.pendingScheduleCount,
    playbackNodes: playback.playbackNodeCount,
    playbackCursorAheadMs: Math.max(0, (playback.playbackCursor - playback.currentTime) * 1000),
    responseDoneToPlaybackDrainMs,
    microphoneStreaming: state.microphoneStreaming,
  });

  if (state.activeResponseId === responseId) state.activeResponseId = null;
  if (endReason) {
    if (state.autoEndGeneration !== endGeneration || state.lifecycle === 'ending') {
      traceClient('auto_end_cancelled', { reason: endReason, responseId, lifecycle: state.lifecycle });
      return;
    }
    traceClient('auto_end_after_playback', {
      reason: endReason,
      drained,
      playbackPending: isOutputAudioPlaybackPending(playback),
    });
    void endInterview(endReason);
    return;
  }
  if (canResumeRealtimeListening({
    lifecycle: state.lifecycle,
    status: stats.completedStatus,
    playbackPending: isOutputAudioPlaybackPending(playback),
    responseMatches: state.activeResponseId === null,
  })) {
    setLifecycle('active');
    updateCallStatusFromEvent({ type: 'playback_drained' });
  }
}

function finishUi(message, hasError = false) {
  cleanupAudio();
  if (state.websocket && state.websocket.readyState <= WebSocket.OPEN) {
    state.websocket.close();
  }
  state.websocket = null;
  if (state.endTimer) clearTimeout(state.endTimer);
  state.endTimer = null;
  if (state.endResolve) state.endResolve();
  state.endResolve = null;
  state.startedAt = 0;
  if (state.lifecycle !== 'idle') {
    setLifecycle(hasError ? 'failed' : 'finished');
    setStatus(hasError ? 'error' : 'ended', message || (hasError ? '发生错误' : '已结束'));
  }
}

function showError(message) {
  setStatus('error', '发生错误');
  elements.connectionNote.textContent = message;
  elements.storyMeta.textContent = message;
}

async function setupMicrophone() {
  // Construct/resume the output context inside the Start button's user gesture,
  // before the permission prompt yields control to the browser.
  state.audioContext = new AudioContext();
  const context = state.audioContext;
  const setupGeneration = ++state.audioSetupGeneration;
  context.addEventListener('statechange', () => {
    traceClient('audio_context_state', { contextState: context.state });
  });
  const resumePromise = context.resume().then(() => true).catch((error) => {
    traceClient('audio_context_resume_failed', {
      contextState: context.state,
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return false;
  });
  const workletPromise = context.audioWorklet.addModule('/audio-worklet.js');
  const mediaPromise = navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: { ideal: 1 },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    },
    video: false,
  }).then((mediaStream) => {
    if (setupGeneration !== state.audioSetupGeneration || context !== state.audioContext) {
      for (const track of mediaStream.getTracks()) track.stop();
    } else {
      state.mediaStream = mediaStream;
    }
    return mediaStream;
  });
  const [mediaStream] = await Promise.all([mediaPromise, workletPromise]);
  if (setupGeneration !== state.audioSetupGeneration || context !== state.audioContext) {
    for (const track of mediaStream.getTracks()) track.stop();
    throw new Error('麦克风初始化已取消，请重新开始采访。');
  }
  const resumed = await resumePromise;
  if (!resumed || context.state !== 'running') {
    throw new Error('浏览器音频尚未就绪，请重新点击开始聊天。');
  }
  state.audioSettings = mediaStream.getAudioTracks()[0]?.getSettings?.() || {};

  state.audioSource = context.createMediaStreamSource(state.mediaStream);
  const targetSampleRate = state.realtimeProvider === 'qwen' ? 16000 : 24000;
  const frameSamples = targetSampleRate / 50;
  state.workletNode = new AudioWorkletNode(context, 'interview-pcm-resampler', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { targetSampleRate, frameSamples },
  });
  state.muteNode = context.createGain();
  state.muteNode.gain.value = 0;
  state.playbackGain = context.createGain();
  state.playbackGain.gain.value = state.isSpeakerOn ? 1 : 0;
  state.playbackGain.connect(context.destination);
  state.audioSource.connect(state.workletNode);
  state.workletNode.connect(state.muteNode);
  state.muteNode.connect(state.audioContext.destination);
  state.workletNode.port.onmessage = (event) => {
    const streamMicrophone = state.microphoneStreaming;
    if (state.websocket?.readyState === WebSocket.OPEN && streamMicrophone) {
      state.websocket.send(event.data);
      state.microphonePacketCount += 1;
      state.lastMicrophonePacketAt = performance.now();
    }
  };
  state.audioContextInfo = {
    contextState: context.state,
    sampleRate: context.sampleRate,
    baseLatencyMs: context.baseLatency * 1000,
    outputLatencyMs: typeof context.outputLatency === 'number' ? context.outputLatency * 1000 : undefined,
    echoCancellation: state.audioSettings.echoCancellation ?? null,
    noiseSuppression: state.audioSettings.noiseSuppression ?? null,
    autoGainControl: state.audioSettings.autoGainControl ?? null,
  };
  traceClient('audio_context_ready', state.audioContextInfo);
  traceClient('microphone_ready', {
    contextState: context.state,
    sampleRate: context.sampleRate,
    microphoneStreaming: state.microphoneStreaming,
  });
}

function flushScrollTrace() {
  if (state.scrollTraceTimer) {
    clearTimeout(state.scrollTraceTimer);
    state.scrollTraceTimer = null;
  }
  if (state.pendingScrollEvents === 0) return;
  const eventCount = state.pendingScrollEvents;
  state.pendingScrollEvents = 0;
  traceClient('scroll_activity', {
    eventCount,
    responseActive: state.lifecycle === 'responding',
    contextState: state.audioContext?.state || 'missing',
    pendingNodes: state.playbackNodes.size,
  });
}

document.addEventListener('wheel', () => {
  if (!state.sessionId || !['active', 'responding'].includes(state.lifecycle)) return;
  state.pendingScrollEvents += 1;
  if (state.scrollTraceTimer) return;
  state.scrollTraceTimer = setTimeout(flushScrollTrace, 250);
}, { passive: true });

function connectRealtime() {
  return new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const realtimePath = state.interviewType === 'external_contributor'
      ? `/api/realtime?share_token=${encodeURIComponent(state.shareToken)}`
      : '/api/realtime';
    const socket = new WebSocket(`${protocol}//${location.host}${realtimePath}`);
    socket.binaryType = 'arraybuffer';
    state.websocket = socket;
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('连接本机语音服务超时。'));
        socket.close();
      }
    }, 20_000);

    socket.addEventListener('open', () => {
      traceClient('websocket_connected', { contextState: state.audioContext?.state || 'missing' });
      const startMessage = state.interviewType === 'onboarding'
        ? createOnboardingStartMessage(state.realtimeProvider)
        : state.interviewType === 'external_contributor'
          ? {
              type: 'start',
              interview_type: 'external_contributor',
              provider: state.realtimeProvider,
            }
          : {
              type: 'start',
              ...(elements.targetMode.value === 'create'
                ? {
                    stage_id: elements.stageSelect.value,
                    ...(elements.storyTitleInput.value.trim()
                      ? { story_title: elements.storyTitleInput.value.trim() }
                      : {}),
                  }
                : { story_id: elements.storySelect.value }),
              provider: state.realtimeProvider,
            };
      socket.send(JSON.stringify(startMessage));
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }

      if (shouldIgnoreAssistantResponseMessage(state.lifecycle, message.type)) {
        const responseId = typeof message.responseId === 'string' ? message.responseId : undefined;
        if (responseId) state.suppressedResponseIds.add(responseId);
        traceClient('late_assistant_message_ignored', {
          type: message.type,
          responseId: responseId || 'unknown',
        });
        return;
      }

      if (message.type === 'ready') {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(message);
        }
        state.sessionId = message.sessionId;
        flushStartupTraceEvents();
        state.microphonePacketCount = 0;
        state.lastMicrophonePacketAt = null;
        state.maxSessionMs = Number(message.maxSessionMs) || 20 * 60 * 1000;
        traceClient('provider_session_ready', {
          contextState: state.audioContext?.state || 'missing',
          sampleRate: state.audioContext?.sampleRate,
        });
        if (state.interviewType === 'story') {
          const currentTitle = message.story?.title || state.stories.find((story) => story.story_id === elements.storySelect?.value)?.title || '当前故事';
          elements.storyHeading.textContent = currentTitle;
          if (elements.callStoryTitle) elements.callStoryTitle.textContent = currentTitle;
          if (elements.callContextCopy) elements.callContextCopy.textContent = message.story?.stage_title || '';
        } else if (state.interviewType === 'external_contributor') {
          const currentTitle = message.story?.title || state.sharedStory?.title || '这段人生故事';
          elements.storyHeading.textContent = currentTitle;
          if (elements.callStoryTitle) elements.callStoryTitle.textContent = currentTitle;
          if (elements.callContextCopy) elements.callContextCopy.textContent = '从你的视角补充这段故事';
        } else {
          if (elements.callStoryTitle) elements.callStoryTitle.textContent = '人生地图';
          if (elements.callContextCopy) elements.callContextCopy.textContent = '从你想说的地方开始就好';
        }
        elements.connectionNote.textContent = `Session ${message.sessionId}`;
        traceClient('session_ready', {
          contextState: state.audioContext?.state || 'missing',
          sampleRate: state.audioContext?.sampleRate,
        });
        traceClient('audio_context_ready', state.audioContextInfo);
        return;
      }

      if (message.type === 'error') {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(message.message || 'Realtime 连接失败。'));
        } else {
          showError(message.message || 'Realtime 连接发生错误。');
          setLifecycle('failed');
          cleanupAudio();
        }
        return;
      }

      if (message.type === 'speech_started') {
        const responseActive = state.lifecycle === 'responding';
        const playback = outputPlaybackState();
        const interruptedResponseId = state.activeResponseId;
        traceClient('speech_started', {
          responseActive,
          microphoneStreaming: state.microphoneStreaming,
          outputAudioPending: playback.outputAudioPending,
          pendingScheduleCount: playback.pendingScheduleCount,
          playbackCursorAheadMs: Math.max(0, playback.playbackCursor - playback.currentTime) * 1000,
          lifecycle: state.lifecycle,
          contextState: playback.contextState,
          pendingNodes: playback.playbackNodeCount,
          ...microphoneTimingDetails(),
        });
        if (state.lifecycle === 'ending') return;
        if (responseActive || playback.outputAudioPending) {
          if (interruptedResponseId) state.suppressedResponseIds.add(interruptedResponseId);
          traceClient('playback_interruption', {
            responseId: interruptedResponseId || 'unknown',
            pendingNodes: playback.playbackNodeCount,
            pendingScheduleCount: playback.pendingScheduleCount,
            playbackCursorAheadMs: Math.max(0, playback.playbackCursor - playback.currentTime) * 1000,
            microphoneStreaming: state.microphoneStreaming,
          });
          stopPlayback(interruptedResponseId);
          if (state.activeResponseId === interruptedResponseId) state.activeResponseId = null;
          state.autoEndGeneration += 1;
        }
        hideLive();
        if (responseActive) setLifecycle('active');
        updateCallStatusFromEvent(message);
        return;
      }
      if (message.type === 'speech_stopped') {
        const stageDetails = {
          source: typeof message.source === 'string' ? message.source : 'unknown',
          responseActive: state.lifecycle === 'responding',
          lifecycle: state.lifecycle,
          contextState: state.audioContext?.state || 'missing',
          pendingNodes: state.playbackNodes.size,
          ...microphoneTimingDetails(),
        };
        traceClient('speech_stopped_received', {
          ...stageDetails,
          ...markTraceStage('speech_stopped', stageDetails),
        });
        hideLive();
        updateCallStatusFromEvent(message);
        return;
      }
      if (message.type === 'user_partial') {
        const partialText = `${message.text || ''}${message.stash || ''}`;
        traceClient('user_partial', {
          chars: partialText.length,
          responseActive: state.lifecycle === 'responding',
          deltaCount: Number.isInteger(message.deltaCount) ? message.deltaCount : undefined,
          deltaChars: Number.isInteger(message.deltaChars) ? message.deltaChars : undefined,
          textPresent: Boolean(partialText),
          ...microphoneTimingDetails(),
        });
        if (state.lifecycle === 'ending') return;
        setStatus('user-speaking');
        hideLive();
        traceClient('user_partial_rendered', {
          chars: partialText.length,
          renderedChars: elements.liveText.textContent.length,
          liveLineVisible: !elements.liveLine.hidden,
          deltaCount: Number.isInteger(message.deltaCount) ? message.deltaCount : undefined,
          deltaChars: Number.isInteger(message.deltaChars) ? message.deltaChars : undefined,
        });
        return;
      }
      if (message.type === 'user_final') {
        const finalText = typeof message.text === 'string' ? message.text : '';
        const traceDetails = {
          chars: finalText.length,
          textPresent: Boolean(finalText),
        };
        traceClient('user_final_received', {
          ...traceDetails,
          ...markTraceStage('user_final', traceDetails),
        });
        updateCallStatusFromEvent(message);
        hideLive();
        traceClient('user_final_rendered', {
          ...traceDetails,
          renderedChars: 0,
          rendered: false,
        });
        return;
      }
      if (message.type === 'assistant_started') {
        const responseId = typeof message.responseId === 'string' ? message.responseId : 'unknown';
        traceClient('assistant_started', markTraceStage('assistant_started', { responseId }));
        state.activeResponseId = responseId;
        responseAudioStats(responseId);
        removeAssistantQuestion();
        clearEmptyState();
        setLifecycle('responding');
        updateCallStatusFromEvent(message);
        hideLive();
        return;
      }
      if (message.type === 'assistant_partial') {
        const responseId = typeof message.responseId === 'string'
          ? message.responseId
          : state.activeResponseId || 'unknown';
        const visibleText = typeof message.text === 'string' ? message.text : '';
        const traceDetails = {
          responseId,
          deltaCount: Number.isInteger(message.deltaCount) ? message.deltaCount : undefined,
          deltaChars: Number.isInteger(message.deltaChars) ? message.deltaChars : undefined,
          chars: visibleText.length,
          textPresent: Boolean(visibleText),
        };
        traceClient('assistant_transcript_delta_received', traceDetails);
        if (visibleText.trim()) {
          clearEmptyState();
          showLive('采访官正在提问', visibleText);
        } else hideLive();
        traceClient('assistant_transcript_delta_rendered', {
          ...traceDetails,
          renderedChars: elements.liveText.textContent.length,
          liveLineVisible: !elements.liveLine.hidden,
        });
        return;
      }
      if (message.type === 'assistant_audio') {
        const responseId = typeof message.responseId === 'string'
          ? message.responseId
          : state.activeResponseId || 'unknown';
        const stats = responseAudioStats(responseId);
        const receivedAt = performance.now();
        const interArrivalMs = stats.lastReceivedAt === null
          ? undefined
          : receivedAt - stats.lastReceivedAt;
        const deltaBytes = typeof message.delta === 'string' ? base64ByteLength(message.delta) : 0;
        const pcmDurationMs = pcm16MonoDurationMs(deltaBytes, 24_000);
        if (interArrivalMs !== undefined) stats.maxArrivalGapMs = Math.max(stats.maxArrivalGapMs, interArrivalMs);
        stats.firstReceivedAt ??= receivedAt;
        stats.lastReceivedAt = receivedAt;
        stats.chunks += 1;
        const chunkIndex = stats.chunks;
        stats.bytes += deltaBytes;
        stats.queuedAudioMs += pcmDurationMs;
        stats.maxQueuedAudioMs = Math.max(stats.maxQueuedAudioMs, stats.queuedAudioMs);
        stats.pcmDurationMs += pcmDurationMs;
        traceClient('output_audio_chunk', {
          responseId,
          chunk: chunkIndex,
          bytes: deltaBytes,
          pcmDurationMs,
          queuedAudioMs: stats.queuedAudioMs,
          interArrivalMs,
          contextState: state.audioContext?.state || 'missing',
          pendingNodes: state.playbackNodes.size,
          ...markTraceStage('first_audio', { responseId, chunk: chunkIndex, bytes: deltaBytes }),
        });
        stats.pendingScheduleCount += 1;
        void state.playbackScheduleQueue.enqueue(responseId, (isCurrent) => (
          playPcmChunk(message.delta, message.encoding || 'pcm_s16le', responseId, chunkIndex, isCurrent)
        )).then((result) => {
          stats.queuedAudioMs = Math.max(0, stats.queuedAudioMs - pcmDurationMs);
          if (result?.scheduled) {
            stats.scheduledChunks += 1;
            stats.maxScheduleGapMs = Math.max(stats.maxScheduleGapMs, result.scheduleGapMs || 0);
            stats.maxPlaybackDelayMs = Math.max(stats.maxPlaybackDelayMs, result.playbackDelayMs || 0);
          } else {
            stats.droppedChunks += 1;
          }
          traceClient('output_audio_scheduled', {
            responseId,
            chunk: chunkIndex,
            scheduled: Boolean(result?.scheduled),
            reason: result?.reason,
            bytes: result?.bytes ?? deltaBytes,
            pcmDurationMs: result?.pcmDurationMs ?? pcmDurationMs,
            segmentCount: result?.segmentCount,
            queuedAudioMs: stats.queuedAudioMs,
            maxQueuedAudioMs: stats.maxQueuedAudioMs,
            scheduleGapMs: result?.scheduleGapMs,
            playbackDelayMs: result?.playbackDelayMs,
            contextState: result?.contextState || state.audioContext?.state || 'missing',
            pendingNodes: state.playbackNodes.size,
            boundaryJump: result?.boundaryJump,
            peak: result?.peak,
            rms: result?.rms,
            terminalSampleAbs: result?.terminalSampleAbs,
            clippedSamples: result?.clippedSamples,
            nonFiniteSamples: result?.nonFiniteSamples,
          });
        }).catch((error) => {
          stats.queuedAudioMs = Math.max(0, stats.queuedAudioMs - pcmDurationMs);
          stats.droppedChunks += 1;
          traceClient('audio_playback_error', {
            responseId,
            chunk: chunkIndex,
            reason: error instanceof Error ? error.name : 'unknown',
            contextState: state.audioContext?.state || 'missing',
            pendingNodes: state.playbackNodes.size,
          });
        }).finally(() => {
          stats.pendingScheduleCount -= 1;
          if (stats.completedStatus !== null && stats.pendingScheduleCount === 0) {
            writeResponseAudioSummary(responseId, stats);
          }
        });
        return;
      }
      if (message.type === 'assistant_audio_started') {
        const responseId = typeof message.responseId === 'string'
          ? message.responseId
          : state.activeResponseId || 'unknown';
        state.activeResponseId = responseId;
        const stats = responseAudioStats(responseId);
        stats.outputStartedAt ??= performance.now();
        traceClient('output_audio_started', {
          responseId,
          contextState: state.audioContext?.state || 'missing',
        });
        return;
      }
      if (message.type === 'assistant_audio_done') {
        traceClient('output_audio_done', {
          responseId: message.responseId || state.activeResponseId || 'unknown',
          status: message.statusCode || 'done',
        });
        return;
      }
      if (message.type === 'assistant_final') {
        const finalText = typeof message.text === 'string' ? message.text : '';
        const traceDetails = {
          responseId: typeof message.responseId === 'string' ? message.responseId : 'unknown',
          chars: finalText.length,
          textPresent: Boolean(finalText),
        };
        traceClient('assistant_transcript_final_received', traceDetails);
        const row = addMessage('assistant', message.text, {
          providerMessageId: message.itemId,
          pending: true,
        });
        row.dataset.providerId = message.itemId || '';
        state.pendingAssistantRow = row;
        hideLive();
        traceClient('assistant_transcript_final_rendered', {
          ...traceDetails,
          renderedChars: row.querySelector('.message-text')?.textContent?.length ?? 0,
        });
        return;
      }
      if (message.type === 'assistant_cancelled') {
        if (state.pendingAssistantRow?.isConnected) state.pendingAssistantRow.remove();
        state.pendingAssistantRow = null;
        hideLive();
        return;
      }
      if (message.type === 'response_done') {
        const responseId = typeof message.responseId === 'string'
          ? message.responseId
          : state.activeResponseId;
        if (!responseId) return;
        const stats = responseAudioStats(responseId);
        stats.responseDoneAt ??= performance.now();
        if (responseId) finishResponseAudioTrace(responseId, message.status);
        if (state.lifecycle === 'ending') return;
        if (message.status === 'cancelled') {
          state.suppressedResponseIds.add(responseId);
          stopPlayback(responseId);
          if (state.activeResponseId === responseId) {
            state.activeResponseId = null;
            if (state.lifecycle === 'responding') {
              setLifecycle('active');
              updateCallStatusFromEvent({ type: 'playback_drained' });
            }
          }
          return;
        }
        if (message.status !== 'completed' || state.suppressedResponseIds.has(responseId)) return;
        if (message.endAfterPlayback) {
          scheduleAutomaticEnd(
            automaticEndReason(message.endReason, state.interviewType),
            responseId,
            stats,
          );
        } else if (state.lifecycle === 'responding') {
          void drainResponsePlayback(responseId, stats);
        }
        return;
      }
      if (message.type === 'time_warning') {
        const remainingMinutes = Math.max(1, Math.round((Number(message.remainingMs) || 120_000) / 60_000));
        elements.connectionNote.textContent = `还剩约 ${remainingMinutes} 分钟，采访官会开始收尾。`;
        return;
      }
      if (message.type === 'time_limit_reached') {
        setStatus('ending', '已到时间上限，正在完成当前话轮');
        elements.connectionNote.textContent = '已停止开启新话轮；当前告别语播放完会自动结束并保存。';
        return;
      }
      if (message.type === 'transcript_saved') {
        markRowSavedById(message.role, message.providerMessageId, message.messageId);
        return;
      }
      if (message.type === 'transcript_save_error') {
        elements.connectionNote.textContent = `Transcript 写入失败：${message.message}`;
        setStatus('error', 'Transcript 写入失败');
        return;
      }
      if (message.type === 'status' && message.status === 'ending') {
        setLifecycle('ending');
        setStatus('ending', '正在收尾并保存字幕');
        if (state.interviewType === 'external_contributor' && message.reason === 'user' && state.shareToken) {
          window.location.assign(`/share/story/${encodeURIComponent(state.shareToken)}?processing=1`);
          return;
        }
        if (state.interviewType === 'story' && message.reason === 'user' && state.sessionId) {
          window.location.assign(`/interview/result?session_id=${encodeURIComponent(state.sessionId)}`);
        }
        return;
      }
      if (message.type === 'ended') {
        const isExternalContributor = state.interviewType === 'external_contributor'
          || message.external_contributor === true;
        const isOnboarding = !isExternalContributor
          && (state.interviewType === 'onboarding' || message.session_type === 'onboarding');
        const externalCloseoutFailed = isExternalContributor && message.closeout?.status === 'failed';
        const externalCloseoutCompleted = isExternalContributor && message.closeout?.status === 'completed';
        const saved = message.savedTranscriptCount ?? message.transcriptCount ?? 0;
        const hasSaveErrors = Array.isArray(message.transcriptSaveErrors) && message.transcriptSaveErrors.length > 0;
        const note = hasSaveErrors
          ? `Session 已结束，已保存 ${saved} 条；有 ${message.transcriptSaveErrors.length} 条写入失败。`
          : message.drainTimedOut
            ? `Session 已结束，已保存 ${saved} 条；Realtime 收尾超时。`
            : externalCloseoutFailed
              ? '原始访谈记录已保存，但连续采访记忆整理失败。'
              : externalCloseoutCompleted
                ? '你的补充已经保存。'
                : isOnboarding && message.end_reason === 'model_complete'
                  ? `人生框架访谈已结束，Transcript ${saved} 条；正在整理人生档案。`
                  : isOnboarding
                    ? `访谈已结束，已保存 ${saved} 条 Transcript；下次可以继续。`
                    : `采访已结束，Transcript ${message.transcriptCount} 条；正在整理访谈结果。`;
        elements.connectionNote.textContent = note;
        void (async () => {
          const playbackDrained = await waitForOutputAudioDrain();
          const finalNote = playbackDrained
            ? note
            : `${note} 最后一段语音未能确认播完；文字记录已保存。`;
          finishUi(finalNote, hasSaveErrors || message.drainTimedOut || externalCloseoutFailed);
          if (isExternalContributor && state.shareToken) {
            if (externalCloseoutCompleted) {
              window.location.assign(`/share/story/${encodeURIComponent(state.shareToken)}?completed=1`);
            } else if (externalCloseoutFailed && elements.externalCloseoutRetry) {
              elements.externalCloseoutRetry.hidden = false;
              elements.externalCloseoutRetryMessage.textContent = finalNote;
              elements.externalCloseoutRetryButton.disabled = false;
              elements.externalCloseoutRetryButton.textContent = '重新整理';
            }
            return;
          }
          if (message.sessionId) {
            const resultUrl = isOnboarding
              ? onboardingEndUrl(message)
              : typeof message.resultUrl === 'string'
                ? message.resultUrl
                : `/interview/result?session_id=${encodeURIComponent(message.sessionId)}`;
            window.location.assign(resultUrl);
          }
        })();
        return;
      }
    });

    socket.addEventListener('close', () => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(new Error('本机语音连接已关闭。'));
      } else if (['active', 'responding', 'ending'].includes(state.lifecycle)) {
        finishUi('连接已断开，已保存的 Transcript 会保留。', true);
      }
    });
    socket.addEventListener('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error('无法连接本机语音服务。'));
      }
    });
  });
}

async function startInterview() {
  if (state.lifecycle !== 'idle') return;
  if (elements.externalCloseoutRetry) elements.externalCloseoutRetry.hidden = true;
  removeAssistantQuestion();
  hideLive();
  elements.interviewCard.hidden = true;
  elements.conversationCard.hidden = false;
  elements.emptyStateTitle.textContent = state.interviewType === 'onboarding'
    ? '准备好后，点击“开始聊天”。'
    : state.interviewType === 'external_contributor'
      ? '准备好后，点击“开始聊天”。'
      : '准备好后，点击“开始采访”。';
  if (elements.callStoryTitle) {
    const selected = state.stories.find((story) => story.story_id === elements.storySelect?.value);
    elements.callStoryTitle.textContent = state.interviewType === 'onboarding'
      ? '人生地图'
      : state.interviewType === 'external_contributor'
        ? (state.sharedStory?.title || '这段人生故事')
        : (selected?.title || (elements.targetMode?.value === 'create' ? '一段新故事' : '当前故事'));
  }
  if (elements.callContextCopy) {
    const selected = state.stories.find((story) => story.story_id === elements.storySelect?.value);
    elements.callContextCopy.textContent = state.interviewType === 'onboarding'
      ? '从你想说的地方开始就好'
      : state.interviewType === 'external_contributor'
        ? '从你的视角补充这段故事'
        : (selected?.stage_title || '这次聊天会保存到你的故事里');
  }
  state.traceStartedAt = performance.now();
  state.startupTraceEvents = [];
  state.playbackReadySent = false;
  resetTraceTurnState();
  state.sessionId = null;
  state.activeResponseId = null;
  state.responseAudioStats.clear();
  state.playbackScheduleQueue.invalidate();
  state.suppressedResponseIds.clear();
  state.microphoneStreaming = false;
  state.autoEndGeneration += 1;
  state.audioContextInfo = {};
  state.isMuted = false;
  state.isSpeakerOn = true;
  elements.muteButton?.setAttribute('aria-pressed', 'false');
  elements.speakerButton?.setAttribute('aria-pressed', 'true');
  setLifecycle('connecting');
  setStatus('connecting', '正在请求麦克风');
  elements.connectionNote.textContent = '请在浏览器弹窗中允许麦克风访问。';
  traceClient('start_clicked', { provider: state.realtimeProvider, interviewType: state.interviewType });
  try {
    const microphoneReady = setupMicrophone();
    setStatus('connecting', `正在连接${realtimeProviderLabels[state.realtimeProvider]}`);
    const providerReady = connectRealtime();
    await Promise.all([microphoneReady, providerReady]);
    if (state.lifecycle !== 'connecting' || !state.sessionId) {
      throw new Error('Realtime 启动状态已取消，请重试。');
    }
    state.startedAt = Date.now();
    state.timer = setInterval(updateDuration, 500);
    setLifecycle('active');
    setStatus('active');
    if (!state.playbackReadySent && state.websocket?.readyState === WebSocket.OPEN) {
      state.websocket.send(JSON.stringify({ type: 'playback_ready' }));
      state.playbackReadySent = true;
      traceClient('playback_ready_sent', {
        contextState: state.audioContext?.state || 'missing',
        microphoneStreaming: state.microphoneStreaming,
      });
    } else if (!state.playbackReadySent) {
      throw new Error('语音连接在播放系统就绪前关闭。');
    }
  } catch (error) {
    cleanupAudio();
    if (state.websocket) state.websocket.close();
    state.websocket = null;
    elements.interviewCard.hidden = false;
    elements.conversationCard.hidden = true;
    setLifecycle('failed');
    const message = error instanceof Error ? error.message : '采访启动失败。';
    showError(message);
    elements.startButton.disabled = true;
  }
}

async function endInterview(reason = 'user') {
  if (!['active', 'responding', 'ending'].includes(state.lifecycle)) return;
  state.autoEndGeneration += 1;
  const lifecycleAtEnd = state.lifecycle;
  const outputAudioBeforeEnd = outputAudioState();
  const outputAudioPending = isOutputAudioPlaybackPending(outputAudioBeforeEnd);
  const interruptOutputAudio = shouldInterruptOutputAudioOnEnd({
    reason,
    lifecycle: lifecycleAtEnd,
    outputAudioPending,
  });
  if (interruptOutputAudio) {
    const responseId = state.activeResponseId;
    if (responseId) state.suppressedResponseIds.add(responseId);
    for (const [pendingResponseId, stats] of state.responseAudioStats) {
      if (stats.pendingScheduleCount > 0) state.suppressedResponseIds.add(pendingResponseId);
    }
    traceClient('manual_end_interrupted_playback', {
      responseId: responseId || 'unknown',
      responseActive: lifecycleAtEnd === 'responding',
      pendingNodes: outputAudioBeforeEnd.playbackNodeCount,
      pendingScheduleCount: outputAudioBeforeEnd.pendingScheduleCount,
      playbackDelayMs: Math.max(0, (outputAudioBeforeEnd.playbackCursor - outputAudioBeforeEnd.currentTime) * 1000),
      contextState: outputAudioBeforeEnd.contextState,
    });
    stopPlayback();
  }
  setLifecycle('ending');
  setStatus('ending', '正在结束并保存字幕');
  stopMicrophone();
  if (state.websocket?.readyState === WebSocket.OPEN) {
    state.websocket.send(JSON.stringify({ type: 'end', reason }));
    await waitForEnd();
  } else {
    finishUi('连接已断开；Session 会保留已写入的 Transcript。', true);
  }
}

async function retryExternalContributorCloseout() {
  if (!state.shareToken || !elements.externalCloseoutRetryButton) return;
  elements.externalCloseoutRetryButton.disabled = true;
  elements.externalCloseoutRetryButton.textContent = '重试中…';
  elements.externalCloseoutRetryMessage.textContent = '正在重新整理已保存的访谈内容…';
  try {
    const response = await fetch(
      `/api/public/story-share/${encodeURIComponent(state.shareToken)}/retry-closeout`,
      { method: 'POST' },
    );
    let payload = {};
    try { payload = await response.json(); } catch { /* Keep the generic fallback below. */ }
    if (response.status === 200) {
      window.location.assign(`/share/story/${encodeURIComponent(state.shareToken)}?completed=1`);
      return;
    }
    if (response.status === 202) {
      elements.externalCloseoutRetryMessage.textContent = '正在整理，请稍后再试。';
    } else {
      elements.externalCloseoutRetryMessage.textContent = payload.error
        || '补充内容已保留，但整理仍未完成，请稍后重试。';
    }
  } catch {
    elements.externalCloseoutRetryMessage.textContent = '网络连接失败，补充内容仍已保留，请稍后重试。';
  } finally {
    elements.externalCloseoutRetryButton.disabled = false;
    elements.externalCloseoutRetryButton.textContent = '重新整理';
  }
}

async function loadSharedStoryData() {
  const [shareResponse, healthResponse] = await Promise.all([
    fetch(`/api/public/story-share/${encodeURIComponent(state.shareToken)}`, { cache: 'no-store' }),
    fetch('/api/health', { cache: 'no-store' }),
  ]);
  const sharePayload = await shareResponse.json();
  const health = await healthResponse.json();
  if (!shareResponse.ok || !sharePayload.story) {
    throw new Error(sharePayload.error || '该分享链接已不可用。');
  }
  if (!healthResponse.ok || !health.databaseAvailable) {
    throw new Error(health.error || '语音服务暂不可用。');
  }

  state.authenticatedProfile = null;
  state.interviewType = 'external_contributor';
  state.sharedStory = sharePayload.story;
  state.stories = [{
    story_id: 'shared-story',
    title: sharePayload.story.title,
    summary: sharePayload.story.summary,
    gaps: sharePayload.story.gaps,
    status: sharePayload.story.status,
    stage_title: '亲友补充',
  }];
  state.lifeStages = [];
  state.providers = health.providers || {};
  state.realtimeProvider = resolveRealtimeProvider(health.defaultProvider);
  state.databaseAvailable = true;

  elements.authCard.hidden = true;
  elements.interviewCard.hidden = false;
  elements.conversationCard.hidden = true;
  elements.logoutButton.hidden = true;
  elements.onboardingWelcome.hidden = true;
  elements.storyInterviewControls.hidden = true;
  elements.precallPanel.hidden = false;
  elements.interviewKicker.textContent = '亲友补充采访';
  elements.startButtonLabel.textContent = sharePayload.has_previous_interview ? '继续聊天' : '开始聊天';
  elements.endButton.textContent = '结束聊天';
  elements.storyHeading.textContent = sharePayload.story.title || '补充这段故事';
  elements.storyMeta.textContent = '你的内容会作为独立视角保存，不会自动覆盖主人公自己的讲述。';
  elements.emptyStateTitle.textContent = '准备好后，点击“开始聊天”。';

  renderPrecall();
  updateRealtimeAvailability();
}

async function loadPageData() {
  try {
    if (state.shareToken) {
      await loadSharedStoryData();
      return;
    }
    const authResponse = await fetch('/api/auth/me', { cache: 'no-store' });
    const authPayload = await authResponse.json();
    state.authMode = authPayload.authMode === 'demo_phone' ? 'demo_phone' : 'sms';
    elements.authCopy.textContent = state.authMode === 'demo_phone'
      ? '输入手机号即可进入；第一次来，我们会自动为你准备一个人生档案。'
      : '使用手机号验证码登录。验证成功后会自动创建一个默认人生档案。';
    elements.requestCodeButton.textContent = state.authMode === 'demo_phone' ? '进入我的人生' : '获取验证码';
    elements.verificationControls.classList.toggle('debug-only', state.authMode !== 'sms');
    elements.verificationControls.hidden = state.authMode === 'demo_phone' || !state.verificationChallengeId;
    if (!authResponse.ok || !authPayload.profile) {
      state.authenticatedProfile = null;
      state.onboardingStatus = null;
      state.interviewType = 'story';
      state.databaseAvailable = false;
      elements.authCard.hidden = false;
      elements.interviewCard.hidden = true;
      elements.conversationCard.hidden = true;
      elements.precallPanel.hidden = true;
      elements.onboardingWelcome.hidden = true;
      elements.storyInterviewControls.hidden = false;
      elements.logoutButton.hidden = true;
      elements.developmentLogin.hidden = authPayload.developmentAuthEnabled !== true;
      elements.connectionNote.textContent = '请先登录后查看个人故事。';
      setStatus('idle', '需要登录');
      return;
    }
    state.authenticatedProfile = authPayload.profile;
    state.onboardingStatus = authPayload.profile.onboarding_status || null;
    const homeView = onboardingHomeView(state.onboardingStatus);
    if (homeView === 'my-life') {
      const returnTo = new URLSearchParams(window.location.search).get('return_to');
      if (returnTo) {
        try {
          const target = new URL(returnTo, window.location.origin);
          if (target.origin === window.location.origin) {
            window.location.replace(`${target.pathname}${target.search}${target.hash}`);
            return;
          }
        } catch { /* Ignore malformed post-login return paths. */ }
      }
      if (!isStoryInterviewRoute(window.location.pathname, window.location.search)) {
        window.location.assign('/my-life');
        return;
      }
    }
    const interviewView = homeView === 'my-life' ? 'main' : homeView;
    state.interviewType = interviewView === 'main' ? 'story' : 'onboarding';
    elements.authCard.hidden = true;
    elements.interviewCard.hidden = false;
    elements.conversationCard.hidden = true;
    elements.logoutButton.hidden = false;
    elements.onboardingWelcome.hidden = interviewView === 'main';
    elements.storyInterviewControls.hidden = interviewView !== 'main';
    elements.precallPanel.hidden = interviewView !== 'main';

    if (interviewView === 'main') {
      elements.interviewKicker.textContent = '本次采访';
      elements.startButtonLabel.textContent = '开始聊天';
      elements.endButton.textContent = '结束采访';
      elements.storyHeading.textContent = '选择一个已有故事';
    } else {
      const continuing = interviewView === 'continue';
      elements.interviewKicker.textContent = continuing ? '继续建档' : '首次建档';
      elements.storyHeading.textContent = continuing ? '继续认识你的人生' : '先认识你的人生';
      elements.onboardingModeLabel.textContent = continuing ? '继续上一次的人生了解' : '第一次见面';
      elements.onboardingTitle.textContent = continuing ? '从上次聊到的地方继续' : '先一起建立你的人生地图';
      elements.onboardingCopy.textContent = continuing
        ? '我们会接着上次的对话，继续了解你的成长背景、人生中的重要阶段和现在的生活。已经讲过的内容会保留下来。'
        : '我们会先一起了解你的成长背景、主要人生阶段、现在的生活，以及每个阶段里值得以后继续聊的故事。';
      elements.onboardingReassurance.textContent = continuing
        ? '不需要重新讲一遍，也不必一次把每个故事讲得很详细。准备好后，点击下面的按钮继续聊天。'
        : '不需要一次把每个故事讲得很详细。我们会自然地聊，准备好后再点击下面的按钮开始。';
      elements.startButtonLabel.textContent = continuing ? '继续聊天' : '开始聊天';
      elements.endButton.textContent = '结束聊天';
      elements.emptyStateTitle.textContent = continuing ? '准备好后，点击“继续聊天”。' : '准备好后，点击“开始聊天”。';
      state.stories = [];
      state.lifeStages = [];
    }

    const healthResponse = await fetch('/api/health', { cache: 'no-store' });
    const health = await healthResponse.json();
    if (!healthResponse.ok || !health.databaseAvailable) {
      throw new Error(health.error || '无法读取本机数据库。');
    }
    state.providers = health.providers || {};
    state.realtimeProvider = resolveRealtimeProvider(health.defaultProvider);
    state.databaseAvailable = true;

    if (interviewView !== 'main') {
      updateRealtimeAvailability();
      return;
    }

    const [storiesResponse, stagesResponse] = await Promise.all([
      fetch('/api/stories', { cache: 'no-store' }),
      fetch('/api/life-stages', { cache: 'no-store' }),
    ]);
    const storyPayload = await storiesResponse.json();
    const stagesPayload = await stagesResponse.json();
    if (!storiesResponse.ok || !Array.isArray(storyPayload.stories)
      || !stagesResponse.ok || !Array.isArray(stagesPayload.life_stages)) {
      throw new Error(storyPayload.error || stagesPayload.error || '无法读取本机数据库。');
    }

    const stories = storyPayload.stories;
    const lifeStages = stagesPayload.life_stages;
    state.stories = stories;
    state.lifeStages = lifeStages;
    const routeParams = new URLSearchParams(window.location.search);
    const requestedMode = routeParams.get('mode');
    const requestedStoryId = routeParams.get('story_id');
    const requestedStageId = routeParams.get('stage_id');
    elements.storySelect.replaceChildren();
    for (const story of stories) {
      const option = document.createElement('option');
      option.value = story.story_id;
      const statusLabel = story.status === 'complete' ? '已整理' : story.status === 'interviewing' ? '继续采访' : '待采访';
      option.textContent = `${story.title} · ${story.stage_title || '未分类'} · ${statusLabel}`;
      elements.storySelect.append(option);
    }
    elements.storySelect.disabled = stories.length === 0;
    if (requestedMode === 'create' || requestedStageId) {
      elements.targetMode.value = 'create';
    } else if (requestedMode === 'continue' || requestedStoryId) {
      elements.targetMode.value = 'continue';
      if (requestedStoryId && stories.some((story) => story.story_id === requestedStoryId)) {
        elements.storySelect.value = requestedStoryId;
      }
    }

    elements.stageSelect.replaceChildren();
    for (const stage of lifeStages) {
      const option = document.createElement('option');
      option.value = stage.stage_id;
      option.textContent = `${stage.title}${stage.start_year ? ` · ${stage.start_year}` : ''}`;
      elements.stageSelect.append(option);
    }
    if (requestedStageId && lifeStages.some((stage) => stage.stage_id === requestedStageId)) {
      elements.stageSelect.value = requestedStageId;
    }
    elements.stageSelect.disabled = lifeStages.length === 0;

    if (!stories.length) {
      elements.storyHeading.textContent = '还没有 Story';
      elements.storyMeta.textContent = lifeStages.length
        ? '可以切换到“采访并新建 Story”，从一段真实经历开始。'
        : '当前档案还没有人生阶段；新建 Story 前需要先建立人生阶段。';
    } else {
      const selected = stories.find((story) => story.story_id === elements.storySelect.value) || stories[0];
      elements.storyHeading.textContent = selected.title;
      elements.storyMeta.textContent = `${selected.stage_title || '未分类'} · ${selected.summary || '采访结束后会整理故事摘要'} · 完整 Transcript 会保留`;
    }

    updateInterviewTargetMode();
    updateRealtimeAvailability();
    renderPrecall();
  } catch (error) {
    const message = error instanceof Error ? error.message : '读取本机服务失败。';
    elements.storyHeading.textContent = '本机服务未就绪';
    elements.storyMeta.textContent = message;
    elements.connectionNote.textContent = message;
    setStatus('error', '数据库不可用');
    elements.startButton.disabled = true;
    elements.storySelect.disabled = true;
    elements.stageSelect.disabled = true;
  }
}

async function requestVerificationCode() {
  elements.authMessage.textContent = '';
  elements.requestCodeButton.disabled = true;
  try {
    const response = await fetch('/api/auth/verification', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: elements.phoneInput.value.trim() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '验证码发送失败。');
    state.verificationChallengeId = result.challengeId;
    elements.verificationControls.hidden = false;
    elements.codeInput.focus();
    elements.authMessage.textContent = result.developmentCode
      ? `本地开发验证码：${result.developmentCode}`
      : '验证码已发送，请查收短信。';
  } catch (error) {
    elements.authMessage.textContent = error instanceof Error ? error.message : '验证码发送失败。';
  } finally {
    elements.requestCodeButton.disabled = false;
  }
}

async function verifyPhoneAndLogin() {
  elements.authMessage.textContent = '';
  elements.verifyButton.disabled = true;
  try {
    const response = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        phone: elements.phoneInput.value.trim(),
        challengeId: state.verificationChallengeId,
        code: elements.codeInput.value.trim(),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '验证码验证失败。');
    state.verificationChallengeId = null;
    await loadPageData();
  } catch (error) {
    elements.authMessage.textContent = error instanceof Error ? error.message : '验证码验证失败。';
  } finally {
    elements.verifyButton.disabled = false;
  }
}

async function loginLegacyProfile() {
  elements.authMessage.textContent = '';
  try {
    const response = await fetch('/api/auth/development/legacy-session', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '无法继续使用本机旧档案。');
    await loadPageData();
  } catch (error) {
    elements.authMessage.textContent = error instanceof Error ? error.message : '本机旧档案登录失败。';
  }
}

async function loginWithDemoPhone() {
  elements.authMessage.textContent = '';
  elements.requestCodeButton.disabled = true;
  try {
    const response = await fetch('/api/auth/demo-phone', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: elements.phoneInput.value.trim() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '手机号登录失败。');
    await loadPageData();
  } catch (error) {
    elements.authMessage.textContent = error instanceof Error ? error.message : '手机号登录失败。';
  } finally {
    elements.requestCodeButton.disabled = false;
  }
}

function handlePhoneLoginAction() {
  if (state.authMode === 'demo_phone') void loginWithDemoPhone();
  else void requestVerificationCode();
}

function toggleMute() {
  state.isMuted = !state.isMuted;
  const tracks = state.mediaStream?.getAudioTracks?.() || [];
  for (const track of tracks) track.enabled = !state.isMuted;
  if (elements.muteButton) {
    elements.muteButton.setAttribute('aria-pressed', String(state.isMuted));
    elements.muteButton.classList.toggle('is-active', state.isMuted);
  }
}

function toggleSpeaker() {
  state.isSpeakerOn = !state.isSpeakerOn;
  if (state.playbackGain && state.audioContext) {
    state.playbackGain.gain.setTargetAtTime(state.isSpeakerOn ? 1 : 0, state.audioContext.currentTime, .015);
  }
  if (elements.speakerButton) {
    elements.speakerButton.setAttribute('aria-pressed', String(state.isSpeakerOn));
    elements.speakerButton.classList.toggle('is-active', state.isSpeakerOn);
  }
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  state.authenticatedProfile = null;
  state.stories = [];
  state.lifeStages = [];
  await loadPageData();
}

elements.storySelect.addEventListener('change', () => {
  updateInterviewTargetMode();
});
elements.targetMode.addEventListener('change', updateInterviewTargetMode);
elements.startButton.addEventListener('click', () => void startInterview());
elements.externalCloseoutRetryButton?.addEventListener('click', () => void retryExternalContributorCloseout());
elements.endButton.addEventListener('click', () => void endInterview());
elements.callEndButton?.addEventListener('click', () => void endInterview());
elements.muteButton?.addEventListener('click', toggleMute);
elements.speakerButton?.addEventListener('click', toggleSpeaker);
elements.requestCodeButton.addEventListener('click', handlePhoneLoginAction);
elements.verifyButton.addEventListener('click', () => void verifyPhoneAndLogin());
elements.legacyLoginButton.addEventListener('click', () => void loginLegacyProfile());
elements.logoutButton.addEventListener('click', () => void logout());
window.addEventListener('beforeunload', () => {
  cleanupAudio();
  if (state.websocket?.readyState === WebSocket.OPEN) {
    state.websocket.send(JSON.stringify({ type: 'end' }));
  }
});

void loadPageData();
