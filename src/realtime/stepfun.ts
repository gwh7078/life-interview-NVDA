import { buildInterviewInstructions, type RealtimeInterviewContext } from './prompt.js';
import type { RealtimeProviderConfig, RealtimeVoiceProvider } from './provider.js';
import type {
  NormalizedRealtimeEvent,
  RealtimeAudioSpec,
  RealtimeClosePlan,
  RealtimeConnectionFailure,
  RealtimeOutboundStep,
  RealtimeProviderCapabilities,
} from './types.js';

export const DEFAULT_STEPFUN_MODEL = 'step-audio-2-mini';
export const DEFAULT_STEPFUN_VOICE = 'wenrounansheng';
export const STEPFUN_REALTIME_URL = 'wss://api.stepfun.com/v1/realtime';
export const STEPFUN_INPUT_SAMPLE_RATE = 24_000;
export const STEPFUN_OUTPUT_SAMPLE_RATE = 24_000;
export const STEPFUN_PCM_FRAME_BYTES = 960;
export const STEPFUN_CONTEXT_TOOL = 'get_interview_context';

const STEPFUN_CONTEXT_TOOL_DESCRIPTION = '当继续采访需要确认用户过去提到的人物、时间、关系或历史原话时调用。当前信息足够时不要调用。';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function responseOutputText(value: unknown): { text?: string; itemId?: string } {
  const response = record(value);
  const output = Array.isArray(response?.output) ? response.output : [];
  for (const rawItem of output) {
    const item = record(rawItem);
    if (item?.role !== 'assistant' || !Array.isArray(item.content)) continue;
    for (const rawPart of item.content) {
      const part = record(rawPart);
      const text = typeof part?.transcript === 'string'
        ? part.transcript
        : typeof part?.text === 'string' ? part.text : undefined;
      if (text !== undefined) {
        return { text, itemId: typeof item.id === 'string' ? item.id : undefined };
      }
    }
  }
  return {};
}

function sanitizedProviderError(
  event: Record<string, unknown>,
  secret?: string,
): string {
  const details = record(event.error);
  const raw = typeof details?.message === 'string' ? details.message : 'Realtime 服务返回错误。';
  const message = secret ? raw.split(secret).join('[redacted]') : raw;
  const code = typeof details?.code === 'string' ? ` (${details.code})` : '';
  return `StepFun Realtime：${message}${code}`;
}

export function buildStepfunRealtimeUrl(model = DEFAULT_STEPFUN_MODEL): string {
  return `${STEPFUN_REALTIME_URL}?model=${encodeURIComponent(model.trim() || DEFAULT_STEPFUN_MODEL)}`;
}

export function buildStepfunContextTool(): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: STEPFUN_CONTEXT_TOOL,
      description: STEPFUN_CONTEXT_TOOL_DESCRIPTION,
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
  };
}

export function buildStepfunSessionUpdate(
  context: RealtimeInterviewContext,
  voice = DEFAULT_STEPFUN_VOICE,
): Record<string, unknown> {
  const allowsContextTool = context.interview_type === undefined || context.interview_type === 'story';
  const toolInstructions = `\n\n## 历史上下文工具\n当当前轮需要确认用户以前讲过的人物、时间、关系或原话时，先静默调用 ${STEPFUN_CONTEXT_TOOL}，只传递需要确认的信息；不要假装记得，也不要把工具调用过程说给用户听。收到工具结果后再继续回答。当前信息足够时不要调用工具。`;
  return {
    type: 'session.update',
    session: {
      modalities: ['text', 'audio'],
      instructions: `${buildInterviewInstructions(context)}${allowsContextTool ? toolInstructions : ''}请使用默认男声与用户交流。`,
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      voice,
      turn_detection: {
        type: 'server_vad',
        prefix_padding_ms: 300,
        silence_duration_ms: 700,
      },
      ...(allowsContextTool ? { tools: [buildStepfunContextTool()] } : {}),
    },
  };
}

export function buildStepfunAudioAppend(audio: Uint8Array): Record<string, string> {
  return {
    type: 'input_audio_buffer.append',
    audio: Buffer.from(audio).toString('base64'),
  };
}

export function buildStepfunToolResult(
  callId: string,
  output: unknown,
  options: { resume?: boolean } = {},
): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [
    {
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(output),
      },
    },
  ];
  if (options.resume !== false) messages.push({
    type: 'response.create',
    response: { modalities: ['text', 'audio'] },
  });
  return messages;
}

