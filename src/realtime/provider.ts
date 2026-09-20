import { randomUUID } from 'node:crypto';
import {
  buildDoubaoAudioAppend,
  buildDoubaoAudioCommit,
  buildDoubaoMuteInput,
  buildDoubaoOpeningGreetingText,
  buildDoubaoRealtimeHeaders,
  buildDoubaoSessionClose,
  buildDoubaoSessionCreate,
  buildDoubaoTextCommit,
  DEFAULT_DOUBAO_MODEL,
  DOUBAO_INPUT_SAMPLE_RATE,
  DOUBAO_OUTPUT_ENCODING,
  DOUBAO_OUTPUT_SAMPLE_RATE,
  DOUBAO_PCM_FRAME_BYTES,
  DOUBAO_REALTIME_URL,
  filterDoubaoOnboardingTranscript,
  filterDoubaoOnboardingTranscriptPartial,
  normalizeDoubaoAssistantTranscriptEvent,
  parseDoubaoServerEvent,
  readDoubaoTranscriptionText,
} from './doubao.js';
import {
  buildQwenAudioAppend,
  buildQwenOnboardingCompletionAcknowledgement,
  buildQwenRealtimeUrl,
  buildQwenSessionUpdate,
  DEFAULT_QWEN_MODEL,
  parseQwenOnboardingCompletionCall,
  parseQwenServerEvent,
  type QwenRealtimeRegion,
} from './qwen.js';
import type { RealtimeInterviewContext } from './prompt.js';
import type {
  NormalizedRealtimeEvent,
  RealtimeAudioSpec,
  RealtimeClosePlan,
  RealtimeConnectionFailure,
  RealtimeOutboundStep,
  RealtimeProviderCapabilities,
  RealtimeProviderContract,
  RealtimeProviderId,
} from './types.js';

export type { RealtimeProviderId } from './types.js';

const QWEN_END_SILENCE_FRAMES = 40;
const QWEN_END_SILENCE_FRAME_DELAY_MS = 20;
const QWEN_INPUT_SAMPLE_RATE = 16_000;
const QWEN_OUTPUT_SAMPLE_RATE = 24_000;
const QWEN_PCM_FRAME_BYTES = 640;
const QWEN_OUTPUT_ENCODING = 'pcm_s16le';

export interface RealtimeProviderConfig {
  doubaoApiKey?: string;
  doubaoVoice?: string;
  apiKey?: string;
  workspaceId?: string;
  region: QwenRealtimeRegion;
  model: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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
        : typeof part?.text === 'string'
          ? part.text
          : undefined;
      if (text !== undefined) {
        return { text, itemId: typeof item.id === 'string' ? item.id : undefined };
      }
    }
  }
  return {};
}

function sanitizedProviderError(
  event: Record<string, unknown>,
  label: string,
  secret?: string,
): string {
  const details = record(event.error);
  const raw = typeof details?.message === 'string' ? details.message : 'Realtime 服务返回错误。';
  const message = secret ? raw.split(secret).join('[redacted]') : raw;
  const code = typeof details?.code === 'string' ? ` (${details.code})` : '';
  return `${label}：${message}${code}`;
}

export interface RealtimeVoiceProvider extends RealtimeProviderContract {
  connectOptions(): { url: string; headers: Record<string, string> };
  setupSession(context: RealtimeInterviewContext): Record<string, unknown>[];
  initialResponsePlan(context: RealtimeInterviewContext): {
    steps: RealtimeOutboundStep[];
    fallbackText?: string;
  };
  appendAudioMessages(audio: Uint8Array): Record<string, unknown>[];
  requestAssistantTurnMessages(instruction: string): Record<string, unknown>[];
  /** Provider-specific recovery for a user turn that has stopped producing ASR activity. */
  recoverStalledUserTurn?(): RealtimeOutboundStep[];
  /** Preserve the provider's current hard-limit turn-finalization semantics. */
  stopInputAfterCurrentTurn(): RealtimeOutboundStep[];
  beginInputShutdown(): RealtimeOutboundStep[];
  closePlan(): RealtimeClosePlan | null;
  connectionFailureMessage(failure: RealtimeConnectionFailure): string;
  normalizeServerMessage(raw: unknown): NormalizedRealtimeEvent[];
  handleControlEvent(event: NormalizedRealtimeEvent): Record<string, unknown>[];
}

