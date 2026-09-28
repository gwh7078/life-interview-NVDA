import { spawn } from 'node:child_process';
import path from 'node:path';

function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!);
}

function runSmoke(args: string[]): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/spark-realtime-bridge-smoke.ts', ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 2_000_000) stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 100_000) stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      const line = stdout.trim().split(/\r?\n/u).at(-1);
      if (code !== 0 || !line) {
        reject(new Error(`realtime smoke failed (exit=${code}): ${stderr.slice(-500)}`));
        return;
      }
      resolve(JSON.parse(line));
    });
  });
}

const fixtureDir = path.resolve('runtime/benchmarks/spark/fixtures');
const shortRun = await runSmoke(['--turns', '1', '--fixture', path.join(fixtureDir, 'speech-short.wav')]);
const fiveTurn = await runSmoke(['--turns', '5', '--fixture', path.join(fixtureDir, 'speech-short.wav')]);
const longRun = await runSmoke(['--turns', '1', '--fixture', path.join(fixtureDir, 'speech-long.wav')]);
const allMetrics = [...shortRun.metrics, ...fiveTurn.metrics, ...longRun.metrics] as Array<Record<string, number>>;
const asr = allMetrics.map((m) => m.asr_ms);
const firstAudio = allMetrics.map((m) => m.first_audio_ms);
const audioToAudio = allMetrics.map((m) => m.asr_ms + m.total_response_ms);

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  model_load_ms: Number(process.env.SPARK_BENCH_VOICE_LOAD_MS || 0) || null,
  model_load_measurement: 'restart of Step-Audio backend + bridge with cached model files',
  asr: { p50_ms: percentile(asr, 0.50), p95_ms: percentile(asr, 0.95), samples_ms: asr },
  first_audio: { p50_ms: percentile(firstAudio, 0.50), p95_ms: percentile(firstAudio, 0.95), samples_ms: firstAudio },
  audio_to_audio: { p50_ms: percentile(audioToAudio, 0.50), p95_ms: percentile(audioToAudio, 0.95), samples_ms: audioToAudio },
  streaming: {
    total_audio_chunks: allMetrics.reduce((sum, m) => sum + m.audio_chunks, 0),
    all_turns_streamed_audio: allMetrics.every((m) => m.audio_chunks > 0),
  },
  five_turn: { status: fiveTurn.status, turns: fiveTurn.turns, metrics: fiveTurn.metrics },
  long_session: { status: longRun.status, fixture: longRun.fixture, metrics: longRun.metrics },
  short_session: { status: shortRun.status, metrics: shortRun.metrics },
})}\n`);
