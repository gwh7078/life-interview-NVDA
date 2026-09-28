import {
  existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NEXT_QUESTION_CASES } from './cases.js';
import { readCanonicalWav } from './audio.js';

const directory = fileURLToPath(new URL('./audio/', import.meta.url));
const manifestPath = path.join(directory, 'manifest.json');
const config = {
  tts_provider: 'Apple macOS Speech Synthesis',
  tts_model: 'NSSpeechSynthesizer',
  voice: 'Tingting',
  language: 'zh_CN',
  rate_words_per_minute: 180,
  volume: 'NSSpeechSynthesizer default (1.0); no post-scaling',
  output_format: 'PCM signed 16-bit little-endian, mono, 16000 Hz',
};

interface AudioEntry {
  case_id: string;
  source_text: string;
  tts_provider: string;
  tts_model: string;
  voice: string;
  language: string;
  rate_words_per_minute: number;
  volume: string;
  output_format: string;
  duration_ms: number;
  sample_rate: 16000;
  channels: 1;
  bit_depth: 16;
  sha256: string;
  file: string;
}

interface AudioManifest {
  benchmark: string;
  generated_at: string;
  generator: typeof config;
  complete: boolean;
  cases: AudioEntry[];
}

function writeManifest(manifest: AudioManifest): void {
  const temporary = `${manifestPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  renameSync(temporary, manifestPath);
}

function loadManifest(): AudioManifest {
  if (!existsSync(manifestPath)) {
    return {
      benchmark: 'controlled-next-question',
      generated_at: new Date().toISOString(),
      generator: config,
      complete: false,
      cases: [],
    };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as AudioManifest;
  if (JSON.stringify(manifest.generator) !== JSON.stringify(config)
    || manifest.benchmark !== 'controlled-next-question'
    || !Array.isArray(manifest.cases)) {
    throw new Error('Existing audio manifest uses a different canonical TTS configuration.');
  }
  return manifest;
}

function makeEntry(caseId: string, sourceText: string, wavPath: string): AudioEntry {
  const bytes = readFileSync(wavPath);
  const audio = readCanonicalWav(wavPath);
  const pcmBytes = bytes.readUInt32LE(findDataChunk(bytes));
  return {
    case_id: caseId,
    source_text: sourceText,
    ...config,
    duration_ms: Math.round(pcmBytes / 32_000 * 1000),
    sample_rate: 16_000,
    channels: 1,
    bit_depth: 16,
    sha256: audio.sha256,
    file: `${caseId}.wav`,
  };
}

function findDataChunk(wav: Buffer): number {
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (wav.toString('ascii', offset, offset + 4) === 'data') return offset + 4;
    offset = end + (size & 1);
  }
  throw new Error('CANONICAL_WAV_MISSING_DATA_CHUNK');
}

function verifyExistingEntries(manifest: AudioManifest): void {
  for (const entry of manifest.cases) {
    const item = NEXT_QUESTION_CASES.find((candidate) => candidate.id === entry.case_id);
    if (!item || entry.source_text !== item.userAnswer || entry.file !== `${entry.case_id}.wav`) {
      throw new Error(`Existing audio manifest does not match frozen Case ${entry.case_id}.`);
    }
    const wavPath = path.join(directory, entry.file);
    if (!existsSync(wavPath) || makeEntry(entry.case_id, item.userAnswer, wavPath).sha256 !== entry.sha256) {
      throw new Error(`Existing canonical WAV failed manifest verification: ${entry.case_id}.`);
    }
  }
}

function generateOne(caseId: string, sourceText: string, tempDir: string): AudioEntry {
  const wavPath = path.join(directory, `${caseId}.wav`);
  if (existsSync(wavPath)) throw new Error(`Refusing to overwrite canonical audio: ${caseId}.wav`);
  const aiffPath = path.join(tempDir, `${caseId}.aiff`);
  const convertedPath = path.join(tempDir, `${caseId}.wav`);
  execFileSync('say', ['-v', config.voice, '-r', String(config.rate_words_per_minute), '-o', aiffPath, sourceText], {
    stdio: 'ignore',
    timeout: 120_000,
  });
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiffPath, convertedPath], {
    stdio: 'ignore',
    timeout: 120_000,
  });
  readCanonicalWav(convertedPath);
  if (existsSync(wavPath)) throw new Error(`Canonical WAV appeared while generating ${caseId}.`);
  renameSync(convertedPath, wavPath);
  return makeEntry(caseId, sourceText, wavPath);
}

function main(): void {
  const manifest = loadManifest();
  verifyExistingEntries(manifest);
  if (manifest.complete && manifest.cases.length === NEXT_QUESTION_CASES.length) {
    process.stdout.write(`Verified ${manifest.cases.length}/10 canonical audio fixtures; no files changed.\n`);
    return;
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), 'next-question-tts-'));
  try {
    for (const item of NEXT_QUESTION_CASES) {
      if (manifest.cases.some((entry) => entry.case_id === item.id)) continue;
      const entry = generateOne(item.id, item.userAnswer, tempDir);
      manifest.cases.push(entry);
      writeManifest(manifest);
      process.stdout.write(`${item.id} ${entry.duration_ms}ms ${entry.sha256}\n`);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  manifest.cases.sort((left, right) => left.case_id.localeCompare(right.case_id));
  manifest.complete = true;
  writeManifest(manifest);
  verifyExistingEntries(manifest);
  process.stdout.write(`Verified ${manifest.cases.length}/10 canonical audio fixtures.\n`);
}

main();
