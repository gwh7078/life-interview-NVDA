#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const MODEL = 'step-audio-2-mini';
const WS_BASE_URL = 'wss://api.stepfun.com/v1/realtime';
const SAMPLE_RATE = Number(process.env.STEPFUN_SAMPLE_RATE || 24_000);
const VOICE = process.env.STEPFUN_VOICE || 'wenrounansheng';
const HOLD_MS = Number(process.env.STEPFUN_HOLD_MS || 5_000);
const INPUT_TEXT = process.env.STEPFUN_INPUT_TEXT || '你好，我想聊聊我第一次创业的经历。';
const TTS_VOICE = process.env.STEPFUN_TTS_VOICE || 'Tingting';
const CONTEXT_ROLE = process.env.STEPFUN_CONTEXT_ROLE || 'user';
const CONTEXT_TEXT = process.env.STEPFUN_CONTEXT_TEXT
  || '补充上下文（来自本地 Judge/Retriever）：请在回答开头明确说“上下文已注入”，然后围绕用户的第一次创业经历提出一个追问。';
const CONTEXT_ITEM_ID = 'stepfun_probe_context';
const TOOL_TEST_MODE = process.env.STEPFUN_TOOL_TEST_MODE || '';
const TOOL_NAME = 'get_interview_context';
const TOOL_INPUT_TEXT = process.env.STEPFUN_TOOL_INPUT_TEXT
  || (TOOL_TEST_MODE === 'positive'
    ? '我以前跟你讲过王师傅，你还记得他和我的关系吗？'
    : '那天我第一次到厂里，特别紧张。');
const REPORT_PATH = process.env.STEPFUN_REPORT_PATH || '';
const OUTPUT_PATH = process.env.STEPFUN_OUTPUT_PATH
  || path.join(os.tmpdir(), `stepfun-realtime-output-${Date.now()}.wav`);

if (!Number.isInteger(SAMPLE_RATE) || SAMPLE_RATE <= 0) {
  throw new Error('STEPFUN_SAMPLE_RATE must be a positive integer.');
}
if (!Number.isInteger(HOLD_MS) || HOLD_MS < 0 || HOLD_MS > 6_000) {
  throw new Error('STEPFUN_HOLD_MS must be an integer between 0 and 6000.');
}
if (!['user', 'assistant'].includes(CONTEXT_ROLE)) {
  throw new Error('STEPFUN_CONTEXT_ROLE must be user or assistant.');
}
if (!['', 'positive', 'negative'].includes(TOOL_TEST_MODE)) {
  throw new Error('STEPFUN_TOOL_TEST_MODE must be empty, positive or negative.');
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const truncate = (value, length = 160) => {
  const text = String(value ?? '');
  return text.length <= length ? text : `${text.slice(0, length)}…`;
};

function extractPcm16FromWav(buffer) {
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF'
    || buffer.subarray(8, 12).toString('ascii') !== 'WAVE') {
    return buffer;
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = Math.min(chunkStart + chunkSize, buffer.length);
    if (chunkType === 'data') {
      return buffer.subarray(chunkStart, chunkEnd);
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  throw new Error('WAV input has no data chunk.');
}

function writeWav(filePath, pcm16, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm16.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm16.length, 40);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([header, pcm16]));
}

