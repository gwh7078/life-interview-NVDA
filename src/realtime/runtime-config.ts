import {
  DEFAULT_QWEN_MODEL,
  type QwenRealtimeRegion,
} from './qwen.js';
import { DEFAULT_STEPFUN_MODEL } from './stepfun.js';
import { DEFAULT_MODELBEST_MODEL } from './modelbest.js';
import type { RealtimeProviderConfig } from './provider.js';
import type { RealtimeProviderId } from './types.js';

export const REALTIME_PROVIDER_IDS = ['qwen', 'stepfun', 'modelbest'] as const;

export interface RealtimeProviderRuntimeSource {
  apiKey?: string;
  workspaceId?: string;
  region: QwenRealtimeRegion;
  model: string;
  qwenModel?: string;
  stepfunApiKey?: string;
  stepfunModel?: string;
  modelbestApiKey?: string;
  modelbestModel?: string;
}

export function isRealtimeProviderId(value: unknown): value is RealtimeProviderId {
  return typeof value === 'string'
    && (REALTIME_PROVIDER_IDS as readonly string[]).includes(value);
}

export function resolveRealtimeProviderConfig(
  id: RealtimeProviderId,
  source: RealtimeProviderRuntimeSource,
): RealtimeProviderConfig {
  if (id === 'stepfun') {
    return {
      stepfunApiKey: source.stepfunApiKey,
      region: source.region,
      model: source.stepfunModel ?? DEFAULT_STEPFUN_MODEL,
    };
  }
  if (id === 'modelbest') {
    return {
      modelbestApiKey: source.modelbestApiKey,
      region: source.region,
      model: source.modelbestModel ?? DEFAULT_MODELBEST_MODEL,
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
    modelbest: {
      configured: Boolean(source.modelbestApiKey),
      ...(detailed ? { model: source.modelbestModel ?? DEFAULT_MODELBEST_MODEL } : {}),
    },
  };
}
