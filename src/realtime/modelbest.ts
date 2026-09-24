import { buildInterviewInstructions, type RealtimeInterviewContext } from './prompt.js';
import type { RealtimeProviderConfig, RealtimeVoiceProvider } from './provider.js';
import type { NormalizedRealtimeEvent, RealtimeConnectionFailure } from './types.js';

export const DEFAULT_MODELBEST_MODEL = 'MiniCPM-o-4.5-Realtime';
export const MODELBEST_REALTIME_URL = 'wss://api.modelbest.cn/v1/realtime';
export const MODELBEST_INPUT_SAMPLE_RATE = 16_000;
export const MODELBEST_OUTPUT_SAMPLE_RATE = 24_000;
export const MODELBEST_PCM_FRAME_BYTES = 640;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseMessage(raw: unknown): Record<string, unknown> | undefined {
  try {
    const text = typeof raw === 'string'
      ? raw
      : Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw).toString('utf8')
          : ArrayBuffer.isView(raw)
            ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
            : '';
    const parsed: unknown = JSON.parse(text);
    const event = record(parsed);
    return typeof event?.type === 'string' ? event : undefined;
  } catch {
    return undefined;
  }
}

export function encodePcm16ToFloat32Base64(audio: Uint8Array): string {
  if (audio.byteLength % 2 !== 0) throw new RangeError('PCM16 audio must be aligned to two-byte samples.');
  const samples = Buffer.alloc(audio.byteLength * 2);
  const input = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  for (let offset = 0; offset < input.byteLength; offset += 2) {
    const sample = input.readInt16LE(offset) / 32768;
    samples.writeFloatLE(sample, offset * 2);
  }
  return samples.toString('base64');
}

export function decodeFloat32Base64ToPcm16(audio: string): Buffer {
  const input = Buffer.from(audio, 'base64');
  if (input.byteLength % 4 !== 0) throw new RangeError('Float32 audio must be aligned to four-byte samples.');
  const output = Buffer.alloc(input.byteLength / 2);
  for (let inputOffset = 0, outputOffset = 0; inputOffset < input.byteLength; inputOffset += 4, outputOffset += 2) {
    const raw = input.readFloatLE(inputOffset);
    const sample = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
    output.writeInt16LE(sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), outputOffset);
  }
  return output;
}

function sanitizedProviderError(event: Record<string, unknown>, secret?: string): string {
  const details = record(event.error);
  const rawMessage = typeof details?.message === 'string' ? details.message : 'Realtime 服务返回错误。';
  const message = secret ? rawMessage.split(secret).join('[redacted]') : rawMessage;
  const code = typeof details?.code === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.test(details.code)
    ? ` (${details.code})`
    : '';
  return `MiniCPM-o Realtime：${message}${code}`;
}

function connectionFailureMessage(failure: RealtimeConnectionFailure, secret?: string): string {
  if (failure.kind === 'timeout') return '连接面壁 MiniCPM-o Realtime 超时，请检查 MODELBEST_API_KEY、模型权限与网络。';
  if (failure.kind === 'unexpected-response') {
    if (failure.statusCode === 401 || failure.statusCode === 403) return '面壁 MiniCPM-o Realtime 鉴权失败，请检查 MODELBEST_API_KEY。';
    if (failure.statusCode === 404) return '面壁 Realtime 地址或模型不存在，请检查 MODELBEST_REALTIME_MODEL。';
    return `面壁 MiniCPM-o Realtime 握手失败（HTTP ${failure.statusCode ?? 'unknown'}）。`;
  }
  if (failure.kind === 'socket-error') {
    return `面壁 MiniCPM-o Realtime 连接失败：${secret ? failure.message.split(secret).join('[redacted]') : failure.message}`;
  }
  return failure.phase === 'connect'
    ? `面壁 MiniCPM-o Realtime 在初始化时断开（${failure.code}）。`
    : `面壁 MiniCPM-o Realtime 连接中断（${failure.code}），本次 Transcript 将保留。`;
}