function makeInputAudio() {
  const configuredPath = process.env.STEPFUN_PCM16_PATH;
  if (configuredPath) {
    const source = fs.readFileSync(configuredPath);
    const pcm16 = extractPcm16FromWav(source);
    if (pcm16.length === 0 || pcm16.length % 2 !== 0) {
      throw new Error('STEPFUN_PCM16_PATH must contain non-empty 16-bit PCM audio.');
    }
    return {
      pcm16,
      source: configuredPath,
      sourceType: 'provided file',
    };
  }

  if (process.platform !== 'darwin') {
    throw new Error('Set STEPFUN_PCM16_PATH to a PCM16/WAV file when not running on macOS.');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stepfun-realtime-input-'));
  const aiffPath = path.join(tempDir, 'input.aiff');
  const wavPath = path.join(tempDir, 'input.wav');
  const speech = spawnSync('say', ['-v', TTS_VOICE, '-o', aiffPath, TOOL_TEST_MODE ? TOOL_INPUT_TEXT : INPUT_TEXT], {
    encoding: 'utf8',
  });
  if (speech.status !== 0) {
    throw new Error(`macOS say failed: ${truncate(speech.stderr || speech.stdout || 'unknown error')}`);
  }

  const conversion = spawnSync(
    'afconvert',
    ['-f', 'WAVE', '-d', `LEI16@${SAMPLE_RATE}`, '-c', '1', aiffPath, wavPath],
    { encoding: 'utf8' },
  );
  if (conversion.status !== 0) {
    throw new Error(`afconvert failed: ${truncate(conversion.stderr || conversion.stdout || 'unknown error')}`);
  }

  const pcm16 = extractPcm16FromWav(fs.readFileSync(wavPath));
  if (pcm16.length === 0 || pcm16.length % 2 !== 0) {
    throw new Error('Generated audio is empty or not aligned to PCM16 samples.');
  }
  return {
    pcm16,
    source: wavPath,
    sourceType: 'macOS say + afconvert',
  };
}

function summarizeServerEvent(event) {
  const summary = {};
  if (event.event_id) summary.event_id = event.event_id;
  if (event.response_id) summary.response_id = event.response_id;
  if (event.item_id) summary.item_id = event.item_id;
  if (event.previous_item_id) summary.previous_item_id = event.previous_item_id;
  if (event.output_index !== undefined) summary.output_index = event.output_index;
  if (event.content_index !== undefined) summary.content_index = event.content_index;

  if (event.type === 'error') {
    const error = event.error || {};
    summary.error = {
      type: error.type || event.type,
      code: error.code ?? null,
      message: error.message || event.message || null,
      event_id: error.event_id || null,
    };
  }

  if (event.session) {
    summary.session = {
      id: event.session.id || null,
      model: event.session.model || null,
      modalities: event.session.modalities || null,
      voice: event.session.voice || null,
      input_audio_format: event.session.input_audio_format || null,
      output_audio_format: event.session.output_audio_format || null,
      turn_detection: event.session.turn_detection ?? null,
      instructions_ending: typeof event.session.instructions === 'string'
        ? truncate(event.session.instructions.slice(-80), 80)
        : null,
    };
  }

  if (event.type === 'response.created') {
    summary.response = {
      id: event.response?.id || event.id || null,
      status: event.response?.status || event.status || null,
    };
  }
  if (event.type === 'response.done') {
    summary.response = {
      id: event.response?.id || event.id || null,
      status: event.response?.status || null,
      output_items: Array.isArray(event.response?.output) ? event.response.output.length : null,
    };
  }
  if (event.type === 'response.audio.delta') {
    summary.audio_bytes = typeof event.delta === 'string'
      ? Buffer.from(event.delta, 'base64').length
      : 0;
  }
  if (event.type === 'response.audio_transcript.delta') {
    summary.transcript_delta = truncate(event.delta || '');
  }
  if (event.type === 'response.audio_transcript.done') {
    summary.transcript = event.transcript || '';
  }
  if (event.type === 'conversation.item.input_audio_transcription.completed') {
    summary.transcript = event.transcript || '';
  }
  if (event.type === 'input_audio_buffer.committed') {
    summary.committed_item_id = event.item_id || null;
  }
  if (event.type === 'conversation.item.created') {
    summary.item = {
      id: event.item?.id || null,
      role: event.item?.role || null,
      type: event.item?.type || null,
      content_types: Array.isArray(event.item?.content)
        ? event.item.content.map((content) => content.type || null)
        : [],
      text: Array.isArray(event.item?.content)
        ? truncate(event.item.content.map((content) => content.text || '').join(' '))
        : '',
    };
  }
  if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
    summary.item_role = event.item?.role || null;
    summary.item_status = event.item?.status || null;
  }
  return summary;
}

