export type RealtimeProviderId = 'qwen' | 'stepfun' | 'modelbest';
export const INTERVIEW_CONTEXT_TOOL_NAME = 'get_interview_context';

export type RealtimeAudioEncoding = 'pcm_s16le';

export interface RealtimeAudioSpec {
  input: {
    encoding: RealtimeAudioEncoding;
    sampleRate: number;
    frameBytes?: number;
  };
  output: {
    encoding: RealtimeAudioEncoding;
    sampleRate: number;
  };
}

export interface RealtimeProviderCapabilities {
  fullDuplex: boolean;
  supportsInterrupt: boolean;
  supportsToolCalling: boolean;
  supportsSlowContext: boolean;
  supportsExplicitTurnRequest: boolean;
  supportsPlaybackAck: boolean;
  supportsExplicitSessionClose: boolean;
  manualTurnControl: boolean;
}

export type RealtimeOutboundMessage = Record<string, unknown>;

export interface RealtimeOutboundStep {
  message: RealtimeOutboundMessage;
  delayAfterMs?: number;
}

export interface RealtimeClosePlan {
  steps: RealtimeOutboundStep[];
  waitFor?: 'session.closed';
  timeoutMs?: number;
}

export type RealtimeConnectionFailure =
  | { kind: 'timeout' }
  | { kind: 'unexpected-response'; statusCode?: number }
  | { kind: 'socket-error'; message: string }
  | { kind: 'socket-close'; code: number; phase: 'connect' | 'stream' };

export type NormalizedRealtimeEvent =
  | { type: 'session.queue.ready' }
  | { type: 'session.ready'; providerSessionId?: string }
  | { type: 'session.configured'; turnDetectionMode: 'manual' | 'server_vad' | 'unknown' }
  | { type: 'session.closed' }
  | { type: 'speech.started'; eventId?: string }
  | { type: 'speech.stopped'; eventId?: string; source?: 'speech_stopped' | 'committed' | 'transcription' }
  | { type: 'user.transcript.delta'; eventId?: string; itemId?: string; text: string; stash?: string; deltaChars?: number }
  | { type: 'user.transcript.final'; eventId?: string; itemId?: string; text: string }
  | { type: 'assistant.started'; eventId?: string; responseId: string; openingFallbackText?: string }
  | { type: 'assistant.transcript.delta'; eventId?: string; responseId: string; itemId?: string; delta: string }
  | { type: 'assistant.transcript.final'; eventId?: string; responseId: string; itemId?: string; text: string }
  | { type: 'assistant.audio.started'; responseId: string; ttsType?: string }
  | { type: 'assistant.audio.delta'; responseId: string; audio: string; encoding: RealtimeAudioEncoding }
  | { type: 'assistant.audio.done'; responseId: string; statusCode?: string }
  | { type: 'response.done'; responseId: string; status: string; finalText?: string; finalItemId?: string; message?: string }
  | { type: 'response.cancelled'; responseId: string }
  | {
      type: 'tool.call.requested';
      name: string;
      callId: string;
      arguments: unknown;
      rawArguments?: string;
      responseId: string;
      itemId?: string;
      eventId?: string;
    }
  | { type: 'onboarding.completion.requested'; responseId?: string; controlToken?: string; requiresAck: boolean }
  | { type: 'provider.error'; message: string; retryable?: boolean; phase?: 'connect' | 'session' | 'stream' };

export interface RealtimeProviderContract {
  readonly id: RealtimeProviderId;
  readonly capabilities: RealtimeProviderCapabilities;
  readonly audio: RealtimeAudioSpec;
}