/** Backwards-compatible type name only; the contract itself is provider-neutral. */
export type RealtimeInterviewProviderAdapter = RealtimeVoiceProvider;

function redactSecret(value: string, secret?: string): string {
  return secret ? value.split(secret).join('[redacted]') : value;
}

function doubaoConnectionFailureMessage(
  failure: RealtimeConnectionFailure,
  secret?: string,
): string {
  if (failure.kind === 'timeout') {
    return '连接豆包 Realtime 超时，请检查火山 API Key、服务开通状态与网络。';
  }
  if (failure.kind === 'unexpected-response') {
    const status = failure.statusCode;
    if (status === 401 || status === 403) return '豆包 Realtime 鉴权失败。请检查 VOLCENGINE_API_KEY 与服务开通状态。';
    if (status === 404) return '豆包 Realtime 地址未找到，请检查是否已开通端到端实时语音服务。';
    return `豆包 Realtime 握手失败（HTTP ${status ?? 'unknown'}）。`;
  }
  if (failure.kind === 'socket-error') {
    return `豆包 Realtime 连接失败：${redactSecret(failure.message, secret)}`;
  }
  return failure.phase === 'connect'
    ? `豆包 Realtime 在初始化时断开（${failure.code}）。`
    : `豆包 Realtime 连接中断（${failure.code}），本次 Transcript 将保留。`;
}

function qwenConnectionFailureMessage(
  failure: RealtimeConnectionFailure,
  secret?: string,
): string {
  if (failure.kind === 'timeout') {
    return '连接 Qwen Realtime 超时，请检查 Workspace ID 和地域设置。';
  }
  if (failure.kind === 'unexpected-response') {
    const status = failure.statusCode;
    if (status === 401 || status === 403) return 'Qwen Realtime 鉴权失败。请检查 DASHSCOPE_API_KEY、Workspace ID 与地域。';
    if (status === 404) return 'Qwen Realtime 地址未找到。请检查 Workspace ID、地域和模型名称。';
    return `Qwen Realtime 握手失败（HTTP ${status ?? 'unknown'}）。`;
  }
  if (failure.kind === 'socket-error') {
    return `Qwen Realtime 连接失败：${redactSecret(failure.message, secret)}`;
  }
  return failure.phase === 'connect'
    ? `Qwen Realtime 在初始化时断开（${failure.code}）。`
    : `Qwen Realtime 连接中断（${failure.code}），本次 Transcript 将保留。`;
}

function doubaoCapabilities(): RealtimeProviderCapabilities {
  return {
    fullDuplex: true,
    supportsInterrupt: true,
    supportsExplicitTurnRequest: true,
    supportsPlaybackAck: false,
    supportsExplicitSessionClose: true,
  };
}

function qwenCapabilities(): RealtimeProviderCapabilities {
  return {
    fullDuplex: true,
    supportsInterrupt: true,
    supportsExplicitTurnRequest: true,
    supportsPlaybackAck: false,
    supportsExplicitSessionClose: false,
  };
}

function doubaoAudio(): RealtimeAudioSpec {
  return {
    input: { encoding: 'pcm_s16le', sampleRate: DOUBAO_INPUT_SAMPLE_RATE, frameBytes: DOUBAO_PCM_FRAME_BYTES },
    output: { encoding: DOUBAO_OUTPUT_ENCODING, sampleRate: DOUBAO_OUTPUT_SAMPLE_RATE },
  };
}

function qwenAudio(): RealtimeAudioSpec {
  return {
    input: { encoding: 'pcm_s16le', sampleRate: QWEN_INPUT_SAMPLE_RATE, frameBytes: QWEN_PCM_FRAME_BYTES },
    output: { encoding: QWEN_OUTPUT_ENCODING, sampleRate: QWEN_OUTPUT_SAMPLE_RATE },
  };
}