class RealtimeProbe {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.url = `${WS_BASE_URL}?model=${encodeURIComponent(MODEL)}`;
    this.socket = null;
    this.seq = 0;
    this.rawEvents = [];
    this.events = [];
    this.clientEvents = [];
    this.waiters = [];
    this.errors = [];
    this.outputChunks = [];
    this.fallbackOutputChunks = [];
    this.inputTranscript = '';
    this.outputTranscript = '';
    this.toolCalls = new Map();
    this.closeInfo = null;
    this.messageChain = Promise.resolve();
    this.closePromise = new Promise((resolve) => { this.resolveClose = resolve; });
  }

  async connect() {
    if (typeof WebSocket !== 'function') {
      throw new Error('This script needs a Node.js runtime with built-in WebSocket support (Node 22+).');
    }

    await new Promise((resolve, reject) => {
      let opened = false;
      const socket = new WebSocket(this.url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      this.socket = socket;
      socket.binaryType = 'arraybuffer';
      socket.addEventListener('open', () => {
        opened = true;
        resolve();
      });
      socket.addEventListener('message', (message) => {
        this.messageChain = this.messageChain
          .then(() => this.consumeMessage(message.data))
          .catch((error) => this.recordLocalError(error));
      });
      socket.addEventListener('error', (event) => {
        if (!opened) {
          reject(new Error(`WebSocket connection error: ${event?.message || 'no handshake details'}`));
        } else {
          this.recordLocalError(new Error(`WebSocket error: ${event?.message || 'no details'}`));
        }
      });
      socket.addEventListener('close', (event) => {
        this.closeInfo = {
          code: event.code,
          reason: event.reason || '',
          wasClean: event.wasClean,
        };
        this.resolveClose(this.closeInfo);
      });
    });
  }

  async consumeMessage(data) {
    let text;
    if (typeof data === 'string') {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = Buffer.from(data).toString('utf8');
    } else if (data && typeof data.text === 'function') {
      text = await data.text();
    } else {
      text = String(data);
    }

    let event;
    try {
      event = JSON.parse(text);
    } catch {
      this.recordLocalError(new Error(`Non-JSON server frame: ${truncate(text)}`));
      return;
    }
    if (!event || typeof event.type !== 'string') {
      this.recordLocalError(new Error('Server frame did not contain an event type.'));
      return;
    }

    const entry = {
      seq: ++this.seq,
      receivedAt: new Date().toISOString(),
      receivedAtMs: Date.now(),
      type: event.type,
      summary: summarizeServerEvent(event),
    };
    this.rawEvents.push({ ...entry, raw: event });
    this.events.push(entry);

    if (event.type === 'error') this.errors.push(entry);
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      this.inputTranscript = event.transcript || '';
    }
    if (event.type === 'response.function_call_arguments.delta') {
      const callId = typeof event.call_id === 'string' ? event.call_id : '';
      if (callId) {
        const previous = this.toolCalls.get(callId) || { call_id: callId };
        this.toolCalls.set(callId, {
          ...previous,
          name: typeof event.name === 'string' ? event.name : previous.name,
          arguments: `${previous.arguments || ''}${event.delta || ''}`,
          response_id: typeof event.response_id === 'string' ? event.response_id : previous.response_id,
        });
      }
    }
    if (event.type === 'response.function_call_arguments.done') {
      const callId = typeof event.call_id === 'string' ? event.call_id : '';
      if (callId) {
        const previous = this.toolCalls.get(callId) || { call_id: callId };
        this.toolCalls.set(callId, {
          ...previous,
          name: typeof event.name === 'string' ? event.name : previous.name,
          arguments: typeof event.arguments === 'string' ? event.arguments : previous.arguments || '',
          response_id: typeof event.response_id === 'string' ? event.response_id : previous.response_id,
        });
      }
    }
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      const item = event.item;
      if (item?.type === 'function_call') {
        const callId = typeof item.call_id === 'string' ? item.call_id : item.id;
        if (callId) {
          const previous = this.toolCalls.get(callId) || { call_id: callId };
          this.toolCalls.set(callId, {
            ...previous,
            name: typeof item.name === 'string' ? item.name : previous.name,
            arguments: typeof item.arguments === 'string' ? item.arguments : previous.arguments || '',
            item_id: typeof item.id === 'string' ? item.id : previous.item_id,
            response_id: typeof event.response_id === 'string' ? event.response_id : previous.response_id,
          });
        }
      }
    }
    if (event.type === 'response.audio_transcript.delta') {
      this.outputTranscript += event.delta || '';
    }
    if (event.type === 'response.audio_transcript.done' && event.transcript) {
      this.outputTranscript = event.transcript;
    }
    if (event.type === 'response.audio.delta' && event.delta) {
      this.outputChunks.push(Buffer.from(event.delta, 'base64'));
    }
    if (event.type === 'response.content_part.added' && event.part?.audio) {
      this.fallbackOutputChunks.push(Buffer.from(event.part.audio, 'base64'));
    }

    for (const waiter of [...this.waiters]) {
      if (entry.seq <= waiter.afterSeq) continue;
      if (!waiter.predicate(event, entry)) continue;
      this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
      clearTimeout(waiter.timeout);
      waiter.resolve({ event, entry });
    }
  }

  firstToolCall() {
    return this.toolCalls.values().next().value || null;
  }

  recordLocalError(error) {
    this.errors.push({
      seq: ++this.seq,
      receivedAt: new Date().toISOString(),
      type: 'local.error',
      summary: { message: truncate(error?.message || error) },
    });
  }

  send(type, body = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`Cannot send ${type}: WebSocket is not open.`);
    }
    const event = {
      ...body,
      event_id: `stepfun_probe_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      type,
    };
    this.clientEvents.push({ type, event_id: event.event_id, sentAt: new Date().toISOString() });
    this.socket.send(JSON.stringify(event));
    return event.event_id;
  }

  waitFor(predicate, timeoutMs, label, afterSeq = 0) {
    const existing = this.rawEvents.find((candidate) => candidate.seq > afterSeq
      && predicate(candidate.raw, candidate));
    if (existing) return Promise.resolve({ event: existing.raw, entry: existing });

    return new Promise((resolve, reject) => {
      const waiter = {
        afterSeq,
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          reject(new Error(`Timed out waiting for ${label}.`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  waitForType(type, timeoutMs, afterSeq = 0) {
    return this.waitFor((event) => event.type === type, timeoutMs, type, afterSeq);
  }

  async close() {
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return this.closeInfo;
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, 'probe complete');
    return Promise.race([this.closePromise, sleep(1_000).then(() => this.closeInfo)]);
  }
}

function groupEventTypes(events) {
  const groups = [];
  for (const event of events) {
    const previous = groups.at(-1);
    if (previous?.type === event.type) {
      previous.count += 1;
      continue;
    }
    groups.push({ type: event.type, count: 1, first: event.summary });
  }
  return groups;
}

function classifyFailure(errors, closeInfo) {
  const text = JSON.stringify({ errors, closeInfo }).toLowerCase();
  if (/401|403|unauthor|forbidden|api.?key|token/.test(text)) return 'authentication';
  if (/model|permission|access|not.?found/.test(text)) return 'model permission';
  if (/invalid|param|unsupported|format|turn_detection|audio/.test(text)) return 'parameter';
  if (/protocol|event|incompatible/.test(text)) return 'API incompatibility';
  if (closeInfo || /websocket|network|timeout|handshake/.test(text)) return 'network';
  return 'unknown';
}

function printJson(label, value) {
  process.stdout.write(`${label}=${JSON.stringify(value)}\n`);
}

async function main() {
  const apiKey = process.env.STEPFUN_API_KEY;
  if (!apiKey) {
    throw new Error('STEPFUN_API_KEY is required; export it in the shell and do not put it in this file.');
  }

  const audio = makeInputAudio();
  if (audio.pcm16.length < 2) throw new Error('Input PCM16 audio is empty.');
  const probe = new RealtimeProbe(apiKey);
  const result = {
    model: MODEL,
    ws_url: probe.url,
    voice: VOICE,
    input_audio_format: 'pcm16',
    output_audio_format: 'pcm16',
    sample_rate_hz: SAMPLE_RATE,
    turn_detection: null,
    input_audio_bytes: audio.pcm16.length,
    input_audio_duration_ms: Math.round(audio.pcm16.length / 2 / SAMPLE_RATE * 1_000),
    input_audio_source: audio.sourceType,
    input_audio_path: audio.source,
    websocket_open: false,
    session_created: false,
    session_updated: false,
    websocket_auth: false,
    manual_commit: false,
    manual_response_create: false,
    delayed_response_5_to_6_seconds: false,
    no_automatic_response_before_response_create: false,
    input_audio_recognized: false,
    output_audio_received: false,
    context_injected_before_response: false,
    context_requested_item_id: CONTEXT_ITEM_ID,
    context_role: CONTEXT_ROLE,
    context_ack_event_observed: false,
    context_marker_in_output: false,
    tool_test_mode: TOOL_TEST_MODE || null,
    tool_configured: TOOL_TEST_MODE !== '',
    tool_call_requested: false,
    tool_call_name: null,
    tool_call_id: null,
    tool_arguments: null,
    tool_result_sent: false,
    tool_resume_response_create: false,
    tool_resume_response_done_status: null,
    tool_resume_audio_received: false,
    negative_no_tool_call: false,
    response_done_status: null,
    commit_to_response_create_ms: null,
    response_transcript: '',
    input_transcript: '',
    output_audio_path: null,
    errors: [],
  };

  let fatalError = null;
  let commitEntry = null;
  let responseCreateSentAtMs = null;

  try {
    await probe.connect();
    result.websocket_open = true;
    const sessionCreated = await probe.waitForType('session.created', 15_000);
    result.session_created = true;
    result.websocket_auth = true;
    result.session_created_config = sessionCreated.event.session || null;

    const updateAfterSeq = probe.seq;
    probe.send('session.update', {
      session: {
        modalities: ['text', 'audio'],
        instructions: TOOL_TEST_MODE === 'positive'
          ? `你是人生采访局的中文采访官。用户提到以前讲过的人物时，必须先静默调用 ${TOOL_NAME}，只传递你需要确认的信息。不要假装记得，也不要先回答。收到工具结果后，再用简洁、温和的中文继续采访。请使用默认男声与用户交流`
            : TOOL_TEST_MODE === 'negative'
              ? `你是人生采访局的中文采访官。当前用户只是在继续描述眼前经历，当前信息足够，不要调用任何工具，直接用简洁、温和的中文追问。请使用默认男声与用户交流`
              : '你是人生采访局的中文采访官。请简洁、温和地追问用户的经历。请使用默认男声与用户交流',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        voice: VOICE,
        turn_detection: null,
        ...(TOOL_TEST_MODE ? {
          tools: [{
            type: 'function',
            function: {
              name: TOOL_NAME,
              description: '当继续采访需要确认用户过去提到的人物、时间、关系或历史原话时调用。不要在当前信息足够时调用。',
              parameters: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description: '用一句简短中文描述需要确认的历史信息。',
                  },
                },
                required: ['query'],
                additionalProperties: false,
              },
            },
          }],
        } : {}),
      },
    });
    const sessionUpdated = await probe.waitForType('session.updated', 15_000, updateAfterSeq);
    result.session_updated = true;
    result.session_config = sessionUpdated.event.session || null;
    result.turn_detection = sessionUpdated.event.session?.turn_detection ?? null;

    const appendAfterSeq = probe.seq;
    probe.send('input_audio_buffer.append', {
      audio: audio.pcm16.toString('base64'),
    });
    const commitSentAtMs = Date.now();
    probe.send('input_audio_buffer.commit');
    const committed = await probe.waitForType('input_audio_buffer.committed', 15_000, appendAfterSeq);
    commitEntry = committed.entry;
    result.manual_commit = true;

    const holdStartedAtMs = Date.now();
    if (!TOOL_TEST_MODE) {
      const contextAfterSeq = probe.seq;
      probe.send('conversation.item.create', {
        item: {
          id: CONTEXT_ITEM_ID,
          type: 'message',
          role: CONTEXT_ROLE,
          content: [{
            type: 'input_text',
            text: CONTEXT_TEXT,
          }],
        },
      });
      try {
        await probe.waitFor(
          (event) => event.type === 'conversation.item.created'
            && event.item?.role === CONTEXT_ROLE
            && event.item?.id
            && event.item.id !== committed.event.item_id,
          750,
          'context conversation.item.created',
          contextAfterSeq,
        );
        result.context_ack_event_observed = true;
      } catch {
        result.context_ack_event_observed = false;
      }
    }

    const remainingHoldMs = TOOL_TEST_MODE ? 0 : HOLD_MS - (Date.now() - holdStartedAtMs);
    if (remainingHoldMs > 0) await sleep(remainingHoldMs);

    const responseBeforeCreate = probe.rawEvents.some((event) => event.type === 'response.created'
      && event.receivedAtMs >= commitEntry.receivedAtMs);
    result.no_automatic_response_before_response_create = !responseBeforeCreate;
    const responseAfterSeq = probe.seq;
    responseCreateSentAtMs = Date.now();
    probe.send('response.create');
    const responseCreated = await probe.waitForType('response.created', 30_000, responseAfterSeq);
    result.manual_response_create = responseCreated.entry.receivedAtMs >= responseCreateSentAtMs - 100;
    result.commit_to_response_create_ms = responseCreateSentAtMs - commitEntry.receivedAtMs;
    result.delayed_response_5_to_6_seconds = TOOL_TEST_MODE
      ? true
      : result.commit_to_response_create_ms >= 4_500 && result.commit_to_response_create_ms <= 6_500;

    if (TOOL_TEST_MODE === 'positive') {
      const toolEvent = await probe.waitFor(
        (event) => event.type === 'response.function_call_arguments.done'
          || (event.type === 'response.output_item.done' && event.item?.type === 'function_call'),
        30_000,
        'Step-Audio function call',
        responseCreated.entry.seq - 1,
      );
      const toolCall = probe.firstToolCall();
      if (!toolCall?.call_id || toolCall.name !== TOOL_NAME) {
        throw new Error(`Unexpected tool call: ${JSON.stringify({ event: toolEvent.event, toolCall })}`);
      }
      result.tool_call_requested = true;
      result.tool_call_name = toolCall.name;
      result.tool_call_id = toolCall.call_id;
      result.tool_arguments = toolCall.arguments || '';

      const toolResponseDone = await probe.waitForType('response.done', 30_000, responseCreated.entry.seq - 1);
      result.response_done_status = toolResponseDone.event.response?.status || null;
      probe.send('conversation.item.create', {
        item: {
          type: 'function_call_output',
          call_id: toolCall.call_id,
          output: JSON.stringify({
            based_on_turn_id: 'probe-turn-1',
            facts: [{ claim: '用户此前提到王师傅是入厂后的第一位师傅。', source_message_ids: ['probe-msg-1'] }],
            possible_conflicts: [],
            interview_hints: ['可以自然追问第一次跟王师傅一起工作的场景。'],
          }),
        },
      });
      result.tool_result_sent = true;
      const resumeAfterSeq = probe.seq;
      probe.send('response.create');
      const resumedResponse = await probe.waitForType('response.created', 30_000, resumeAfterSeq);
      result.tool_resume_response_create = Boolean(resumedResponse.event);
      const resumedDone = await probe.waitForType('response.done', 60_000, resumedResponse.entry.seq - 1);
      result.tool_resume_response_done_status = resumedDone.event.response?.status || null;
      result.response_done_status = result.tool_resume_response_done_status;
      result.input_transcript = probe.inputTranscript;
      result.response_transcript = probe.outputTranscript;
      result.tool_resume_audio_received = probe.outputChunks.length > 0 || probe.fallbackOutputChunks.length > 0;
    } else if (TOOL_TEST_MODE === 'negative') {
      const responseDone = await probe.waitForType('response.done', 60_000, responseCreated.entry.seq - 1);
      result.response_done_status = responseDone.event.response?.status || null;
      result.negative_no_tool_call = ![...probe.toolCalls.values()].some((call) => call.name === TOOL_NAME);
      result.input_transcript = probe.inputTranscript;
      result.response_transcript = probe.outputTranscript;
    } else {
      const responseDone = await probe.waitForType('response.done', 60_000, responseCreated.entry.seq - 1);
      result.response_done_status = responseDone.event.response?.status || null;
      result.input_transcript = probe.inputTranscript;
      result.response_transcript = probe.outputTranscript;
      result.context_marker_in_output = probe.outputTranscript.includes('上下文已注入');
      result.context_injected_before_response = result.context_ack_event_observed
        || result.context_marker_in_output;
    }
    result.input_audio_recognized = Boolean(probe.inputTranscript.trim());
    if (probe.outputChunks.length === 0) probe.outputChunks = probe.fallbackOutputChunks;
    result.output_audio_received = probe.outputChunks.some((chunk) => chunk.length > 0)
      && probe.events.some((event) => event.type === 'response.audio.done');

    if (probe.outputChunks.length > 0) {
      const outputPcm16 = Buffer.concat(probe.outputChunks);
      writeWav(OUTPUT_PATH, outputPcm16, SAMPLE_RATE);
      result.output_audio_path = OUTPUT_PATH;
      result.output_audio_bytes = outputPcm16.length;
      result.output_audio_duration_ms = Math.round(outputPcm16.length / 2 / SAMPLE_RATE * 1_000);
    }
  } catch (error) {
    fatalError = error;
  } finally {
    result.errors = probe.errors.map((error) => ({
      seq: error.seq,
      type: error.type,
      summary: error.summary,
    }));
    await probe.close();
  }

  const basePassed = result.websocket_auth
    && result.session_updated
    && result.manual_commit
    && result.manual_response_create
    && result.delayed_response_5_to_6_seconds
    && result.no_automatic_response_before_response_create
    && result.input_audio_recognized
    && result.output_audio_received
    && result.response_done_status === 'completed';
  const passed = TOOL_TEST_MODE === 'positive'
    ? result.websocket_auth
      && result.session_updated
      && result.manual_commit
      && result.manual_response_create
      && result.no_automatic_response_before_response_create
      && result.input_audio_recognized
      && result.tool_call_requested
      && result.tool_result_sent
      && result.tool_resume_response_create
      && result.tool_resume_response_done_status === 'completed'
      && result.tool_resume_audio_received
      : TOOL_TEST_MODE === 'negative'
        ? basePassed && result.tool_configured && result.negative_no_tool_call
        : basePassed;
  const report = {
    generated_at: new Date().toISOString(),
    config: {
      websocket_url: result.ws_url,
      model: MODEL,
      authorization_header: 'Bearer <redacted>',
      voice: VOICE,
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      sample_rate_hz: SAMPLE_RATE,
      turn_detection: null,
      hold_ms_requested: HOLD_MS,
    },
    result: {
      ...result,
      pass: passed,
      fatal_error: fatalError?.message || null,
      failure_category: fatalError || result.errors.length
        ? classifyFailure(result.errors, probe.closeInfo)
        : null,
    },
    server_event_sequence: groupEventTypes(probe.events),
    server_events: probe.events,
    client_events: probe.clientEvents,
    connection_close: probe.closeInfo,
  };

  if (REPORT_PATH) {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }

  printJson('RESULT', report.result);
  printJson('SERVER_EVENT_SEQUENCE', report.server_event_sequence);
  printJson('SERVER_EVENTS', report.server_events);
  if (REPORT_PATH) process.stdout.write(`REPORT_PATH=${REPORT_PATH}\n`);
  if (fatalError) process.stderr.write(`FATAL_ERROR=${fatalError.message}\n`);
  process.exitCode = passed ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`FATAL_ERROR=${error.message}\n`);
  process.exitCode = 1;
});
