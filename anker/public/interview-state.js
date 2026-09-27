const assistantResponseMessageTypes = new Set([
  'assistant_started',
  'assistant_partial',
  'assistant_audio',
  'assistant_audio_started',
  'assistant_audio_done',
  'assistant_final',
]);

const realtimeCallStatuses = {
  speech_started: { status: 'user-speaking', label: '正在听你说' },
  speech_stopped: { status: 'thinking', label: '正在理解' },
  user_final: { status: 'thinking', label: '正在准备回应' },
  assistant_started: { status: 'responding', label: '采访官正在说' },
  response_done: { status: 'responding', label: '采访官正在说' },
  playback_drained: { status: 'active', label: '正在听' },
};

export function resolveRealtimeProvider(value) {
  return value === 'qwen' || value === 'stepfun' || value === 'modelbest'
    || value === 'stepaudio3_quality' || value === 'stepaudio2_mini'
    ? value
    : 'stepaudio2_mini';
}

export function realtimeInputSampleRate(provider) {
  return provider === 'qwen' || provider === 'modelbest' ? 16000 : 24000;
}

export function shouldIgnoreAssistantResponseMessage(lifecycle, messageType) {
  return lifecycle === 'ending' && assistantResponseMessageTypes.has(messageType);
}

export function realtimeCallStatus(messageType, lifecycle) {
  if (lifecycle === 'ending' || shouldIgnoreAssistantResponseMessage(lifecycle, messageType)) return null;
  return realtimeCallStatuses[messageType] ?? null;
}

export function automaticEndReason(providerReason, interviewType = 'story') {
  if (providerReason === 'timeout' || providerReason === 'assistant_farewell') return providerReason;
  if (providerReason === 'model_complete' && interviewType === 'onboarding') return providerReason;
  return 'user_confirmed';
}
