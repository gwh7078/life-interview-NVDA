import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

type Event = Record<string, any>;

function parseArgs() {
  const args = process.argv.slice(2);
  let turns = 1;
  let fixture = process.env.SPARK_REALTIME_FIXTURE
    || path.resolve('runtime/benchmarks/spark/fixtures/speech-short.wav');
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--turns') turns = Number(args[++i]);
    else if (args[i] === '--fixture') fixture = args[++i]!;
  }
  if (!Number.isInteger(turns) || turns <= 0) throw new Error('--turns must be a positive integer.');
  return { turns, fixture };
}

function wavPcm(file: string): { pcm: Buffer; rate: number } {
  const b = fs.readFileSync(file);
  assert.equal(b.toString('ascii', 0, 4), 'RIFF');
  assert.equal(b.toString('ascii', 8, 12), 'WAVE');
  let off = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  let data: Buffer | undefined;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const start = off + 8;
    if (id === 'fmt ') {
      channels = b.readUInt16LE(start + 2);
      rate = b.readUInt32LE(start + 4);
      bits = b.readUInt16LE(start + 14);
    }
    if (id === 'data') {
      data = b.subarray(start, start + size);
      break;
    }
    off = start + size + (size % 2);
  }
  assert.ok(data);
  assert.equal(channels, 1);
  assert.equal(bits, 16);
  assert.ok(rate > 0);
  return { pcm: data, rate };
}

function resample(pcm: Buffer, from: number, to = 24_000): Buffer {
  if (from === to) return pcm;
  const input = pcm.length / 2;
  const output = Math.floor(input * to / from);
  const out = Buffer.alloc(output * 2);
  for (let i = 0; i < output; i += 1) {
    const src = Math.min(input - 1, Math.floor(i * from / to));
    out.writeInt16LE(pcm.readInt16LE(src * 2), i * 2);
  }
  return out;
}

class EventBuffer {
  private readonly items: Event[] = [];

  push(event: Event): void {
    this.items.push(event);
  }

  async next(type: string, timeoutMs = 180_000): Promise<Event> {
    return this.nextAny([type], timeoutMs);
  }

  async nextAny(types: string[], timeoutMs = 180_000): Promise<Event> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.items.findIndex((event) => types.includes(String(event.type)));
      if (index >= 0) return this.items.splice(index, 1)[0]!;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timeout waiting for ${types.join(' or ')}`);
  }
}

const { turns, fixture } = parseArgs();
const { pcm: raw, rate } = wavPcm(fixture);
const pcm = resample(raw, rate);
const url = process.env.STEPAUDIO2_LOCAL_WS_URL || 'ws://127.0.0.1:8092/realtime';
const ws = new WebSocket(url);
const q = new EventBuffer();
ws.on('message', (raw) => q.push(JSON.parse(raw.toString()) as Event));
await new Promise<void>((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});
ws.send(JSON.stringify({
  type: 'session.update',
  session: { instructions: 'You are a concise memoir interviewer.', turn_detection: null },
}));
const caps = await q.next('session.capabilities', 10_000);
assert.equal(caps.capabilities.fullDuplex, false);
assert.equal(caps.capabilities.supportsInterrupt, false);
await q.next('session.updated', 10_000);

const metrics: Array<Record<string, number>> = [];
for (let turn = 0; turn < turns; turn += 1) {
  for (let off = 0; off < pcm.length; off += 960) {
    ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: pcm.subarray(off, off + 960).toString('base64'),
    }));
  }
  const commitAt = performance.now();
  ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  const transcript = await q.next('conversation.item.input_audio_transcription.completed');
  const asrMs = performance.now() - commitAt;
  assert.ok(String(transcript.transcript || '').trim().length > 0, 'ASR returned empty transcript');

  const responseAt = performance.now();
  ws.send(JSON.stringify({ type: 'response.create', response: { modalities: ['text', 'audio'] } }));
  let firstAudioMs: number | undefined;
  let audioChunks = 0;
  while (true) {
    const event = await q.nextAny(['response.audio.delta', 'response.done']);
    if (event.type === 'response.audio.delta') {
      if (firstAudioMs === undefined) firstAudioMs = performance.now() - responseAt;
      audioChunks += 1;
      continue;
    }
    break;
  }
  assert.ok(firstAudioMs !== undefined && audioChunks > 0, 'no streamed audio received');
  metrics.push({
    turn: turn + 1,
    asr_ms: Math.round(asrMs),
    first_audio_ms: Math.round(firstAudioMs),
    total_response_ms: Math.round(performance.now() - responseAt),
    audio_chunks: audioChunks,
  });
}
ws.send(JSON.stringify({ type: 'session.close' }));
await q.next('session.closed', 5_000);
ws.close();
console.log(JSON.stringify({ status: 'PASS', fixture: path.basename(fixture), turns, metrics }));