/** Provider protocol details stay behind one per-session adapter boundary. */
export function createRealtimeInterviewProvider(
  id: RealtimeProviderId,
  config: RealtimeProviderConfig,
): RealtimeVoiceProvider {
  if (id === 'doubao') {
    let activeResponseId: string | undefined;
    let openingFallbackText: string | undefined;
    let onboardingSession = false;
    const startedResponses = new Set<string>();
    const partialTextByResponse = new Map<string, string>();
    const visiblePartialByResponse = new Map<string, string>();

    const resolveResponseId = (event: Record<string, unknown>): string => {
      const response = record(event.response);
      const responseId = typeof event.response_id === 'string'
        ? event.response_id
        : typeof response?.id === 'string'
          ? response.id
          : activeResponseId;
      const resolved = responseId ?? randomUUID();
      activeResponseId = resolved;
      return resolved;
    };

    const ensureStarted = (
      events: NormalizedRealtimeEvent[],
      responseId: string,
      event: Record<string, unknown>,
    ): void => {
      if (activeResponseId !== responseId) activeResponseId = responseId;
      if (!startedResponses.has(responseId)) {
        startedResponses.add(responseId);
        events.push({
          type: 'assistant.started',
          responseId,
          ...(typeof event.event_id === 'string' ? { eventId: event.event_id } : {}),
          ...(openingFallbackText ? { openingFallbackText } : {}),
        });
        openingFallbackText = undefined;
      }
    };

    const normalize = (raw: unknown): NormalizedRealtimeEvent[] => {
      const event = parseDoubaoServerEvent(raw);
      if (!event) return [];
      const type = String(event.type ?? '');
      const eventId = typeof event.event_id === 'string' ? event.event_id : undefined;
      if (type === 'session.created' || type === 'session.updated') {
        const session = record(event.session);
        return [{
          type: 'session.ready',
          ...(typeof session?.id === 'string'
            ? { providerSessionId: session.id }
            : typeof event.session_id === 'string'
              ? { providerSessionId: event.session_id }
              : {}),
        }];
      }
      if (type === 'session.closed') return [{ type: 'session.closed' }];
      if (type === 'error') {
        return [{
          type: 'provider.error',
          message: sanitizedProviderError(event, '豆包 Realtime', config.doubaoApiKey),
          phase: 'stream',
        }];
      }
      if (type === 'conversation.item.input_audio_transcription.started') {
        return [{ type: 'speech.started', ...(eventId ? { eventId } : {}) }];
      }
      if (type === 'conversation.item.input_audio_transcription.delta') {
        const text = typeof event.delta === 'string'
          ? event.delta
          : typeof event.text === 'string' ? event.text : '';
        const stash = typeof event.stash === 'string' ? event.stash : '';
        return [{
          type: 'user.transcript.delta',
          text,
          stash,
          deltaChars: text.length,
          ...(eventId ? { eventId } : {}),
          ...(typeof event.item_id === 'string' ? { itemId: event.item_id } : {}),
        }];
      }
      if (type === 'conversation.item.input_audio_transcription.completed') {
        return [{
          type: 'user.transcript.final',
          text: readDoubaoTranscriptionText(event),
          ...(eventId ? { eventId } : {}),
          ...(typeof event.item_id === 'string' ? { itemId: event.item_id } : {}),
        }];
      }
      if (type === 'input_audio_buffer.committed') {
        return [{ type: 'speech.stopped', source: 'committed', ...(eventId ? { eventId } : {}) }];
      }
      if (type === 'input_audio_buffer.speech_stopped') {
        return [{ type: 'speech.stopped', source: 'speech_stopped', ...(eventId ? { eventId } : {}) }];
      }
      if (type === 'response.created') {
        const responseId = resolveResponseId(event);
        startedResponses.add(responseId);
        const started: NormalizedRealtimeEvent = {
          type: 'assistant.started',
          responseId,
          ...(eventId ? { eventId } : {}),
          ...(openingFallbackText ? { openingFallbackText } : {}),
        };
        openingFallbackText = undefined;
        return [started];
      }

      const responseId = resolveResponseId(event);
      if (type === 'response.output_audio.started') {
        const events: NormalizedRealtimeEvent[] = [];
        ensureStarted(events, responseId, event);
        events.push({
          type: 'assistant.audio.started',
          responseId,
          ...(typeof event.tts_type === 'string' ? { ttsType: event.tts_type } : {}),
        });
        return events;
      }

      const transcript = normalizeDoubaoAssistantTranscriptEvent(event, responseId);
      if (transcript) {
        const events: NormalizedRealtimeEvent[] = [];
        ensureStarted(events, responseId, event);
        if (transcript.type === 'response.audio_transcript.delta') {
          const delta = typeof transcript.delta === 'string' ? transcript.delta : '';
          const previous = partialTextByResponse.get(responseId) ?? '';
          const cumulative = previous + delta;
          partialTextByResponse.set(responseId, cumulative);
          const visible = onboardingSession ? filterDoubaoOnboardingTranscriptPartial(cumulative) : cumulative;
          const priorVisible = visiblePartialByResponse.get(responseId) ?? '';
          visiblePartialByResponse.set(responseId, visible);
          const visibleDelta = visible.startsWith(priorVisible) ? visible.slice(priorVisible.length) : visible;
          events.push({
            type: 'assistant.transcript.delta',
            responseId,
            delta: visibleDelta,
            ...(eventId ? { eventId } : {}),
            ...(typeof transcript.item_id === 'string' ? { itemId: transcript.item_id } : {}),
          });
          return events;
        }

        const rawText = typeof transcript.transcript === 'string'
          ? transcript.transcript
          : typeof transcript.text === 'string' ? transcript.text : '';
        const filtered = onboardingSession
          ? filterDoubaoOnboardingTranscript(rawText)
          : { text: rawText, completionSignal: false };
        partialTextByResponse.delete(responseId);
        visiblePartialByResponse.delete(responseId);
        if (filtered.text) {
          events.push({
            type: 'assistant.transcript.final',
            responseId,
            text: filtered.text,
            ...(eventId ? { eventId } : {}),
            ...(typeof transcript.item_id === 'string' ? { itemId: transcript.item_id } : {}),
          });
        }
        if (filtered.completionSignal) {
          events.push({ type: 'onboarding.completion.requested', responseId, requiresAck: false });
        }
        return events;
      }

      if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
        const audio = typeof event.delta === 'string'
          ? event.delta
          : typeof event.audio === 'string' ? event.audio : '';
        if (!audio) return [];
        const events: NormalizedRealtimeEvent[] = [];
        ensureStarted(events, responseId, event);
        events.push({ type: 'assistant.audio.delta', responseId, audio, encoding: DOUBAO_OUTPUT_ENCODING });
        return events;
      }
      if (type === 'response.output_audio.done') {
        return [{
          type: 'assistant.audio.done',
          responseId,
          ...(typeof event.status_code === 'string' ? { statusCode: event.status_code } : {}),
        }];
      }
      if (type === 'response.done' || type === 'response.canceled') {
        const response = record(event.response);
        const status = type === 'response.canceled'
          ? 'cancelled'
          : typeof response?.status === 'string'
            ? response.status
            : typeof event.status === 'string' ? event.status : 'completed';
        if (activeResponseId === responseId) activeResponseId = undefined;
        startedResponses.delete(responseId);
        partialTextByResponse.delete(responseId);
        visiblePartialByResponse.delete(responseId);
        if (type === 'response.canceled' || status === 'cancelled') {
          return [{ type: 'response.cancelled', responseId }];
        }
        const fallback = responseOutputText(response);
        const filteredFallback = fallback.text && onboardingSession
          ? filterDoubaoOnboardingTranscript(fallback.text)
          : { text: fallback.text ?? '', completionSignal: false };
        const events: NormalizedRealtimeEvent[] = [];
        if (filteredFallback.completionSignal) {
          events.push({ type: 'onboarding.completion.requested', responseId, requiresAck: false });
        }
        events.push({
          type: 'response.done',
          responseId,
          status,
          ...(filteredFallback.text ? { finalText: filteredFallback.text } : {}),
          ...(fallback.itemId ? { finalItemId: fallback.itemId } : {}),
        });
        return events;
      }
      return [];
    };

    const adapter: RealtimeVoiceProvider = {
      id,
      capabilities: doubaoCapabilities(),
      audio: doubaoAudio(),
      connectOptions() {
        if (!config.doubaoApiKey) {
          throw new Error('尚未配置豆包 Realtime。请在项目 .env 中填写 VOLCENGINE_API_KEY 后重启服务。');
        }
        return { url: DOUBAO_REALTIME_URL, headers: buildDoubaoRealtimeHeaders({ apiKey: config.doubaoApiKey }) };
      },
      setupSession(context) {
        onboardingSession = context.interview_type === 'onboarding';
        return [buildDoubaoSessionCreate(context, {
          model: config.model?.trim() || DEFAULT_DOUBAO_MODEL,
          voice: config.doubaoVoice,
        })];
      },
      normalizeServerMessage: normalize,
      appendAudioMessages: (audio) => [buildDoubaoAudioAppend(audio)],
      recoverStalledUserTurn: () => [{ message: buildDoubaoAudioCommit() }],
      stopInputAfterCurrentTurn: () => [{ message: buildDoubaoMuteInput() }],
      beginInputShutdown: () => [{ message: buildDoubaoMuteInput() }],
      closePlan: () => ({
        steps: [{ message: buildDoubaoSessionClose() }],
        waitFor: 'session.closed',
        timeoutMs: 5_000,
      }),
      connectionFailureMessage: (failure) => doubaoConnectionFailureMessage(failure, config.doubaoApiKey),
      requestAssistantTurnMessages: (instruction) => [buildDoubaoTextCommit(instruction)],
      handleControlEvent: () => [],
      initialResponsePlan(context) {
        onboardingSession = context.interview_type === 'onboarding';
        const greetingText = buildDoubaoOpeningGreetingText(context);
        openingFallbackText = greetingText;
        return { steps: [{ message: buildDoubaoTextCommit(greetingText) }], fallbackText: greetingText };
      },
    };
    return adapter;
  }

  const audioStartedResponses = new Set<string>();
  const normalize = (raw: unknown): NormalizedRealtimeEvent[] => {
    const event = parseQwenServerEvent(raw);
    if (!event) return [];
    const type = String(event.type ?? '');
    if (type === 'session.updated' || type === 'session.created') {
      const session = record(event.session);
      return [{
        type: 'session.ready',
        ...(typeof session?.id === 'string'
          ? { providerSessionId: session.id }
          : typeof event.session_id === 'string'
            ? { providerSessionId: event.session_id }
            : {}),
      }];
    }
    if (type === 'session.closed') return [{ type: 'session.closed' }];
    if (type === 'error') {
      return [{
        type: 'provider.error',
        message: sanitizedProviderError(event, 'Qwen Realtime', config.apiKey),
        phase: 'stream',
      }];
    }

    const completion = parseQwenOnboardingCompletionCall(event);
    if (completion) {
      return [{
        type: 'onboarding.completion.requested',
        ...(completion.responseId ? { responseId: completion.responseId } : {}),
        controlToken: completion.callId,
        requiresAck: true,
      }];
    }

    const eventId = typeof event.event_id === 'string' ? event.event_id : undefined;
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
      const text = typeof event.text === 'string' ? event.text : typeof event.delta === 'string' ? event.delta : '';
      const stash = typeof event.stash === 'string' ? event.stash : '';
      return [{
        type: 'user.transcript.delta',
        text,
        stash,
        deltaChars: typeof event.delta === 'string' ? event.delta.length : text.length + stash.length,
        ...(eventId ? { eventId } : {}),
        ...(typeof event.item_id === 'string' ? { itemId: event.item_id } : {}),
      }];
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const text = typeof event.transcript === 'string'
        ? event.transcript
        : typeof event.text === 'string' ? event.text : '';
      return [{
        type: 'user.transcript.final',
        text,
        ...(eventId ? { eventId } : {}),
        ...(typeof event.item_id === 'string' ? { itemId: event.item_id } : {}),
      }];
    }
    if (type === 'response.created') {
      const response = record(event.response);
      const responseId = typeof response?.id === 'string'
        ? response.id
        : typeof event.response_id === 'string' ? event.response_id : String(event.event_id ?? randomUUID());
      return [{ type: 'assistant.started', responseId, ...(eventId ? { eventId } : {}) }];
    }
    if (type === 'response.audio_transcript.delta' || type === 'response.text.delta') {
      return [{
        type: 'assistant.transcript.delta',
        responseId: typeof event.response_id === 'string' ? event.response_id : 'response',
        delta: typeof event.delta === 'string' ? event.delta : '',
        ...(eventId ? { eventId } : {}),
        ...(typeof event.item_id === 'string' ? { itemId: event.item_id } : {}),
      }];
    }
    if (type === 'response.audio_transcript.done' || type === 'response.text.done') {
      const text = typeof event.transcript === 'string'
        ? event.transcript
        : typeof event.text === 'string' ? event.text : '';
      return [{
        type: 'assistant.transcript.final',
        responseId: typeof event.response_id === 'string' ? event.response_id : 'response',
        text,
        ...(eventId ? { eventId } : {}),
        ...(typeof event.item_id === 'string' ? { itemId: event.item_id } : {}),
      }];
    }
    if (type === 'response.audio.delta') {
      const responseId = typeof event.response_id === 'string' ? event.response_id : 'response';
      const audio = typeof event.delta === 'string' ? event.delta : '';
      if (!audio) return [];
      const events: NormalizedRealtimeEvent[] = [];
      if (!audioStartedResponses.has(responseId)) {
        audioStartedResponses.add(responseId);
        events.push({ type: 'assistant.audio.started', responseId });
      }
      events.push({ type: 'assistant.audio.delta', responseId, audio, encoding: QWEN_OUTPUT_ENCODING });
      return events;
    }
    if (type === 'response.audio.done') {
      const responseId = typeof event.response_id === 'string' ? event.response_id : 'response';
      audioStartedResponses.delete(responseId);
      return [{ type: 'assistant.audio.done', responseId }];
    }
    if (type === 'response.done' || type === 'response.cancelled' || type === 'response.canceled') {
      const response = record(event.response);
      const responseId = typeof response?.id === 'string'
        ? response.id
        : typeof event.response_id === 'string' ? event.response_id : 'response';
      const status = type === 'response.cancelled' || type === 'response.canceled'
        ? 'cancelled'
        : String(response?.status ?? event.status ?? 'unknown');
      audioStartedResponses.delete(responseId);
      if (status === 'cancelled') return [{ type: 'response.cancelled', responseId }];
      const fallback = responseOutputText(response);
      const details = record(response?.status_details);
      return [{
        type: 'response.done',
        responseId,
        status,
        ...(fallback.text ? { finalText: fallback.text } : {}),
        ...(fallback.itemId ? { finalItemId: fallback.itemId } : {}),
        ...(typeof details?.reason === 'string' ? { message: `Realtime 回复未完成：${details.reason}` } : {}),
      }];
    }
    return [];
  };

  const adapter: RealtimeVoiceProvider = {
    id,
    capabilities: qwenCapabilities(),
    audio: qwenAudio(),
    connectOptions() {
      if (!config.apiKey || !config.workspaceId) {
        throw new Error('尚未配置 Qwen Realtime。请在项目 .env 中填写 DASHSCOPE_API_KEY 和 DASHSCOPE_WORKSPACE_ID 后重启服务。');
      }
      return {
        url: buildQwenRealtimeUrl({
          workspaceId: config.workspaceId,
          region: config.region,
          model: config.model?.trim() || DEFAULT_QWEN_MODEL,
        }),
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'X-DashScope-WorkSpace': config.workspaceId,
          'user-agent': 'rensheng-local-interview/0.1',
        },
      };
    },
    setupSession: (context) => [buildQwenSessionUpdate(context)],
    normalizeServerMessage: normalize,
    appendAudioMessages: (audio) => [buildQwenAudioAppend(audio)],
    recoverStalledUserTurn: () => [],
    stopInputAfterCurrentTurn: () => [],
    beginInputShutdown: () => Array.from({ length: QWEN_END_SILENCE_FRAMES }, () => ({
      message: buildQwenAudioAppend(Buffer.alloc(QWEN_PCM_FRAME_BYTES)),
      delayAfterMs: QWEN_END_SILENCE_FRAME_DELAY_MS,
    })),
    closePlan: () => null,
    connectionFailureMessage: (failure) => qwenConnectionFailureMessage(failure, config.apiKey),
    requestAssistantTurnMessages: (instruction) => [{
      type: 'response.create',
      response: { modalities: ['audio', 'text'], instructions: instruction },
    }],
    handleControlEvent(event) {
      if (event.type !== 'onboarding.completion.requested' || !event.requiresAck || !event.controlToken) return [];
      return buildQwenOnboardingCompletionAcknowledgement({
        callId: event.controlToken,
        ...(event.responseId ? { responseId: event.responseId } : {}),
      });
    },
    initialResponsePlan: () => ({
      steps: [{ message: { type: 'response.create', response: { modalities: ['audio', 'text'] } } }],
    }),
  };
  return adapter;
}
