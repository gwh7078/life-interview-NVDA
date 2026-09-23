export function decodePcmSamples(bytes, encoding = 'pcm_s16le') {
  return decodePcmSamplesWithMetrics(bytes, encoding).samples;
}

export function isOutputAudioPlaybackPending({
  contextState = 'missing',
  currentTime = 0,
  playbackCursor = 0,
  playbackNodeCount = 0,
  pendingScheduleCount = 0,
} = {}) {
  return pendingScheduleCount > 0
    || playbackNodeCount > 0
    || (contextState === 'running' && playbackCursor > currentTime + 0.01);
}

export function shouldInterruptOutputAudioOnEnd({
  reason = 'user',
  lifecycle = 'idle',
  outputAudioPending = false,
} = {}) {
  return reason === 'user' && (lifecycle === 'responding' || outputAudioPending);
}

export function decodePcmSamplesWithMetrics(bytes, encoding = 'pcm_s16le') {
  if (encoding !== 'pcm_s16le') throw new Error(`Unsupported PCM encoding: ${encoding}`);
  const bytesPerSample = 2;
  if (!(bytes instanceof Uint8Array)) throw new TypeError('PCM audio must be a Uint8Array.');
  if (bytes.byteLength % bytesPerSample !== 0) {
    throw new RangeError(`${encoding} audio length must be aligned to ${bytesPerSample}-byte samples.`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.byteLength / bytesPerSample);
  let peak = 0;
  let sumSquares = 0;
  let clippedSamples = 0;
  let nonFiniteSamples = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const rawValue = view.getInt16(index * 2, true) / 32768;
    if (!Number.isFinite(rawValue)) nonFiniteSamples += 1;
    else if (rawValue < -1 || rawValue > 1) clippedSamples += 1;
    const value = Number.isFinite(rawValue) ? Math.max(-1, Math.min(1, rawValue)) : 0;
    samples[index] = value;
    const magnitude = Math.abs(value);
    peak = Math.max(peak, magnitude);
    sumSquares += value * value;
  }
  return {
    samples,
    firstSample: samples[0] ?? 0,
    lastSample: samples.at(-1) ?? 0,
    peak,
    rms: samples.length ? Math.sqrt(sumSquares / samples.length) : 0,
    clippedSamples,
    nonFiniteSamples,
  };
}
