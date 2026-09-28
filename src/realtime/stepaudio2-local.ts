import { createStepfunRealtimeProvider } from './stepfun.js';
import type { RealtimeProviderConfig, RealtimeVoiceProvider } from './provider.js';
import type {
  NormalizedRealtimeEvent,
  RealtimeConnectionFailure,
  RealtimeProviderCapabilities,
} from './types.js';

export type StepAudio2Execution = 'stepfun-cloud' | 'local';
export const DEFAULT_STEPAUDIO2_LOCAL_WS_URL = 'ws://127.0.0.1:8092/realtime';

const CAPABILITY_KEYS = [
  'fullDuplex',
  'supportsInterrupt',
  'supportsToolCalling',
  'supportsContextInjection',
  'supportsExplicitTurnRequest',
  'supportsPlaybackAck',
  'supportsExplicitSessionClose',
  'manualTurnControl',
] as const satisfies readonly (keyof RealtimeProviderCapabilities)[];

function conservativeCapabilities(): RealtimeProviderCapabilities {
  return {
    fullDuplex: false,
    supportsInterrupt: false,
    supportsToolCalling: false,
    supportsContextInjection: false,
    supportsExplicitTurnRequest: false,
    supportsPlaybackAck: false,
    supportsExplicitSessionClose: false,
    manualTurnControl: false,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseWireObject(raw: unknown): Record<string, unknown> | undefined {
  try {
    const text = typeof raw === 'string'
      ? raw
      : Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw).toString('utf8')
          : ArrayBuffer.isView(raw)
            ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
            : undefined;
    if (!text) return undefined;
    return record(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function capabilityHandshake(raw: unknown): RealtimeProviderCapabilities | undefined {
  const event = parseWireObject(raw);
  if (event?.type !== 'session.capabilities') return undefined;
  const capabilities = record(event.capabilities);
  if (!capabilities || CAPABILITY_KEYS.some((key) => typeof capabilities[key] !== 'boolean')) return undefined;
  return Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, capabilities[key]])) as unknown as RealtimeProviderCapabilities;
}

function localConnectionFailureMessage(failure: RealtimeConnectionFailure): string {
  if (failure.kind === 'timeout') return '连接本地 Step-Audio-2 Bridge 超时，请检查 Spark Voice 服务状态。';
  if (failure.kind === 'unexpected-response') {
    return `本地 Step-Audio-2 Bridge 握手失败（HTTP ${failure.statusCode ?? 'unknown'}）。`;
  }
  if (failure.kind === 'socket-error') return `本地 Step-Audio-2 Bridge 连接失败：${failure.message}`;
  return failure.phase === 'connect'
    ? `本地 Step-Audio-2 Bridge 在初始化时断开（${failure.code}）。`
    : `本地 Step-Audio-2 Bridge 连接中断（${failure.code}），本次 Transcript 将保留。`;
}

/**
 * Local Step-Audio-2 reuses the existing StepFun wire contract so Server keeps
 * consuming exactly one normalized event model. Capabilities start conservative
 * and are populated only by the bridge's explicit session.capabilities handshake.
 */
export function createStepAudio2LocalProvider(config: RealtimeProviderConfig): RealtimeVoiceProvider {
  const base = createStepfunRealtimeProvider(config, 'stepaudio2_mini');
  const capabilities = conservativeCapabilities();
  const url = config.stepaudio2LocalUrl?.trim() || DEFAULT_STEPAUDIO2_LOCAL_WS_URL;
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw new Error('STEPAUDIO2_LOCAL_WS_URL must be a valid ws:// or wss:// URL.'); }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('STEPAUDIO2_LOCAL_WS_URL must use ws:// or wss://.');
  }

  return {
    ...base,
    capabilities,
    connectOptions: () => ({ url, headers: {} }),
    closePlan: () => ({
      steps: [{ message: { type: 'session.close' } }],
      waitFor: 'session.closed',
      timeoutMs: 3_000,
    }),
    connectionFailureMessage: localConnectionFailureMessage,
    normalizeServerMessage(raw): NormalizedRealtimeEvent[] {
      const event = parseWireObject(raw);
      if (event?.type === 'session.capabilities') {
        const announced = capabilityHandshake(raw);
        if (!announced) {
          return [{
            type: 'provider.error',
            phase: 'session',
            message: '本地 Step-Audio-2 Bridge 返回了无效 capability 握手。',
          }];
        }
        Object.assign(capabilities, announced);
        return [];
      }
      return base.normalizeServerMessage(raw);
    },
  };
}
