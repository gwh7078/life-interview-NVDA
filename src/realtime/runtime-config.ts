import {
  DEFAULT_DOUBAO_MODEL,
  DOUBAO_MODEL_NAME,
} from './doubao.js';
import {
  DEFAULT_QWEN_MODEL,
  type QwenRealtimeRegion,
} from './qwen.js';
import { DEFAULT_STEPFUN_MODEL } from './stepfun.js';
import type { RealtimeProviderConfig } from './provider.js';
import type { RealtimeProviderId } from './types.js';

export const REALTIME_PROVIDER_IDS = ['doubao', 'qwen', 'stepfun'] as const;

export interface RealtimeProviderRuntimeSource {
  apiKey?: string;
  workspaceId?: string;
  region: QwenRealtimeRegion;
  model: string;
  doubaoApiKey?: string;
  doubaoVoice?: string;
  doubaoModel?: string;
  qwenModel?: string;
  stepfunApiKey?: string;
  stepfunModel?: string;
}

export function isRealtimeProviderId(value: unknown): value is RealtimeProviderId {
  return typeof value === 'string'
    && (REALTIME_PROVIDER_IDS as readonly string[]).includes(value);
}

export function resolveRealtimeProviderConfig(
  id: RealtimeProviderId,
  source: RealtimeProviderRuntimeSource,
): RealtimeProviderConfig {
  if (id === 'doubao') {
    return {
      doubaoApiKey: source.doubaoApiKey,
      doubaoVoice: source.doubaoVoice,
      region: source.region,
      model: source.doubaoModel ?? DEFAULT_DOUBAO_MODEL,
    };
  }
  if (id === 'stepfun') {
    return {
      stepfunApiKey: source.stepfunApiKey,
      region: source.region,
      model: source.stepfunModel ?? DEFAULT_STEPFUN_MODEL,
    };
  }
  return {
    apiKey: source.apiKey,
    workspaceId: source.workspaceId,
    region: source.region,
    model: source.qwenModel ?? source.model ?? DEFAULT_QWEN_MODEL,
  };
}

export function realtimeProviderHealthSummary(
  source: RealtimeProviderRuntimeSource,
  detailed = true,
): Record<RealtimeProviderId, Record<string, unknown>> {
  return {
    doubao: {
      configured: Boolean(source.doubaoApiKey),
      ...(detailed ? { model: `${DOUBAO_MODEL_NAME} (${source.doubaoModel ?? DEFAULT_DOUBAO_MODEL})` } : {}),
    },
    qwen: {
      configured: Boolean(source.apiKey && source.workspaceId),
      ...(detailed ? {
        region: source.region,
        model: source.qwenModel ?? source.model ?? DEFAULT_QWEN_MODEL,
      } : {}),
    },
    stepfun: {
      configured: Boolean(source.stepfunApiKey),
      ...(detailed ? { model: source.stepfunModel ?? DEFAULT_STEPFUN_MODEL } : {}),
    },
  };
}
