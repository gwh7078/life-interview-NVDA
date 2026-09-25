import { buildInterviewContextPayload, buildInterviewInstructions, type RealtimeInterviewContext } from './prompt.js';
import type { RealtimeProviderConfig, RealtimeVoiceProvider } from './provider.js';
import type { RealtimeContextHint } from './slow-coordinator.js';
import {
  INTERVIEW_CONTEXT_TOOL_NAME,
  type NormalizedRealtimeEvent,
  type RealtimeAudioSpec,
  type RealtimeClosePlan,
  type RealtimeConnectionFailure,
  type RealtimeOutboundStep,
  type RealtimeProviderCapabilities,
} from './types.js';

export const DEFAULT_STEPFUN_MODEL = 'step-audio-2-mini';
export const STEPAUDIO_3_REALTIME_PREVIEW = 'stepaudio-3-realtime-preview';
export const DEFAULT_STEPAUDIO3_MODEL = STEPAUDIO_3_REALTIME_PREVIEW;
export const DEFAULT_STEPFUN_VOICE = 'wenrounansheng';
export const STEPFUN_REALTIME_URL = 'wss://api.stepfun.com/v1/realtime';
export const STEPFUN_INPUT_SAMPLE_RATE = 24_000;
export const STEPFUN_OUTPUT_SAMPLE_RATE = 24_000;
export const STEPFUN_PCM_FRAME_BYTES = 960;
export const STEPFUN_CONTEXT_TOOL = INTERVIEW_CONTEXT_TOOL_NAME;

export type StepFunRealtimeProfileId = 'stepaudio3_quality' | 'stepaudio2_mini';

const STEPFUN_CAPABILITIES: RealtimeProviderCapabilities = {
  fullDuplex: true,
  supportsInterrupt: false,
  supportsToolCalling: true,
  supportsContextInjection: true,
  supportsExplicitTurnRequest: true,
  supportsPlaybackAck: false,
  supportsExplicitSessionClose: false,
  manualTurnControl: true,
};

export const STEPFUN_REALTIME_PROFILES = {
  stepaudio3_quality: {
    model: DEFAULT_STEPAUDIO3_MODEL,
    execution: 'stepfun-cloud',
    openingPrelude: true,
    capabilities: STEPFUN_CAPABILITIES,
  },
  stepaudio2_mini: {
    model: DEFAULT_STEPFUN_MODEL,
    execution: 'stepfun-cloud',
    openingPrelude: false,
    capabilities: STEPFUN_CAPABILITIES,
  },
} as const;

const STEPFUN_CONTEXT_TOOL_DESCRIPTION = '读取系统已经准备好的当前 Story Memory Hint；此工具不触发 Retriever 或 Agent。没有已准备内容时返回空结果。';

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

function initialResponseInstructions(context: RealtimeInterviewContext): string {
  if (context.interview_type === 'onboarding') {
    return context.taskContext.mode === 'new'
      ? '这是首次建档的第一问。自然问候后，从较早经历或成长环境开始，只问一个容易回答的问题。'
      : '这是继续建档的第一问。参考已有档案和历史对话，沿尚未覆盖的人生时间线只问一个问题。';
  }
  if (context.interview_type === 'external_contributor') {
    return '这是亲友补充采访的第一问。从受访者自己的亲历或观察切入，只问一个具体问题，不提主人公版本或要求比较。';
  }

  const payload = buildInterviewContextPayload(context);
  const mode = payload.interview_mode;
  const openingGap = typeof payload.opening_gap === 'string' ? payload.opening_gap : '';
  if (mode === 'continue' && openingGap) {
    return `这是本次故事续访的第一问。请直接自然地询问下面这个问题，只问这一问：\n${JSON.stringify(openingGap)}`;
  }
  const targetTitle = typeof payload.target_title === 'string' ? payload.target_title : '';
  if (mode === 'create' && targetTitle) {
    return `这是新建故事的第一问。围绕故事标题 ${JSON.stringify(targetTitle)} 自然开场，只问一个具体问题；不要转成泛泛的人生阶段问题。`;
  }
  return mode === 'continue'
    ? '这是故事续访的第一问。基于现有内容，选一个尚未明确的重要细节，只问一个问题；不要从头复述故事。'
    : '这是新建故事的第一问。从当前人生阶段选一个具体经历切入，只问一个问题。';
}