export function createModelBestRealtimeProvider(config: RealtimeProviderConfig): RealtimeVoiceProvider {
  let activeResponseId: string | undefined;
  let fallbackResponseSequence = 0;
  const startedResponses = new Set<string>();
  const startedAudioResponses = new Set<string>();

  const responseIdFor = (event: Record<string, unknown>): string => {
    const id = typeof event.response_id === 'string'
      ? event.response_id
      : typeof event.responseId === 'string'
        ? event.responseId
        : activeResponseId;
    if (id) {
      activeResponseId = id;
      return id;
    }
    fallbackResponseSequence += 1;
    activeResponseId = `modelbest-response-${fallbackResponseSequence}`;
    return activeResponseId;
  };

  const startResponse = (responseId: string): NormalizedRealtimeEvent[] => {
    if (startedResponses.has(responseId)) return [];
    startedResponses.add(responseId);
    return [{ type: 'assistant.started', responseId }];
  };

  const normalize = (raw: unknown): NormalizedRealtimeEvent[] => {
    const event = parseMessage(raw);
    if (!event) return [];
    const type = String(event.type);
    const eventId = typeof event.event_id === 'string' ? event.event_id : undefined;
    if (type === 'session.queue_done' || type === 'queue_done') return [{ type: 'session.queue.ready' }];
    if (type === 'session.created') {
      return [{
        type: 'session.ready',
        ...(typeof event.session_id === 'string'
          ? { providerSessionId: event.session_id }
          : typeof record(event.session)?.id === 'string'
            ? { providerSessionId: record(event.session)?.id as string }
            : {}),
      }];
    }
    if (type === 'session.closed') {
      activeResponseId = undefined;
      startedResponses.clear();
      startedAudioResponses.clear();
      return [{ type: 'session.closed' }];
    }
    if (type === 'error') {
      return [{ type: 'provider.error', message: sanitizedProviderError(event, config.modelbestApiKey), phase: 'stream' }];
    }

    if (type === 'response.listen' || type === 'user.transcript') {
      const text = typeof event.transcript === 'string'
        ? event.transcript
        : typeof event.text === 'string'
          ? event.text
          : typeof event.delta === 'string' ? event.delta : '';
      if (!text) return [];
      const final = event.is_final !== false && event.final !== false;
      return [final
        ? { type: 'user.transcript.final', text, ...(eventId ? { eventId } : {}), ...(typeof event.item_id === 'string' ? { itemId: event.item_id } : {}) }
        : { type: 'user.transcript.delta', text, deltaChars: text.length, ...(eventId ? { eventId } : {}), ...(typeof event.item_id === 'string' ? { itemId: event.item_id } : {}) }];
    }

    if (type === 'response.output.delta') {
      const kind = String(event.kind ?? '');
      if (kind === 'listen') {
        const responseId = typeof event.response_id === 'string' ? event.response_id : activeResponseId;
        if (!responseId) return [];
        startedResponses.delete(responseId);
        startedAudioResponses.delete(responseId);
        if (activeResponseId === responseId) activeResponseId = undefined;
        return [{ type: 'response.done', responseId, status: 'completed' }];
      }
      if (kind === 'text') return normalize(JSON.stringify({ ...event, type: 'response.output_text.delta' }));
      if (kind === 'audio') return normalize(JSON.stringify({ ...event, type: 'response.output_audio.delta' }));
      return [];
    }

    if (type === 'response.output_text.delta' || type === 'response.text.delta') {
      const delta = typeof event.text === 'string' ? event.text : typeof event.delta === 'string' ? event.delta : '';
      if (!delta) return [];
      const responseId = responseIdFor(event);
      return [
        ...startResponse(responseId),
        { type: 'assistant.transcript.delta', responseId, delta, ...(eventId ? { eventId } : {}), ...(typeof event.item_id === 'string' ? { itemId: event.item_id } : {}) },
      ];
    }

    if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
      const encoded = typeof event.audio === 'string' ? event.audio : typeof event.delta === 'string' ? event.delta : '';
      if (!encoded) return [];
      const responseId = responseIdFor(event);
      try {
        const audio = decodeFloat32Base64ToPcm16(encoded).toString('base64');
        if (!audio) return [];
        const output: NormalizedRealtimeEvent[] = [...startResponse(responseId)];
        if (!startedAudioResponses.has(responseId)) {
          startedAudioResponses.add(responseId);
          output.push({ type: 'assistant.audio.started', responseId });
        }
        output.push({ type: 'assistant.audio.delta', responseId, audio, encoding: 'pcm_s16le' });
        return output;
      } catch {
        return [{ type: 'provider.error', message: 'MiniCPM-o Realtime 返回了无法解码的音频片段。', phase: 'stream' }];
      }
    }

    if (type === 'response.done') {
      const responseId = responseIdFor(event);
      startedResponses.delete(responseId);
      startedAudioResponses.delete(responseId);
      if (activeResponseId === responseId) activeResponseId = undefined;
      const response = record(event.response);
      const status = String(response?.status ?? event.status ?? 'completed');
      if (status === 'cancelled' || status === 'canceled') {
        return [{ type: 'response.cancelled', responseId }];
      }
      return [{
        type: 'response.done',
        responseId,
        status,
        ...(typeof event.text === 'string' && event.text ? { finalText: event.text } : {}),
      }];
    }
    if (type === 'response.cancelled' || type === 'response.canceled') {
      const responseId = responseIdFor(event);
      startedResponses.delete(responseId);
      startedAudioResponses.delete(responseId);
      if (activeResponseId === responseId) activeResponseId = undefined;
      return [{ type: 'response.cancelled', responseId }];
    }
    return [];
  };

  return {
    id: 'modelbest',
    requiresQueueBeforeSessionInit: true,
    capabilities: {
      fullDuplex: true,
      supportsInterrupt: false,
      supportsExplicitTurnRequest: false,
      supportsPlaybackAck: false,
      supportsExplicitSessionClose: true,
    },
    audio: {
      input: { encoding: 'pcm_s16le', sampleRate: MODELBEST_INPUT_SAMPLE_RATE, frameBytes: MODELBEST_PCM_FRAME_BYTES },
      output: { encoding: 'pcm_s16le', sampleRate: MODELBEST_OUTPUT_SAMPLE_RATE },
    },
    connectOptions() {
      const apiKey = config.modelbestApiKey?.trim();
      if (!apiKey) throw new Error('尚未配置面壁 MiniCPM-o Realtime。请在项目 .env 中填写 MODELBEST_API_KEY 后重启服务。');
      const model = config.model?.trim() || DEFAULT_MODELBEST_MODEL;
      const url = new URL(MODELBEST_REALTIME_URL);
      url.searchParams.set('mode', 'audio');
      url.searchParams.set('model', model);
      return { url: url.toString(), headers: { Authorization: `Bearer ${apiKey}` } };
    },
    setupSession(context: RealtimeInterviewContext) {
      return [{
        type: 'session.init',
        payload: {
          system_prompt: buildInterviewInstructions(context),
          config: { tts_enabled: true },
        },
      }];
    },
    initialResponsePlan: () => ({ steps: [] }),
    appendAudioMessages(audio) {
      return [{
        type: 'input.append',
        input: { audio: encodePcm16ToFloat32Base64(audio), force_listen: false },
      }];
    },
    requestAssistantTurnMessages: () => [],
    stopInputAfterCurrentTurn: () => [],
    beginInputShutdown: () => [],
    closePlan: () => ({
      steps: [{ message: { type: 'session.close', reason: 'user_stop' } }],
      waitFor: 'session.closed',
      timeoutMs: 5_000,
    }),
    connectionFailureMessage: (failure) => connectionFailureMessage(failure, config.modelbestApiKey),
    normalizeServerMessage: normalize,
    handleControlEvent: () => [],
  };
}
