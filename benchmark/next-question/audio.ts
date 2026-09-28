import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { STEPFUN_INPUT_SAMPLE_RATE, STEPFUN_PCM_FRAME_BYTES } from '../../src/realtime/stepfun.js';

export { STEPFUN_INPUT_SAMPLE_RATE, STEPFUN_PCM_FRAME_BYTES };

export interface CanonicalAudio {
  path: string;
  sha256: string;
  adapterPcmSha256: string;
  adapterPcm: Buffer;
  frames: Buffer[];
}

function failure(code: string): never {
  throw new Error(code);
}

export function readCanonicalWav(filePath: string): CanonicalAudio {
  const wav = readFileSync(filePath);
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    return failure('CANONICAL_WAV_INVALID_HEADER');
  }

  let format: { codec: number; channels: number; sampleRate: number; byteRate: number; blockAlign: number; bits: number } | undefined;
  let pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > wav.length) return failure('CANONICAL_WAV_TRUNCATED_CHUNK');
    if (chunkId === 'fmt ') {
      if (chunkSize < 16) return failure('CANONICAL_WAV_INVALID_FORMAT_CHUNK');
      format = {
        codec: wav.readUInt16LE(chunkStart),
        channels: wav.readUInt16LE(chunkStart + 2),
        sampleRate: wav.readUInt32LE(chunkStart + 4),
        byteRate: wav.readUInt32LE(chunkStart + 8),
        blockAlign: wav.readUInt16LE(chunkStart + 12),
        bits: wav.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === 'data' && !pcm) {
      pcm = wav.subarray(chunkStart, chunkEnd);
    }
    offset = chunkEnd + (chunkSize & 1);
  }
  if (!format || !pcm || pcm.length === 0) return failure('CANONICAL_WAV_MISSING_FORMAT_OR_AUDIO');
  if (format.codec !== 1 || format.channels !== 1 || format.sampleRate !== 16_000
    || format.byteRate !== 32_000 || format.blockAlign !== 2 || format.bits !== 16 || pcm.length % 2 !== 0) {
    return failure('CANONICAL_WAV_MUST_BE_PCM16_MONO_16000HZ');
  }

  const sourceSamples = pcm.length / 2;
  const outputSamples = Math.round(sourceSamples * STEPFUN_INPUT_SAMPLE_RATE / format.sampleRate);
  const adapterPcm = Buffer.alloc(outputSamples * 2);
  for (let index = 0; index < outputSamples; index += 1) {
    const sourcePosition = index * format.sampleRate / STEPFUN_INPUT_SAMPLE_RATE;
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(leftIndex + 1, sourceSamples - 1);
    const fraction = sourcePosition - leftIndex;
    const left = pcm.readInt16LE(leftIndex * 2);
    const right = pcm.readInt16LE(rightIndex * 2);
    const sample = Math.max(-32768, Math.min(32767, Math.round(left + (right - left) * fraction)));
    adapterPcm.writeInt16LE(sample, index * 2);
  }

  const frames: Buffer[] = [];
  for (let offset = 0; offset < adapterPcm.length; offset += STEPFUN_PCM_FRAME_BYTES) {
    const frame = Buffer.alloc(STEPFUN_PCM_FRAME_BYTES);
    adapterPcm.copy(frame, 0, offset, Math.min(offset + STEPFUN_PCM_FRAME_BYTES, adapterPcm.length));
    frames.push(frame);
  }
  return {
    path: filePath,
    sha256: createHash('sha256').update(wav).digest('hex'),
    adapterPcmSha256: createHash('sha256').update(adapterPcm).digest('hex'),
    adapterPcm,
    frames,
  };
}

export function normalizeAsrForEquivalence(text: string): string {
  const compact = text.normalize('NFKC').toLowerCase()
    .replace(/(^|[\p{P}\p{Z}\s])(?:嗯|呃|额)(?=$|[\p{P}\p{Z}\s])/gu, '$1')
    .replace(/[\p{Z}\s]/gu, '');
  return compact.replace(/[\p{P}]/gu, (punctuation, offset: number, source: string) => {
    const previous = source[offset - 1] ?? '';
    const next = source[offset + punctuation.length] ?? '';
    return /\d/u.test(previous) && /\d/u.test(next) ? punctuation : '';
  });
}
