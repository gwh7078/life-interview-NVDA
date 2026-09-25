import {
  DEFAULT_QWEN_MODEL,
  type QwenRealtimeRegion,
} from './qwen.js';
import { DEFAULT_STEPFUN_MODEL, DEFAULT_STEPAUDIO3_MODEL } from './stepfun.js';
import { DEFAULT_MODELBEST_MODEL } from './modelbest.js';
import type { RealtimeProviderConfig } from './provider.js';
import type { RealtimeProviderId } from './types.js';

export const REALTIME_PROVIDER_IDS = ['qwen', 'stepfun', 'modelbest', 'stepaudio3_quality', 'stepaudio2_mini'] as const;
export type RealtimeMemoryTriggerMode = 'voice_tool' | 'supervisor_auto';

export function parseRealtimeMemoryTriggerMode(value: unknown): RealtimeMemoryTriggerMode | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'voice_tool' || value === 'supervisor_auto') return value;
  if (value === 'backend_auto') return 'supervisor_auto';
  throw new Error('REALTIME_MEMORY_TRIGGER must be voice_tool or supervisor_auto (backend_auto is deprecated).');
}

export function resolveRealtimeMemoryTriggerMode(
  profile: RealtimeProviderId | undefined,
  override?: RealtimeMemoryTriggerMode,
): RealtimeMemoryTriggerMode {
  if (profile === 'stepaudio2_mini' || profile === 'stepfun') return override ?? 'supervisor_auto';
  return 'voice_tool';
}

export interface RealtimeProviderRuntimeSource {
  apiKey?: string;
  workspaceId?: string;
  region: QwenRealtimeRegion;
  model: string;
  qwenModel?: string;
  stepfunApiKey?: string;
  stepfunModel?: string;
  stepaudio3Model?: string;
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
  if (id === 'stepaudio3_quality') {
    return {
      stepfunApiKey: source.stepfunApiKey,
      region: source.region,
      model: source.stepaudio3Model ?? DEFAULT_STEPAUDIO3_MODEL,
    };
  }
  if (id === 'stepfun' || id === 'stepaudio2_mini') {
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
      ...(detailed ? { model: source.stepfunModel ?? DEFAULT_STEPFUN_MODEL, execution: 'stepfun-cloud', compatibilityAlias: 'stepaudio2_mini' } : {}),
    },
    stepaudio3_quality: {
      configured: Boolean(source.stepfunApiKey),
      ...(detailed ? { model: source.stepaudio3Model ?? DEFAULT_STEPAUDIO3_MODEL, execution: 'stepfun-cloud' } : {}),
    },
    stepaudio2_mini: {
      configured: Boolean(source.stepfunApiKey),
      ...(detailed ? { model: source.stepfunModel ?? DEFAULT_STEPFUN_MODEL, execution: 'stepfun-cloud' } : {}),
    },
    modelbest: {
      configured: Boolean(source.modelbestApiKey),
      ...(detailed ? { model: source.modelbestModel ?? DEFAULT_MODELBEST_MODEL, experimental: true } : {}),
    },
  };
}