export function buildStepfunSessionUpdate(
  context: RealtimeInterviewContext,
  voice = DEFAULT_STEPFUN_VOICE,
): Record<string, unknown> {
  const allowsContextTool = context.interview_type === 'story'
    && context.task_context?.mode === 'continue'
    && typeof context.story?.story_id === 'string'
    && context.story.story_id.trim().length > 0;
  const toolInstructions = `\n\n## 历史 Memory 与工具调用\nMemory 会在用户回答后由系统独立触发。不要调用 ${STEPFUN_CONTEXT_TOOL} 来启动检索；若当前回合确需读取已经准备好的 Memory Hint，可以调用该工具。Tool Result 可能为空，随后继续当前采访。`;
  return {
    type: 'session.update',
    session: {
      modalities: ['text', 'audio'],
      instructions: `${buildInterviewInstructions(context, { omitOpeningGap: true })}${allowsContextTool ? toolInstructions : ''}请使用默认男声与用户交流。`,
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      voice,
      turn_detection: null,
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
  profileId: StepFunRealtimeProfileId = 'stepaudio2_mini',
): RealtimeVoiceProvider {
  const profile = STEPFUN_REALTIME_PROFILES[profileId];
  let activeResponseId: string | undefined;
  let speechStopEmitted = false;
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
      const readyEvent: NormalizedRealtimeEvent = {
        type: 'session.ready',
        ...(typeof session?.id === 'string' ? { providerSessionId: session.id } : {}),
      };
      if (type !== 'session.updated') return [readyEvent];
      const turnDetection = session?.turn_detection;
      const turnDetectionMode: 'manual' | 'server_vad' | 'unknown' = turnDetection === null || record(turnDetection)?.type === ''
        ? 'manual'
        : record(turnDetection)?.type === 'server_vad'
          ? 'server_vad'
          : 'unknown';
      return [readyEvent, { type: 'session.configured', turnDetectionMode }];
    }
    if (type === 'session.closed') return [{ type: 'session.closed' }];
    if (type === 'error') return [{ type: 'provider.error', message: sanitizedProviderError(event, config.stepfunApiKey), phase: 'stream' }];
    if (type === 'input_audio_buffer.speech_started') {
      speechStopEmitted = false;
      return [{ type: 'speech.started', ...(eventId ? { eventId } : {}) }];
    }
    if (type === 'input_audio_buffer.speech_stopped' || type === 'input_audio_buffer.committed') {
      if (speechStopEmitted) return [];
      speechStopEmitted = true;
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
    id: profileId,
    capabilities: profile.capabilities,
    audio: stepfunAudio(),
    connectOptions() {
      if (!config.stepfunApiKey) throw new Error('尚未配置 StepFun Realtime。请在项目 .env 中填写 STEPFUN_API_KEY 后重启服务。');
      return {
        url: buildStepfunRealtimeUrl(config.model?.trim() || DEFAULT_STEPFUN_MODEL),
        headers: { Authorization: `Bearer ${config.stepfunApiKey}` },
      };
    },
    setupSession: (context) => [buildStepfunSessionUpdate(context)],
    openingPreludeMessages: () => profile.openingPrelude
      ? [{
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '请开始访谈。' }],
          },
        }]
      : [],
    initialResponsePlan: (context) => ({
      steps: [{ message: {
        type: 'response.create',
        response: {
          modalities: ['text', 'audio'],
          instructions: initialResponseInstructions(context),
        },
      } }],
    }),
    appendAudioMessages: (audio) => [buildStepfunAudioAppend(audio)],
    commitAndRespondToInputTurn: () => [
      { message: { type: 'input_audio_buffer.commit' } },
      { message: { type: 'response.create', response: { modalities: ['text', 'audio'] } } },
    ],
    recoverStalledUserTurn: () => [{ message: { type: 'input_audio_buffer.commit' } }],
    stopInputAfterCurrentTurn: () => [],
    beginInputShutdown: (options) => [
      ...Array.from({ length: 40 }, () => ({
        message: buildStepfunAudioAppend(Buffer.alloc(STEPFUN_PCM_FRAME_BYTES)),
        delayAfterMs: 20,
      })),
      ...(options?.commitPendingInput ? [{ message: { type: 'input_audio_buffer.commit' } }] : []),
    ],
    closePlan: (): RealtimeClosePlan | null => null,
    connectionFailureMessage: (failure) => stepfunConnectionFailureMessage(failure, config.stepfunApiKey),
    requestAssistantTurnMessages: (instruction) => [{
      type: 'response.create',
      response: { modalities: ['text', 'audio'], instructions: instruction },
    }],
    normalizeServerMessage: normalize,
    handleControlEvent: () => [],
    injectContextHint: (hint) => profile.capabilities.supportsContextInjection
      ? buildStepfunContextHintMessages(hint)
      : [],
    handleToolResult: (call, output, options) => buildStepfunToolResult(call.callId, output, options),
  };
  return adapter;
}

export function buildStepfunContextHintMessages(hint: RealtimeContextHint): Record<string, unknown>[] {
  const lines = [
    ...hint.facts.map((fact) => `${fact.question ? `问题：${fact.question} ` : ''}用户回答：${fact.claim}`),
    ...hint.possibleConflicts.map((conflict) => `可能需要向用户确认：${conflict}`),
    ...hint.interviewHints,
  ];
  if (lines.length === 0) return [];
  return [{
    type: 'conversation.item.create',
    item: {
      type: 'message',
        role: 'assistant',
        content: [{
          type: 'input_text',
          text: `以下背景来自当前 Story 已保存的用户回答，只作为已核验的历史上下文，不代表用户本轮新表达；用户当前回答优先：\n${lines.join('\n')}`,
      }],
    },
  }];
}