export function parseStepfunServerEvent(raw: unknown): Record<string, unknown> | null {
  try {
    let text: string;
    if (typeof raw === 'string') {
      text = raw;
    } else if (Buffer.isBuffer(raw)) {
      text = raw.toString('utf8');
    } else if (Array.isArray(raw) && raw.every((part) => Buffer.isBuffer(part))) {
      text = Buffer.concat(raw).toString('utf8');
    } else if (raw instanceof ArrayBuffer) {
      text = Buffer.from(raw).toString('utf8');
    } else if (ArrayBuffer.isView(raw)) {
      text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
    } else {
      return null;
    }
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof (parsed as Record<string, unknown>).type !== 'string') return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stepfunCapabilities(): RealtimeProviderCapabilities {
  return {
    fullDuplex: true,
    supportsInterrupt: true,
    supportsExplicitTurnRequest: true,
    supportsPlaybackAck: false,
    supportsExplicitSessionClose: false,
  };
}

function stepfunAudio(): RealtimeAudioSpec {
  return {
    input: { encoding: 'pcm_s16le', sampleRate: STEPFUN_INPUT_SAMPLE_RATE, frameBytes: STEPFUN_PCM_FRAME_BYTES },
    output: { encoding: 'pcm_s16le', sampleRate: STEPFUN_OUTPUT_SAMPLE_RATE },
  };
}

function stepfunConnectionFailureMessage(
  failure: RealtimeConnectionFailure,
  secret?: string,
): string {
  if (failure.kind === 'timeout') return '连接 StepFun Realtime 超时，请检查 STEPFUN_API_KEY、模型权限与网络。';
  if (failure.kind === 'unexpected-response') {
    if (failure.statusCode === 401 || failure.statusCode === 403) return 'StepFun Realtime 鉴权失败，请检查 STEPFUN_API_KEY。';
    if (failure.statusCode === 404) return 'StepFun Realtime 地址或模型不存在，请检查 STEPFUN_REALTIME_MODEL。';
    return `StepFun Realtime 握手失败（HTTP ${failure.statusCode ?? 'unknown'}）。`;
  }
  if (failure.kind === 'socket-error') {
    return `StepFun Realtime 连接失败：${secret ? failure.message.split(secret).join('[redacted]') : failure.message}`;
  }
  return failure.phase === 'connect'
    ? `StepFun Realtime 在初始化时断开（${failure.code}）。`
    : `StepFun Realtime 连接中断（${failure.code}），本次 Transcript 将保留。`;
}

export function createStepfunRealtimeProvider(
  config: RealtimeProviderConfig,
): RealtimeVoiceProvider {
  let activeResponseId: string | undefined;
  const audioStartedResponses = new Set<string>();
  const toolArgumentsByCall = new Map<string, string>();
  const emittedToolCalls = new Set<string>();

  const responseIdFor = (event: Record<string, unknown>): string => {
    const response = record(event.response);
    const resolved = typeof event.response_id === 'string'
      ? event.response_id
      : typeof response?.id === 'string'
        ? response.id
        : activeResponseId ?? 'response';
    activeResponseId = resolved;
    return resolved;
  };

  const normalize = (raw: unknown): NormalizedRealtimeEvent[] => {
    const event = parseStepfunServerEvent(raw);
    if (!event) return [];
    const type = String(event.type ?? '');
    const eventId = typeof event.event_id === 'string' ? event.event_id : undefined;
    if (type === 'session.created' || type === 'session.updated') {
      const session = record(event.session);
      return [{
        type: 'session.ready',
        ...(typeof session?.id === 'string' ? { providerSessionId: session.id } : {}),
      }];
    }
    if (type === 'session.closed') return [{ type: 'session.closed' }];
    if (type === 'error') return [{ type: 'provider.error', message: sanitizedProviderError(event, config.stepfunApiKey), phase: 'stream' }];
    if (type === 'input_audio_buffer.speech_started') {
      return [{ type: 'speech.started', ...(eventId ? { eventId } : {}) }];
    }
    if (type === 'input_audio_buffer.speech_stopped' || type === 'input_audio_buffer.committed') {
      return [{
        type: 'speech.stopped',
        source: type === 'input_audio_buffer.committed' ? 'committed' : 'speech_stopped',
        ...(eventId ? { eventId } : {}),
      }];
    }
    if (type === 'conversation.item.input_audio_transcription.delta') {
      const text = typeof event.delta === 'string' ? event.delta : typeof event.text === 'string' ? event.text : '';
      return [{
        type: 'user.transcript.delta',
        text,
        deltaChars: text.length,
        ...(eventId ? { eventId } : {}),
        ...(typeof event.item_id === 'string' ? { itemId: event.item_id } : {}),
      }];
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      return [{
        type: 'user.transcript.final',
        text: typeof event.transcript === 'string' ? event.transcript : typeof event.text === 'string' ? event.text : '',
        ...(eventId ? { eventId } : {}),
        ...(typeof event.item_id === 'string' ? { itemId: event.item_id } : {}),
      }];
    }
    if (type === 'response.created') {
      return [{ type: 'assistant.started', responseId: responseIdFor(event), ...(eventId ? { eventId } : {}) }];
    }
    if (type === 'response.function_call_arguments.delta') {
      const callId = typeof event.call_id === 'string' ? event.call_id : typeof event.item_id === 'string' ? event.item_id : '';
      if (callId) toolArgumentsByCall.set(callId, `${toolArgumentsByCall.get(callId) ?? ''}${typeof event.delta === 'string' ? event.delta : ''}`);
      return [];
    }
    if (type === 'response.function_call_arguments.done') {
      const callId = typeof event.call_id === 'string' ? event.call_id : typeof event.item_id === 'string' ? event.item_id : '';
      if (!callId || emittedToolCalls.has(callId)) return [];
      emittedToolCalls.add(callId);
      const rawArguments = typeof event.arguments === 'string'
        ? event.arguments
        : toolArgumentsByCall.get(callId) ?? '{}';
      return [{
        type: 'tool.call.requested',
        name: typeof event.name === 'string' ? event.name : STEPFUN_CONTEXT_TOOL,
        callId,
        arguments: parseJsonObject(rawArguments),
        rawArguments,
        responseId: responseIdFor(event),
        ...(typeof event.item_id === 'string' ? { itemId: event.item_id } : {}),
        ...(eventId ? { eventId } : {}),
      }];
    }
    if (type === 'response.audio_transcript.delta' || type === 'response.text.delta') {
      return [{
        type: 'assistant.transcript.delta',
        responseId: responseIdFor(event),
        delta: typeof event.delta === 'string' ? event.delta : '',
        ...(eventId ? { eventId } : {}),
        ...(typeof event.item_id === 'string' ? { itemId: event.item_id } : {}),
      }];
    }
    if (type === 'response.audio_transcript.done' || type === 'response.text.done') {
      return [{
        type: 'assistant.transcript.final',
        responseId: responseIdFor(event),
        text: typeof event.transcript === 'string' ? event.transcript : typeof event.text === 'string' ? event.text : '',
        ...(eventId ? { eventId } : {}),
        ...(typeof event.item_id === 'string' ? { itemId: event.item_id } : {}),
      }];
    }
    if (type === 'response.audio.delta') {
      const responseId = responseIdFor(event);
      const audio = typeof event.delta === 'string' ? event.delta : '';
      if (!audio) return [];
      const events: NormalizedRealtimeEvent[] = [];
      if (!audioStartedResponses.has(responseId)) {
        audioStartedResponses.add(responseId);
        events.push({ type: 'assistant.audio.started', responseId });
      }
      events.push({ type: 'assistant.audio.delta', responseId, audio, encoding: 'pcm_s16le' });
      return events;
    }
    if (type === 'response.audio.done') {
      const responseId = responseIdFor(event);
      audioStartedResponses.delete(responseId);
      return [{ type: 'assistant.audio.done', responseId }];
    }
    if (type === 'response.done' || type === 'response.cancelled' || type === 'response.canceled') {
      const response = record(event.response);
      const responseId = responseIdFor(event);
      const status = type === 'response.cancelled' || type === 'response.canceled'
        ? 'cancelled'
        : String(response?.status ?? event.status ?? 'unknown');
      audioStartedResponses.delete(responseId);
      if (status === 'cancelled') return [{ type: 'response.cancelled', responseId }];
      const fallback = responseOutputText(response);
      return [{
        type: 'response.done',
        responseId,
        status,
        ...(fallback.text ? { finalText: fallback.text } : {}),
        ...(fallback.itemId ? { finalItemId: fallback.itemId } : {}),
      }];
    }
    return [];
  };

  const adapter: RealtimeVoiceProvider = {
    id: 'stepfun',
    capabilities: stepfunCapabilities(),
    audio: stepfunAudio(),
    connectOptions() {
      if (!config.stepfunApiKey) throw new Error('尚未配置 StepFun Realtime。请在项目 .env 中填写 STEPFUN_API_KEY 后重启服务。');
      return {
        url: buildStepfunRealtimeUrl(config.model?.trim() || DEFAULT_STEPFUN_MODEL),
        headers: { Authorization: `Bearer ${config.stepfunApiKey}` },
      };
    },
    setupSession: (context) => [buildStepfunSessionUpdate(context)],
    initialResponsePlan: () => ({
      steps: [{ message: { type: 'response.create', response: { modalities: ['text', 'audio'] } } }],
    }),
    appendAudioMessages: (audio) => [buildStepfunAudioAppend(audio)],
    recoverStalledUserTurn: () => [{ message: { type: 'input_audio_buffer.commit' } }],
    stopInputAfterCurrentTurn: () => [],
    beginInputShutdown: () => Array.from({ length: 40 }, () => ({
      message: buildStepfunAudioAppend(Buffer.alloc(STEPFUN_PCM_FRAME_BYTES)),
      delayAfterMs: 20,
    })),
    closePlan: (): RealtimeClosePlan | null => null,
    connectionFailureMessage: (failure) => stepfunConnectionFailureMessage(failure, config.stepfunApiKey),
    requestAssistantTurnMessages: (instruction) => [{
      type: 'response.create',
      response: { modalities: ['text', 'audio'], instructions: instruction },
    }],
    normalizeServerMessage: normalize,
    handleControlEvent: () => [],
    handleToolResult: (call, output, options) => buildStepfunToolResult(call.callId, output, options),
  };
  return adapter;
}
