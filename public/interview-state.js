const assistantResponseMessageTypes = new Set([
  'assistant_started',
  'assistant_partial',
  'assistant_audio',
  'assistant_audio_started',
  'assistant_audio_done',
  'assistant_final',
]);

export function shouldIgnoreAssistantResponseMessage(lifecycle, messageType) {
  return lifecycle === 'ending' && assistantResponseMessageTypes.has(messageType);
}

export function automaticEndReason(providerReason, interviewType = 'story') {
  if (providerReason === 'timeout' || providerReason === 'assistant_farewell') return providerReason;
  if (providerReason === 'model_complete' && interviewType === 'onboarding') return providerReason;
  return 'user_confirmed';
}
