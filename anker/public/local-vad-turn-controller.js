export function createLocalVadTurnController({
  silenceTimeoutMs = 2000,
  startThreshold = 0.3,
  continueThreshold = 0.25,
  consecutiveStartFrames = 2,
} = {}) {
  let enabled = true;
  let isSpeaking = false;
  let candidateFrames = 0;
  let silenceStartedAtMs = null;
  let commitTriggered = false;

  function clearTurn() {
    isSpeaking = false;
    candidateFrames = 0;
    silenceStartedAtMs = null;
    commitTriggered = false;
  }

  function update(speechProbability, nowMs) {
    if (
      !enabled ||
      !Number.isFinite(speechProbability) ||
      speechProbability < 0 ||
      speechProbability > 1 ||
      !Number.isFinite(nowMs)
    ) return [];

    const events = [];
    if (!isSpeaking) {
      if (speechProbability < startThreshold) {
        candidateFrames = 0;
        return events;
      }

      candidateFrames += 1;
      if (candidateFrames >= consecutiveStartFrames) {
        isSpeaking = true;
        candidateFrames = 0;
        events.push({ type: 'speech_started' });
      }
      return events;
    }

    if (speechProbability >= continueThreshold) {
      if (silenceStartedAtMs !== null) {
        silenceStartedAtMs = null;
        commitTriggered = false;
        events.push({ type: 'speech_resumed' });
      }
      return events;
    }

    if (silenceStartedAtMs === null) {
      silenceStartedAtMs = nowMs;
      events.push({ type: 'silence_started' });
    }

    const silenceObservedMs = Math.max(0, nowMs - silenceStartedAtMs);
    if (!commitTriggered && silenceObservedMs >= silenceTimeoutMs) {
      commitTriggered = true;
      events.push({
        type: 'commit_triggered',
        silenceObservedMs,
        silenceThresholdMs: silenceTimeoutMs,
      });
    }
    return events;
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    if (!enabled) clearTurn();
  }

  function reset() {
    clearTurn();
  }

  function getState() {
    return {
      enabled,
      isSpeaking,
      candidateFrames,
      silenceStartedAtMs,
      commitTriggered,
    };
  }

  return { update, setEnabled, reset, getState };
}
