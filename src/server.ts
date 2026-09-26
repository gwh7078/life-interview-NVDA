import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveDiagnosticsPath } from './diagnostics/paths.js';
import { writeDiagnosticLog } from './diagnostics/logger.js';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { createDatabase, resolveDatabasePath } from './db/client.js';
import { resolveAiTaskConfig } from './ai/task-config.js';
import { AuthService } from './auth/service.js';
import { handleAuthRequest } from './auth/http.js';
import { readAuthCookie } from './auth/session-token.js';
import { DevelopmentVerificationProvider, UnconfiguredSmsVerificationProvider } from './auth/verification-provider.js';
import type { AuthContext } from './auth/context.js';
import { InterviewSessionRepository, LifeStageRepository, MemoirDocumentRepository, StoryRepository, TranscriptRepository } from './repositories/domain-repositories.js';
import { createInterviewRuntimeCore, type InterviewStartInput } from './interview/core.js';
import { InterviewContextError } from './interview/context/story-interview-context.js';
import { createRealtimeInterviewProvider, type RealtimeProviderId, type RealtimeVoiceProvider } from './realtime/provider.js';
import {
  isRealtimeProviderId,
  parseRealtimeMemoryTriggerMode,
  resolveRealtimeMemoryTriggerMode,
  realtimeProviderHealthSummary,
  resolveRealtimeProviderConfig,
  type RealtimeMemoryTriggerMode,
} from './realtime/runtime-config.js';
import {
  BailianRealtimeCoach,
  buildCoachGatePrompt,
  buildCoachResolvePrompt,
  buildRealtimeCoachGateInput,
} from './realtime/coach/service.js';
import { RealtimeCoachPipeline } from './realtime/coach/pipeline.js';
import { renderMiniCoachPacket } from './realtime/coach/mini-coach-renderer.js';
import type {
  CoachConversationMessage,
  CoachGateResult,
  RealtimeCoachPort,
} from './realtime/coach/types.js';
import {
  STORY_INTERVIEW_COMPLETION_UTTERANCE,
  isAssistantFarewell,
  isExplicitEndIntent,
} from './interview/closeout.js';
import {
  endRealtimeInterviewSession,
  type RealtimeInterviewSession,
} from './interview/session.js';
import {
  beginInterviewCloseout,
  cancelInterviewCloseout,
  CloseoutWorkflowError,
  failInterviewCloseout,
  getInterviewCloseoutResult,
  type CloseoutWorkflowConfig,
  type CloseoutWorkflowDependencies,
} from './interview/closeout-workflow.js';
import {
  DEFAULT_QWEN_MODEL,
  type QwenRealtimeRegion,
} from './realtime/qwen.js';
import { DEFAULT_STEPFUN_MODEL, DEFAULT_STEPAUDIO3_MODEL, STEPFUN_REALTIME_PROFILES } from './realtime/stepfun.js';
import { DEFAULT_MODELBEST_MODEL } from './realtime/modelbest.js';
import {
  RealtimeSlowCoordinator,
  UnavailableRealtimeRecall,
  type RealtimeContextHint,
  type RealtimeRecallPort,
  type RealtimeSlowPathProgress,
} from './realtime/slow-coordinator.js';
import {
  createRealtimeTraceStageTracker,
  createRealtimeTraceWriter,
  pcm16Rms,
  type RealtimeTraceWriter,
  type RealtimeTraceFields,
} from './realtime/trace.js';
import { createRealtimeToolCycleTracker } from './realtime/tool-cycle-tracker.js';
import type { RealtimeInterviewProvider } from './interview/session.js';
import { buildStepAudio2MiniInstructions, type RealtimeInterviewContext } from './realtime/prompt.js';
import { INTERVIEW_CONTEXT_TOOL_NAME, type NormalizedRealtimeEvent } from './realtime/types.js';
import {
  beginOnboardingCloseout,
  failOnboardingCloseout,
  OnboardingWorkflowError,
  type OnboardingCloseoutConfig,
  type OnboardingCloseoutDependencies,
} from './onboarding/closeout-workflow.js';
import { getOnboardingResult } from './onboarding/result.js';
import { createStoryCompletionService } from './story/completion/runtime.js';
import type { StoryCompletionService } from './story/completion/service.js';
import { createStoryGenerationService } from './story/generation/runtime.js';
import { StoryGenerationError, type StoryGenerationService } from './story/generation/index.js';
import { DirectTextModelProvider, type TextModelProvider } from './providers/text-model-provider.js';
import { CloseoutModelError } from './interview/llm-provider.js';
import { BookService, BookServiceError, parseBookSaveInput } from './book/service.js';
import { StoryShareRepository, isStoryShareRelationship } from './repositories/story-share-repository.js';
import { parseStoryGaps } from './story/gaps.js';
import { markExternalContributorSessionCloseout, runExternalContributorCloseout } from './interview/external-contributor/closeout.js';
import {
  AgentOnboardingCloseoutProcessor,
  AgentStoryCloseoutProcessor,
  AgentStoryCompletionProcessor,
  AgentStoryGenerationContextModel,
  createAgentTaskPort,
  type AgentTaskPort,
} from './agent-tasks/index.js';
import { AgentToolTokenService } from '../agent/tools/token.js';
import { createRetrieverClientFromEnv, type RetrieverAdapter } from './retriever/client.js';
import { RetrieverIndexService } from './retriever/indexer.js';
import { RetrieverScriptError, RetrieverScriptGateway } from './retriever/script-gateway.js';
import { ObservationBus, emitObservationEvent } from './observability/observation-bus.js';
import { createObservationContext, type ObservationContext } from './observability/observation-event.js';
import { adaptRealtimeTrace, normalizeAgentSkipReasonForObservation } from './observability/adapters/realtime-adapter.js';
import { RealtimeSlowContextPipeline } from './realtime/slow-context-pipeline.js';
import { createEraContextClientFromEnv } from './era-context/client.js';
import { EraContextScriptError, EraContextScriptGateway } from './era-context/script-gateway.js';
import type { EraContextAdapter } from './era-context/types.js';

const DEFAULT_PORT = 4174;
const DEFAULT_HOST = '127.0.0.1';
const END_QUIET_MS = 1_500;
const END_DRAIN_MAX_MS = 20_000;
const MANUAL_END_QUIET_MS = 500;
const DEFAULT_WRAPUP_MS = 18 * 60 * 1_000;
const DEFAULT_MAX_SESSION_MS = 20 * 60 * 1_000;
const DEFAULT_CLOSE_GRACE_MS = 45_000;
const DEFAULT_OPENING_RESPONSE_TIMEOUT_MS = 8_000;
const DEFAULT_USER_TURN_STALL_TIMEOUT_MS = 4_000;
const DEFAULT_REALTIME_SLOW_DEADLINE_MS = 5_000;
const DEFAULT_REALTIME_LOCAL_SILENCE_TIMEOUT_MS = 2_000;

function realtimeContextAgentEnabled(flagValue = process.env.REALTIME_CONTEXT_AGENT_ENABLED, runtimeValue = process.env.AI_TASK_RUNTIME): boolean {
  const flag = flagValue?.trim().toLowerCase() ?? '';
  if (['1', 'true'].includes(flag)) return true;
  if (['0', 'false'].includes(flag)) return false;
  return ['agent', 'stub'].includes(runtimeValue?.trim() || 'direct');
}

export interface RuntimeConfig {
  host: string;
  port: number;
  databasePath?: string;
  apiKey?: string;
  workspaceId?: string;
  region: QwenRealtimeRegion;
  model: string;
  defaultRealtimeProvider?: RealtimeProviderId;
  realtimeMemoryTriggerMode?: RealtimeMemoryTriggerMode;
  realtimeCoachProvider?: 'openai-compatible';
  realtimeCoachBaseUrl?: string;
  realtimeCoachModel?: string;
  realtimeCoachApiKey?: string;
  realtimeCoachGateTimeoutMs?: number;
  realtimeCoachTotalTimeoutMs?: number;
  realtimeRetrieverEnabled?: boolean;
  realtimeContextAgentEnabled?: boolean;
  qwenModel?: string;
  stepfunModel?: string;
  stepaudio3Model?: string;
  stepfunApiKey?: string;
  modelbestModel?: string;
  modelbestApiKey?: string;
  realtimeLocalSilenceTimeoutMs?: number;
  closeoutApiKey?: string;
  closeoutBaseUrl?: string;
  closeoutApiFormat?: 'chat-completions' | 'chat-json-schema' | 'responses';
  closeoutModel?: string;
  closeoutProvider?: string;
  closeoutTimeoutMs?: number;
  storyCompletionBaseUrl?: string;
  storyCompletionApiFormat?: 'chat-completions' | 'chat-json-schema' | 'responses';
  storyCompletionModel?: string;
  storyCompletionProvider?: string;
  storyCompletionTimeoutMs?: number;
  storyGenerationBaseUrl?: string;
  storyGenerationApiFormat?: 'chat-completions' | 'chat-json-schema' | 'responses';
  storyGenerationModel?: string;
  storyGenerationProvider?: string;
  storyGenerationTimeoutMs?: number;
  onboardingCloseoutBaseUrl?: string;
  onboardingCloseoutApiFormat?: 'chat-completions' | 'chat-json-schema' | 'responses';
  onboardingCloseoutModel?: string;
  onboardingCloseoutProvider?: string;
  onboardingCloseoutTimeoutMs?: number;
  wrapUpMs?: number;
  maxSessionMs?: number;
  closeGraceMs?: number;
  openingResponseTimeoutMs?: number;
  userTurnStallTimeoutMs?: number;
  realtimeSlowDeadlineMs?: number;
  authSessionSecret?: string;
  authMode?: 'sms' | 'demo_phone';
  developmentAuthEnabled?: boolean;
  secureCookies?: boolean;
}

export interface InterviewServiceDependencies {
  realtimeProviderFactory?: (
    id: RealtimeProviderId,
    config: Parameters<typeof createRealtimeInterviewProvider>[1],
  ) => RealtimeVoiceProvider;
  closeout?: CloseoutWorkflowDependencies;
  onboardingCloseout?: OnboardingCloseoutDependencies;
  storyCompletion?: Pick<StoryCompletionService, 'evaluate'>;
  storyGeneration?: Pick<StoryGenerationService, 'generate'>;
  agentTasks?: AgentTaskPort | null;
  retriever?: RetrieverAdapter;
  retrieverIndex?: RetrieverIndexService;
  retrieverScriptGateway?: RetrieverScriptGateway;
  eraContextClient?: EraContextAdapter;
  eraContextScriptGateway?: EraContextScriptGateway;
  realtimeRecall?: RealtimeRecallPort;
  observationBus?: ObservationBus;
  realtimeContextAgentTasks?: AgentTaskPort | null;
  realtimeCoach?: RealtimeCoachPort | null;
  realtimeCoachPipeline?: RealtimeCoachPipeline;
}

interface ProviderTranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
  providerMessageId: string;
  providerEventId?: string;
}

interface AssistantResponse {
  itemId?: string;
  finalTranscript?: string;
  transcriptEventId?: string;
  partialText: string;
  transcriptDeltaCount?: number;
  openingFallbackText?: string;
}

interface ProviderAudioTrace {
  chunks: number;
  bytes: number;
  responseStartedAt: number;
  firstDeltaAt?: number;
  lastDeltaAt?: number;
  maxGapMs: number;
}

const CLIENT_TRACE_EVENTS = new Set([
  'start_clicked',
  'microphone_ready',
  'websocket_connected',
  'provider_session_ready',
  'playback_ready_sent',
  'microphone_stream_paused',
  'microphone_stream_resumed',
  'session_ready',
  'audio_context_state',
  'audio_context_ready',
  'audio_context_resume',
  'audio_context_resume_failed',
  'speech_started',
  'local_vad_error',
  'local_vad_speech_started',
  'local_vad_silence_started',
  'local_vad_speech_resumed',
  'local_vad_commit_triggered',
  'manual_turn_recovered_after_response_failure',
  'speech_stopped_received',
  'assistant_started',
  'user_partial',
  'user_partial_rendered',
  'user_final_received',
  'user_final_rendered',
  'assistant_transcript_delta_received',
  'assistant_transcript_delta_rendered',
  'assistant_transcript_final_received',
  'assistant_transcript_final_rendered',
  'playback_interruption',
  'playback_response_started',
  'playback_response_draining',
  'playback_response_drained',
  'playback_response_drain_timeout',
  'output_audio_started',
  'output_audio_chunk',
  'output_audio_scheduled',
  'output_audio_node_start_called',
  'output_audio_node_ended',
  'output_audio_done',
  'output_audio_summary',
  'manual_end_interrupted_playback',
  'auto_end_after_playback',
  'auto_end_cancelled',
  'audio_decode_error',
  'audio_playback_error',
  'scroll_activity',
]);

function base64ByteLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}

export function readRuntimeConfig(): RuntimeConfig {
  const taskConfig = resolveAiTaskConfig();
  const interviewTask = taskConfig['interview.story'];
  const closeoutTask = taskConfig['closeout.story'];
  const onboardingCloseoutTask = taskConfig['closeout.onboarding'];
  const storyCompletionTask = taskConfig['completion.story'];
  const storyGenerationTask = taskConfig['generation.story'];
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('PORT must be an integer between 0 and 65535.');
  }

  const rawRegion = String(interviewTask.parameters.region ?? 'cn-beijing');
  if (rawRegion !== 'cn-beijing' && rawRegion !== 'ap-southeast-1') {
    throw new Error('DASHSCOPE_REGION must be cn-beijing or ap-southeast-1.');
  }

  const maxSessionMs = Number(process.env.REALTIME_MAX_SESSION_MS ?? DEFAULT_MAX_SESSION_MS);
  const wrapUpMs = Number(process.env.REALTIME_WRAPUP_MS ?? DEFAULT_WRAPUP_MS);
  const closeGraceMs = Number(process.env.REALTIME_CLOSE_GRACE_MS ?? DEFAULT_CLOSE_GRACE_MS);
  const openingResponseTimeoutMs = Number(process.env.REALTIME_OPENING_RESPONSE_TIMEOUT_MS ?? DEFAULT_OPENING_RESPONSE_TIMEOUT_MS);
  const userTurnStallTimeoutMs = Number(process.env.REALTIME_USER_TURN_STALL_TIMEOUT_MS ?? DEFAULT_USER_TURN_STALL_TIMEOUT_MS);
  const realtimeSlowDeadlineMs = Number(process.env.REALTIME_SLOW_DEADLINE_MS ?? DEFAULT_REALTIME_SLOW_DEADLINE_MS);
  const realtimeMemoryTriggerMode = parseRealtimeMemoryTriggerMode(process.env.REALTIME_MEMORY_TRIGGER);
  const realtimeCoachProvider = process.env.REALTIME_COACH_PROVIDER?.trim() || 'openai-compatible';
  if (realtimeCoachProvider !== 'openai-compatible') {
    throw new Error('REALTIME_COACH_PROVIDER must be openai-compatible.');
  }
  const realtimeCoachBaseUrl = process.env.REALTIME_COACH_BASE_URL?.trim()
    || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const realtimeCoachModel = process.env.REALTIME_COACH_MODEL?.trim() || 'qwen3-8b';
  const realtimeCoachApiKey = process.env.REALTIME_COACH_API_KEY?.trim()
    || process.env.BAILIAN_API_KEY?.trim()
    || undefined;
  const realtimeCoachGateTimeoutMs = Number(process.env.REALTIME_COACH_GATE_TIMEOUT_MS ?? 1_200);
  const realtimeCoachTotalTimeoutMs = Number(process.env.REALTIME_COACH_TOTAL_TIMEOUT_MS ?? DEFAULT_REALTIME_SLOW_DEADLINE_MS);
  const realtimeRetrieverEnabled = process.env.NEMO_RETRIEVER_ENABLED?.trim() === 'true';
  const contextAgentEnabled = realtimeContextAgentEnabled();
  const realtimeLocalSilenceTimeoutMs = Number(process.env.REALTIME_LOCAL_SILENCE_TIMEOUT_MS ?? DEFAULT_REALTIME_LOCAL_SILENCE_TIMEOUT_MS);
  const closeoutTimeoutMs = Number(closeoutTask.parameters.timeoutMs ?? 60_000);
  const closeoutApiFormat = String(closeoutTask.parameters.apiFormat ?? 'chat-completions');
  const storyCompletionTimeoutMs = Number(storyCompletionTask.parameters.timeoutMs ?? closeoutTimeoutMs);
  const storyCompletionApiFormat = String(storyCompletionTask.parameters.apiFormat ?? closeoutApiFormat);
  const storyGenerationTimeoutMs = Number(storyGenerationTask.parameters.timeoutMs ?? closeoutTimeoutMs);
  const storyGenerationApiFormat = String(storyGenerationTask.parameters.apiFormat ?? closeoutApiFormat);
  const host = process.env.HOST ?? DEFAULT_HOST;
  const authMode = process.env.AUTH_MODE?.trim() || 'sms';
  if (authMode !== 'sms' && authMode !== 'demo_phone') {
    throw new Error('AUTH_MODE must be sms or demo_phone.');
  }
  const authSessionSecret = process.env.AUTH_SESSION_SECRET?.trim() || undefined;
  if (process.env.NODE_ENV === 'production' && (!authSessionSecret || authSessionSecret.length < 32)) {
    throw new Error('Production requires AUTH_SESSION_SECRET with at least 32 characters.');
  }
  if (!Number.isFinite(maxSessionMs) || maxSessionMs <= 0) {
    throw new Error('REALTIME_MAX_SESSION_MS must be a positive number.');
  }
  if (!Number.isFinite(wrapUpMs) || wrapUpMs < 0 || wrapUpMs >= maxSessionMs) {
    throw new Error('REALTIME_WRAPUP_MS must be at least 0 and less than REALTIME_MAX_SESSION_MS.');
  }
  if (!Number.isFinite(closeGraceMs) || closeGraceMs < 0) {
    throw new Error('REALTIME_CLOSE_GRACE_MS must be at least 0.');
  }
  if (!Number.isFinite(openingResponseTimeoutMs) || openingResponseTimeoutMs <= 0 || openingResponseTimeoutMs > 60_000) {
    throw new Error('REALTIME_OPENING_RESPONSE_TIMEOUT_MS must be greater than 0 and at most 60000.');
  }
  if (!Number.isFinite(userTurnStallTimeoutMs) || userTurnStallTimeoutMs <= 0 || userTurnStallTimeoutMs > 60_000) {
    throw new Error('REALTIME_USER_TURN_STALL_TIMEOUT_MS must be greater than 0 and at most 60000.');
  }
  if (!Number.isInteger(realtimeSlowDeadlineMs) || realtimeSlowDeadlineMs <= 0 || realtimeSlowDeadlineMs > 5_000) {
    throw new Error('REALTIME_SLOW_DEADLINE_MS must be an integer between 1 and 5000.');
  }
  if (!Number.isInteger(realtimeCoachGateTimeoutMs) || realtimeCoachGateTimeoutMs <= 0 || realtimeCoachGateTimeoutMs > 1_200) {
    throw new Error('REALTIME_COACH_GATE_TIMEOUT_MS must be an integer between 1 and 1200.');
  }
  if (!Number.isInteger(realtimeCoachTotalTimeoutMs) || realtimeCoachTotalTimeoutMs <= 0 || realtimeCoachTotalTimeoutMs > 5_000) {
    throw new Error('REALTIME_COACH_TOTAL_TIMEOUT_MS must be an integer between 1 and 5000.');
  }
  if (!Number.isInteger(realtimeLocalSilenceTimeoutMs) || realtimeLocalSilenceTimeoutMs <= 0 || realtimeLocalSilenceTimeoutMs > 10_000) {
    throw new Error('REALTIME_LOCAL_SILENCE_TIMEOUT_MS must be an integer between 1 and 10000.');
  }
  if (!Number.isInteger(closeoutTimeoutMs) || closeoutTimeoutMs <= 0 || closeoutTimeoutMs > 300_000) {
    throw new Error('CLOSEOUT_TIMEOUT_MS must be an integer between 1 and 300000.');
  }
  if (closeoutApiFormat !== 'chat-completions' && closeoutApiFormat !== 'chat-json-schema' && closeoutApiFormat !== 'responses') {
    throw new Error('CLOSEOUT_API_FORMAT must be chat-completions, chat-json-schema or responses.');
  }
  for (const [taskName, timeoutMs, apiFormat] of [
    ['STORY_COMPLETION', storyCompletionTimeoutMs, storyCompletionApiFormat],
    ['STORY_GENERATION', storyGenerationTimeoutMs, storyGenerationApiFormat],
  ] as const) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
      throw new Error(`${taskName}_TIMEOUT_MS must be an integer between 1 and 300000.`);
    }
    if (apiFormat !== 'chat-completions' && apiFormat !== 'chat-json-schema' && apiFormat !== 'responses') {
      throw new Error(`${taskName}_API_FORMAT must be chat-completions, chat-json-schema or responses.`);
    }
  }

  return {
    host,
    port,
    databasePath: process.env.DATABASE_PATH,
    apiKey: process.env.DASHSCOPE_API_KEY?.trim() || undefined,
    workspaceId: process.env.DASHSCOPE_WORKSPACE_ID?.trim() || undefined,
    region: rawRegion,
    model: interviewTask.provider === 'qwen' || interviewTask.provider === 'stepfun'
      || interviewTask.provider === 'stepaudio2_mini' || interviewTask.provider === 'stepaudio3_quality'
      || interviewTask.provider === 'modelbest'
      ? interviewTask.model
      : process.env.DASHSCOPE_MODEL?.trim() || DEFAULT_QWEN_MODEL,
    defaultRealtimeProvider: isRealtimeProviderId(interviewTask.provider) ? interviewTask.provider : 'stepaudio2_mini',
    qwenModel: interviewTask.provider === 'qwen'
      ? interviewTask.model
      : process.env.DASHSCOPE_MODEL?.trim() || DEFAULT_QWEN_MODEL,
    stepfunModel: interviewTask.provider === 'stepfun' || interviewTask.provider === 'stepaudio2_mini'
      ? interviewTask.model
      : process.env.STEPFUN_REALTIME_MODEL?.trim() || DEFAULT_STEPFUN_MODEL,
    stepfunApiKey: process.env.STEPFUN_API_KEY?.trim() || undefined,
    stepaudio3Model: interviewTask.provider === 'stepaudio3_quality'
      ? interviewTask.model
      : process.env.STEPAUDIO3_REALTIME_MODEL?.trim() || DEFAULT_STEPAUDIO3_MODEL,
    modelbestModel: interviewTask.provider === 'modelbest'
      ? interviewTask.model
      : process.env.MODELBEST_REALTIME_MODEL?.trim() || DEFAULT_MODELBEST_MODEL,
    modelbestApiKey: process.env.MODELBEST_API_KEY?.trim() || undefined,
    realtimeLocalSilenceTimeoutMs,
    closeoutApiKey: process.env.TEXT_MODEL_API_KEY?.trim()
      || process.env.BAILIAN_API_KEY?.trim()
      || process.env.CLOSEOUT_API_KEY?.trim()
      || undefined,
    closeoutBaseUrl: String(closeoutTask.parameters.baseUrl ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
    closeoutApiFormat,
    closeoutModel: closeoutTask.model,
    closeoutProvider: closeoutTask.provider,
    closeoutTimeoutMs,
    storyCompletionBaseUrl: String(storyCompletionTask.parameters.baseUrl ?? closeoutTask.parameters.baseUrl),
    storyCompletionApiFormat: storyCompletionApiFormat as RuntimeConfig['storyCompletionApiFormat'],
    storyCompletionModel: storyCompletionTask.model,
    storyCompletionProvider: storyCompletionTask.provider,
    storyCompletionTimeoutMs,
    storyGenerationBaseUrl: String(storyGenerationTask.parameters.baseUrl ?? closeoutTask.parameters.baseUrl),
    storyGenerationApiFormat: storyGenerationApiFormat as RuntimeConfig['storyGenerationApiFormat'],
    storyGenerationModel: storyGenerationTask.model,
    storyGenerationProvider: storyGenerationTask.provider,
    storyGenerationTimeoutMs,
    onboardingCloseoutBaseUrl: String(onboardingCloseoutTask.parameters.baseUrl ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
    onboardingCloseoutApiFormat: String(onboardingCloseoutTask.parameters.apiFormat ?? closeoutApiFormat) as RuntimeConfig['onboardingCloseoutApiFormat'],
    onboardingCloseoutModel: onboardingCloseoutTask.model,
    onboardingCloseoutProvider: onboardingCloseoutTask.provider,
    onboardingCloseoutTimeoutMs: Number(onboardingCloseoutTask.parameters.timeoutMs ?? closeoutTimeoutMs),
    wrapUpMs,
    maxSessionMs,
    closeGraceMs,
    openingResponseTimeoutMs,
    userTurnStallTimeoutMs,
    realtimeSlowDeadlineMs,
    realtimeMemoryTriggerMode,
    realtimeCoachProvider,
    realtimeCoachBaseUrl,
    realtimeCoachModel,
    realtimeCoachApiKey,
    realtimeCoachGateTimeoutMs,
    realtimeCoachTotalTimeoutMs,
    realtimeRetrieverEnabled,
    realtimeContextAgentEnabled: contextAgentEnabled,
    authSessionSecret,
    authMode,
    developmentAuthEnabled: process.env.NODE_ENV !== 'production'
      && process.env.AUTH_DEV_ADAPTER !== 'false'
      && ['127.0.0.1', 'localhost', '::1'].includes(host.toLowerCase()),
    secureCookies: process.env.NODE_ENV === 'production',
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown, headOnly = false): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(headOnly ? undefined : JSON.stringify(value));
}

function realtimeMemoryHealthSummary(config: RuntimeConfig): Record<string, string> {
  const provider = config.defaultRealtimeProvider ?? 'stepaudio2_mini';
  const contextInjectionSupported = provider === 'stepaudio3_quality'
    ? STEPFUN_REALTIME_PROFILES.stepaudio3_quality.capabilities.supportsContextInjection
    : provider === 'stepaudio2_mini' || provider === 'stepfun'
      ? STEPFUN_REALTIME_PROFILES.stepaudio2_mini.capabilities.supportsContextInjection
      : false;
  const voiceModel = provider === 'stepaudio3_quality'
    ? 'StepAudio 3'
    : provider === 'stepaudio2_mini' || provider === 'stepfun'
      ? 'Step-Audio-2-mini'
      : provider === 'modelbest' ? 'ModelBest Realtime' : 'Qwen Realtime';
  return {
    voiceModel,
    memoryTriggerMode: resolveRealtimeMemoryTriggerMode(provider, config.realtimeMemoryTriggerMode),
    ...(provider === 'stepaudio2_mini' || provider === 'stepfun' ? {
      coachModel: config.realtimeCoachModel ?? 'qwen3-8b',
      coachConfigured: String(Boolean(config.realtimeCoachApiKey)),
    } : {}),
    retriever: config.realtimeRetrieverEnabled ? 'enabled' : 'disabled',
    contextAgent: config.realtimeContextAgentEnabled ? 'enabled' : 'disabled',
    contextInjection: contextInjectionSupported ? 'supported' : 'unsupported',
  };
}

function readBearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  if (!value?.startsWith('Bearer ')) return null;
  const token = value.slice('Bearer '.length).trim();
  return token || null;
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 32 * 1024) throw new Error('REQUEST_BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  if (size === 0) throw new Error('INVALID_JSON');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('INVALID_JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_JSON');
  return value as Record<string, unknown>;
}

function parseYearValue(value: unknown, allowNow = false): number | 'now' | null | undefined {
  if (value === null || value === '') return null;
  if (allowNow && value === 'now') return 'now';
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 9999) return value;
  if (typeof value === 'string' && /^\d{1,4}$/.test(value.trim())) {
    const year = Number(value.trim());
    if (year >= 1 && year <= 9999) return year;
  }
  return undefined;
}

function parseLifeStageInput(body: Record<string, unknown>): {
  title: string;
  startYear: number | null;
  endYear: number | 'now' | null;
} | null {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const startYear = Object.hasOwn(body, 'start_year') ? parseYearValue(body.start_year) : null;
  const endYear = Object.hasOwn(body, 'end_year') ? parseYearValue(body.end_year, true) : null;
  if (!title || startYear === undefined || startYear === 'now' || endYear === undefined) return null;
  return { title, startYear: startYear ?? null, endYear: endYear ?? null };
}

function sameOriginRequest(request: IncomingMessage): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === String(request.headers.host ?? '').toLowerCase();
  } catch {
    return false;
  }
}

function errorStatus(error: unknown): number {
  if (error instanceof CloseoutWorkflowError) return error.httpStatus;
  if (error instanceof OnboardingWorkflowError) return error.statusCode;
  return 500;
}

function closeoutModelConfig(config: RuntimeConfig): CloseoutWorkflowConfig {
  return {
    provider: config.closeoutProvider,
    apiKey: config.closeoutApiKey ?? '',
    baseUrl: config.closeoutBaseUrl,
    apiFormat: config.closeoutApiFormat,
    model: config.closeoutModel,
    timeoutMs: config.closeoutTimeoutMs,
  };
}

function onboardingCloseoutModelConfig(config: RuntimeConfig): OnboardingCloseoutConfig {
  return {
    provider: config.onboardingCloseoutProvider,
    apiKey: config.closeoutApiKey ?? '',
    baseUrl: config.onboardingCloseoutBaseUrl ?? config.closeoutBaseUrl,
    apiFormat: config.onboardingCloseoutApiFormat ?? config.closeoutApiFormat,
    model: config.onboardingCloseoutModel,
    timeoutMs: config.onboardingCloseoutTimeoutMs ?? config.closeoutTimeoutMs,
  };
}

function storyCompletionModelConfig(config: RuntimeConfig) {
  return {
    provider: config.storyCompletionProvider ?? config.closeoutProvider ?? 'openai-compatible',
    apiKey: config.closeoutApiKey ?? '',
    baseUrl: config.storyCompletionBaseUrl ?? config.closeoutBaseUrl,
    apiFormat: config.storyCompletionApiFormat ?? config.closeoutApiFormat,
    model: config.storyCompletionModel ?? config.closeoutModel,
    timeoutMs: config.storyCompletionTimeoutMs ?? config.closeoutTimeoutMs,
  };
}

function storyGenerationModelConfig(config: RuntimeConfig) {
  return {
    provider: config.storyGenerationProvider ?? config.closeoutProvider ?? 'openai-compatible',
    apiKey: config.closeoutApiKey ?? '',
    baseUrl: config.storyGenerationBaseUrl ?? config.closeoutBaseUrl,
    apiFormat: config.storyGenerationApiFormat ?? config.closeoutApiFormat,
    model: config.storyGenerationModel ?? config.closeoutModel,
    timeoutMs: config.storyGenerationTimeoutMs ?? config.closeoutTimeoutMs,
  };
}

function loadStories(databasePath: string | undefined, userId: string): Array<Record<string, unknown>> {
  return new StoryRepository(databasePath).listForUser(userId);
}

function loadLifeStages(databasePath: string | undefined, userId: string) {
  const stages = new LifeStageRepository(databasePath).listV1ForUser(userId);
  const storyCounts = new Map<string, number>();
  for (const story of new StoryRepository(databasePath).listForUser(userId)) {
    const stageId = String(story.stage_id ?? '');
    if (stageId) storyCounts.set(stageId, (storyCounts.get(stageId) ?? 0) + 1);
  }
  return stages.map((stage) => ({
    stage_id: stage.stageId,
    title: stage.title,
    start_year: stage.startYear,
    end_year: stage.endYear,
    sort_order: stage.sortOrder,
    status: stage.status,
    created_source_session_id: stage.createdSourceSessionId,
    created_at: stage.createdAt,
    updated_at: stage.updatedAt,
    story_count: storyCounts.get(stage.stageId) ?? 0,
  }));
}

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const localVadRoot = fileURLToPath(new URL('../node_modules/', import.meta.url));
const localVadAssets: Record<string, { file: string; contentType: string }> = {
  '/vad/ort.wasm.min.js': { file: 'onnxruntime-web/dist/ort.wasm.min.js', contentType: 'text/javascript; charset=utf-8' },
  '/vad/ort-wasm-simd-threaded.mjs': { file: 'onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', contentType: 'text/javascript; charset=utf-8' },
  '/vad/ort-wasm-simd-threaded.asyncify.mjs': { file: 'onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs', contentType: 'text/javascript; charset=utf-8' },
  '/vad/ort-wasm-simd-threaded.jspi.mjs': { file: 'onnxruntime-web/dist/ort-wasm-simd-threaded.jspi.mjs', contentType: 'text/javascript; charset=utf-8' },
  '/vad/ort-wasm-simd-threaded.jsep.mjs': { file: 'onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs', contentType: 'text/javascript; charset=utf-8' },
  '/vad/bundle.min.js': { file: '@ricky0123/vad-web/dist/bundle.min.js', contentType: 'text/javascript; charset=utf-8' },
  '/vad/vad.worklet.bundle.min.js': { file: '@ricky0123/vad-web/dist/vad.worklet.bundle.min.js', contentType: 'text/javascript; charset=utf-8' },
  '/vad/silero_vad_v6.onnx': { file: '@ricky0123/vad-web/dist/silero_vad_v6.onnx', contentType: 'application/octet-stream' },
  '/vad/ort-wasm-simd-threaded.wasm': { file: 'onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', contentType: 'application/wasm' },
  '/vad/ort-wasm-simd-threaded.asyncify.wasm': { file: 'onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', contentType: 'application/wasm' },
  '/vad/ort-wasm-simd-threaded.jspi.wasm': { file: 'onnxruntime-web/dist/ort-wasm-simd-threaded.jspi.wasm', contentType: 'application/wasm' },
  '/vad/ort-wasm-simd-threaded.jsep.wasm': { file: 'onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', contentType: 'application/wasm' },
};
const staticAssets: Record<string, { file: string; contentType: string }> = {
  '/life.js': { file: 'life.js', contentType: 'text/javascript; charset=utf-8' },
  '/life.css': { file: 'life.css', contentType: 'text/css; charset=utf-8' },
  '/life-model.js': { file: 'life-model.js', contentType: 'text/javascript; charset=utf-8' },
  '/http.js': { file: 'http.js', contentType: 'text/javascript; charset=utf-8' },
  '/client.js': { file: 'client.js', contentType: 'text/javascript; charset=utf-8' },
  '/tech-observer.js': { file: 'tech-observer.js', contentType: 'text/javascript; charset=utf-8' },
  '/audio-format.js': { file: 'audio-format.js', contentType: 'text/javascript; charset=utf-8' },
  '/interview-state.js': { file: 'interview-state.js', contentType: 'text/javascript; charset=utf-8' },
  '/text-disclosure.js': { file: 'text-disclosure.js', contentType: 'text/javascript; charset=utf-8' },
  '/audio-worklet.js': { file: 'audio-worklet.js', contentType: 'text/javascript; charset=utf-8' },
  '/local-vad-turn-controller.js': { file: 'local-vad-turn-controller.js', contentType: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', contentType: 'text/css; charset=utf-8' },
  '/ui.css': { file: 'ui.css', contentType: 'text/css; charset=utf-8' },
  '/onboarding-ui.js': { file: 'onboarding-ui.js', contentType: 'text/javascript; charset=utf-8' },
  '/onboarding.css': { file: 'onboarding.css', contentType: 'text/css; charset=utf-8' },
  '/onboarding-processing.js': { file: 'onboarding-processing.js', contentType: 'text/javascript; charset=utf-8' },
  '/onboarding-result.js': { file: 'onboarding-result.js', contentType: 'text/javascript; charset=utf-8' },
  '/result.js': { file: 'result.js', contentType: 'text/javascript; charset=utf-8' },
  '/result.css': { file: 'result.css', contentType: 'text/css; charset=utf-8' },
  '/story.js': { file: 'story.js', contentType: 'text/javascript; charset=utf-8' },
  '/story.css': { file: 'story.css', contentType: 'text/css; charset=utf-8' },
  '/share.js': { file: 'share.js', contentType: 'text/javascript; charset=utf-8' },
  '/share.css': { file: 'share.css', contentType: 'text/css; charset=utf-8' },
  '/documents.js': { file: 'documents.js', contentType: 'text/javascript; charset=utf-8' },
  '/documents.css': { file: 'documents.css', contentType: 'text/css; charset=utf-8' },
  '/document.js': { file: 'document.js', contentType: 'text/javascript; charset=utf-8' },
  '/book.js': { file: 'book.js', contentType: 'text/javascript; charset=utf-8' },
  '/book-model.js': { file: 'book-model.js', contentType: 'text/javascript; charset=utf-8' },
  '/book.css': { file: 'book.css', contentType: 'text/css; charset=utf-8' },
};
const onboardingPages: Record<string, { file: string; microphone: boolean }> = {
  '/onboarding': { file: 'index.html', microphone: true },
  '/onboarding/processing': { file: 'onboarding-processing.html', microphone: false },
  '/onboarding/result': { file: 'onboarding-result.html', microphone: false },
};

function createStoryWorkflowDependencies(
  config: RuntimeConfig,
  dependencies: InterviewServiceDependencies,
  observationBus: ObservationBus,
): InterviewServiceDependencies {
  const textModelProvider = dependencies.closeout?.textModelProvider ?? new DirectTextModelProvider();
  const onObservationEvent = (event: Parameters<typeof emitObservationEvent>[0]) => emitObservationEvent(event, observationBus);
  const agentTasks = dependencies.agentTasks === undefined
    ? createAgentTaskPort(process.env, {
        databasePath: config.databasePath,
        onObservationEvent,
      })
    : dependencies.agentTasks;
  const realtimeAgentEnabled = config.realtimeContextAgentEnabled === true;
  const realtimeContextAgentTasks = dependencies.realtimeContextAgentTasks !== undefined
    ? dependencies.realtimeContextAgentTasks
    : realtimeAgentEnabled
      ? agentTasks ?? createAgentTaskPort({ ...process.env, AI_TASK_RUNTIME: 'agent' }, {
          databasePath: config.databasePath,
          onObservationEvent,
        })
      : null;
  const storyCompletion = dependencies.storyCompletion
    ?? createStoryCompletionService(
      config.databasePath,
      storyCompletionModelConfig(config),
      textModelProvider,
      agentTasks ? new AgentStoryCompletionProcessor(agentTasks) : undefined,
    );
  const storyGeneration = dependencies.storyGeneration
    ?? createStoryGenerationService(
      config.databasePath,
      storyGenerationModelConfig(config),
      textModelProvider,
      agentTasks ? new AgentStoryGenerationContextModel(agentTasks) : undefined,
    );
  const retriever = dependencies.retriever
    ?? (process.env.NEMO_RETRIEVER_ENABLED?.trim() === 'true' ? createRetrieverClientFromEnv(process.env) : undefined);
  const eraContextEnabled = process.env.NEMO_ERA_CONTEXT_ENABLED?.trim() === 'true';
  const eraContextClient = eraContextEnabled
    ? dependencies.eraContextClient ?? createEraContextClientFromEnv(process.env)
    : undefined;
  const realtimeRecall = dependencies.realtimeRecall
    ?? (retriever ? new RealtimeSlowContextPipeline(retriever, realtimeContextAgentTasks) : undefined);
  const realtimeCoach = dependencies.realtimeCoach === undefined
    ? config.realtimeCoachApiKey ? new BailianRealtimeCoach({
        provider: config.realtimeCoachProvider ?? 'openai-compatible',
        baseUrl: config.realtimeCoachBaseUrl ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: config.realtimeCoachModel ?? 'qwen3-8b',
        apiKey: config.realtimeCoachApiKey,
      }) : null
    : dependencies.realtimeCoach;
  const realtimeCoachPipeline = dependencies.realtimeCoachPipeline
    ?? (realtimeCoach ? new RealtimeCoachPipeline(realtimeCoach, retriever, eraContextClient) : undefined);
  const retrieverIndex = dependencies.retrieverIndex
    ?? (retriever ? new RetrieverIndexService(config.databasePath, retriever) : undefined);
  const retrievalTokenSecret = process.env.AGENT_RETRIEVAL_TOKEN_SECRET?.trim()
    || process.env.AGENT_TOOL_TOKEN_SECRET?.trim();
  const retrievalTokenService = retrievalTokenSecret
    ? new AgentToolTokenService(retrievalTokenSecret)
    : undefined;
  const retrieverScriptGateway = dependencies.retrieverScriptGateway
    ?? (retriever && retrievalTokenService ? new RetrieverScriptGateway(retriever, retrievalTokenService) : undefined);
  const eraContextScriptGateway = dependencies.eraContextScriptGateway
    ?? (process.env.NEMO_ERA_CONTEXT_ENABLED?.trim() === 'true' && retrievalTokenService
      ? new EraContextScriptGateway(eraContextClient ?? createEraContextClientFromEnv(process.env), retrievalTokenService)
      : undefined);
  const retrievalScriptConfig = retrievalTokenService && process.env.AGENT_RETRIEVAL_BASE_URL?.trim()
    ? {
        baseUrl: process.env.AGENT_RETRIEVAL_BASE_URL.trim().replace(/\/+$/u, ''),
        tokenService: retrievalTokenService,
      }
    : undefined;
  return {
    ...dependencies,
    agentTasks,
    ...(retriever ? { retriever } : {}),
    ...(realtimeRecall ? { realtimeRecall } : {}),
    ...(realtimeCoach ? { realtimeCoach } : {}),
    ...(eraContextClient ? { eraContextClient } : {}),
    ...(realtimeCoachPipeline ? { realtimeCoachPipeline } : {}),
    ...(retrieverIndex ? { retrieverIndex } : {}),
    ...(retrieverScriptGateway ? { retrieverScriptGateway } : {}),
    ...(eraContextScriptGateway ? { eraContextScriptGateway } : {}),
    storyCompletion,
    storyGeneration,
    closeout: {
      ...dependencies.closeout,
      ...(agentTasks && !dependencies.closeout?.processor
        ? { processor: new AgentStoryCloseoutProcessor(agentTasks, retrievalScriptConfig) }
        : {}),
      async afterApply(userId, storyId) {
        if (dependencies.closeout?.afterApply) {
          try { await dependencies.closeout.afterApply(userId, storyId); }
          catch (error) {
            const failureType = error instanceof Error ? error.name : 'unknown';
            console.error('[story-completion] Custom post-Closeout hook failed.', { failureType });
            writeDiagnosticLog('server', 'error', 'Custom post-Closeout hook failed.', { failureType });
          }
        }
        await storyCompletion.evaluate(userId, storyId);
        void retrieverIndex?.reindexStorySessions(userId, storyId).catch(() => undefined);
      },
    },
    onboardingCloseout: {
      ...dependencies.onboardingCloseout,
      ...(agentTasks && !dependencies.onboardingCloseout?.processor
        ? { processor: new AgentOnboardingCloseoutProcessor(agentTasks) }
        : {}),
      async afterApply(userId, storyId) {
        if (dependencies.onboardingCloseout?.afterApply) {
          try { await dependencies.onboardingCloseout.afterApply(userId, storyId); }
          catch (error) {
            const failureType = error instanceof Error ? error.name : 'unknown';
            console.error('[story-completion] Custom post-Onboarding hook failed.', { failureType });
            writeDiagnosticLog('server', 'error', 'Custom post-Onboarding hook failed.', { failureType });
          }
        }
        await storyCompletion.evaluate(userId, storyId);
        void retrieverIndex?.reindexStorySessions(userId, storyId).catch(() => undefined);
      },
    },
  };
}

function createHttpHandler(config: RuntimeConfig, authService: AuthService, dependencies: InterviewServiceDependencies, observationBus: ObservationBus) {
  const textModelProvider: TextModelProvider = dependencies.closeout?.textModelProvider ?? new DirectTextModelProvider();
  const storyCompletion = dependencies.storyCompletion
    ?? createStoryCompletionService(config.databasePath, storyCompletionModelConfig(config), textModelProvider);
  const storyGeneration = dependencies.storyGeneration
    ?? createStoryGenerationService(config.databasePath, storyGenerationModelConfig(config), textModelProvider);
  const bookService = new BookService(config.databasePath);
  const closeoutDependencies: CloseoutWorkflowDependencies = dependencies.closeout ?? {};
  const observationStreamsByUser = new Map<string, Set<ServerResponse>>();
  const closeObservationStreams = (userId: string): void => {
    const streams = observationStreamsByUser.get(userId);
    if (!streams) return;
    for (const stream of [...streams]) stream.end();
  };
  const observationTokenExpiry = (token: string): number | undefined => {
    try {
      const payload = token.split('.', 1)[0];
      if (!payload) return undefined;
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { expiresAt?: unknown };
      return typeof claims.expiresAt === 'number' && Number.isSafeInteger(claims.expiresAt)
        ? claims.expiresAt * 1_000
        : undefined;
    } catch { return undefined; }
  };
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'POST' && url.pathname === '/internal/agent-retrieval/memory-search') {
      const gateway = dependencies.retrieverScriptGateway;
      if (!gateway) {
        sendJson(response, 503, { error: 'Retriever is not configured.', errorCode: 'RETRIEVER_UNAVAILABLE' });
        return;
      }
      const token = readBearerToken(request);
      if (!token) {
        sendJson(response, 401, { error: 'Missing retrieval token.', errorCode: 'RETRIEVAL_TOKEN_INVALID' });
        return;
      }
      try {
        const body = await readJsonObject(request);
        sendJson(response, 200, await gateway.memorySearch(token, body));
      } catch (error) {
        if (error instanceof RetrieverScriptError) {
          sendJson(response, error.statusCode, { error: error.message, errorCode: error.code });
          return;
        }
        sendJson(response, 400, { error: 'Invalid retrieval request.', errorCode: 'INVALID_RETRIEVAL_REQUEST' });
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/internal/agent-retrieval/era-context-search') {
      const gateway = dependencies.eraContextScriptGateway;
      if (!gateway) {
        sendJson(response, 503, { error: 'Era context Retriever is not configured.', errorCode: 'ERA_CONTEXT_UNAVAILABLE' });
        return;
      }
      const token = readBearerToken(request);
      if (!token) {
        sendJson(response, 401, { error: 'Missing era context token.', errorCode: 'ERA_CONTEXT_TOKEN_INVALID' });
        return;
      }
      try {
        const body = await readJsonObject(request);
        sendJson(response, 200, await gateway.search(token, body));
      } catch (error) {
        if (error instanceof EraContextScriptError) {
          sendJson(response, error.statusCode, { error: error.message, errorCode: error.code });
          return;
        }
        sendJson(response, 400, { error: 'Invalid era context request.', errorCode: 'INVALID_ERA_CONTEXT_REQUEST' });
      }
      return;
    }
    const logoutRequest = request.method === 'POST' && url.pathname === '/api/auth/logout';
    let logoutUserId: string | undefined;
    if (logoutRequest) {
      try { logoutUserId = authService.resolveToken(readAuthCookie(request.headers.cookie))?.userId; } catch { /* Logout remains available if stream cleanup cannot resolve the account. */ }
    }
    if (await handleAuthRequest(request, response, authService, {
      developmentAuthEnabled: config.developmentAuthEnabled === true,
      secureCookie: config.secureCookies === true,
      authMode: config.authMode ?? 'sms',
    })) {
      if (logoutRequest && logoutUserId && response.statusCode === 200) closeObservationStreams(logoutUserId);
      return;
    }

    if (url.pathname === '/api/observability/events' && request.method === 'GET') {
      const authToken = readAuthCookie(request.headers.cookie);
      const authContext = authService.resolveToken(authToken);
      if (!authToken || !authContext) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED' });
        return;
      }
      const authExpiresAt = observationTokenExpiry(authToken);
      if (!authExpiresAt) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED' });
        return;
      }
      if (!observationBus.enabled) {
        sendJson(response, 503, { error: 'Observation is disabled.', errorCode: 'OBSERVABILITY_DISABLED' });
        return;
      }
      const sessionId = url.searchParams.get('sessionId')?.trim();
      if (!sessionId || sessionId.length > 200) {
        sendJson(response, 400, { error: 'Session ID is required.', errorCode: 'OBSERVABILITY_SESSION_REQUIRED' });
        return;
      }
      try {
        if (!new InterviewSessionRepository(config.databasePath).findByIdForUser(authContext.userId, sessionId)) {
          sendJson(response, 404, { error: 'Session not found.', errorCode: 'SESSION_NOT_FOUND' });
          return;
        }
      } catch {
        sendJson(response, 503, { error: 'Observation stream is unavailable.', errorCode: 'OBSERVABILITY_UNAVAILABLE' });
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      });
      response.write('retry: 1500\n\n');
      const userStreams = observationStreamsByUser.get(authContext.userId) ?? new Set<ServerResponse>();
      userStreams.add(response);
      observationStreamsByUser.set(authContext.userId, userStreams);
      const sent = new Set<string>();
      const sendEvent = (event: ReturnType<ObservationBus['recent']>[number]): void => {
        if (Date.now() >= authExpiresAt) {
          response.end();
          return;
        }
        if (response.destroyed || response.writableEnded || response.writableLength > 64 * 1024 || sent.has(event.eventId)) return;
        sent.add(event.eventId);
        if (sent.size > 200) sent.delete(sent.values().next().value as string);
        response.write(`id: ${event.eventId}\nevent: observation\ndata: ${JSON.stringify(event)}\n\n`);
      };
      for (const event of observationBus.recent(sessionId)) sendEvent(event);
      const unsubscribe = observationBus.subscribe((event) => {
        if (event.sessionId === sessionId) sendEvent(event);
      });
      const heartbeat = setInterval(() => {
        let currentAuth: ReturnType<AuthService['resolveToken']> = null;
        try { currentAuth = authService.resolveToken(authToken); } catch { /* Fail closed if auth state cannot be checked. */ }
        if (!currentAuth || currentAuth.userId !== authContext.userId) {
          response.end();
          return;
        }
        if (!response.destroyed && !response.writableEnded && response.writableLength < 64 * 1024) response.write(': heartbeat\n\n');
      }, 20_000);
      const expiryTimer = setTimeout(() => response.end(), Math.max(1, authExpiresAt - Date.now()));
      expiryTimer.unref?.();
      const cleanup = (): void => {
        clearInterval(heartbeat);
        clearTimeout(expiryTimer);
        unsubscribe();
        userStreams.delete(response);
        if (userStreams.size === 0 && observationStreamsByUser.get(authContext.userId) === userStreams) {
          observationStreamsByUser.delete(authContext.userId);
        }
      };
      response.once('close', cleanup);
      response.once('error', cleanup);
      request.once('aborted', cleanup);
      return;
    }

    const closeoutMatch = url.pathname.match(/^\/api\/interview-sessions\/([^/]+)\/(closeout|result)(?:\/(cancel))?$/);
    const onboardingCloseoutMatch = url.pathname.match(/^\/api\/onboarding\/sessions\/([^/]+)\/closeout$/);
    const closeoutAction = closeoutMatch?.[3] ? 'cancel' : closeoutMatch?.[2];
    const isCloseoutPost = request.method === 'POST'
      && (closeoutAction === 'closeout' || closeoutAction === 'cancel');
    const isOnboardingCloseoutPost = request.method === 'POST' && Boolean(onboardingCloseoutMatch);
    const lifeStageItemMatch = url.pathname.match(/^\/api\/life-stages\/([^/]+)$/);
    const storyStageMatch = url.pathname.match(/^\/api\/stories\/([^/]+)\/stage$/);
    const storyItemMatch = url.pathname.match(/^\/api\/stories\/([^/]+)$/);
    const storyTitleMatch = url.pathname.match(/^\/api\/stories\/([^/]+)\/title$/);
    const storyDocumentsMatch = url.pathname.match(/^\/api\/stories\/([^/]+)\/documents$/);
    const storyDocumentMatch = url.pathname.match(/^\/api\/stories\/([^/]+)\/documents\/([^/]+)$/);
    const storyGenerationMatch = Boolean(storyDocumentMatch?.[2] === 'generate' && request.method === 'POST');
    const storyShareLinksMatch = url.pathname.match(/^\/api\/stories\/([^/]+)\/share-links$/);
    const storyShareLinkItemMatch = url.pathname.match(/^\/api\/story-share-links\/([^/]+)$/);
    const publicStoryShareMatch = url.pathname.match(/^\/api\/public\/story-share\/([^/]+)$/);
    const publicStoryShareRetryMatch = url.pathname.match(/^\/api\/public\/story-share\/([^/]+)\/retry-closeout$/);
    const bookApiMatch = url.pathname === '/api/book';
    const bookPreviewMatch = url.pathname === '/api/book/preview';
    const bookExportMatch = url.pathname === '/api/book/export.pdf';
    const isBookMutation = bookApiMatch && request.method === 'PUT';
    const isLifeStageMutation = (url.pathname === '/api/life-stages' && request.method === 'POST')
      || (Boolean(lifeStageItemMatch) && ['PATCH', 'DELETE'].includes(request.method ?? ''));
    const isStoryStageMutation = Boolean(storyStageMatch) && request.method === 'PATCH';
    const isStoryTitleMutation = Boolean(storyTitleMatch) && request.method === 'PATCH';
    const isStoryShareMutation = (Boolean(storyShareLinksMatch) && request.method === 'POST')
      || (Boolean(storyShareLinkItemMatch) && request.method === 'DELETE')
      || (Boolean(publicStoryShareRetryMatch) && request.method === 'POST');
    if (request.method !== 'GET' && request.method !== 'HEAD' && !isCloseoutPost
      && !isOnboardingCloseoutPost && !isLifeStageMutation && !isStoryStageMutation
      && !isStoryTitleMutation && !storyGenerationMatch && !isBookMutation && !isStoryShareMutation) {
      sendJson(response, 405, { error: 'Method not allowed.' });
      return;
    }

    if (url.pathname === '/api/onboarding/result' && (request.method === 'GET' || request.method === 'HEAD')) {
      const authContext = authService.resolveToken(readAuthCookie(request.headers.cookie));
      if (!authContext) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED', retryable: false }, request.method === 'HEAD');
        return;
      }
      const requestedSessionId = url.searchParams.get('session_id')?.trim() || undefined;
      try {
        sendJson(response, 200, getOnboardingResult(config.databasePath, authContext.userId, requestedSessionId), request.method === 'HEAD');
      } catch (error) {
        const workflowError = error instanceof OnboardingWorkflowError;
        sendJson(response, errorStatus(error), {
          error: error instanceof Error ? error.message : '无法读取首次建档结果。',
          errorCode: workflowError ? error.code : 'ONBOARDING_RESULT_READ_FAILED',
          retryable: false,
        }, request.method === 'HEAD');
      }
      return;
    }

    if (onboardingCloseoutMatch && request.method === 'POST') {
      const authContext = authService.resolveToken(readAuthCookie(request.headers.cookie));
      if (!authContext) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED', retryable: false });
        return;
      }
      if (!sameOriginRequest(request)) {
        sendJson(response, 403, { error: '跨站请求已拒绝。', errorCode: 'CROSS_SITE_REQUEST', retryable: false });
        return;
      }
      let sessionId: string;
      try { sessionId = decodeURIComponent(onboardingCloseoutMatch[1]!); }
      catch {
        sendJson(response, 400, { error: 'Invalid Session ID.', errorCode: 'INVALID_SESSION_ID' });
        return;
      }
      try {
        const started = beginOnboardingCloseout(
          config.databasePath,
          sessionId,
          onboardingCloseoutModelConfig(config),
          authContext.userId,
          dependencies.onboardingCloseout,
        );
        const result = getOnboardingResult(config.databasePath, authContext.userId, sessionId);
        sendJson(response,
          started.status === 'completed' ? 200 : started.status === 'failed' ? 422 : 202,
          result);
      } catch (error) {
        let current: Record<string, unknown> = {};
        try { current = getOnboardingResult(config.databasePath, authContext.userId, sessionId) as unknown as Record<string, unknown>; }
        catch { /* Session may not exist or may belong to another profile. */ }
        sendJson(response, errorStatus(error), {
          ...current,
          error: error instanceof Error ? error.message : '无法启动首次建档整理。',
          errorCode: error instanceof OnboardingWorkflowError ? error.code : 'ONBOARDING_CLOSEOUT_START_FAILED',
          retryable: !(error instanceof OnboardingWorkflowError && [
            'SESSION_NOT_FOUND', 'INVALID_SESSION_TYPE', 'SESSION_NOT_ENDED', 'CLOSEOUT_NOT_CLAIMABLE',
            'ONBOARDING_COMPLETION_REQUIRED', 'ONBOARDING_TRANSCRIPT_INCOMPLETE',
          ].includes(error.code)),
        });
      }
      return;
    }

    if ((isLifeStageMutation || isStoryStageMutation || isStoryTitleMutation || storyGenerationMatch || isBookMutation)
      && !sameOriginRequest(request)) {
      sendJson(response, 403, { error: '跨站请求已拒绝。', errorCode: 'CROSS_SITE_REQUEST', retryable: false });
      return;
    }

    if (bookApiMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      const authContext = authService.resolveToken(readAuthCookie(request.headers.cookie));
      if (!authContext) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED' }, request.method === 'HEAD');
        return;
      }
      const bookId = url.searchParams.get('book_id')?.trim() || undefined;
      try {
        sendJson(response, 200, bookService.load(authContext.userId, bookId), request.method === 'HEAD');
      } catch (error) {
        const status = error instanceof BookServiceError ? error.httpStatus : 503;
        sendJson(response, status, {
          error: error instanceof Error ? error.message : '无法读取人生书。',
          errorCode: error instanceof BookServiceError ? error.code : 'BOOK_READ_FAILED',
        }, request.method === 'HEAD');
      }
      return;
    }

    if (isBookMutation) {
      const authContext = authService.resolveToken(readAuthCookie(request.headers.cookie));
      if (!authContext) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED' });
        return;
      }
      let body: Record<string, unknown>;
      try { body = await readJsonObject(request); } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error && error.message === 'REQUEST_BODY_TOO_LARGE' ? '请求内容过大。' : '请求内容无效。',
          errorCode: error instanceof Error && error.message === 'REQUEST_BODY_TOO_LARGE' ? 'REQUEST_BODY_TOO_LARGE' : 'INVALID_JSON',
        });
        return;
      }
      try {
        sendJson(response, 200, bookService.save(authContext.userId, parseBookSaveInput(body)));
      } catch (error) {
        const status = error instanceof BookServiceError ? error.httpStatus : 503;
        sendJson(response, status, {
          error: error instanceof Error ? error.message : '无法保存人生书。',
          errorCode: error instanceof BookServiceError ? error.code : 'BOOK_SAVE_FAILED',
        });
      }
      return;
    }

    if (bookPreviewMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      const authContext = authService.resolveToken(readAuthCookie(request.headers.cookie));
      if (!authContext) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED' }, request.method === 'HEAD');
        return;
      }
      const bookId = url.searchParams.get('book_id')?.trim() || '';
      if (!bookId) {
        sendJson(response, 400, { error: '缺少人生书编号。', errorCode: 'INVALID_BOOK_ID' }, request.method === 'HEAD');
        return;
      }
      try {
        sendJson(response, 200, { preview: bookService.preview(authContext.userId, bookId).book }, request.method === 'HEAD');
      } catch (error) {
        const status = error instanceof BookServiceError ? error.httpStatus : 503;
        sendJson(response, status, {
          error: error instanceof Error ? error.message : '无法读取成书预览。',
          errorCode: error instanceof BookServiceError ? error.code : 'BOOK_PREVIEW_FAILED',
        }, request.method === 'HEAD');
      }
      return;
    }

    if (bookExportMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      const authContext = authService.resolveToken(readAuthCookie(request.headers.cookie));
      if (!authContext) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED' }, request.method === 'HEAD');
        return;
      }
      const bookId = url.searchParams.get('book_id')?.trim() || '';
      if (!bookId) {
        sendJson(response, 400, { error: '缺少人生书编号。', errorCode: 'INVALID_BOOK_ID' }, request.method === 'HEAD');
        return;
      }
      try {
        const pdf = bookService.exportPdf(authContext.userId, bookId);
        response.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': String(pdf.byteLength),
          'Content-Disposition': 'attachment; filename="memoir-book.pdf"',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(request.method === 'HEAD' ? undefined : pdf);
      } catch (error) {
        const status = error instanceof BookServiceError ? error.httpStatus : 503;
        sendJson(response, status, {
          error: error instanceof Error ? error.message : '无法导出电子书。',
          errorCode: error instanceof BookServiceError ? error.code : 'BOOK_EXPORT_FAILED',
        }, request.method === 'HEAD');
      }
      return;
    }

    if (closeoutMatch) {
      const authContext = authService.resolveToken(readAuthCookie(request.headers.cookie));
      if (!authContext) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED', retryable: false });
        return;
      }
      if (request.method === 'POST' && !sameOriginRequest(request)) {
        sendJson(response, 403, { error: '跨站请求已拒绝。', errorCode: 'CROSS_SITE_REQUEST', retryable: false });
        return;
      }
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(closeoutMatch[1]);
      } catch {
        sendJson(response, 400, { error: 'Invalid Session ID.' });
        return;
      }
      if (closeoutMatch[2] === 'result' && (request.method === 'GET' || request.method === 'HEAD')) {
        try {
          sendJson(response, 200, getInterviewCloseoutResult(config.databasePath, sessionId, authContext.userId), request.method === 'HEAD');
        } catch (error) {
          sendJson(response, errorStatus(error), {
            error: error instanceof Error ? error.message : '无法读取访谈结果。',
            code: error instanceof CloseoutWorkflowError ? error.code : 'RESULT_READ_FAILED',
            status: error instanceof CloseoutWorkflowError && error.code === 'SESSION_NOT_FOUND' ? 'empty' : 'failed',
            closeoutStatus: error instanceof CloseoutWorkflowError && error.code === 'SESSION_NOT_FOUND' ? 'empty' : 'failed',
            retryable: false,
          }, request.method === 'HEAD');
        }
        return;
      }
      if (closeoutMatch[2] === 'closeout' && closeoutMatch[3] === 'cancel' && request.method === 'POST') {
        try {
          const current = getInterviewCloseoutResult(config.databasePath, sessionId, authContext.userId);
          const cancellation = cancelInterviewCloseout(sessionId);
          if (cancellation.status === 'cancelling') {
            sendJson(response, 202, { ...current, cancellationRequested: true });
          } else if (current.closeoutStatus === 'completed'
            || (current.closeoutStatus === 'failed' && current.errorCode === 'CLOSEOUT_CANCELLED')) {
            sendJson(response, 200, { ...current, cancellationRequested: false });
          } else {
            sendJson(response, 409, {
              ...current,
              cancellationRequested: false,
              error: '当前服务进程没有正在运行的整理任务。',
              errorCode: 'CLOSEOUT_CANCEL_UNAVAILABLE',
              retryable: false,
            });
          }
        } catch (error) {
          sendJson(response, errorStatus(error), {
            error: error instanceof Error ? error.message : '无法停止访谈整理。',
            errorCode: error instanceof CloseoutWorkflowError ? error.code : 'CLOSEOUT_CANCEL_FAILED',
            retryable: false,
          });
        }
        return;
      }
      if (closeoutMatch[2] === 'closeout' && request.method === 'POST') {
        try {
          beginInterviewCloseout(config.databasePath, sessionId, closeoutModelConfig(config), authContext.userId, closeoutDependencies);
          const result = getInterviewCloseoutResult(config.databasePath, sessionId, authContext.userId);
          const closeoutStatus = result.closeoutStatus;
          sendJson(response,
            closeoutStatus === 'completed' ? 200 : closeoutStatus === 'failed' ? 422 : 202,
            result);
        } catch (error) {
          const code = error instanceof CloseoutWorkflowError ? error.code : 'CLOSEOUT_START_FAILED';
          let current: Record<string, unknown> = {};
          try { current = getInterviewCloseoutResult(config.databasePath, sessionId, authContext.userId); } catch { /* Session may not exist or may belong to another profile. */ }
          const notFound = code === 'SESSION_NOT_FOUND';
          const retryable = ![
            'CLOSEOUT_RETRY_BLOCKED',
            'CLOSEOUT_NOT_CLAIMABLE',
            'SESSION_NOT_FOUND',
            'SESSION_NOT_ENDED',
          ].includes(code);
          sendJson(response, errorStatus(error), {
            ...current,
            status: notFound ? 'empty' : current.status ?? 'failed',
            closeoutStatus: notFound ? 'empty' : current.closeoutStatus ?? 'failed',
            error: error instanceof Error ? error.message : '无法启动访谈整理。',
            errorCode: code,
            retryable,
          });
        }
        return;
      }
    }

    if (publicStoryShareRetryMatch && request.method === 'POST') {
      if (!sameOriginRequest(request)) {
        sendJson(response, 403, { error: '请求来源无效。', errorCode: 'ORIGIN_FORBIDDEN' });
        return;
      }
      const token = publicStoryShareRetryMatch[1] ?? '';
      const shares = new StoryShareRepository(config.databasePath);
      const identity = shares.resolveTokenIdentity(token);
      if (!identity) {
        sendJson(response, 410, { error: '该分享链接已不可用。', errorCode: 'SHARE_LINK_UNAVAILABLE' });
        return;
      }
      const sessionId = shares.findLatestFailedSessionForShare(identity.userId, identity.shareId);
      if (!sessionId) {
        sendJson(response, 409, {
          error: '当前没有需要重试的访谈整理。',
          errorCode: 'EXTERNAL_CONTRIBUTOR_RETRY_UNAVAILABLE',
        });
        return;
      }
      try {
        await runExternalContributorCloseout({
          databasePath: config.databasePath,
          userId: identity.userId,
          sessionId,
          config: closeoutModelConfig(config),
          textModelProvider: dependencies.closeout?.textModelProvider,
          agentTaskPort: dependencies.agentTasks ?? undefined,
        });
        sendJson(response, 200, { ok: true });
      } catch (error) {
        const code = error instanceof Error ? error.message : 'EXTERNAL_CONTRIBUTOR_CLOSEOUT_FAILED';
        if (code === 'EXTERNAL_CONTRIBUTOR_CLOSEOUT_ALREADY_PROCESSING') {
          sendJson(response, 202, { ok: false, status: 'processing' });
          return;
        }
        sendJson(response, 422, {
          ok: false,
          error: '补充内容已保留，但整理仍未完成，请稍后重试。',
          errorCode: 'EXTERNAL_CONTRIBUTOR_CLOSEOUT_FAILED',
        });
      }
      return;
    }

    if (publicStoryShareMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      const token = publicStoryShareMatch[1] ?? '';
      const shares = new StoryShareRepository(config.databasePath);
      const share = shares.resolvePublicToken(token);
      if (!share) {
        sendJson(response, 410, {
          error: '该分享链接无效或已过期。',
          errorCode: 'SHARE_LINK_UNAVAILABLE',
        }, request.method === 'HEAD');
        return;
      }
      sendJson(response, 200, {
        story: {
          title: share.storyTitle,
          summary: share.storySummary,
          status: share.storyStatus,
          gaps: parseStoryGaps(share.storyGapsJson),
        },
        owner_name: share.ownerName,
        relationship: share.relationship,
        expires_at: share.expiresAt,
        has_previous_interview: share.interviewCount > 0,
        ...(() => {
          const latest = shares.findLatestContributorSessionStateForShare(share.userId, share.shareId);
          return latest
            ? {
                contributor_session_status: latest.sessionStatus,
                contributor_closeout_status: latest.closeoutStatus,
              }
            : {};
        })(),
      }, request.method === 'HEAD');
      return;
    }

    if (storyShareLinksMatch && request.method === 'POST') {
      const authContext = authService.resolveToken(readAuthCookie(request.headers.cookie));
      if (!authContext) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED' });
        return;
      }
      if (!sameOriginRequest(request)) {
        sendJson(response, 403, { error: '请求来源无效。', errorCode: 'ORIGIN_FORBIDDEN' });
        return;
      }
      let storyId: string;
      try { storyId = decodeURIComponent(storyShareLinksMatch[1]!); } catch {
        sendJson(response, 400, { error: '故事编号无效。', errorCode: 'INVALID_STORY_ID' });
        return;
      }
      let body: Record<string, unknown>;
      try { body = await readJsonObject(request); } catch {
        sendJson(response, 400, { error: '请求内容无效。', errorCode: 'INVALID_JSON' });
        return;
      }
      if (!isStoryShareRelationship(body.relationship)) {
        sendJson(response, 400, { error: '请选择有效的关系。', errorCode: 'INVALID_RELATIONSHIP' });
        return;
      }
      const created = new StoryShareRepository(config.databasePath)
        .createForStory(authContext.userId, storyId, body.relationship);
      if (!created) {
        sendJson(response, 404, { error: '故事不存在。', errorCode: 'STORY_NOT_FOUND' });
        return;
      }
      sendJson(response, 201, {
        share_id: created.link.shareId,
        relationship: created.link.relationship,
        expires_at: created.link.expiresAt,
        share_url: `/share/story/${created.token}`,
      });
      return;
    }

    if (storyShareLinksMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      const authContext = authService.resolveToken(readAuthCookie(request.headers.cookie));
      if (!authContext) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED' }, request.method === 'HEAD');
        return;
      }
      let storyId: string;
      try { storyId = decodeURIComponent(storyShareLinksMatch[1]!); } catch {
        sendJson(response, 400, { error: '故事编号无效。', errorCode: 'INVALID_STORY_ID' }, request.method === 'HEAD');
        return;
      }
      const now = Date.now();
      const links = new StoryShareRepository(config.databasePath).listForStory(authContext.userId, storyId)
        .map((link) => ({
          share_id: link.shareId,
          relationship: link.relationship,
          status: link.status === 'revoked'
            ? 'revoked'
            : Date.parse(link.expiresAt) <= now ? 'expired' : 'active',
          expires_at: link.expiresAt,
          interview_count: link.interviewCount,
          last_interview_at: link.lastInterviewAt,
        }));
      sendJson(response, 200, { share_links: links }, request.method === 'HEAD');
      return;
    }

    if (storyShareLinkItemMatch && request.method === 'DELETE') {
      const authContext = authService.resolveToken(readAuthCookie(request.headers.cookie));
      if (!authContext) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED' });
        return;
      }
      if (!sameOriginRequest(request)) {
        sendJson(response, 403, { error: '请求来源无效。', errorCode: 'ORIGIN_FORBIDDEN' });
        return;
      }
      let shareId: string;
      try { shareId = decodeURIComponent(storyShareLinkItemMatch[1]!); } catch {
        sendJson(response, 400, { error: '分享编号无效。', errorCode: 'INVALID_SHARE_ID' });
        return;
      }
      const revoked = new StoryShareRepository(config.databasePath).revokeForUser(authContext.userId, shareId);
      sendJson(response, revoked ? 200 : 404, revoked
        ? { ok: true }
        : { error: '分享链接不存在或已失效。', errorCode: 'SHARE_LINK_NOT_FOUND' });
      return;
    }

    if (url.pathname === '/api/health') {
      try {
        const databaseConnection = createDatabase(config.databasePath);
        try { databaseConnection.sqlite.prepare('SELECT 1').get(); } finally { databaseConnection.close(); }
        sendJson(response, 200, {
          ok: true,
          defaultProvider: config.defaultRealtimeProvider ?? 'stepaudio2_mini',
          realtimeMemory: realtimeMemoryHealthSummary(config),
          providers: realtimeProviderHealthSummary(config),
          closeout: {
            configured: Boolean(config.closeoutApiKey),
            provider: config.closeoutProvider ?? 'openai-compatible',
            model: config.closeoutModel ?? 'qwen3.6-35b-a3b',
          },
          databaseAvailable: true,
          interviewLimits: {
            wrapUpMs: config.wrapUpMs ?? DEFAULT_WRAPUP_MS,
            maxSessionMs: config.maxSessionMs ?? DEFAULT_MAX_SESSION_MS,
            closeGraceMs: config.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS,
            openingResponseTimeoutMs: config.openingResponseTimeoutMs ?? DEFAULT_OPENING_RESPONSE_TIMEOUT_MS,
            userTurnStallTimeoutMs: config.userTurnStallTimeoutMs ?? DEFAULT_USER_TURN_STALL_TIMEOUT_MS,
          },
        }, request.method === 'HEAD');
      } catch (error) {
        sendJson(response, 503, {
          ok: false,
          defaultProvider: config.defaultRealtimeProvider ?? 'stepaudio2_mini',
          realtimeMemory: realtimeMemoryHealthSummary(config),
          providers: realtimeProviderHealthSummary(config, false),
          closeout: {
            configured: Boolean(config.closeoutApiKey),
            provider: config.closeoutProvider ?? 'openai-compatible',
            model: config.closeoutModel ?? 'qwen3.6-35b-a3b',
          },
          databaseAvailable: false,
          error: error instanceof Error ? error.message : 'Database unavailable.',
        }, request.method === 'HEAD');
      }
      return;
    }

    if (url.pathname === '/api/stories') {
      const authContext = authService.resolveToken(readAuthCookie(request.headers.cookie));
      if (!authContext) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED' }, request.method === 'HEAD');
        return;
      }
      try {
        sendJson(response, 200, { stories: loadStories(config.databasePath, authContext.userId) }, request.method === 'HEAD');
      } catch (error) {
        sendJson(response, 503, {
          error: error instanceof Error ? error.message : 'Database unavailable.',
        }, request.method === 'HEAD');
      }
      return;
    }

    if (storyItemMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      const authContext = authService.resolveToken(readAuthCookie(request.headers.cookie));
      if (!authContext) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED' }, request.method === 'HEAD');
        return;
      }
      let storyId: string;
      try { storyId = decodeURIComponent(storyItemMatch[1]!); } catch {
        sendJson(response, 400, { error: '故事编号无效。', errorCode: 'INVALID_STORY_ID' }, request.method === 'HEAD');
        return;
      }
      try {
        const story = new StoryRepository(config.databasePath).getDetailForUser(authContext.userId, storyId);
        if (!story) {
          sendJson(response, 404, { error: '故事不存在。', errorCode: 'STORY_NOT_FOUND' }, request.method === 'HEAD');
          return;
        }
        sendJson(response, 200, { story: {
          story_id: story.storyId,
          title: story.title,
          summary: story.summary,
          status: story.status,
          gaps: story.gaps,
          stage_id: story.stageId,
          stage_title: story.stageTitle,
          updated_at: story.updatedAt,
        } }, request.method === 'HEAD');
      } catch {
        sendJson(response, 503, { error: '无法读取故事。', errorCode: 'STORY_READ_FAILED' }, request.method === 'HEAD');
      }
      return;
    }

    if (storyTitleMatch && isStoryTitleMutation) {
      const authContext = authService.resolveToken(readAuthCookie(request.headers.cookie));
      if (!authContext) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED' });
        return;
      }
      let storyId: string;
      try { storyId = decodeURIComponent(storyTitleMatch[1]!); } catch {
        sendJson(response, 400, { error: '故事编号无效。', errorCode: 'INVALID_STORY_ID' });
        return;
      }
      let body: Record<string, unknown>;
      try { body = await readJsonObject(request); } catch (error) {
        const tooLarge = error instanceof Error && error.message === 'REQUEST_BODY_TOO_LARGE';
        sendJson(response, 400, {
          error: tooLarge ? '请求内容过大。' : '请求内容无效。',
          errorCode: tooLarge ? 'REQUEST_BODY_TOO_LARGE' : 'INVALID_JSON',
        });
        return;
      }
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title || title.length > 200) {
        sendJson(response, 400, { error: '标题不能为空且不能超过 200 个字符。', errorCode: 'INVALID_STORY_TITLE' });
        return;
      }
      const repository = new StoryRepository(config.databasePath);
      try {
        if (!repository.updateTitleForUser(authContext.userId, storyId, title)) {
          sendJson(response, 404, { error: '故事不存在。', errorCode: 'STORY_NOT_FOUND' });
          return;
        }
        const story = repository.getDetailForUser(authContext.userId, storyId);
        if (!story) {
          sendJson(response, 404, { error: '故事不存在。', errorCode: 'STORY_NOT_FOUND' });
          return;
        }
        sendJson(response, 200, { story: {
          story_id: story.storyId,
          title: story.title,
          summary: story.summary,
          status: story.status,
          gaps: story.gaps,
          stage_id: story.stageId,
          stage_title: story.stageTitle,
          updated_at: story.updatedAt,
        } });
      } catch {
        sendJson(response, 503, { error: '无法更新故事标题。', errorCode: 'STORY_TITLE_UPDATE_FAILED' });
      }
      return;
    }

    if (storyDocumentsMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      const authContext = authService.resolveToken(readAuthCookie(request.headers.cookie));
      if (!authContext) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED' }, request.method === 'HEAD');
        return;
      }
      let storyId: string;
      try { storyId = decodeURIComponent(storyDocumentsMatch[1]!); } catch {
        sendJson(response, 400, { error: '故事编号无效。', errorCode: 'INVALID_STORY_ID' }, request.method === 'HEAD');
        return;
      }
      try {
        const story = new StoryRepository(config.databasePath).findByIdForUser(authContext.userId, storyId);
        if (!story) {
          sendJson(response, 404, { error: '故事不存在。', errorCode: 'STORY_NOT_FOUND' }, request.method === 'HEAD');
          return;
        }
        const documents = new MemoirDocumentRepository(config.databasePath).listForStory(authContext.userId, storyId);
        sendJson(response, 200, { documents: documents.map((document) => ({
          document_id: document.documentId,
          version_number: document.versionNumber,
          title: document.title,
          created_at: document.createdAt,
        })) }, request.method === 'HEAD');
      } catch {
        sendJson(response, 503, { error: '无法读取成稿版本。', errorCode: 'DOCUMENT_LIST_FAILED' }, request.method === 'HEAD');
      }
      return;
    }

    if (storyDocumentMatch && !storyGenerationMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      const authContext = authService.resolveToken(readAuthCookie(request.headers.cookie));
      if (!authContext) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED' }, request.method === 'HEAD');
        return;
      }
      let storyId: string;
      let documentId: string;
      try {
        storyId = decodeURIComponent(storyDocumentMatch[1]!);
        documentId = decodeURIComponent(storyDocumentMatch[2]!);
      } catch {
        sendJson(response, 400, { error: '故事或成稿编号无效。', errorCode: 'INVALID_DOCUMENT_ID' }, request.method === 'HEAD');
        return;
      }
      try {
        const document = new MemoirDocumentRepository(config.databasePath)
          .findForStoryForUser(authContext.userId, storyId, documentId);
        if (!document) {
          sendJson(response, 404, { error: '成稿不存在。', errorCode: 'DOCUMENT_NOT_FOUND' }, request.method === 'HEAD');
          return;
        }
        sendJson(response, 200, { document: {
          document_id: document.documentId,
          story_id: storyId,
          title: document.title,
          content: document.content,
          version_number: document.versionNumber,
          created_at: document.createdAt,
        } }, request.method === 'HEAD');
      } catch {
        sendJson(response, 503, { error: '无法读取成稿。', errorCode: 'DOCUMENT_READ_FAILED' }, request.method === 'HEAD');
      }
      return;
    }

    if (storyGenerationMatch && storyDocumentMatch && request.method === 'POST') {
      const authContext = authService.resolveToken(readAuthCookie(request.headers.cookie));
      if (!authContext) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED', retryable: false });
        return;
      }
      let storyId: string;
      try { storyId = decodeURIComponent(storyDocumentMatch[1]!); } catch {
        sendJson(response, 400, { error: '故事编号无效。', errorCode: 'INVALID_STORY_ID', retryable: false });
        return;
      }
      let body: Record<string, unknown>;
      try { body = await readJsonObject(request); } catch (error) {
        const tooLarge = error instanceof Error && error.message === 'REQUEST_BODY_TOO_LARGE';
        sendJson(response, 400, {
          error: tooLarge ? '请求内容过大。' : '请求内容无效。',
          errorCode: tooLarge ? 'REQUEST_BODY_TOO_LARGE' : 'INVALID_JSON',
          retryable: false,
        });
        return;
      }
      try {
        const document = await storyGeneration.generate({
          ownerId: authContext.userId,
          storyId,
          style: body.style,
          ...(body.user_instruction !== undefined ? { userInstruction: body.user_instruction } : {}),
          ...(body.base_document_id !== undefined ? { baseDocumentId: body.base_document_id } : {}),
        });
        sendJson(response, 201, { document: {
          document_id: document.documentId,
          story_id: storyId,
          title: document.title,
          content: document.content,
          version_number: document.versionNumber,
        } });
      } catch (error) {
        if (error instanceof StoryGenerationError) {
          sendJson(response, error.httpStatus, {
            error: error.message,
            errorCode: error.code,
            retryable: false,
          });
          return;
        }
        if (error instanceof CloseoutModelError) {
          sendJson(response, error.code === 'MODEL_TIMEOUT' ? 504 : 502, {
            error: '成稿生成暂时失败，可以稍后手动重试。',
            errorCode: error.code,
            retryable: error.retryable,
          });
          return;
        }
        sendJson(response, 503, {
          error: '成稿生成暂时失败，可以稍后手动重试。',
          errorCode: 'GENERATION_FAILED',
          retryable: true,
        });
      }
      return;
    }

    if (url.pathname === '/api/life-stages') {
      const authContext = authService.resolveToken(readAuthCookie(request.headers.cookie));
      if (!authContext) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED' }, request.method === 'HEAD');
        return;
      }
      try {
        if (request.method === 'POST') {
          let body: Record<string, unknown>;
          try { body = await readJsonObject(request); } catch (error) {
            const errorCode = error instanceof Error && error.message === 'REQUEST_BODY_TOO_LARGE' ? 'REQUEST_BODY_TOO_LARGE' : 'INVALID_JSON';
            sendJson(response, 400, { error: errorCode === 'INVALID_JSON' ? '请求内容无效。' : '请求内容过大。', errorCode });
            return;
          }
          const input = parseLifeStageInput(body);
          if (!input) {
            sendJson(response, 400, { error: '请填写人生阶段名称，并检查年份格式。', errorCode: 'INVALID_LIFE_STAGE' });
            return;
          }
          const stage = new LifeStageRepository(config.databasePath).createV1ForUser(authContext.userId, input);
          sendJson(response, 201, { life_stage: {
            stage_id: stage.stageId,
            title: stage.title,
            start_year: stage.startYear,
            end_year: stage.endYear,
            sort_order: stage.sortOrder,
            status: stage.status,
            created_source_session_id: stage.createdSourceSessionId,
            created_at: stage.createdAt,
            updated_at: stage.updatedAt,
            story_count: 0,
          } });
        } else {
          sendJson(response, 200, { life_stages: loadLifeStages(config.databasePath, authContext.userId) }, request.method === 'HEAD');
        }
      } catch (error) {
        sendJson(response, 503, {
          error: error instanceof Error ? error.message : 'Database unavailable.',
        }, request.method === 'HEAD');
      }
      return;
    }

    if (lifeStageItemMatch && isLifeStageMutation) {
      const authContext = authService.resolveToken(readAuthCookie(request.headers.cookie));
      if (!authContext) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED' });
        return;
      }
      let stageId: string;
      try { stageId = decodeURIComponent(lifeStageItemMatch[1]!); } catch {
        sendJson(response, 400, { error: '人生阶段编号无效。', errorCode: 'INVALID_STAGE_ID' });
        return;
      }
      const repository = new LifeStageRepository(config.databasePath);
      if (request.method === 'PATCH') {
        let body: Record<string, unknown>;
        try { body = await readJsonObject(request); } catch (error) {
          const errorCode = error instanceof Error && error.message === 'REQUEST_BODY_TOO_LARGE' ? 'REQUEST_BODY_TOO_LARGE' : 'INVALID_JSON';
          sendJson(response, 400, { error: errorCode === 'INVALID_JSON' ? '请求内容无效。' : '请求内容过大。', errorCode });
          return;
        }
        const current = repository.listV1ForUser(authContext.userId).find((stage) => stage.stageId === stageId);
        if (!current) {
          sendJson(response, 404, { error: '人生阶段不存在。', errorCode: 'LIFE_STAGE_NOT_FOUND' });
          return;
        }
        const input = parseLifeStageInput({
          title: Object.hasOwn(body, 'title') ? body.title : current.title,
          start_year: Object.hasOwn(body, 'start_year') ? body.start_year : current.startYear,
          end_year: Object.hasOwn(body, 'end_year') ? body.end_year : current.endYear,
        });
        if (!input) {
          sendJson(response, 400, { error: '请填写人生阶段名称，并检查年份格式。', errorCode: 'INVALID_LIFE_STAGE' });
          return;
        }
        const stage = repository.updateV1ForUser(authContext.userId, stageId, input);
        if (!stage) {
          sendJson(response, 404, { error: '人生阶段不存在。', errorCode: 'LIFE_STAGE_NOT_FOUND' });
          return;
        }
        sendJson(response, 200, { life_stage: {
          stage_id: stage.stageId,
          title: stage.title,
          start_year: stage.startYear,
          end_year: stage.endYear,
          sort_order: stage.sortOrder,
          status: stage.status,
          created_source_session_id: stage.createdSourceSessionId,
          created_at: stage.createdAt,
          updated_at: stage.updatedAt,
          story_count: new StoryRepository(config.databasePath).listByStageForUser(authContext.userId, stageId).length,
        } });
      } else {
        const result = repository.deleteForUser(authContext.userId, stageId);
        if (result === 'not_found') {
          sendJson(response, 404, { error: '人生阶段不存在。', errorCode: 'LIFE_STAGE_NOT_FOUND' });
        } else if (result === 'has_stories') {
          sendJson(response, 409, {
            error: '这个人生阶段下还有故事。请先将这些故事移动到其他人生阶段，或者删除相关故事后，再删除这个人生阶段。',
            errorCode: 'STAGE_HAS_STORIES',
          });
        } else {
          sendJson(response, 200, { deleted: true });
        }
      }
      return;
    }

    if (storyStageMatch && isStoryStageMutation) {
      const authContext = authService.resolveToken(readAuthCookie(request.headers.cookie));
      if (!authContext) {
        sendJson(response, 401, { error: '请先登录。', errorCode: 'AUTH_REQUIRED' });
        return;
      }
      let storyId: string;
      try { storyId = decodeURIComponent(storyStageMatch[1]!); } catch {
        sendJson(response, 400, { error: '故事编号无效。', errorCode: 'INVALID_STORY_ID' });
        return;
      }
      let body: Record<string, unknown>;
      try { body = await readJsonObject(request); } catch (error) {
        const errorCode = error instanceof Error && error.message === 'REQUEST_BODY_TOO_LARGE' ? 'REQUEST_BODY_TOO_LARGE' : 'INVALID_JSON';
        sendJson(response, 400, { error: errorCode === 'INVALID_JSON' ? '请求内容无效。' : '请求内容过大。', errorCode });
        return;
      }
      const stageId = typeof body.stage_id === 'string' ? body.stage_id.trim() : '';
      if (!stageId) {
        sendJson(response, 400, { error: '请选择人生阶段。', errorCode: 'INVALID_STAGE_ID' });
        return;
      }
      const result = new StoryRepository(config.databasePath).moveToStageForUser(authContext.userId, storyId, stageId);
      if (result !== 'moved') {
        sendJson(response, 404, { error: '故事或人生阶段不存在。', errorCode: 'STORY_OR_STAGE_NOT_FOUND' });
      } else {
        sendJson(response, 200, { moved: true, story_id: storyId, stage_id: stageId });
      }
      return;
    }

    const asset = staticAssets[url.pathname];
    if (asset) {
      try {
        const contents = readFileSync(path.join(publicRoot, asset.file));
        response.writeHead(200, {
          'Content-Type': asset.contentType,
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(request.method === 'HEAD' ? undefined : contents);
      } catch {
        sendJson(response, 404, { error: 'Static asset not found.' });
      }
      return;
    }

    const localVadAsset = localVadAssets[url.pathname];
    if (localVadAsset && (request.method === 'GET' || request.method === 'HEAD')) {
      try {
        const contents = readFileSync(path.join(localVadRoot, localVadAsset.file));
        response.writeHead(200, {
          'Content-Type': localVadAsset.contentType,
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(request.method === 'HEAD' ? undefined : contents);
      } catch {
        sendJson(response, 404, { error: 'Local VAD asset not found.' });
      }
      return;
    }

    const storyDocumentPage = url.pathname.match(/^\/stories\/([^/]+)\/documents\/([^/]+)\/?$/);
    const storyDocumentsPage = url.pathname.match(/^\/stories\/([^/]+)\/documents\/?$/);
    const storyPage = url.pathname.match(/^\/stories\/([^/]+)\/?$/);
    const storyPageFile = storyDocumentPage ? 'document.html'
      : storyDocumentsPage ? 'documents.html'
        : storyPage ? 'story.html' : undefined;
    if (storyPageFile && (request.method === 'GET' || request.method === 'HEAD')) {
      try {
        const contents = readFileSync(path.join(publicRoot, storyPageFile));
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:",
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(request.method === 'HEAD' ? undefined : contents);
      } catch {
        sendJson(response, 404, { error: 'Story page not found.' }, request.method === 'HEAD');
      }
      return;
    }

    if (/^\/book(?:\/preview)?\/?$/.test(url.pathname) && (request.method === 'GET' || request.method === 'HEAD')) {
      try {
        const contents = readFileSync(path.join(publicRoot, 'book.html'));
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:",
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(request.method === 'HEAD' ? undefined : contents);
      } catch {
        sendJson(response, 404, { error: 'Book page not found.' }, request.method === 'HEAD');
      }
      return;
    }

    const onboardingPage = onboardingPages[url.pathname];
    if (onboardingPage) {
      try {
        const contents = readFileSync(path.join(publicRoot, onboardingPage.file));
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': onboardingPage.microphone
            ? "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' ws: wss:; media-src 'self' blob:"
            : "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:",
          ...(onboardingPage.microphone ? { 'Permissions-Policy': 'microphone=(self)' } : {}),
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(request.method === 'HEAD' ? undefined : contents);
      } catch {
        sendJson(response, 404, { error: 'Onboarding page not found.' });
      }
      return;
    }

    if (/^\/share\/story\/[^/]+\/?$/.test(url.pathname) && (request.method === 'GET' || request.method === 'HEAD')) {
      try {
        const contents = readFileSync(path.join(publicRoot, 'share.html'));
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:",
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(request.method === 'HEAD' ? undefined : contents);
      } catch {
        sendJson(response, 404, { error: 'Story share page not found.' }, request.method === 'HEAD');
      }
      return;
    }

    if (url.pathname === '/interview/result' || url.pathname === '/interview/result/') {
      try {
        const contents = readFileSync(path.join(publicRoot, 'result.html'));
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:",
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(request.method === 'HEAD' ? undefined : contents);
      } catch {
        sendJson(response, 404, { error: 'Interview result page not found.' });
      }
      return;
    }

    if (url.pathname === '/' || url.pathname === '/my-life' || url.pathname === '/my-life/') {
      try {
        const contents = readFileSync(path.join(publicRoot, 'life.html'));
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:",
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(request.method === 'HEAD' ? undefined : contents);
      } catch {
        sendJson(response, 404, { error: 'Life timeline page not found.' });
      }
      return;
    }

    if (url.pathname === '/interview' || url.pathname === '/interview/') {
      try {
        const contents = readFileSync(path.join(publicRoot, 'index.html'));
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' ws: wss:; media-src 'self' blob:",
          'Permissions-Policy': 'microphone=(self)',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(request.method === 'HEAD' ? undefined : contents);
      } catch {
        sendJson(response, 404, { error: 'Interview page not found.' });
      }
      return;
    }

    sendJson(response, 404, { error: 'Not found.' });
  };
}

function asBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}


function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type TimedOutcome<T> =
  | { status: 'completed'; value: T }
  | { status: 'failed'; error: unknown }
  | { status: 'timeout' };

function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<TimedOutcome<T>> {
  let timeout: NodeJS.Timeout | undefined;
  const settled = promise.then(
    (value): TimedOutcome<T> => ({ status: 'completed', value }),
    (error: unknown): TimedOutcome<T> => ({ status: 'failed', error }),
  );
  const deadline = new Promise<TimedOutcome<T>>((resolve) => {
    timeout = setTimeout(() => resolve({ status: 'timeout' }), Math.max(0, timeoutMs));
  });
  return Promise.race([settled, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function coachErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)) return code;
  return error instanceof Error && /^[A-Z][A-Za-z0-9]{0,63}$/u.test(error.name)
    ? error.name.toUpperCase()
    : 'REALTIME_COACH_FAILED';
}

function latestAssistantQuestion(text: string): string | null {
  return text.match(/[^。！？!?\n]*[？?]/gu)?.at(-1)?.trim() || null;
}

function createRealtimeHandler(
  config: RuntimeConfig,
  client: WebSocket,
  authContext: { userId: string },
  dependencies: InterviewServiceDependencies,
  observationBus: ObservationBus,
  access: { externalShareId?: string } = {},
): void {
  const interviewCore = createInterviewRuntimeCore(config.databasePath);
  const isExternalContributor = Boolean(access.externalShareId);
  let phase: 'idle' | 'connecting' | 'active' | 'ending' | 'ended' | 'failed' = 'idle';
  let provider: WebSocket | undefined;
  let selectedProvider: RealtimeInterviewProvider | undefined;
  let selectedAdapter: RealtimeVoiceProvider | undefined;
  let providerSessionInitSent = false;
  let interviewSession: RealtimeInterviewSession | undefined;
  let pendingProviderSessionId: string | undefined;
  let pendingTurnDetectionMode: 'manual' | 'server_vad' | 'unknown' | undefined;
  let providerSessionReadyAt: number | undefined;
  let sessionContext: RealtimeInterviewContext | undefined;
  let startupResolve: (() => void) | undefined;
  let startupReject: ((error: Error) => void) | undefined;
  let startupTimeout: NodeJS.Timeout | undefined;
  let openingResponseTimer: NodeJS.Timeout | undefined;
  let userTurnStallTimer: NodeJS.Timeout | undefined;
  let userTurnRecoveryAttempted = false;
  let openingRequest: Record<string, unknown> | undefined;
  let openingPreludeSent = false;
  let clientPlaybackReady = false;
  let clientPlaybackReadyAt: number | undefined;
  let playbackReadyTracePending = false;
  let openingAttemptCount = 0;
  let endingPromise: Promise<void> | undefined;
  let sessionClosedResolver: ((received: boolean) => void) | undefined;
  let pendingSpeech = false;
  let manualTurnCommitPending = false;
  let manualTurnCommitSent = false;
  let manualInputReadyForTurn = true;
  let awaitingUserTranscript = false;
  let awaitingAssistant = false;
  let manualEndRequested = false;
  let lastProviderActivityAt = Date.now();
  let traceWriter: RealtimeTraceWriter | undefined;
  let observationContext: ObservationContext | undefined;
  let observationProvider = 'unknown';
  let microphoneTraceWindowAt = performance.now();
  let microphoneTraceFrames = 0;
  let microphoneTraceBytes = 0;
  let microphoneTracePower = 0;
  let microphoneTraceSamples = 0;
  let microphoneTraceMaxRms = 0;
  let microphonePacketCount = 0;
  let lastMicrophonePacketAt: number | undefined;
  let userTranscriptDeltaCount = 0;
  let transcriptWriteTail = Promise.resolve();
  const transcriptRepository = new TranscriptRepository(config.databasePath);
  const interviewSessionRepository = new InterviewSessionRepository(config.databasePath);
  let pendingWriteCount = 0;
  let savedTranscriptCount = 0;
  let lastAssistantText = '';
  let userConfirmedEnding = false;
  let userFarewellResponseId: string | undefined;
  let assistantEndedInterview = false;
  let hardLimitReached = false;
  let acceptingAudio = true;
  let wrapUpTimer: NodeJS.Timeout | undefined;
  let hardLimitTimer: NodeJS.Timeout | undefined;
  let closeGraceTimer: NodeJS.Timeout | undefined;
  let autoEndFallbackTimer: NodeJS.Timeout | undefined;
  let wrapUpPromptPending = false;
  let pendingOnboardingCompletionRequest: Extract<NormalizedRealtimeEvent, { type: 'onboarding.completion.requested' }> | undefined;
  let awaitingOnboardingCompletionClose = false;
  let onboardingCompletionCloseResponseId: string | undefined;
  let onboardingCloseResponseRetries = 0;
  let modelCompletionReady = false;
  const transcriptWriteErrors: string[] = [];
  const seenProviderMessages = new Set<string>();
  const activeResponses = new Set<string>();
  const manualToolCallResponseIds = new Set<string>();
  const assistantResponses = new Map<string, AssistantResponse>();
  const providerAudioTrace = new Map<string, ProviderAudioTrace>();
  const slowCoordinator = new RealtimeSlowCoordinator(
    dependencies.realtimeRecall ?? new UnavailableRealtimeRecall(),
    config.realtimeSlowDeadlineMs ?? DEFAULT_REALTIME_SLOW_DEADLINE_MS,
  );
  let currentTurnId: string | undefined;
  let contextVersion = 0;
  let pendingNextTurnContext: {
    hint: RealtimeContextHint;
    messages: Record<string, unknown>[];
    sessionId: string;
    storyId: string;
    turnId: string;
    contextVersion: number;
    createdAt: number;
    expiresAt: number;
  } | undefined;

  const send = (message: Record<string, unknown>): boolean => {
    if (client.readyState !== WebSocket.OPEN) return false;
    client.send(JSON.stringify(message));
    return true;
  };

  const competitionTechPanelEnabled = process.env.COMPETITION_TECH_PANEL?.trim() === '1';
  const sendTechStatus = (input: {
    stage: 'fast_voice' | 'tool_trigger' | 'retrieval' | 'slow_agent' | 'context_hint' | 'resume' | 'first_audio';
    status: 'started' | 'completed' | 'failed' | 'skipped' | 'ready';
    latencyMs?: number;
    count?: number;
    model?: string;
    skill?: string;
    errorCode?: string;
  }): void => {
    if (!competitionTechPanelEnabled) return;
    send({
      type: 'tech_status',
      stage: input.stage,
      status: input.status,
      ...(Number.isFinite(input.latencyMs) ? { latencyMs: input.latencyMs } : {}),
      ...(Number.isFinite(input.count) ? { count: input.count } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.skill ? { skill: input.skill } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    });
  };

  const sendProviderMessage = (message: Record<string, unknown>): boolean => {
    if (!provider || provider.readyState !== WebSocket.OPEN) return false;
    try {
      provider.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  };

  const sendProviderMessages = (messages: Record<string, unknown>[]): boolean => {
    if (!provider || provider.readyState !== WebSocket.OPEN) return false;
    for (const message of messages) {
      if (!sendProviderMessage(message)) return false;
    }
    return true;
  };

  const executeProviderSteps = async (
    steps: Array<{ message: Record<string, unknown>; delayAfterMs?: number }>,
  ): Promise<boolean> => {
    if (!provider || provider.readyState !== WebSocket.OPEN) return false;
    for (const step of steps) {
      if (!sendProviderMessage(step.message)) return false;
      if (step.delayAfterMs && step.delayAfterMs > 0) await delay(step.delayAfterMs);
    }
    return true;
  };

  const providerConnectionFailureMessage = (
    failure: Parameters<RealtimeVoiceProvider['connectionFailureMessage']>[0],
  ): string => selectedAdapter
    ? selectedAdapter.connectionFailureMessage(failure)
    : 'Realtime Provider 尚未初始化。';

  const clearOpeningResponseWatchdog = (): void => {
    if (openingResponseTimer) clearTimeout(openingResponseTimer);
    openingResponseTimer = undefined;
    openingRequest = undefined;
  };

  const clearUserTurnStallWatchdog = (): void => {
    if (userTurnStallTimer) clearTimeout(userTurnStallTimer);
    userTurnStallTimer = undefined;
  };

  const clearSessionTimers = (): void => {
    clearOpeningResponseWatchdog();
    clearUserTurnStallWatchdog();
    if (wrapUpTimer) clearTimeout(wrapUpTimer);
    if (hardLimitTimer) clearTimeout(hardLimitTimer);
    if (closeGraceTimer) clearTimeout(closeGraceTimer);
    if (autoEndFallbackTimer) clearTimeout(autoEndFallbackTimer);
    wrapUpTimer = undefined;
    hardLimitTimer = undefined;
    closeGraceTimer = undefined;
    autoEndFallbackTimer = undefined;
  };

  const requestProviderWrapUp = (final: boolean): boolean => {
    if (!provider || provider.readyState !== WebSocket.OPEN || phase !== 'active') return false;
    const instruction = final
      ? `系统时间上限已经到达。请只说固定结束语：“${STORY_INTERVIEW_COMPLETION_UTTERANCE}”，不要添加其他文字或问题。`
      : `系统提示：采访即将进入最后两分钟。请优先补问一个最有价值的缺失细节。若随后判断本轮已经没有明显值得继续追问的关键点，请只说固定结束语：“${STORY_INTERVIEW_COMPLETION_UTTERANCE}”；否则继续自然采访，不要声称内容已经完整。`;
    const requests = selectedAdapter?.requestAssistantTurnMessages(instruction) ?? [];
    if (requests.length === 0 || !sendProviderMessages(requests)) return false;
    traceWriter?.recordContent(final ? 'session.farewell_instructions' : 'session.wrapup_instructions', instruction);
    recordTrace(final ? 'session.timeout_farewell_requested' : 'session.wrapup_prompt_requested');
    return true;
  };

  const recordTrace = (event: string, fields: RealtimeTraceFields = {}): void => {
    traceWriter?.record(event, fields);
    if (!interviewSession || observationBus === undefined || !observationBus.enabled) return;
    try {
      observationContext ??= createObservationContext({
        sessionId: interviewSession.sessionId,
        rootSpanId: `session:${interviewSession.sessionId}`,
        ...(sessionContext && 'story' in sessionContext && sessionContext.story && typeof sessionContext.story.story_id === 'string'
          ? { storyId: sessionContext.story.story_id }
          : {}),
      });
      const observation = adaptRealtimeTrace({
        context: observationContext,
        sessionId: interviewSession.sessionId,
        ...(observationContext.storyId ? { storyId: observationContext.storyId } : {}),
        provider: observationProvider,
        environment: process.env.NODE_ENV === 'production' ? 'Production' : 'Development',
        event,
        fields,
      });
      if (observation) emitObservationEvent(observation, observationBus);
    } catch { /* Realtime observation is an optional side channel. */ }
  };
  const traceStageTracker = createRealtimeTraceStageTracker();
  const toolCycleTracker = createRealtimeToolCycleTracker({ record: recordTrace });
  const miniProfileSelected = (): boolean => selectedProvider === 'stepaudio2_mini' || selectedProvider === 'stepfun';
  const supervisorAutoSelected = (): boolean => miniProfileSelected()
    && sessionContext?.memoryTriggerMode === 'supervisor_auto';
  let activeCoachController: AbortController | undefined;
  const recentCoachContext: CoachConversationMessage[] = [];
  let latestUserAnswer = '';

  const sendMiniResponse = (input: {
    turnId: string;
    version: number;
    packet?: string;
    traceFields: RealtimeTraceFields;
  }): boolean => {
    if (!sessionContext || !selectedAdapter?.requestAssistantTurnMessages
      || phase !== 'active' || currentTurnId !== input.turnId || contextVersion !== input.version) return false;
    const instructions = buildStepAudio2MiniInstructions(sessionContext, {
      memoryTriggerMode: 'supervisor_auto',
      omitOpeningGap: true,
      ...(input.packet ? { coachPacket: input.packet } : {}),
    });
    const messages = selectedAdapter.requestAssistantTurnMessages(instructions);
    const sent = messages.length > 0 && sendProviderMessages(messages);
    recordTrace('coach.response_requested', {
      ...input.traceFields,
      turnId: input.turnId,
      sent,
      chars: Array.from(instructions).length,
      packetChars: input.packet ? Array.from(input.packet).length : 0,
    });
    if (sent) {
      traceWriter?.recordContent('coach.response_instructions', instructions);
      if (input.packet) traceWriter?.recordContent('coach.mini_packet', input.packet);
    }
    if (sent && input.packet) {
      recordTrace('coach.applied', {
        ...input.traceFields,
        turnId: input.turnId,
        packetChars: Array.from(input.packet).length,
      });
    } else if (!sent) {
      recordTrace('coach.skipped', { ...input.traceFields, reason: 'response_request_failed' });
    }
    return sent;
  };

  const runSupervisorCoach = (text: string, turnId: string, version: number): void => {
    const context = sessionContext;
    if (!supervisorAutoSelected() || !context) return;
    activeCoachController?.abort('superseded');
    const controller = new AbortController();
    activeCoachController = controller;
    const startedAt = performance.now();
    const totalBudgetMs = Math.min(config.realtimeCoachTotalTimeoutMs ?? DEFAULT_REALTIME_SLOW_DEADLINE_MS, DEFAULT_REALTIME_SLOW_DEADLINE_MS);
    const totalDeadlineAt = startedAt + totalBudgetMs;
    const baseGate = buildRealtimeCoachGateInput(context, {
      lastAssistantQuestion: latestAssistantQuestion(lastAssistantText),
      currentUserAnswer: text,
      recentContext: recentCoachContext,
    });
    const traceFields: RealtimeTraceFields = {
      scenario: baseGate.scenario,
      voiceProfile: 'stepaudio2_mini',
      triggerMode: 'supervisor_auto',
      coachModel: config.realtimeCoachModel ?? 'qwen3-8b',
      turnId,
      contextVersion: version,
    };
    const isCurrent = (): boolean => phase === 'active'
      && currentTurnId === turnId
      && contextVersion === version
      && !controller.signal.aborted;
    const failOpen = (reason: string, fields: RealtimeTraceFields = {}): void => {
      if (!isCurrent()) return;
      recordTrace('coach.skipped', { ...traceFields, ...fields, reason });
      sendMiniResponse({ turnId, version, traceFields: { ...traceFields, ...fields } });
    };

    if (!dependencies.realtimeCoach) {
      failOpen('coach_not_configured');
      return;
    }

    const gateStartedAt = performance.now();
    recordTrace('coach.gate.started', traceFields);
    traceWriter?.recordContent('coach.gate.input', { turnId, input: baseGate });
    if (process.env.DIAGNOSTICS_CAPTURE_CONTENT === '1') {
      traceWriter?.recordContent('coach.gate.prompt', { turnId, ...buildCoachGatePrompt(baseGate) });
    }
    const gateRemaining = Math.max(0, Math.min(
      config.realtimeCoachGateTimeoutMs ?? 1_200,
      totalDeadlineAt - performance.now(),
    ));
    void settleWithin(
      Promise.resolve().then(() => dependencies.realtimeCoach!.evaluate(baseGate, { signal: controller.signal })),
      gateRemaining,
    ).then(async (gateOutcome) => {
      const gateMs = Number((performance.now() - gateStartedAt).toFixed(2));
      if (!isCurrent()) return;
      if (gateOutcome.status === 'timeout') {
        controller.abort('gate-timeout');
        recordTrace('coach.gate.timeout', { ...traceFields, gate_ms: gateMs, total_ms: gateMs });
        if (phase === 'active' && currentTurnId === turnId && contextVersion === version) {
          sendMiniResponse({ turnId, version, traceFields: { ...traceFields, gate_ms: gateMs, total_ms: gateMs } });
        }
        return;
      }
      if (gateOutcome.status === 'failed') {
        controller.abort('gate-failed');
        recordTrace('coach.gate.failed', {
          ...traceFields, gate_ms: gateMs, total_ms: gateMs,
          errorCode: coachErrorCode(gateOutcome.error),
        });
        if (phase === 'active' && currentTurnId === turnId && contextVersion === version) {
          sendMiniResponse({ turnId, version, traceFields: { ...traceFields, gate_ms: gateMs, total_ms: gateMs } });
        }
        return;
      }

      const gate = gateOutcome.value;
      traceWriter?.recordContent('coach.gate.output', { turnId, output: gate });
      recordTrace('coach.gate.completed', {
        ...traceFields, turnId, contextVersion: version,
        action: gate.action,
        retrieve_memory: gate.retrieve_memory,
        retrieve_era: gate.retrieve_era,
        reason: gate.reason,
        queryChars: gate.era_query ? Array.from(gate.era_query).length : gate.memory_query ? Array.from(gate.memory_query).length : 0,
        gate_ms: gateMs, total_ms: gateMs,
      });
      if (gate.action === 'none') {
        recordTrace('coach.skipped', {
          ...traceFields, turnId, contextVersion: version,
          action: gate.action, retrieve_memory: false, retrieve_era: false,
          memoryEvidenceCount: 0, eraEvidenceCount: 0,
          gate_ms: gateMs, total_ms: gateMs, reason: 'normal',
        });
        sendMiniResponse({
          turnId, version,
          traceFields: {
            ...traceFields, turnId, contextVersion: version,
            action: gate.action, retrieve_memory: false, retrieve_era: false,
            memoryEvidenceCount: 0, eraEvidenceCount: 0,
            gate_ms: gateMs, total_ms: gateMs,
          },
        });
        return;
      }

      if (!gate.retrieve_memory && !gate.retrieve_era) {
        const packet = renderMiniCoachPacket({
          scenario: baseGate.scenario,
          currentUserAnswer: text,
          gate,
          scenarioState: baseGate.scenarioState,
        });
        sendMiniResponse({
          turnId, version, packet,
          traceFields: {
            ...traceFields, turnId, contextVersion: version,
            action: gate.action, retrieve_memory: false, retrieve_era: false,
            memoryEvidenceCount: 0, eraEvidenceCount: 0,
            gate_ms: gateMs, total_ms: Number((performance.now() - startedAt).toFixed(2)),
          },
        });
        return;
      }

      const storyId = context.interview_type === 'story'
        && context.task_context?.mode === 'continue'
        && typeof context.story?.story_id === 'string'
        ? context.story.story_id.trim()
        : '';
      const sessionId = interviewSession?.sessionId;
      if (!dependencies.realtimeCoachPipeline) {
        failOpen('coach_pipeline_not_configured', {
          turnId, contextVersion: version,
          action: gate.action, retrieve_memory: gate.retrieve_memory, retrieve_era: gate.retrieve_era,
          memoryEvidenceCount: 0, eraEvidenceCount: 0, gate_ms: gateMs,
        });
        return;
      }
      if (baseGate.scenario !== 'story_continue' || !storyId || !sessionId
        || (gate.retrieve_memory && !gate.memory_query)) {
        failOpen('retrieval_scope_unavailable', {
          turnId, contextVersion: version,
          action: gate.action, retrieve_memory: gate.retrieve_memory, retrieve_era: gate.retrieve_era,
          memoryEvidenceCount: 0, eraEvidenceCount: 0, gate_ms: gateMs,
        });
        return;
      }

      const stageStatuses: Record<'retrieval' | 'era_retrieval' | 'resolve', 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'skipped'> = {
        retrieval: gate.retrieve_memory ? 'pending' : 'skipped',
        era_retrieval: gate.retrieve_era ? 'pending' : 'skipped',
        resolve: 'pending',
      };
      let pipelineExpired = false;
      const stageBaseFields = () => ({
        ...traceFields, turnId, contextVersion: version,
        action: gate.action, retrieve_memory: gate.retrieve_memory, retrieve_era: gate.retrieve_era,
        gate_ms: gateMs,
      });
      const recordPipelineTimeout = (totalMs: number) => {
        if (pipelineExpired) return;
        pipelineExpired = true;
        for (const stage of ['retrieval', 'era_retrieval', 'resolve'] as const) {
          if (['completed', 'failed', 'timeout', 'skipped'].includes(stageStatuses[stage])) continue;
          stageStatuses[stage] = 'timeout';
          recordTrace(`coach.${stage}.timeout`, {
            ...stageBaseFields(), total_ms: totalMs, errorCode: 'COACH_TOTAL_TIMEOUT',
          });
        }
        recordTrace('coach.pipeline.timeout', {
          ...stageBaseFields(), total_ms: totalMs, errorCode: 'COACH_TOTAL_TIMEOUT',
        });
      };
      const pipelinePromise = dependencies.realtimeCoachPipeline.retrieveAndResolve({
        scenario: baseGate.scenario,
        currentUserAnswer: text,
        gate,
        request: {
          ownerId: authContext.userId,
          sessionId,
          storyId,
          turnId,
          contextVersion: version,
          query: gate.memory_query ?? '',
          traceContext: { traceId: sessionId, sessionId, storyId, parentSpanId: `coach:${turnId}` },
        },
        signal: controller.signal,
        onResolveInput: (input) => {
          traceWriter?.recordContent('coach.resolve.input', { turnId, input });
          if (process.env.DIAGNOSTICS_CAPTURE_CONTENT === '1') {
            traceWriter?.recordContent('coach.resolve.prompt', { turnId, ...buildCoachResolvePrompt(input) });
          }
        },
        onResolveOutput: (output) => traceWriter?.recordContent('coach.resolve.output', { turnId, output }),
        onProgress: (progress) => {
          if (!isCurrent() || pipelineExpired) return;
          stageStatuses[progress.stage] = progress.status === 'started'
            ? 'running'
            : progress.status === 'completed' ? 'completed'
              : progress.status === 'failed' ? 'failed'
                : progress.status === 'timeout' ? 'timeout' : 'skipped';
          const durationField = progress.stage === 'retrieval' ? 'memory_retrieval_ms'
            : progress.stage === 'era_retrieval' ? 'era_retrieval_ms' : 'resolve_ms';
          recordTrace(`coach.${progress.stage}.${progress.status}`, {
            ...stageBaseFields(),
            turnId: progress.turnId ?? turnId,
            contextVersion: progress.contextVersion ?? version,
            ...(progress.latencyMs === undefined ? {} : { [durationField]: Number(progress.latencyMs.toFixed(2)) }),
            ...(progress.queryChars === undefined ? {} : { queryChars: progress.queryChars }),
            ...(progress.startYear === undefined ? {} : { startYear: progress.startYear }),
            ...(progress.endYear === undefined ? {} : { endYear: progress.endYear }),
            ...(progress.candidateCount === undefined ? {} : { candidateCount: progress.candidateCount }),
            ...(progress.evidenceCount === undefined ? {} : { evidenceCount: progress.evidenceCount }),
            ...(progress.memoryEvidenceCount === undefined ? {} : { memoryEvidenceCount: progress.memoryEvidenceCount }),
            ...(progress.eraEvidenceCount === undefined ? {} : { eraEvidenceCount: progress.eraEvidenceCount }),
            ...(progress.errorCode ? { errorCode: progress.errorCode } : {}),
            ...(progress.skipReason ? { skipReason: progress.skipReason } : {}),
          });
        },
      });
      const remaining = Math.max(0, totalDeadlineAt - performance.now());
      const pipelineOutcome = await settleWithin(pipelinePromise, remaining);
      const totalMs = Number((performance.now() - startedAt).toFixed(2));
      if (pipelineOutcome.status === 'timeout') {
        recordPipelineTimeout(totalMs);
        controller.abort('coach-total-timeout');
        if (phase === 'active' && currentTurnId === turnId && contextVersion === version) {
          sendMiniResponse({ turnId, version, traceFields: {
            ...traceFields, turnId, contextVersion: version,
            action: gate.action, retrieve_memory: gate.retrieve_memory, retrieve_era: gate.retrieve_era,
            memoryEvidenceCount: 0, eraEvidenceCount: 0, gate_ms: gateMs, total_ms: totalMs,
          } });
        }
        return;
      }
      if (pipelineOutcome.status === 'failed') {
        pipelineExpired = true;
        controller.abort('coach-pipeline-failed');
        const failedStage = (['resolve', 'retrieval', 'era_retrieval'] as const)
          .find((stage) => stageStatuses[stage] === 'running');
        recordTrace(failedStage ? `coach.${failedStage}.failed` : 'coach.pipeline.failed', {
          ...stageBaseFields(), total_ms: totalMs,
          errorCode: coachErrorCode(pipelineOutcome.error),
        });
        if (phase === 'active' && currentTurnId === turnId && contextVersion === version) {
          sendMiniResponse({ turnId, version, traceFields: {
            ...traceFields, turnId, contextVersion: version,
            action: gate.action, retrieve_memory: gate.retrieve_memory, retrieve_era: gate.retrieve_era,
            memoryEvidenceCount: 0, eraEvidenceCount: 0, gate_ms: gateMs, total_ms: totalMs,
          } });
        }
        return;
      }
      if (!isCurrent()) return;
      if (performance.now() > totalDeadlineAt) {
        recordPipelineTimeout(totalMs);
        controller.abort('coach-total-timeout');
        return;
      }
      const result = pipelineOutcome.value;
      const packet = renderMiniCoachPacket({
        scenario: baseGate.scenario,
        currentUserAnswer: text,
        gate,
        packet: result.packet,
        scenarioState: baseGate.scenarioState,
      });
      sendMiniResponse({
        turnId,
        version,
        packet,
        traceFields: {
          ...traceFields,
          turnId,
          contextVersion: version,
          action: gate.action,
          retrieve_memory: gate.retrieve_memory,
          retrieve_era: gate.retrieve_era,
          memoryEvidenceCount: result.memoryEvidenceCount,
          eraEvidenceCount: result.eraEvidenceCount,
          gate_ms: gateMs,
          ...(result.memoryRetrievalMs === null ? {} : { memory_retrieval_ms: Number(result.memoryRetrievalMs.toFixed(2)) }),
          ...(result.eraRetrievalMs === null ? {} : { era_retrieval_ms: Number(result.eraRetrievalMs.toFixed(2)) }),
          resolve_ms: Number(result.resolveMs.toFixed(2)),
          total_ms: Number((performance.now() - startedAt).toFixed(2)),
        },
      });
    }).catch(() => {
      if (isCurrent()) failOpen('coach_pipeline_failed');
    });
  };

  const pendingContextForCurrentTurn = () => {
    const pending = pendingNextTurnContext;
    if (!pending) return undefined;
    if (performance.now() >= pending.expiresAt) {
      pendingNextTurnContext = undefined;
      recordTrace('slow.result.stale_dropped', {
        turnId: pending.turnId,
        contextVersion: pending.contextVersion,
        reason: 'pending_context_expired',
      });
      return undefined;
    }
    const storyId = sessionContext?.interview_type === 'story'
      && typeof sessionContext.story?.story_id === 'string'
      ? sessionContext.story.story_id.trim()
      : '';
    if (pending.sessionId === interviewSession?.sessionId
      && pending.storyId === storyId
      && pending.turnId === currentTurnId
      && pending.contextVersion === contextVersion) return pending;
    pendingNextTurnContext = undefined;
    recordTrace('slow.result.stale_dropped', {
      turnId: pending.turnId,
      contextVersion: pending.contextVersion,
      reason: 'pending_context_scope_or_turn_changed',
    });
    return undefined;
  };

  const consumePendingNextTurnContext = (): void => {
    if (activeResponses.size > 0 || !provider || provider.readyState !== WebSocket.OPEN) return;
    const pending = pendingContextForCurrentTurn();
    if (!pending) return;
    let sent = true;
    try {
      if (!selectedAdapter?.capabilities.supportsContextInjection || !selectedAdapter.injectContextHint) {
        sent = false;
      } else {
        for (const message of pending.messages) {
          if (provider.readyState !== WebSocket.OPEN) { sent = false; break; }
          provider.send(JSON.stringify(message));
        }
      }
    } catch {
      sent = false;
    }
    pendingNextTurnContext = undefined;
    recordTrace(sent ? 'realtime.context_hint.consumed' : 'realtime.context_hint.injection_failed', {
      turnId: pending.turnId,
      contextVersion: pending.contextVersion,
      factCount: pending.hint.facts.length,
      possibleConflictCount: pending.hint.possibleConflicts.length,
      interviewHintCount: pending.hint.interviewHints.length,
      sent,
    });
  };

  const writeToolResultMessages = (
    callId: string,
    messages: Record<string, unknown>[],
  ): { sent: boolean; outputWritten: boolean; resumeWritten: boolean; resumeExpected: boolean } => {
    let sent = true;
    let outputWritten = false;
    let resumeWritten = false;
    const resumeExpected = messages.some((message) => message.type === 'response.create');
    let serialized: string[];
    try {
      serialized = messages.map((message) => JSON.stringify(message));
    } catch {
      serialized = [];
      sent = false;
    }
    for (const [messageIndex, message] of messages.entries()) {
      if (!sent) {
        toolCycleTracker.recordMessageWrite(callId, {
          kind: message.type === 'response.create' ? 'resume' : 'output',
          messageIndex,
          sent: false,
        });
        break;
      }
      const messageKind = message.type === 'response.create' ? 'resume' : 'output';
      if (!provider || provider.readyState !== WebSocket.OPEN) {
        toolCycleTracker.recordMessageWrite(callId, { kind: messageKind, messageIndex, sent: false });
        sent = false;
        break;
      }
      try {
        if (!sendProviderMessage(message)) throw new Error('Provider message could not be sent.');
        toolCycleTracker.recordMessageWrite(callId, { kind: messageKind, messageIndex, sent: true });
        if (messageKind === 'output') outputWritten = true;
        if (messageKind === 'resume') resumeWritten = true;
      } catch {
        toolCycleTracker.recordMessageWrite(callId, { kind: messageKind, messageIndex, sent: false });
        sent = false;
        break;
      }
    }
    return { sent: sent && (outputWritten || resumeWritten), outputWritten, resumeWritten, resumeExpected };
  };

  const waitForResponseIdle = async (
    responseId: string,
    deadlineAt: number,
    stillCurrent: () => boolean,
  ): Promise<boolean> => {
    while (activeResponses.has(responseId) && performance.now() < deadlineAt && stillCurrent()) await delay(25);
    return !activeResponses.has(responseId);
  };

  const runMiniVoiceToolResolve = async (
    query: string,
    turnId: string,
    version: number,
    deadlineAt: number,
  ): Promise<{
    status: 'completed' | 'timeout' | 'failed';
    packet?: string;
    latencyMs: number;
    memoryEvidenceCount?: number;
    eraEvidenceCount?: number;
  }> => {
    const startedAt = performance.now();
    const traceFields: RealtimeTraceFields = {
      scenario: 'story_continue',
      voiceProfile: 'stepaudio2_mini',
      triggerMode: 'voice_tool',
      coachModel: config.realtimeCoachModel ?? 'qwen3-8b',
      turnId,
      contextVersion: version,
    };
    if (!dependencies.realtimeCoachPipeline || sessionContext?.interview_type !== 'story'
      || sessionContext.task_context?.mode !== 'continue' || !interviewSession) {
      recordTrace('coach.skipped', { ...traceFields, reason: 'retriever_or_resolve_not_configured' });
      return { status: 'failed', latencyMs: performance.now() - startedAt };
    }
    const storyId = typeof sessionContext.story?.story_id === 'string' ? sessionContext.story.story_id.trim() : '';
    const boundedQuery = query.trim();
    if (!storyId || !boundedQuery) return { status: 'failed', latencyMs: performance.now() - startedAt };
    const controller = new AbortController();
    const gate: CoachGateResult = {
      action: 'guide', retrieve_memory: true, memory_query: boundedQuery,
      retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
      reason: 'history_reference',
      avoid: null, direction: '使用相关历史，避免重复提问后继续当前故事。',
    };
    const stageStatuses: Record<'retrieval' | 'era_retrieval' | 'resolve', 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'skipped'> = {
      retrieval: 'pending', era_retrieval: 'skipped', resolve: 'pending',
    };
    let pipelineExpired = false;
    const stageBaseFields = () => ({
      ...traceFields, action: gate.action,
      retrieve_memory: gate.retrieve_memory, retrieve_era: gate.retrieve_era,
    });
    const recordPipelineTimeout = (latencyMs: number) => {
      if (pipelineExpired) return;
      pipelineExpired = true;
      for (const stage of ['retrieval', 'era_retrieval', 'resolve'] as const) {
        if (['completed', 'failed', 'timeout', 'skipped'].includes(stageStatuses[stage])) continue;
        stageStatuses[stage] = 'timeout';
        recordTrace(`coach.${stage}.timeout`, {
          ...stageBaseFields(), total_ms: latencyMs, errorCode: 'COACH_TOTAL_TIMEOUT',
        });
      }
      recordTrace('coach.pipeline.timeout', {
        ...stageBaseFields(), total_ms: latencyMs, errorCode: 'COACH_TOTAL_TIMEOUT',
      });
    };
    const promise = dependencies.realtimeCoachPipeline.retrieveAndResolve({
      scenario: 'story_continue',
      currentUserAnswer: latestUserAnswer,
      gate,
      request: {
        ownerId: authContext.userId,
        sessionId: interviewSession.sessionId,
        storyId,
        turnId,
        contextVersion: version,
        query: boundedQuery,
        traceContext: { traceId: interviewSession.sessionId, sessionId: interviewSession.sessionId, storyId, parentSpanId: `tool-coach:${turnId}` },
      },
      signal: controller.signal,
      onResolveInput: (input) => {
        traceWriter?.recordContent('coach.resolve.input', { turnId, input });
        if (process.env.DIAGNOSTICS_CAPTURE_CONTENT === '1') {
          traceWriter?.recordContent('coach.resolve.prompt', { turnId, ...buildCoachResolvePrompt(input) });
        }
      },
      onResolveOutput: (output) => traceWriter?.recordContent('coach.resolve.output', { turnId, output }),
      onProgress: (progress) => {
        if (pipelineExpired) return;
        stageStatuses[progress.stage] = progress.status === 'started'
          ? 'running'
          : progress.status === 'completed' ? 'completed'
            : progress.status === 'failed' ? 'failed'
              : progress.status === 'timeout' ? 'timeout' : 'skipped';
        const durationField = progress.stage === 'retrieval' ? 'memory_retrieval_ms'
          : progress.stage === 'era_retrieval' ? 'era_retrieval_ms' : 'resolve_ms';
        recordTrace(`coach.${progress.stage}.${progress.status}`, {
          ...traceFields,
          action: gate.action,
          retrieve_memory: gate.retrieve_memory,
          retrieve_era: gate.retrieve_era,
          ...(progress.latencyMs === undefined ? {} : { [durationField]: Number(progress.latencyMs.toFixed(2)) }),
          ...(progress.queryChars === undefined ? {} : { queryChars: progress.queryChars }),
          ...(progress.startYear === undefined ? {} : { startYear: progress.startYear }),
          ...(progress.endYear === undefined ? {} : { endYear: progress.endYear }),
          ...(progress.candidateCount === undefined ? {} : { candidateCount: progress.candidateCount }),
          ...(progress.evidenceCount === undefined ? {} : { evidenceCount: progress.evidenceCount }),
          ...(progress.memoryEvidenceCount === undefined ? {} : { memoryEvidenceCount: progress.memoryEvidenceCount }),
          ...(progress.eraEvidenceCount === undefined ? {} : { eraEvidenceCount: progress.eraEvidenceCount }),
          ...(progress.errorCode ? { errorCode: progress.errorCode } : {}),
          ...(progress.skipReason ? { skipReason: progress.skipReason } : {}),
        });
      },
    });
    const outcome = await settleWithin(promise, Math.max(0, deadlineAt - performance.now()));
    const latencyMs = Number((performance.now() - startedAt).toFixed(2));
    if (outcome.status === 'timeout') {
      recordPipelineTimeout(latencyMs);
      controller.abort('coach-total-timeout');
      return { status: 'timeout', latencyMs };
    }
    if (outcome.status === 'failed') {
      pipelineExpired = true;
      controller.abort('coach-pipeline-failed');
      const failedStage = (['resolve', 'retrieval', 'era_retrieval'] as const)
        .find((stage) => stageStatuses[stage] === 'running');
      recordTrace(failedStage ? `coach.${failedStage}.failed` : 'coach.pipeline.failed', {
        ...stageBaseFields(), total_ms: latencyMs, errorCode: coachErrorCode(outcome.error),
      });
      return { status: 'failed', latencyMs };
    }
    if (phase !== 'active' || currentTurnId !== turnId || contextVersion !== version) {
      return { status: 'timeout', latencyMs };
    }
    if (performance.now() >= deadlineAt) {
      recordPipelineTimeout(latencyMs);
      controller.abort('coach-total-timeout');
      return { status: 'timeout', latencyMs };
    }
    return {
      status: 'completed',
      packet: renderMiniCoachPacket({ scenario: 'story_continue', currentUserAnswer: latestUserAnswer, gate, packet: outcome.value.packet }),
      latencyMs,
      memoryEvidenceCount: outcome.value.memoryEvidenceCount,
      eraEvidenceCount: outcome.value.eraEvidenceCount,
    };
  };

  const runRealtimeMemoryPipeline = (
    query: string,
    turnId: string,
    version: number,
    deadlineAt: number,
    triggerMode: RealtimeMemoryTriggerMode,
  ) => {
    const story = sessionContext?.interview_type === 'story' ? sessionContext.story : undefined;
    const storyId = typeof story?.story_id === 'string' ? story.story_id.trim() : '';
    const sessionId = interviewSession?.sessionId;
    if (!sessionId || !storyId || sessionContext?.interview_type !== 'story'
      || sessionContext.task_context?.mode !== 'continue') return undefined;
    const isCurrent = (): boolean => phase === 'active'
      && contextVersion === version
      && currentTurnId === turnId;
    recordTrace('realtime.recall_started', {
      turnId,
      contextVersion: version,
      triggerMode,
      queryChars: query.length,
      deadlineMs: config.realtimeSlowDeadlineMs ?? DEFAULT_REALTIME_SLOW_DEADLINE_MS,
    });
    const promise = slowCoordinator.run({
      ownerId: authContext.userId,
      sessionId,
      storyId,
      turnId,
      contextVersion: version,
      query,
      traceContext: {
        traceId: sessionId,
        sessionId,
        storyId,
        parentSpanId: `memory:${turnId}`,
      },
      onProgress: (progress) => {
        const skipReason = normalizeAgentSkipReasonForObservation(progress.skipReason, false);
        const fields: RealtimeTraceFields = {
          turnId,
          contextVersion: version,
          ...(progress.latencyMs === undefined ? {} : { latencyMs: progress.latencyMs }),
          ...(progress.stage === 'retrieval' && progress.latencyMs !== undefined ? { retriever_ms: progress.latencyMs } : {}),
          ...(progress.stage === 'slow_agent' && progress.latencyMs !== undefined ? { agent_ms: progress.latencyMs } : {}),
          ...(progress.candidateCount === undefined ? {} : { candidateCount: progress.candidateCount }),
          ...(progress.evidenceCount === undefined ? {} : { evidenceCount: progress.evidenceCount }),
          ...(progress.selectedEvidenceCount === undefined ? {} : { selectedEvidenceCount: progress.selectedEvidenceCount }),
          ...(progress.inputChars === undefined ? {} : { inputChars: progress.inputChars }),
          ...(progress.errorCode ? { errorCode: progress.errorCode } : {}),
          ...(skipReason ? { slowAgentSkipReason: skipReason } : {}),
        };
        const eventStatus = progress.status === 'completed' ? 'completed' : progress.status;
        if (progress.stage === 'retrieval') recordTrace(`slow.retriever.${eventStatus}`, fields);
        else if (progress.stage === 'slow_agent') recordTrace(`slow.agent.${eventStatus}`, fields);
        else recordTrace(`realtime.slow_path.context_hint.${progress.status}`, fields);
        sendTechStatus({
          stage: progress.stage === 'slow_agent' ? 'slow_agent' : progress.stage,
          status: progress.status,
          latencyMs: progress.latencyMs,
          count: progress.selectedEvidenceCount ?? progress.evidenceCount ?? progress.count,
          model: progress.model,
          skill: progress.skill,
          errorCode: progress.errorCode,
        });
      },
    }, isCurrent, deadlineAt);
    return { promise, isCurrent, sessionId, storyId };
  };

  const handleRealtimeToolCall = (
    event: Extract<NormalizedRealtimeEvent, { type: 'tool.call.requested' }>,
  ): void => {
    const holdStartedAt = performance.now();
    const deadlineMs = config.realtimeSlowDeadlineMs ?? DEFAULT_REALTIME_SLOW_DEADLINE_MS;
    const deadlineAt = holdStartedAt + deadlineMs;
    const resumeBy = Math.max(holdStartedAt, deadlineAt - 100);
    const turnId = currentTurnId ?? event.itemId ?? event.callId;
    const version = contextVersion;
    const toolAdapter = selectedAdapter;
    const triggerMode = sessionContext?.memoryTriggerMode
      ?? resolveRealtimeMemoryTriggerMode(selectedProvider, config.realtimeMemoryTriggerMode);
    recordTrace('realtime.tool_call.received', {
      name: event.name,
      callId: event.callId,
      responseId: event.responseId,
      turnId,
      contextVersion: version,
      triggerMode,
      deadlineMs,
    });
    if (toolAdapter?.capabilities.manualTurnControl && event.responseId) {
      manualToolCallResponseIds.add(event.responseId);
    }
    toolCycleTracker.start({
      callId: event.callId,
      toolName: event.name,
      responseAId: event.responseId,
      provider: selectedProvider,
      turnId,
      contextVersion: version,
    });

    if (!toolAdapter?.handleToolResult) {
      recordTrace('realtime.tool_call_ignored', {
        callId: event.callId,
        responseId: event.responseId,
        reason: 'tool_result_unsupported',
      });
      toolCycleTracker.finish(event.callId, 'failed', 'tool_result_unsupported');
      return;
    }

    const scope = sessionContext?.interview_type === 'story'
      && sessionContext.task_context?.mode === 'continue'
      && typeof sessionContext.story?.story_id === 'string'
      && sessionContext.story.story_id.trim().length > 0;
    const rawQuery = record(event.arguments)?.query;
    const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
    const allowed = triggerMode === 'voice_tool'
      && event.name === INTERVIEW_CONTEXT_TOOL_NAME
      && scope
      && query.length > 0;
    const pipelineDeadlineAt = Math.max(
      holdStartedAt,
      deadlineAt - Math.min(250, deadlineMs / 4),
    );
    const miniVoiceTool = allowed && miniProfileSelected();
    const miniCoachPromise = miniVoiceTool
      ? runMiniVoiceToolResolve(query, turnId, version, deadlineAt)
      : undefined;
    const pipeline = allowed && !miniProfileSelected()
      ? runRealtimeMemoryPipeline(query, turnId, version, pipelineDeadlineAt, 'voice_tool')
      : undefined;

    void (async () => {
      const responseIdlePromise = event.responseId
        ? waitForResponseIdle(event.responseId, resumeBy, () => phase === 'active' && currentTurnId === turnId && contextVersion === version)
        : Promise.resolve(true);
      const [responseIdle, result, miniCoachResult] = await Promise.all([
        responseIdlePromise,
        pipeline?.promise ?? Promise.resolve(undefined),
        miniCoachPromise ?? Promise.resolve(undefined),
      ]);
      const timedOut = !responseIdle || performance.now() >= deadlineAt
        || result?.status === 'timeout' || miniCoachResult?.status === 'timeout';
      const usable = !timedOut
        && result?.status === 'completed'
        && result.hint
        && pipeline?.isCurrent()
        && result.hint.basedOnTurnId === turnId
        && performance.now() < deadlineAt;
      const miniOutput = miniCoachResult
        ? miniCoachResult.status === 'completed' && miniCoachResult.packet
          ? { status: 'coach-context', coach_packet: miniCoachResult.packet }
          : { status: 'no-context' }
        : undefined;
      const output = miniOutput ?? (usable
        ? result.hint
        : {
            status: event.name === INTERVIEW_CONTEXT_TOOL_NAME && !scope ? 'unavailable' : 'no-context',
            facts: [],
            possibleConflicts: [],
            interviewHints: [],
          });
      const resultStatus = miniOutput
        ? miniOutput.status === 'coach-context' ? 'completed' : 'no_context'
        : usable ? 'completed' : 'no_context';
      if (timedOut) recordTrace('realtime.tool_call.deadline_exceeded', {
        callId: event.callId,
        responseId: event.responseId,
        deadlineMs,
        fallbackUsed: true,
        status: 'timeout',
      });

      const messages = toolAdapter.handleToolResult!(event, output, { resume: true });
      const outputMessages = messages.filter((message) => message.type !== 'response.create');
      const resumeMessages = messages.filter((message) => message.type === 'response.create');
      if (!responseIdle && event.responseId) {
        const cancelSent = sendProviderMessage({ type: 'response.cancel' });
        recordTrace('realtime.tool_call.response_cancel_requested', {
          callId: event.callId,
          responseId: event.responseId,
          sent: cancelSent,
        });
      }
      const outputWrite = writeToolResultMessages(event.callId, outputMessages);
      const resumeWrite = writeToolResultMessages(event.callId, resumeMessages);
      const resumeWritten = resumeWrite.resumeWritten;
      if (miniCoachResult?.status === 'completed' && miniCoachResult.packet && outputWrite.outputWritten) {
        traceWriter?.recordContent('coach.mini_packet', miniCoachResult.packet);
        recordTrace('coach.applied', {
          scenario: 'story_continue',
          voiceProfile: 'stepaudio2_mini',
          triggerMode: 'voice_tool',
          coachModel: config.realtimeCoachModel ?? 'qwen3-8b',
          action: 'guide',
          retrieve_memory: true,
          retrieve_era: false,
          memoryEvidenceCount: miniCoachResult.memoryEvidenceCount ?? 0,
          eraEvidenceCount: miniCoachResult.eraEvidenceCount ?? 0,
          turnId,
          packetChars: Array.from(miniCoachResult.packet).length,
          total_ms: Number(miniCoachResult.latencyMs.toFixed(2)),
        });
      }

      const elapsedMs = performance.now() - holdStartedAt;
      toolCycleTracker.setMetrics(event.callId, {
        toolResultWriteLatencyMs: elapsedMs,
        terminalOutcome: outputWrite.outputWritten && (resumeWritten || resumeMessages.length === 0)
          ? 'completed'
          : 'failed',
      });
      recordTrace('realtime.tool_result.sent', {
        callId: event.callId,
        responseId: event.responseId,
        sent: outputWrite.outputWritten,
        outputWritten: outputWrite.outputWritten,
        resumeWritten,
        fallbackUsed: timedOut,
        status: resultStatus,
        latencyMs: elapsedMs,
      });
      sendTechStatus({ stage: 'resume', status: resumeWritten ? 'completed' : 'failed', latencyMs: elapsedMs });
      if (!outputWrite.outputWritten || (resumeMessages.length > 0 && !resumeWritten)) {
        toolCycleTracker.finish(event.callId, 'failed', 'tool_result_or_resume_write_failed');
      }
    })().catch(() => {
      recordTrace('realtime.tool_result_failed', { callId: event.callId, reason: 'processing_failed' });
      toolCycleTracker.finish(event.callId, 'failed', 'tool_result_processing_failed');
    });
  };

  const triggerRealtimeMemory = (text: string, turnId: string, version: number): void => {
    if (selectedProvider === 'stepaudio2_mini' || selectedProvider === 'stepfun'
      || sessionContext?.memoryTriggerMode !== 'supervisor_auto') return;
    const story = sessionContext?.interview_type === 'story' ? sessionContext.story : undefined;
    const storyId = typeof story?.story_id === 'string' ? story.story_id.trim() : '';
    const eligible = sessionContext?.interview_type === 'story'
      && sessionContext.task_context?.mode === 'continue'
      && storyId.length > 0
      && text.trim().length >= 2;
    if (!eligible) {
      recordTrace('realtime.memory_trigger.skipped', { turnId, contextVersion: version, reason: 'current_story_scope_required' });
      return;
    }
    const triggerStartedAt = performance.now();
    const deadlineAt = triggerStartedAt + (config.realtimeSlowDeadlineMs ?? DEFAULT_REALTIME_SLOW_DEADLINE_MS);
    const pipeline = runRealtimeMemoryPipeline(text.trim(), turnId, version, deadlineAt, 'supervisor_auto');
    if (!pipeline) {
      recordTrace('realtime.memory_trigger.skipped', { turnId, contextVersion: version, reason: 'session_unavailable' });
      return;
    }
    void pipeline.promise.then((result) => {
      let finalStatus: string = result.status;
      let finalErrorCode = result.errorCode;
      let injectionMessages: Record<string, unknown>[] | undefined;
      if (result.status === 'completed' && result.hint && pipeline.isCurrent() && result.hint.basedOnTurnId === turnId) {
        if (!selectedAdapter?.capabilities.supportsContextInjection || !selectedAdapter.injectContextHint) {
          finalStatus = 'unsupported';
          finalErrorCode = 'CONTEXT_INJECTION_UNSUPPORTED';
          recordTrace('realtime.memory_trigger.unsupported', {
            turnId,
            contextVersion: version,
            reason: 'context_injection_unsupported',
          });
          sendTechStatus({ stage: 'retrieval', status: 'skipped', errorCode: finalErrorCode });
        } else {
          try {
            injectionMessages = selectedAdapter.injectContextHint(result.hint);
          } catch {
            finalStatus = 'failed';
            finalErrorCode = 'CONTEXT_INJECTION_FAILED';
          }
        }
        if (performance.now() >= deadlineAt) {
          finalStatus = 'timeout';
          finalErrorCode = 'REALTIME_RECALL_TIMEOUT';
          injectionMessages = undefined;
        }
      }
      recordTrace('realtime.slow_recall_finished', {
        runId: result.runId,
        turnId,
        contextVersion: version,
        status: finalStatus,
        latencyMs: result.latencyMs,
        slowRecallLatencyMs: result.latencyMs,
        errorCode: finalErrorCode,
        factCount: result.hint?.facts.length ?? 0,
        possibleConflictCount: result.hint?.possibleConflicts.length ?? 0,
        interviewHintCount: result.hint?.interviewHints.length ?? 0,
      });
      if (finalStatus !== 'completed' || !result.hint || !injectionMessages || injectionMessages.length === 0 || !pipeline.isCurrent()) return;
      const createdAt = performance.now();
      if (createdAt >= deadlineAt) {
        recordTrace('realtime.context_hint.dropped', { turnId, contextVersion: version, reason: 'ttl_expired' });
        return;
      }
      pendingNextTurnContext = {
        hint: result.hint,
        messages: injectionMessages,
        sessionId: pipeline.sessionId,
        storyId: pipeline.storyId,
        turnId,
        contextVersion: version,
        createdAt,
        expiresAt: deadlineAt,
      };
      recordTrace('realtime.context_hint.pending_next_turn', {
        turnId,
        contextVersion: version,
        expiresAt: deadlineAt,
        factCount: result.hint.facts.length,
        possibleConflictCount: result.hint.possibleConflicts.length,
        interviewHintCount: result.hint.interviewHints.length,
      });
    }).catch(() => {
      recordTrace('realtime.memory_trigger.failed', { turnId, contextVersion: version, errorCode: 'MEMORY_TRIGGER_FAILED' });
    });
  };

  const armUserTurnStallWatchdog = (): void => {
    clearUserTurnStallWatchdog();
    if (phase !== 'active'
      || !awaitingUserTranscript
      || manualEndRequested
      || activeResponses.size > 0
      || userTurnRecoveryAttempted) {
      return;
    }
    const timeoutMs = config.userTurnStallTimeoutMs ?? DEFAULT_USER_TURN_STALL_TIMEOUT_MS;
    userTurnStallTimer = setTimeout(() => {
      userTurnStallTimer = undefined;
      if (phase !== 'active'
        || !awaitingUserTranscript
        || manualEndRequested
        || activeResponses.size > 0
        || userTurnRecoveryAttempted) {
        return;
      }
      userTurnRecoveryAttempted = true;
      const steps = selectedAdapter?.recoverStalledUserTurn?.() ?? [];
      recordTrace('user_turn.stall_detected', {
        timeoutMs,
        deltaCount: userTranscriptDeltaCount,
        recoveryStepCount: steps.length,
        ...microphoneTiming(),
      });
      if (steps.length === 0) {
        recordTrace('user_turn.stall_recovery_unavailable', { provider: selectedProvider });
        return;
      }
      void executeProviderSteps(steps)
        .then((sent) => recordTrace('user_turn.stall_recovery_sent', {
          sent,
          stepCount: steps.length,
          provider: selectedProvider,
        }))
        .catch((error) => recordTrace('user_turn.stall_recovery_failed', {
          provider: selectedProvider,
          error: error instanceof Error ? error.name : 'unknown',
        }));
    }, timeoutMs);
  };

  const persistProviderSessionId = (externalSessionId?: string): void => {
    if (!externalSessionId) return;
    if (!interviewSession) {
      pendingProviderSessionId = externalSessionId;
      return;
    }
    try {
      interviewSessionRepository.setProviderSessionIdForUser(authContext.userId, interviewSession.sessionId, externalSessionId);
    } catch {
      recordTrace('provider.session_id_persist_failed', { provider: selectedProvider });
    }
  };

  const flushMicrophoneTrace = (force = false): void => {
    const now = performance.now();
    if (microphoneTraceFrames > 0 || force) {
      recordTrace('client.microphone_uplink', {
        frames: microphoneTraceFrames,
        bytes: microphoneTraceBytes,
        intervalMs: now - microphoneTraceWindowAt,
        microphoneStreaming: microphoneTraceFrames > 0,
        pendingSpeech,
        rms: microphoneTraceSamples > 0 ? Math.sqrt(microphoneTracePower / microphoneTraceSamples) : 0,
        maxRms: microphoneTraceMaxRms,
        responseActive: activeResponses.size > 0,
      });
    }
    microphoneTraceWindowAt = now;
    microphoneTraceFrames = 0;
    microphoneTraceBytes = 0;
    microphoneTracePower = 0;
    microphoneTraceSamples = 0;
    microphoneTraceMaxRms = 0;
  };

  const microphoneTiming = (): Record<string, number | null> => ({
    micPacketCount: microphonePacketCount,
    micPacketAgeMs: lastMicrophonePacketAt === undefined
      ? null
      : performance.now() - lastMicrophonePacketAt,
  });

  const getProviderAudioTrace = (responseId: string): ProviderAudioTrace => {
    const current = providerAudioTrace.get(responseId);
    if (current) return current;
    const created: ProviderAudioTrace = {
      chunks: 0,
      bytes: 0,
      responseStartedAt: performance.now(),
      maxGapMs: 0,
    };
    providerAudioTrace.set(responseId, created);
    return created;
  };

  const recordProviderAudioDelta = (responseId: string, delta: string): void => {
    const now = performance.now();
    const toolToFirstAudioMs = toolCycleTracker.markFirstAudio(responseId);
    if (toolToFirstAudioMs !== undefined) {
      sendTechStatus({ stage: 'first_audio', status: 'completed', latencyMs: toolToFirstAudioMs });
    }
    const stats = getProviderAudioTrace(responseId);
    const deltaBytes = base64ByteLength(delta);
    const interArrivalMs = stats.lastDeltaAt === undefined ? undefined : now - stats.lastDeltaAt;
    stats.chunks += 1;
    stats.bytes += deltaBytes;
    if (stats.firstDeltaAt === undefined) {
      stats.firstDeltaAt = now;
      recordTrace('provider.first_audio_received', {
        responseId,
        chunks: 1,
        deltaBytes,
        elapsedMs: now - stats.responseStartedAt,
      });
    }
    if (interArrivalMs !== undefined) stats.maxGapMs = Math.max(stats.maxGapMs, interArrivalMs);
    stats.lastDeltaAt = now;
    recordTrace('provider.audio_delta', {
      responseId,
      chunk: stats.chunks,
      deltaBytes,
      totalBytes: stats.bytes,
      ...(interArrivalMs === undefined ? {} : { interArrivalMs }),
      ...traceStageTracker.mark('first_audio', {
        responseId,
        chunk: stats.chunks,
        deltaBytes,
        totalBytes: stats.bytes,
      }),
    });
  };

  const finishProviderAudioTrace = (responseId: string, status?: string): void => {
    const stats = providerAudioTrace.get(responseId);
    if (!stats) {
      recordTrace('provider.audio_summary', { responseId, chunks: 0, bytes: 0, status });
      return;
    }
    const now = performance.now();
    recordTrace('provider.audio_summary', {
      responseId,
      chunks: stats.chunks,
      bytes: stats.bytes,
      firstAudioMs: stats.firstDeltaAt === undefined ? undefined : stats.firstDeltaAt - stats.responseStartedAt,
      maxGapMs: stats.maxGapMs,
      elapsedMs: now - stats.responseStartedAt,
      status,
    });
    providerAudioTrace.delete(responseId);
  };

  const setActivity = (): void => {
    lastProviderActivityAt = Date.now();
  };

  const suppressAssistantResponseAfterManualEnd = (event: NormalizedRealtimeEvent): boolean => {
    if (!manualEndRequested) return false;
    const assistantEvent = event.type.startsWith('assistant.')
      || event.type === 'response.done'
      || event.type === 'response.cancelled';
    if (!assistantEvent) return false;

    const responseId = 'responseId' in event ? event.responseId : undefined;
    if (event.type === 'assistant.started' && responseId) {
      recordTrace('provider.response_suppressed_after_manual_end', { responseId, eventType: event.type });
    } else if ((event.type === 'response.done' || event.type === 'response.cancelled') && responseId) {
      const status = event.type === 'response.cancelled' ? 'cancelled' : event.status;
      activeResponses.delete(responseId);
      assistantResponses.delete(responseId);
      if (providerAudioTrace.has(responseId)) finishProviderAudioTrace(responseId, status);
      if (activeResponses.size === 0) awaitingAssistant = false;
      recordTrace('provider.response_suppressed_after_manual_end', { responseId, eventType: event.type, status });
    }
    return true;
  };

  const enqueueTranscript = (message: ProviderTranscriptMessage): void => {
    if (!message.text.trim()) return;
    const dedupeKey = `${message.role}:${message.providerMessageId}`;
    if (seenProviderMessages.has(dedupeKey)) return;
    seenProviderMessages.add(dedupeKey);
    pendingWriteCount += 1;
    const queuedAt = performance.now();
    recordTrace('transcript.write_queued', {
      role: message.role,
      chars: message.text.length,
      queueDepth: pendingWriteCount,
    });

    transcriptWriteTail = transcriptWriteTail.then(() => new Promise<void>((resolve) => {
      setImmediate(() => {
        try {
          if (!interviewSession) throw new Error('Session 尚未创建，Transcript 无法写入。');
          const persistedMessage = transcriptRepository.appendForSession(authContext.userId, interviewSession.sessionId, {
            role: message.role,
            text: message.text,
            provider: selectedProvider ?? 'stepaudio2_mini',
            providerMessageId: message.providerMessageId,
          });
          savedTranscriptCount += 1;
          recordTrace('transcript.write_succeeded', {
            role: message.role,
            chars: message.text.length,
            elapsedMs: performance.now() - queuedAt,
          });
          send({
            type: 'transcript_saved',
            role: message.role,
            providerMessageId: message.providerMessageId,
            messageId: persistedMessage.message_id,
            savedTranscriptCount,
          });
        } catch (error) {
          const messageText = error instanceof Error ? error.message : 'Transcript 写入失败。';
          transcriptWriteErrors.push(messageText);
          recordTrace('transcript.write_failed', {
            role: message.role,
            chars: message.text.length,
            elapsedMs: performance.now() - queuedAt,
            reason: error instanceof Error ? error.name : 'unknown',
          });
          send({
            type: 'transcript_save_error',
            message: messageText,
            providerMessageId: message.providerMessageId,
          });
        } finally {
          pendingWriteCount -= 1;
          resolve();
        }
      });
    }));
  };

  const requestOnboardingCompletionClose = (
    request: Extract<NormalizedRealtimeEvent, { type: 'onboarding.completion.requested' }>,
  ): void => {
    if (!provider || provider.readyState !== WebSocket.OPEN || !selectedAdapter) return;
    pendingOnboardingCompletionRequest = undefined;
    awaitingOnboardingCompletionClose = true;
    onboardingCompletionCloseResponseId = undefined;
    onboardingCloseResponseRetries = 0;
    awaitingAssistant = true;
    for (const message of selectedAdapter.handleControlEvent?.(request) ?? []) {
      provider.send(JSON.stringify(message));
    }
    recordTrace('onboarding.completion_acknowledged', { provider: selectedProvider });
  };

  const resolveStartupAfterProviderSession = (): void => {
    if (phase !== 'connecting') return;
    if (selectedAdapter?.capabilities.manualTurnControl
      && (providerSessionReadyAt === undefined || pendingTurnDetectionMode !== 'manual')) return;
    startupResolve?.();
  };

  const handleNormalizedRealtimeEvent = (event: NormalizedRealtimeEvent): void => {
    if (event.type === 'session.queue.ready') {
      if (phase !== 'connecting' || !selectedAdapter || !sessionContext || providerSessionInitSent) return;
      providerSessionInitSent = true;
      try {
        if (!sendProviderMessages(selectedAdapter.setupSession(sessionContext))) {
          startupReject?.(new Error('面壁 Realtime 会话初始化消息发送失败。'));
        }
      } catch (error) {
        startupReject?.(error instanceof Error ? error : new Error('面壁 Realtime 会话初始化失败。'));
      }
      return;
    }
    if (event.type === 'session.configured') {
      if (traceWriter) recordTrace('provider.turn_detection_acknowledged', {
        provider: selectedProvider,
        turnDetectionMode: event.turnDetectionMode,
      });
      else pendingTurnDetectionMode = event.turnDetectionMode;
      if (phase === 'connecting' && selectedAdapter?.capabilities.manualTurnControl) {
        if (event.turnDetectionMode === 'manual') {
          resolveStartupAfterProviderSession();
        }
        else startupReject?.(new Error('Realtime Provider 未确认手动回合模式，无法安全启动本地语音停顿检测。'));
      }
      return;
    }
    if (event.type === 'session.ready') {
      providerSessionReadyAt = performance.now();
      persistProviderSessionId(event.providerSessionId);
      resolveStartupAfterProviderSession();
      return;
    }
    if (event.type === 'session.closed') {
      sessionClosedResolver?.(true);
      return;
    }
    if (event.type === 'provider.error') {
      if (phase === 'connecting') startupReject?.(new Error(event.message));
      else send({ type: 'error', message: event.message });
      return;
    }
    if (phase !== 'active' && phase !== 'ending') return;
    if (suppressAssistantResponseAfterManualEnd(event)) return;

    if (event.type === 'onboarding.completion.requested') {
      if (sessionContext?.interview_type === 'onboarding'
        && !pendingOnboardingCompletionRequest
        && !awaitingOnboardingCompletionClose) {
        pendingOnboardingCompletionRequest = event;
        recordTrace('onboarding.completion_signal_received', {
          provider: selectedProvider,
          requiresAck: event.requiresAck,
        });
      }
      return;
    }

    if (event.type === 'tool.call.requested') {
      handleRealtimeToolCall(event);
      return;
    }

    setActivity();

    if (event.type === 'speech.started') {
      if (!selectedAdapter?.capabilities.manualTurnControl) slowCoordinator.cancel();
      activeCoachController?.abort('new-speech');
      activeCoachController = undefined;
      clearUserTurnStallWatchdog();
      userTurnRecoveryAttempted = false;
      pendingSpeech = true;
      manualTurnCommitPending = false;
      manualTurnCommitSent = false;
      awaitingUserTranscript = true;
      userTranscriptDeltaCount = 0;
      recordTrace('provider.speech_started', {
        eventId: event.eventId,
        responseActive: activeResponses.size > 0,
        lifecycle: phase,
        ...microphoneTiming(),
      });
      send({ type: 'speech_started' });
      return;
    }

    if (event.type === 'speech.stopped') {
      pendingSpeech = false;
      recordTrace('provider.speech_stopped_received', {
        eventId: event.eventId,
        source: event.source,
        responseActive: activeResponses.size > 0,
        lifecycle: phase,
        ...microphoneTiming(),
        ...traceStageTracker.mark('speech_stopped', { eventId: event.eventId, source: event.source ?? 'speech_stopped' }),
      });
      const forwarded = send({ type: 'speech_stopped', source: event.source ?? 'speech_stopped' });
      recordTrace('provider.speech_stopped_forwarded', { eventId: event.eventId, forwarded });
      return;
    }

    if (event.type === 'user.transcript.delta') {
      const text = event.text;
      const stash = event.stash ?? '';
      userTranscriptDeltaCount += 1;
      const deltaChars = event.deltaChars ?? text.length + stash.length;
      recordTrace('provider.user_transcription_delta_received', {
        deltaCount: userTranscriptDeltaCount,
        deltaChars,
        chars: text.length + stash.length,
        responseActive: activeResponses.size > 0,
        ...microphoneTiming(),
      });
      const forwarded = send({
        type: 'user_partial',
        itemId: event.itemId,
        text,
        stash,
        deltaCount: userTranscriptDeltaCount,
        deltaChars,
      });
      recordTrace('provider.user_transcription_delta_forwarded', {
        forwarded,
        deltaCount: userTranscriptDeltaCount,
        deltaChars,
      });
      armUserTurnStallWatchdog();
      return;
    }

    if (event.type === 'user.transcript.final') {
      clearUserTurnStallWatchdog();
      userTurnRecoveryAttempted = false;
      pendingSpeech = false;
      const text = event.text;
      const providerMessageId = event.itemId ?? event.eventId ?? `user-${Date.now()}`;
      if (pendingNextTurnContext && pendingNextTurnContext.turnId !== providerMessageId) {
        const stale = pendingNextTurnContext;
        pendingNextTurnContext = undefined;
        recordTrace('slow.result.stale_dropped', {
          turnId: stale.turnId,
          contextVersion: stale.contextVersion,
          reason: performance.now() >= stale.expiresAt ? 'pending_context_expired' : 'next_turn_boundary_passed',
        });
      }
      currentTurnId = providerMessageId;
      contextVersion += 1;
      slowCoordinator.cancel();
      awaitingUserTranscript = false;
      const userFinalTrace = text.trim()
        ? traceStageTracker.mark('user_final', {
            eventId: event.eventId,
            chars: text.length,
            textPresent: true,
          })
        : {};
      recordTrace('provider.user_transcription_completed', {
        turnId: providerMessageId,
        eventId: event.eventId,
        chars: text.length,
        deltaCount: userTranscriptDeltaCount,
        textPresent: Boolean(text.trim()),
        responseActive: activeResponses.size > 0,
        ...microphoneTiming(),
        ...userFinalTrace,
      });
      if (text.trim()) {
        const explicitEndIntent = isExplicitEndIntent(text, lastAssistantText);
        recordTrace('session.end_intent_checked', { turnId: providerMessageId, matched: explicitEndIntent });
        if (explicitEndIntent) {
          userConfirmedEnding = true;
          recordTrace('session.user_confirmed_ending', { chars: text.length });
        }
        awaitingAssistant = !manualEndRequested;
        enqueueTranscript({
          role: 'user',
          text,
          providerMessageId,
          providerEventId: event.eventId,
        });
        latestUserAnswer = text;
        const forwarded = send({ type: 'user_final', itemId: providerMessageId, text });
        recordTrace('provider.user_transcription_completed_forwarded', {
          forwarded,
          chars: text.length,
          deltaCount: userTranscriptDeltaCount,
        });
        if (explicitEndIntent && supervisorAutoSelected()) {
          const farewellInstruction = `用户明确要求结束采访。只说“${STORY_INTERVIEW_COMPLETION_UTTERANCE}”，不要再提问。`;
          const farewell = selectedAdapter?.requestAssistantTurnMessages(farewellInstruction) ?? [];
          const sent = farewell.length > 0 && sendProviderMessages(farewell);
          if (sent) traceWriter?.recordContent('session.farewell_instructions', farewellInstruction);
          recordTrace('session.spoken_end_farewell_requested', { sent, turnId: providerMessageId });
          if (!sent) void finishSession('user_confirmed');
        } else if (!explicitEndIntent) {
          if (supervisorAutoSelected()) runSupervisorCoach(text, providerMessageId, contextVersion);
          else triggerRealtimeMemory(text, providerMessageId, contextVersion);
          recentCoachContext.push({ role: 'user', text });
          if (recentCoachContext.length > 6) recentCoachContext.splice(0, recentCoachContext.length - 6);
        }
        if (explicitEndIntent && !endingPromise) {
          if (autoEndFallbackTimer) clearTimeout(autoEndFallbackTimer);
          autoEndFallbackTimer = setTimeout(() => {
            recordTrace('session.spoken_end_timeout', { reason: 'farewell_response_missing' });
            void finishSession('user_confirmed');
          }, 30_000);
        }
        if (hardLimitReached) {
          acceptingAudio = false;
          const steps = selectedAdapter?.stopInputAfterCurrentTurn() ?? [];
          void executeProviderSteps(steps);
        }
      } else {
        recordTrace('provider.user_transcription_completed_forwarded', {
          forwarded: false,
          chars: text.length,
          deltaCount: userTranscriptDeltaCount,
          reason: 'empty_transcript',
        });
      }
      return;
    }

    if (event.type === 'assistant.started') {
      clearOpeningResponseWatchdog();
      clearUserTurnStallWatchdog();
      const responseId = event.responseId;
      if (userConfirmedEnding && !userFarewellResponseId && activeResponses.size === 0) {
        userFarewellResponseId = responseId;
        recordTrace('session.spoken_end_response_started', { responseId });
      }
      toolCycleTracker.markAssistantResponseStarted(responseId);
      activeResponses.add(responseId);
      if (sessionContext?.interview_type === 'onboarding'
        && awaitingOnboardingCompletionClose
        && !onboardingCompletionCloseResponseId) {
        onboardingCompletionCloseResponseId = responseId;
      }
      const assistantResponse = assistantResponses.get(responseId) ?? { partialText: '' };
      if (event.openingFallbackText) assistantResponse.openingFallbackText = event.openingFallbackText;
      assistantResponses.set(responseId, assistantResponse);
      if (!providerAudioTrace.has(responseId)) {
        providerAudioTrace.set(responseId, {
          chunks: 0,
          bytes: 0,
          responseStartedAt: performance.now(),
          maxGapMs: 0,
        });
      }
      recordTrace('provider.response_created', {
        responseId,
        responseActive: true,
        ...traceStageTracker.mark('assistant_started', { responseId }),
      });
      send({ type: 'assistant_started', responseId });
      return;
    }

    if (event.type === 'assistant.transcript.delta') {
      const responseId = event.responseId;
      const response = assistantResponses.get(responseId) ?? { partialText: '' };
      response.transcriptDeltaCount = (response.transcriptDeltaCount ?? 0) + 1;
      response.partialText += event.delta;
      if (event.itemId) response.itemId = event.itemId;
      assistantResponses.set(responseId, response);
      recordTrace('provider.assistant_transcript_delta_received', {
        responseId,
        eventId: event.eventId,
        deltaCount: response.transcriptDeltaCount,
        deltaChars: event.delta.length,
        chars: response.partialText.length,
        textPresent: Boolean(response.partialText),
      });
      const forwarded = send({
        type: 'assistant_partial',
        responseId,
        text: response.partialText,
        deltaCount: response.transcriptDeltaCount,
        deltaChars: event.delta.length,
      });
      recordTrace('provider.assistant_transcript_delta_forwarded', {
        responseId,
        deltaCount: response.transcriptDeltaCount,
        deltaChars: event.delta.length,
        chars: response.partialText.length,
        forwarded,
      });
      return;
    }

    if (event.type === 'assistant.transcript.final') {
      const response = assistantResponses.get(event.responseId) ?? { partialText: '' };
      response.finalTranscript = event.text || response.partialText;
      response.transcriptEventId = event.eventId;
      if (event.itemId) response.itemId = event.itemId;
      assistantResponses.set(event.responseId, response);
      recordTrace('provider.assistant_transcript_done_received', {
        responseId: event.responseId,
        eventId: event.eventId,
        deltaCount: response.transcriptDeltaCount ?? 0,
        chars: response.finalTranscript.length,
        textPresent: Boolean(response.finalTranscript),
      });
      return;
    }

    if (event.type === 'assistant.audio.started') {
      recordTrace('provider.audio_started', { responseId: event.responseId, ttsType: event.ttsType });
      send({ type: 'assistant_audio_started', responseId: event.responseId, ttsType: event.ttsType });
      return;
    }

    if (event.type === 'assistant.audio.delta') {
      recordProviderAudioDelta(event.responseId, event.audio);
      send({
        type: 'assistant_audio',
        responseId: event.responseId,
        delta: event.audio,
        encoding: event.encoding,
      });
      return;
    }

    if (event.type === 'assistant.audio.done') {
      finishProviderAudioTrace(event.responseId, event.statusCode);
      recordTrace('provider.audio_done', { responseId: event.responseId, statusCode: event.statusCode });
      send({ type: 'assistant_audio_done', responseId: event.responseId, statusCode: event.statusCode });
      return;
    }

    if (event.type === 'response.cancelled') {
      const responseId = event.responseId;
      const manualInputReady = !manualToolCallResponseIds.delete(responseId);
      manualInputReadyForTurn = manualInputReady;
      toolCycleTracker.markAssistantResponseDone(responseId, 'cancelled');
      activeResponses.delete(responseId);
      assistantResponses.delete(responseId);
      if (providerAudioTrace.has(responseId)) finishProviderAudioTrace(responseId, 'cancelled');
      awaitingAssistant = activeResponses.size > 0;
      send({ type: 'assistant_cancelled', responseId });
      send({
        type: 'response_done', responseId, status: 'cancelled',
        ...(selectedAdapter?.capabilities.manualTurnControl ? { manualInputReady } : {}),
      });
      if (onboardingCompletionCloseResponseId === responseId) {
        awaitingOnboardingCompletionClose = false;
        onboardingCompletionCloseResponseId = undefined;
      }
      if (pendingOnboardingCompletionRequest?.responseId === responseId) {
        pendingOnboardingCompletionRequest = undefined;
      }
      if (userConfirmedEnding && userFarewellResponseId === responseId) void finishSession('user_confirmed');
      return;
    }

    if (event.type === 'response.done') {
      const responseId = event.responseId;
      const status = event.status;
      const userFarewellResponse = userConfirmedEnding && userFarewellResponseId === responseId;
      const manualInputReady = !manualToolCallResponseIds.delete(responseId);
      manualInputReadyForTurn = manualInputReady;
      toolCycleTracker.markAssistantResponseDone(responseId, status);
      const buffered = assistantResponses.get(responseId);
      activeResponses.delete(responseId);
      if (providerAudioTrace.has(responseId)) finishProviderAudioTrace(responseId, status);
      recordTrace('provider.response_done', {
        responseId,
        status,
        responseActive: activeResponses.size > 0,
      });

      const pendingCompletion = pendingOnboardingCompletionRequest;
      const completionMatches = Boolean(
        sessionContext?.interview_type === 'onboarding'
        && pendingCompletion
        && (!pendingCompletion.responseId || pendingCompletion.responseId === responseId)
      );
      if (completionMatches && pendingCompletion?.requiresAck) {
        assistantResponses.delete(responseId);
        awaitingAssistant = status === 'completed';
        manualInputReadyForTurn = status !== 'completed';
        send({
          type: 'response_done', responseId, status,
          ...(selectedAdapter?.capabilities.manualTurnControl ? { manualInputReady: status !== 'completed' } : {}),
        });
        if (status === 'completed') requestOnboardingCompletionClose(pendingCompletion);
        else {
          pendingOnboardingCompletionRequest = undefined;
          recordTrace('onboarding.completion_response_not_completed', { status });
        }
        return;
      }

      if (status === 'completed') {
        const providerTranscript = buffered?.finalTranscript ?? event.finalText ?? buffered?.partialText ?? '';
        const fallbackText = buffered?.openingFallbackText ?? '';
        const usedOpeningFallback = !providerTranscript.trim() && Boolean(fallbackText.trim());
        const text = providerTranscript.trim() ? providerTranscript : fallbackText;
        const providerMessageId = usedOpeningFallback
          ? responseId
          : buffered?.itemId ?? event.finalItemId ?? responseId;
        const onboarding = sessionContext?.interview_type === 'onboarding';
        const closingResponse = onboarding
          && awaitingOnboardingCompletionClose
          && onboardingCompletionCloseResponseId === responseId;
        const signaledCompletion = Boolean(completionMatches && pendingCompletion && !pendingCompletion.requiresAck);
        const modelComplete = onboarding
          && !hardLimitReached
          && !userConfirmedEnding
          && text.trim().length > 0
          && (signaledCompletion || closingResponse);
        if (signaledCompletion) pendingOnboardingCompletionRequest = undefined;
        if (modelComplete) {
          modelCompletionReady = true;
          awaitingOnboardingCompletionClose = false;
          onboardingCompletionCloseResponseId = undefined;
          recordTrace('onboarding.completion_close_completed', { provider: selectedProvider, chars: text.length });
        }

        if (text.trim()) {
          lastAssistantText = text;
          recentCoachContext.push({ role: 'assistant', text });
          if (recentCoachContext.length > 6) recentCoachContext.splice(0, recentCoachContext.length - 6);
          assistantEndedInterview = onboarding ? false : isAssistantFarewell(text);
          const endAfterPlayback = userFarewellResponse || assistantEndedInterview || hardLimitReached || modelComplete;
          if (usedOpeningFallback) {
            recordTrace('provider.assistant_transcription_fallback_used', {
              responseId,
              source: 'opening_prompt',
              chars: text.length,
            });
          }
          recordTrace('provider.assistant_transcription_completed', {
            responseId,
            chars: text.length,
            deltaCount: buffered?.transcriptDeltaCount ?? 0,
            endAfterPlayback,
          });
          const forwarded = send({ type: 'assistant_final', responseId, itemId: providerMessageId, text, endAfterPlayback });
          recordTrace('provider.assistant_transcript_final_forwarded', {
            responseId,
            chars: text.length,
            deltaCount: buffered?.transcriptDeltaCount ?? 0,
            forwarded,
          });
          enqueueTranscript({
            role: 'assistant',
            text,
            providerMessageId,
            providerEventId: buffered?.transcriptEventId,
          });
        }
        awaitingAssistant = false;
        const endAfterPlayback = userFarewellResponse || assistantEndedInterview || hardLimitReached || modelComplete;
        const endReason = hardLimitReached
          ? 'timeout'
          : userFarewellResponse
            ? 'user_confirmed'
            : modelComplete
              ? 'model_complete'
              : assistantEndedInterview
                ? 'assistant_farewell'
                : undefined;
        send({
          type: 'response_done',
          responseId,
          status,
          endAfterPlayback,
          endReason,
          ...(selectedAdapter?.capabilities.manualTurnControl ? { manualInputReady } : {}),
        });
        if (closingResponse && !modelComplete && onboarding && !hardLimitReached && !userConfirmedEnding && !text.trim()) {
          if (onboardingCloseResponseRetries < 1) {
            onboardingCloseResponseRetries += 1;
            onboardingCompletionCloseResponseId = undefined;
            awaitingOnboardingCompletionClose = true;
            awaitingAssistant = true;
            const retries = selectedAdapter?.requestAssistantTurnMessages(
              '请用一句简短、自然的中文礼貌收尾，告诉用户你已经大致了解其人生框架，不要再提出问题。',
            ) ?? [];
            sendProviderMessages(retries);
          } else {
            awaitingOnboardingCompletionClose = false;
            onboardingCompletionCloseResponseId = undefined;
            send({ type: 'error', message: '采访已收到完成信号，但收尾语音没有生成；可以手动结束并保留记录。' });
          }
        } else if (endAfterPlayback) {
          if (autoEndFallbackTimer) clearTimeout(autoEndFallbackTimer);
          autoEndFallbackTimer = setTimeout(() => {
            void finishSession(endReason === 'model_complete'
              ? 'model_complete'
              : endReason === 'timeout'
                ? 'timeout'
                : endReason === 'user_confirmed'
                  ? 'user_confirmed'
                  : 'assistant_farewell');
          }, 30_000);
        } else if (wrapUpPromptPending) {
          wrapUpPromptPending = false;
          setImmediate(() => requestProviderWrapUp(false));
        }
      } else {
        awaitingAssistant = false;
        if (userFarewellResponse) {
          recordTrace('session.spoken_end_response_failed', { responseId, status });
          void finishSession('user_confirmed');
        }
        if (onboardingCompletionCloseResponseId === responseId) {
          awaitingOnboardingCompletionClose = false;
          onboardingCompletionCloseResponseId = undefined;
        }
        if (pendingOnboardingCompletionRequest?.responseId === responseId) {
          pendingOnboardingCompletionRequest = undefined;
        }
        send({
          type: 'response_done',
          responseId,
          status,
          message: event.message ?? 'Realtime 回复未完成。',
          ...(selectedAdapter?.capabilities.manualTurnControl ? { manualInputReady } : {}),
        });
      }
      assistantResponses.delete(responseId);
    }
  };

  const failStartup = (error: Error): void => {
    if (phase !== 'connecting') return;
    phase = 'failed';
    if (startupTimeout) clearTimeout(startupTimeout);
    startupReject?.(error);
    send({ type: 'error', message: error.message });
    if (provider && provider.readyState === WebSocket.OPEN) provider.close(1011, 'startup failed');
  };

  const finishProviderSession = async (): Promise<boolean> => {
    if (!provider || provider.readyState !== WebSocket.OPEN) return false;
    const plan = selectedAdapter?.closePlan() ?? null;
    if (!plan) return true;

    let finished: Promise<boolean> | undefined;
    if (plan.waitFor === 'session.closed') {
      let resolveFinished!: (received: boolean) => void;
      finished = new Promise<boolean>((resolve) => { resolveFinished = resolve; });
      sessionClosedResolver = resolveFinished;
    }

    const sent = await executeProviderSteps(plan.steps);
    if (!sent) {
      sessionClosedResolver = undefined;
      return false;
    }
    if (!finished) return true;

    let timeout: NodeJS.Timeout | undefined;
    const received = await Promise.race([
      finished,
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), plan.timeoutMs ?? 5_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    sessionClosedResolver = undefined;
    return received;
  };

  const waitForProviderDrain = async (): Promise<boolean> => {
    const startedAt = Date.now();
    const quietThresholdMs = manualEndRequested ? MANUAL_END_QUIET_MS : END_QUIET_MS;
    let observedEventAfterEnd = false;
    while (Date.now() - startedAt < END_DRAIN_MAX_MS) {
      const waitingForAssistant = !manualEndRequested && (awaitingAssistant || activeResponses.size > 0);
      const busy = pendingSpeech || awaitingUserTranscript || waitingForAssistant;
      const quietFor = Date.now() - lastProviderActivityAt;
      if (quietFor < quietThresholdMs) observedEventAfterEnd = true;
      if (!busy && quietFor >= quietThresholdMs && (observedEventAfterEnd || Date.now() - startedAt >= quietThresholdMs)) {
        return true;
      }
      await delay(100);
    }
    return false;
  };

  const finishSession = (
    reason: 'user' | 'user_confirmed' | 'assistant_farewell' | 'timeout' | 'client_disconnected' | 'provider_disconnected' | 'model_complete',
  ): Promise<void> => {
    if (endingPromise) return endingPromise;
    endingPromise = (async () => {
      slowCoordinator.cancel();
      activeCoachController?.abort('session-ended');
      activeCoachController = undefined;
      if (phase === 'connecting') {
        phase = 'failed';
        startupReject?.(new Error('采访连接尚未完成，已取消启动。'));
        provider?.close(1000, 'client ended before ready');
        return;
      }
      if (phase !== 'active' || !interviewSession) return;
      if (reason === 'model_complete'
        && (interviewSession.sessionType !== 'onboarding' || !modelCompletionReady)) {
        send({ type: 'error', message: '当前采访尚未收到完整的建档完成信号。' });
        return;
      }
      if (!interviewCore.canEnd(reason)) {
        send({ type: 'error', message: '当前采访策略暂不允许结束。' });
        return;
      }
      phase = 'ending';
      toolCycleTracker.finishAll(
        reason === 'provider_disconnected' ? 'provider_disconnected' : 'session_ended',
        reason,
      );
      pendingNextTurnContext = undefined;
      manualEndRequested = reason === 'user';
      if (manualEndRequested) awaitingAssistant = false;
      acceptingAudio = false;
      clearSessionTimers();
      flushMicrophoneTrace(true);
      recordTrace('session.ending', { reason, responseActive: activeResponses.size > 0 });
      send({ type: 'status', status: 'ending', reason });

      if (provider?.readyState === WebSocket.OPEN) {
        await executeProviderSteps(selectedAdapter?.beginInputShutdown({
          commitPendingInput: manualEndRequested
            && (pendingSpeech || awaitingUserTranscript)
            && !manualTurnCommitSent,
        }) ?? []);
      }

      let drained = reason === 'provider_disconnected' ? false : await waitForProviderDrain();
      recordTrace('provider.drain_completed', {
        reason,
        drained,
        responseActive: activeResponses.size > 0,
        activeResponseCount: activeResponses.size,
        pendingSpeech,
        awaitingUserTranscript,
        awaitingAssistant,
      });
      if (reason !== 'provider_disconnected') {
        drained = (await finishProviderSession()) && drained;
      }
      await transcriptWriteTail;

      const endedSessionId = interviewSession?.sessionId;
      let transcriptCount = 0;
      let endError: string | undefined;
      let closeoutError: string | undefined;
      let closeout: Record<string, unknown> = { status: 'skipped' };
      let onboardingStatus = 'in_progress';
      let onboardingCloseoutStatus = 'pending';
      try {
        transcriptCount = endRealtimeInterviewSession(
          config.databasePath,
          authContext.userId,
          interviewSession.sessionId,
          undefined,
          {
            onboardingCompletionEligible: interviewSession.sessionType === 'onboarding' && reason === 'model_complete',
            onboardingTranscriptComplete: interviewSession.sessionType === 'onboarding'
              && reason === 'model_complete'
              && drained
              && transcriptWriteErrors.length === 0,
          },
        );
      } catch (error) {
        endError = error instanceof Error ? error.message : '结束 Session 时写入失败。';
      }
      if (!endError && transcriptWriteErrors.length === 0 && drained && endedSessionId
        && sessionContext?.interview_type !== 'external_contributor') {
        const indexService = dependencies.retrieverIndex;
        if (indexService) {
          const indexStartedAt = performance.now();
          recordTrace('retriever.index_scheduled', { sessionId: endedSessionId });
          void (async () => {
            const outcome = await indexService.indexSessionTranscript(authContext.userId, endedSessionId);
            const settled = outcome.status === 'indexing'
              ? await indexService.waitForIndex(authContext.userId, endedSessionId)
              : outcome;
            recordTrace('retriever.index_finished', {
              status: settled?.status ?? outcome.status,
              jobId: settled?.jobId ?? outcome.jobId,
              documentId: settled?.documentId ?? outcome.documentId,
              errorCode: settled?.errorCode ?? outcome.errorCode,
              latencyMs: performance.now() - indexStartedAt,
            });
            await traceWriter?.flush();
          })().catch((error) => {
            recordTrace('retriever.index_failed', {
              status: 'failed',
              errorCode: error && typeof error === 'object' && 'code' in error
                && typeof (error as { code?: unknown }).code === 'string'
                ? (error as { code: string }).code
                : error instanceof Error ? error.name : 'unknown',
              latencyMs: performance.now() - indexStartedAt,
            });
            void traceWriter?.flush();
          });
        } else {
          recordTrace('retriever.index_skipped', { reason: 'not_configured' });
        }
      } else if (!endError && transcriptWriteErrors.length === 0 && drained && endedSessionId
        && sessionContext?.interview_type === 'external_contributor') {
        recordTrace('retriever.index_skipped', {
          sessionId: endedSessionId,
          reason: 'external_contributor',
        });
      }
      if (interviewSession.sessionType === 'onboarding') {
        if (reason === 'model_complete') {
          if (endError || transcriptWriteErrors.length > 0 || !drained) {
            closeoutError = endError
              ? '访谈结束时未能确认 Transcript 已可靠保存，建档整理已暂停。'
              : transcriptWriteErrors.length > 0
                ? '有访谈字幕未能保存，建档整理已暂停。'
                : '实时访谈收尾未能确认完整，建档整理已暂停。';
            closeout = {
              status: 'failed',
              error: closeoutError,
              code: endError ? 'SESSION_END_FAILED' : transcriptWriteErrors.length > 0 ? 'TRANSCRIPT_WRITE_INCOMPLETE' : 'TRANSCRIPT_DRAIN_INCOMPLETE',
            };
            onboardingCloseoutStatus = 'failed';
            try {
              failOnboardingCloseout(
                config.databasePath,
                interviewSession.sessionId,
                String(closeout.code),
                closeoutError,
                authContext.userId,
              );
            } catch (failure) {
              recordTrace('onboarding.closeout_failed_state_write_error', {
                reason: failure instanceof Error ? failure.name : 'unknown',
              });
            }
          } else {
            try {
              const started = beginOnboardingCloseout(
                config.databasePath,
                interviewSession.sessionId,
                onboardingCloseoutModelConfig(config),
                authContext.userId,
                dependencies.onboardingCloseout,
              );
              closeout = {
                status: started.status,
                ...(started.status === 'processing' ? { alreadyProcessing: started.alreadyProcessing } : {}),
                ...(started.status === 'processing' && started.attemptId ? { attemptId: started.attemptId } : {}),
                ...(started.status === 'failed' ? { error: started.error.message, code: started.error.code } : {}),
              };
              if (started.status === 'failed') closeoutError = started.error.message;
              onboardingCloseoutStatus = started.status;
            } catch (error) {
              closeoutError = error instanceof Error ? error.message : '首次建档整理未能启动。';
              const code = error instanceof OnboardingWorkflowError ? error.code : 'ONBOARDING_CLOSEOUT_START_FAILED';
              closeout = { status: 'failed', error: closeoutError, code };
              onboardingCloseoutStatus = 'failed';
              try {
                failOnboardingCloseout(config.databasePath, interviewSession.sessionId, code, closeoutError, authContext.userId);
              } catch (failure) {
                recordTrace('onboarding.closeout_failed_state_write_error', {
                  reason: failure instanceof Error ? failure.name : 'unknown',
                });
              }
            }
          }
          try {
            const result = getOnboardingResult(config.databasePath, authContext.userId, interviewSession.sessionId);
            onboardingStatus = result.onboarding_status ?? 'in_progress';
            onboardingCloseoutStatus = result.session?.closeout_status ?? onboardingCloseoutStatus;
          } catch {
            // Keep the best-known lifecycle values in the terminal message if a result read fails.
          }
        }
      } else if (sessionContext?.interview_type === 'external_contributor' && !endError
        && transcriptWriteErrors.length === 0 && drained) {
        closeout = { status: 'processing' };
        send({ type: 'status', status: 'ending', reason: 'external_closeout' });
        try {
          await runExternalContributorCloseout({
            databasePath: config.databasePath,
            userId: authContext.userId,
            sessionId: interviewSession.sessionId,
            config: closeoutModelConfig(config),
            textModelProvider: dependencies.closeout?.textModelProvider,
            agentTaskPort: dependencies.agentTasks ?? undefined,
          });
          closeout = { status: 'completed' };
        } catch (error) {
          closeoutError = error instanceof Error ? error.message : '亲友补充整理失败。';
          closeout = {
            status: 'failed',
            error: closeoutError,
            code: 'EXTERNAL_CONTRIBUTOR_CLOSEOUT_FAILED',
          };
        }
      } else if (sessionContext?.interview_type === 'external_contributor') {
        const reasonCode = endError
          ? 'SESSION_END_FAILED'
          : transcriptWriteErrors.length > 0
            ? 'TRANSCRIPT_WRITE_INCOMPLETE'
            : 'TRANSCRIPT_DRAIN_INCOMPLETE';
        const reasonText = endError
          ? '访谈结束时未能确认 Transcript 已可靠保存。'
          : transcriptWriteErrors.length > 0
            ? '有访谈字幕未能保存，亲友补充整理已暂停。'
            : '实时访谈收尾未能确认完整，亲友补充整理已暂停。';
        closeoutError = reasonText;
        closeout = { status: 'failed', error: reasonText, code: reasonCode };
        markExternalContributorSessionCloseout(
          config.databasePath,
          authContext.userId,
          interviewSession.sessionId,
          'failed',
          { source_type: 'external_contributor', error: reasonCode },
        );
      } else if (endError) {
        const reasonText = '访谈结束时未能确认 Transcript 已可靠保存，访谈整理已暂停。';
        closeoutError = reasonText;
        closeout = { status: 'failed', error: reasonText, code: 'SESSION_END_FAILED' };
        try {
          failInterviewCloseout(config.databasePath, interviewSession.sessionId, 'SESSION_END_FAILED', reasonText, authContext.userId);
        } catch (failure) {
          recordTrace('closeout.failed_state_write_error', {
            reason: failure instanceof Error ? failure.name : 'unknown',
          });
        }
      } else if (transcriptWriteErrors.length > 0 || !drained) {
        const reasonCode = transcriptWriteErrors.length > 0 ? 'TRANSCRIPT_WRITE_INCOMPLETE' : 'TRANSCRIPT_DRAIN_INCOMPLETE';
        const reasonText = transcriptWriteErrors.length > 0
          ? '有访谈字幕未能保存，完整记录尚未就绪；请检查 Transcript 后再重新整理。'
          : '实时访谈收尾未能确认完整，整理已暂停；请检查 Transcript 后再重新整理。';
        closeoutError = reasonText;
        closeout = { status: 'failed', error: reasonText, code: reasonCode };
        try {
          failInterviewCloseout(config.databasePath, interviewSession.sessionId, reasonCode, reasonText, authContext.userId);
        } catch (error) {
          recordTrace('closeout.failed_state_write_error', {
            reason: error instanceof Error ? error.name : 'unknown',
          });
        }
      } else {
        try {
          const started = beginInterviewCloseout(
            config.databasePath,
            interviewSession.sessionId,
            closeoutModelConfig(config),
            authContext.userId,
            dependencies.closeout,
          );
          closeout = {
            ...closeout,
            status: started.status,
            alreadyProcessing: started.status === 'processing' ? started.alreadyProcessing : undefined,
            ...(started.status === 'processing' && started.attemptId ? { attemptId: started.attemptId } : {}),
          };
        } catch (error) {
          closeoutError = error instanceof Error ? error.message : '会后故事整理未能启动。';
          closeout = {
            status: 'failed',
            error: closeoutError,
            code: error instanceof CloseoutWorkflowError ? error.code : 'CLOSEOUT_START_FAILED',
          };
        }
      }

      phase = 'ended';
      recordTrace('session.ended', {
        reason,
        closeoutStatus: typeof closeout.status === 'string' ? closeout.status : undefined,
        attemptId: typeof closeout.attemptId === 'string' ? closeout.attemptId : undefined,
        closeoutErrorCode: typeof closeout.code === 'string' ? closeout.code : undefined,
        transcriptCount,
        savedTranscriptCount,
        pendingWriteCount,
        drainTimedOut: !drained,
      });
      await traceWriter?.flush();
      const result = {
        type: 'ended',
        sessionId: interviewSession.sessionId,
        session_type: interviewSession.sessionType,
        ...(interviewSession.sessionType === 'onboarding' ? {
          end_reason: reason,
          onboarding_status: onboardingStatus,
          closeout_status: onboardingCloseoutStatus,
        } : {}),
        transcriptCount,
        savedTranscriptCount,
        pendingWriteCount,
        transcriptSaveErrors: transcriptWriteErrors,
        drainTimedOut: !drained,
        endError,
        closeoutError,
        closeout,
        external_contributor: sessionContext?.interview_type === 'external_contributor',
        resultUrl: sessionContext?.interview_type === 'external_contributor'
          ? undefined
          : interviewSession.sessionType === 'onboarding'
            ? reason === 'model_complete'
              ? `/onboarding/processing?session_id=${encodeURIComponent(interviewSession.sessionId)}`
              : '/onboarding'
            : `/interview/result?session_id=${encodeURIComponent(interviewSession.sessionId)}`,
      };
      send(result);

      if (provider && provider.readyState === WebSocket.OPEN) {
        provider.close(1000, 'interview ended');
      }
    })();
    return endingPromise;
  };

  const sendOpeningWithWatchdog = (): void => {
    if (!clientPlaybackReady || !openingRequest || !provider || provider.readyState !== WebSocket.OPEN || phase !== 'active') return;
    if (!openingPreludeSent) {
      const prelude = selectedAdapter?.openingPreludeMessages?.() ?? [];
      if (prelude.length > 0 && !sendProviderMessages(prelude)) return;
      openingPreludeSent = true;
    }
    openingAttemptCount += 1;
    if (!sendProviderMessage(openingRequest)) return;
    recordTrace('opening.sent', { attempt: openingAttemptCount });
    if (openingResponseTimer) clearTimeout(openingResponseTimer);
    const timeoutMs = config.openingResponseTimeoutMs ?? DEFAULT_OPENING_RESPONSE_TIMEOUT_MS;
    openingResponseTimer = setTimeout(() => {
      openingResponseTimer = undefined;
      if (phase !== 'active' || activeResponses.size > 0 || !openingRequest) return;
      if (openingAttemptCount < 2) {
        recordTrace('opening.response_timeout', { attempt: openingAttemptCount, retrying: true, timeoutMs });
        sendOpeningWithWatchdog();
        return;
      }
      recordTrace('opening.response_timeout', { attempt: openingAttemptCount, retrying: false, timeoutMs });
      send({ type: 'error', message: '语音服务未能开始首轮回应，请重新开始采访。' });
      void finishSession('provider_disconnected');
    }, timeoutMs);
  };

  const startInterview = async (
    target: InterviewStartInput,
    requestedProvider: unknown,
  ): Promise<void> => {
    if (phase !== 'idle') {
      send({ type: 'error', message: '此连接已经开始采访或已结束。' });
      return;
    }
    const requestedId = requestedProvider === undefined
      ? config.defaultRealtimeProvider ?? 'stepaudio2_mini'
      : requestedProvider;
    if (!isRealtimeProviderId(requestedId)) {
      phase = 'failed';
      send({ type: 'error', message: '不支持的语音 Provider；请选择 StepAudio 3、Step-Audio-2-mini、Qwen 或实验性 ModelBest。' });
      return;
    }
    const providerName: RealtimeInterviewProvider = requestedId;
    selectedProvider = providerName;

    phase = 'connecting';
    let context: RealtimeInterviewContext;
    try {
      const preparedContext = interviewCore.prepare(authContext.userId, target);
      context = {
        ...preparedContext,
        memoryTriggerMode: resolveRealtimeMemoryTriggerMode(providerName, config.realtimeMemoryTriggerMode),
        ...(providerName === 'stepaudio3_quality'
          ? { voiceProfile: 'stepaudio3_quality' as const }
          : providerName === 'stepaudio2_mini' || providerName === 'stepfun'
            ? { voiceProfile: 'stepaudio2_mini' as const }
            : {}),
      };
      sessionContext = context;
    } catch (error) {
      phase = 'failed';
      send({
        type: 'error',
        message: error instanceof InterviewContextError || error instanceof Error
          ? error.message
          : '无法读取采访上下文。',
      });
      return;
    }

    let connection: { url: string; headers: Record<string, string> };
    try {
      selectedAdapter = (dependencies.realtimeProviderFactory ?? createRealtimeInterviewProvider)(
        providerName,
        resolveRealtimeProviderConfig(providerName, config),
      );
      connection = selectedAdapter.connectOptions();
    } catch (error) {
      phase = 'failed';
      send({
        type: 'error',
        message: error instanceof Error ? error.message : 'Realtime 配置无效。',
      });
      return;
    }

    provider = new WebSocket(connection.url, {
      headers: connection.headers,
      handshakeTimeout: 15_000,
      maxPayload: 2 * 1024 * 1024,
    });

    let resolveConfigured!: () => void;
    let rejectConfigured!: (error: Error) => void;
    const configured = new Promise<void>((resolve, reject) => {
      resolveConfigured = resolve;
      rejectConfigured = reject;
    });
    startupResolve = resolveConfigured;
    startupReject = rejectConfigured;
    startupTimeout = setTimeout(() => {
      rejectConfigured(new Error(providerConnectionFailureMessage({ kind: 'timeout' })));
    }, 20_000);

    provider.on('open', () => {
      if (!provider || provider.readyState !== WebSocket.OPEN) return;
      if (selectedAdapter?.requiresQueueBeforeSessionInit) return;
      providerSessionInitSent = true;
      sendProviderMessages(selectedAdapter?.setupSession(context) ?? []);
    });
    provider.on('message', (raw) => {
      const events = selectedAdapter?.normalizeServerMessage(raw) ?? [];
      for (const event of events) handleNormalizedRealtimeEvent(event);
    });
    provider.on('unexpected-response', (_request, response) => {
      const statusCode = response.statusCode;
      response.resume();
      rejectConfigured(new Error(providerConnectionFailureMessage({
        kind: 'unexpected-response',
        statusCode,
      })));
    });
    provider.on('error', (error) => {
      const message = providerConnectionFailureMessage({ kind: 'socket-error', message: error.message });
      if (phase === 'connecting') {
        rejectConfigured(new Error(message));
      } else if (phase === 'active') {
        send({ type: 'error', message });
      }
    });
    provider.on('close', (code) => {
      sessionClosedResolver?.(false);
      if (phase === 'connecting') {
        rejectConfigured(new Error(providerConnectionFailureMessage({
          kind: 'socket-close',
          code,
          phase: 'connect',
        })));
      } else if (phase === 'active') {
        send({
          type: 'error',
          message: providerConnectionFailureMessage({
            kind: 'socket-close',
            code,
            phase: 'stream',
          }),
        });
        void finishSession('provider_disconnected');
      }
    });

    try {
      await configured;
      if (phase !== 'connecting' || client.readyState !== WebSocket.OPEN) {
        throw new Error('浏览器连接已关闭，采访启动已取消。');
      }
      if (startupTimeout) clearTimeout(startupTimeout);
      startupResolve = undefined;
      startupReject = undefined;
      interviewSession = interviewCore.start(authContext.userId, context, providerName);
      if (pendingProviderSessionId) {
        try {
          interviewSessionRepository.setProviderSessionIdForUser(authContext.userId, interviewSession.sessionId, pendingProviderSessionId);
        } catch {
          recordTrace('provider.session_id_persist_failed', { provider: providerName });
        }
        pendingProviderSessionId = undefined;
      }
      const traceDirectory = resolveDiagnosticsPath('traces', 'realtime');
      traceWriter = createRealtimeTraceWriter({
        directory: traceDirectory,
        sessionId: interviewSession.sessionId,
        provider: providerName,
      });
      observationProvider = providerName;
      recordTrace('session.started', {
        lifecycle: phase,
        voiceProfile: providerName === 'stepaudio3_quality'
          ? 'stepaudio3_quality'
          : providerName === 'stepaudio2_mini' || providerName === 'stepfun'
            ? 'stepaudio2_mini'
            : providerName,
        voiceModel: providerName === 'stepaudio3_quality'
          ? 'StepAudio 3'
          : providerName === 'stepaudio2_mini' || providerName === 'stepfun'
            ? 'Step-Audio-2-mini'
            : providerName,
        memoryTriggerMode: sessionContext?.memoryTriggerMode
          ?? resolveRealtimeMemoryTriggerMode(providerName, config.realtimeMemoryTriggerMode),
        ...(providerName === 'stepaudio2_mini' || providerName === 'stepfun'
          ? { coachModel: config.realtimeCoachModel ?? 'qwen3-8b' }
          : {}),
        retriever: config.realtimeRetrieverEnabled ? 'enabled' : 'disabled',
        contextAgent: config.realtimeContextAgentEnabled ? 'enabled' : 'disabled',
        contextInjection: selectedAdapter?.capabilities.supportsContextInjection ? 'supported' : 'unsupported',
      });
      recordTrace('provider.session_ready', { provider: providerName });
      if (selectedAdapter?.capabilities.manualTurnControl) {
        recordTrace('provider.turn_detection_requested', { turnDetectionMode: 'manual' });
        if (pendingTurnDetectionMode !== undefined) {
          recordTrace('provider.turn_detection_acknowledged', {
            turnDetectionMode: pendingTurnDetectionMode,
          });
          pendingTurnDetectionMode = undefined;
        }
      }
      if (playbackReadyTracePending) {
        recordTrace('client.playback_ready', {
          providerReadyBeforePlaybackReady: providerSessionReadyAt !== undefined
            && clientPlaybackReadyAt !== undefined
            && providerSessionReadyAt <= clientPlaybackReadyAt,
        });
        playbackReadyTracePending = false;
      }
      phase = 'active';
      acceptingAudio = true;
      const wrapUpMs = config.wrapUpMs ?? DEFAULT_WRAPUP_MS;
      const maxSessionMs = config.maxSessionMs ?? DEFAULT_MAX_SESSION_MS;
      const closeGraceMs = config.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
      wrapUpTimer = setTimeout(() => {
        if (phase !== 'active') return;
        recordTrace('session.wrapup_started', { remainingMs: maxSessionMs - wrapUpMs });
        send({ type: 'time_warning', remainingMs: maxSessionMs - wrapUpMs });
        if (pendingSpeech || awaitingUserTranscript || awaitingAssistant || activeResponses.size > 0) {
          wrapUpPromptPending = true;
        } else {
          requestProviderWrapUp(false);
        }
      }, wrapUpMs);
      hardLimitTimer = setTimeout(() => {
        if (phase !== 'active') return;
        hardLimitReached = true;
        wrapUpPromptPending = false;
        const finishingCurrentUserTurn = pendingSpeech || awaitingUserTranscript;
        acceptingAudio = finishingCurrentUserTurn;
        recordTrace('session.hard_limit_reached', {
          finishingCurrentUserTurn,
          responseActive: activeResponses.size > 0,
          closeGraceMs,
        });
        send({ type: 'time_limit_reached', graceMs: closeGraceMs });
        if (!finishingCurrentUserTurn && !awaitingAssistant && activeResponses.size === 0) {
          requestProviderWrapUp(true);
        }
        closeGraceTimer = setTimeout(() => void finishSession('timeout'), closeGraceMs);
      }, maxSessionMs);
      send({
        type: 'ready',
        session_type: interviewSession.sessionType,
        provider: providerName,
        sessionId: interviewSession.sessionId,
        ...(context.interview_type === 'onboarding'
          ? { profile: context.profile, onboarding_mode: context.taskContext.mode }
          : context.interview_type === 'external_contributor'
            ? {
                story: {
                  title: context.story.title,
                  summary: context.story.summary,
                  status: context.story.status,
                  gaps: context.story.gaps,
                },
                relationship: context.relationship,
                external_contributor: true,
              }
            : {
                story: context.story ? { title: context.story.title } : null,
                user: context.user,
              }),
        startedAt: interviewSession.startedAt,
        wrapUpMs,
        maxSessionMs,
        ...(selectedAdapter?.capabilities.manualTurnControl ? {
          manualTurnControl: true,
          localVadSilenceTimeoutMs: config.realtimeLocalSilenceTimeoutMs ?? DEFAULT_REALTIME_LOCAL_SILENCE_TIMEOUT_MS,
        } : {}),
      });
      sendTechStatus({
        stage: 'fast_voice',
        status: 'completed',
        model: providerName === 'stepaudio3_quality'
          ? config.stepaudio3Model ?? DEFAULT_STEPAUDIO3_MODEL
          : providerName === 'stepfun' || providerName === 'stepaudio2_mini'
            ? config.stepfunModel ?? DEFAULT_STEPFUN_MODEL
            : providerName === 'modelbest'
              ? config.modelbestModel ?? DEFAULT_MODELBEST_MODEL
              : config.qwenModel ?? DEFAULT_QWEN_MODEL,
      });
      if (provider?.readyState === WebSocket.OPEN && selectedAdapter?.capabilities.supportsExplicitTurnRequest) {
        const opening = selectedAdapter.initialResponsePlan(context);
        openingRequest = opening.steps[0]?.message;
        openingAttemptCount = 0;
        if (openingRequest) sendOpeningWithWatchdog();
      }
    } catch (error) {
      if (startupTimeout) clearTimeout(startupTimeout);
      startupResolve = undefined;
      startupReject = undefined;
      failStartup(error instanceof Error ? error : new Error('采访连接初始化失败。'));
    }
  };

  client.on('message', (data, isBinary) => {
    if (isBinary) {
      const manualAudioAllowed = !selectedAdapter?.capabilities.manualTurnControl
        || (pendingSpeech && !awaitingAssistant && activeResponses.size === 0);
      if (phase === 'active' && acceptingAudio && manualAudioAllowed && provider?.readyState === WebSocket.OPEN) {
        const audio = asBuffer(data);
        if (audio.length > 0 && audio.length <= 64 * 1024) {
          sendProviderMessages(selectedAdapter?.appendAudioMessages(audio) ?? []);
          microphoneTraceFrames += 1;
          microphoneTraceBytes += audio.byteLength;
          const samples = Math.floor(audio.byteLength / 2);
          const packetRms = pcm16Rms(audio);
          microphoneTracePower += packetRms * packetRms * samples;
          microphoneTraceSamples += samples;
          microphoneTraceMaxRms = Math.max(microphoneTraceMaxRms, packetRms);
          const now = performance.now();
          microphonePacketCount += 1;
          lastMicrophonePacketAt = now;
          const intervalMs = now - microphoneTraceWindowAt;
          if (intervalMs >= 1_000) {
            flushMicrophoneTrace();
          }
        }
      }
      return;
    }

    let command: Record<string, unknown>;
    try {
      command = record(JSON.parse(asBuffer(data).toString('utf8'))) ?? {};
    } catch {
      send({ type: 'error', message: '本机服务收到无法识别的控制消息。' });
      return;
    }

    if (command.type === 'diagnostic_trace') {
      const event = typeof command.event === 'string' ? command.event : '';
      if (!CLIENT_TRACE_EVENTS.has(event)) return;
      const details = record(command.details) ?? {};
      const clientElapsedMs = typeof command.clientElapsedMs === 'number'
        ? command.clientElapsedMs
        : undefined;
      recordTrace(`client.${event}`, { ...details, clientElapsedMs });
      return;
    }

    if (command.type === 'manual_turn_started') {
      if (phase !== 'active' || !selectedAdapter?.capabilities.manualTurnControl
        || !manualInputReadyForTurn || pendingSpeech || awaitingUserTranscript || awaitingAssistant || activeResponses.size > 0) return;
      manualInputReadyForTurn = false;
      handleNormalizedRealtimeEvent({ type: 'speech.started' });
      return;
    }

    if (command.type === 'manual_turn_commit') {
      const silenceObservedMs = typeof command.silenceObservedMs === 'number'
        ? command.silenceObservedMs
        : Number.NaN;
      const minimumSilenceMs = config.realtimeLocalSilenceTimeoutMs ?? DEFAULT_REALTIME_LOCAL_SILENCE_TIMEOUT_MS;
      const supervisorMode = supervisorAutoSelected();
      const commitSteps = supervisorMode && selectedAdapter?.commitInputTurn
        ? selectedAdapter.commitInputTurn()
        : selectedAdapter?.commitAndRespondToInputTurn?.();
      if (phase !== 'active' || !selectedAdapter?.capabilities.manualTurnControl
        || !commitSteps || commitSteps.length === 0 || !pendingSpeech || !awaitingUserTranscript
        || manualTurnCommitPending || !Number.isFinite(silenceObservedMs) || silenceObservedMs < minimumSilenceMs) return;
      manualTurnCommitPending = true;
      recordTrace('realtime.local_vad_commit_accepted', {
        silenceObservedMs: Math.round(silenceObservedMs),
        silenceThresholdMs: minimumSilenceMs,
      });
      if (!supervisorMode) consumePendingNextTurnContext();
      slowCoordinator.cancel();
      void executeProviderSteps(commitSteps).then((sent) => {
        manualTurnCommitSent = sent;
        recordTrace('realtime.local_vad_commit_sent', { sent });
      });
      return;
    }

    if (command.type === 'playback_ready') {
      if (phase !== 'connecting' && phase !== 'active') return;
      if (!clientPlaybackReady) {
        clientPlaybackReady = true;
        clientPlaybackReadyAt = performance.now();
        if (traceWriter) {
          recordTrace('client.playback_ready', {
            providerReadyBeforePlaybackReady: providerSessionReadyAt !== undefined
              && providerSessionReadyAt <= clientPlaybackReadyAt,
          });
        } else playbackReadyTracePending = true;
      }
      if (phase === 'active') sendOpeningWithWatchdog();
      return;
    }

    if (command.type === 'start') {
      if (isExternalContributor) {
        if (command.interview_type !== 'external_contributor' || !access.externalShareId) {
          send({ type: 'error', message: '外部补充采访只能通过当前分享链接启动。' });
          return;
        }
        void startInterview({
          interview_type: 'external_contributor',
          shareId: access.externalShareId,
        }, command.provider);
        return;
      }
      if (command.interview_type === 'onboarding') {
        if (command.story_id !== undefined || command.stage_id !== undefined) {
          send({ type: 'error', message: 'Onboarding start 不能同时指定 Story 或人生阶段。' });
          return;
        }
        void startInterview({ interview_type: 'onboarding' }, command.provider);
        return;
      }
      if (command.interview_type !== undefined) {
        send({ type: 'error', message: '不支持的采访类型。' });
        return;
      }
      if (typeof command.story_id === 'string' && command.story_id.trim()) {
        void startInterview({
          interview_type: 'story',
          target: { mode: 'continue', storyId: command.story_id.trim() },
        }, command.provider);
        return;
      }
      if (typeof command.stage_id === 'string' && command.stage_id.trim()) {
        const title = typeof command.story_title === 'string' ? command.story_title.trim() : undefined;
        if (title && title.length > 80) {
          send({ type: 'error', message: '新故事标题不能超过 80 个字符。' });
          return;
        }
        void startInterview({
          interview_type: 'story',
          target: { mode: 'create', stageId: command.stage_id.trim(), ...(title ? { title } : {}) },
        }, command.provider);
        return;
      }
      send({ type: 'error', message: '开始 Story 采访需要 story_id 或 stage_id。' });
      return;
    }
    if (command.type === 'end') {
      const reason = command.reason === 'timeout'
        ? 'timeout'
        : command.reason === 'user_confirmed'
          ? 'user_confirmed'
          : command.reason === 'assistant_farewell'
            ? 'assistant_farewell'
            : command.reason === 'model_complete' && modelCompletionReady
              ? 'model_complete'
              : 'user';
      void finishSession(reason);
      return;
    }
    if (command.type === 'ping') {
      send({ type: 'pong' });
      return;
    }
    send({ type: 'error', message: '不支持的采访控制消息。' });
  });

  client.on('close', () => {
    if (phase === 'active') void finishSession('client_disconnected');
    else if (phase === 'connecting') {
      startupReject?.(new Error('浏览器连接已关闭，采访启动已取消。'));
      provider?.close(1000, 'browser disconnected');
    }
  });
  client.on('error', () => {
    if (phase === 'active') void finishSession('client_disconnected');
  });
};

export function createInterviewServiceServer(
  config = readRuntimeConfig(),
  dependencies: InterviewServiceDependencies = {},
) {
  const realtimeMemoryTriggerMode = parseRealtimeMemoryTriggerMode(config.realtimeMemoryTriggerMode);
  if (!Number.isInteger(config.realtimeSlowDeadlineMs ?? DEFAULT_REALTIME_SLOW_DEADLINE_MS)
    || (config.realtimeSlowDeadlineMs ?? DEFAULT_REALTIME_SLOW_DEADLINE_MS) <= 0
    || (config.realtimeSlowDeadlineMs ?? DEFAULT_REALTIME_SLOW_DEADLINE_MS) > DEFAULT_REALTIME_SLOW_DEADLINE_MS) {
    throw new Error('REALTIME_SLOW_DEADLINE_MS must be an integer between 1 and 5000.');
  }
  const loopbackHost = ['127.0.0.1', 'localhost', '::1'].includes(config.host.toLowerCase());
  const realtimeAgentRuntimeAvailable = dependencies.realtimeContextAgentTasks !== undefined
    ? dependencies.realtimeContextAgentTasks !== null
    : dependencies.agentTasks !== undefined
      ? dependencies.agentTasks !== null
      : ['agent', 'stub'].includes(process.env.AI_TASK_RUNTIME?.trim() || 'direct');
  const effectiveConfig: RuntimeConfig = {
    ...config,
    realtimeMemoryTriggerMode,
    realtimeRetrieverEnabled: config.realtimeRetrieverEnabled ?? process.env.NEMO_RETRIEVER_ENABLED?.trim() === 'true',
    realtimeContextAgentEnabled: config.realtimeContextAgentEnabled
      ?? realtimeContextAgentEnabled(process.env.REALTIME_CONTEXT_AGENT_ENABLED, realtimeAgentRuntimeAvailable ? 'agent' : 'direct'),
    authSessionSecret: config.authSessionSecret ?? randomBytes(32).toString('base64url'),
    authMode: config.authMode ?? 'sms',
    developmentAuthEnabled: process.env.NODE_ENV !== 'production'
      && (config.developmentAuthEnabled ?? loopbackHost),
    secureCookies: config.secureCookies ?? process.env.NODE_ENV === 'production',
  };
  const authService = new AuthService({
    databasePath: effectiveConfig.databasePath,
    sessionSecret: effectiveConfig.authSessionSecret!,
    developmentAuthEnabled: effectiveConfig.developmentAuthEnabled === true,
    authMode: effectiveConfig.authMode,
    verificationProvider: effectiveConfig.developmentAuthEnabled
      ? new DevelopmentVerificationProvider()
      : new UnconfiguredSmsVerificationProvider(),
  });
  const observationBus = dependencies.observationBus
    ?? new ObservationBus({ enabled: process.env.OBSERVABILITY_ENABLED?.trim() !== 'false' });
  const runtimeDependencies = createStoryWorkflowDependencies(effectiveConfig, dependencies, observationBus);
  const server = createServer(createHttpHandler(effectiveConfig, authService, runtimeDependencies, observationBus));
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const authBySocket = new WeakMap<WebSocket, AuthContext>();
  const shareBySocket = new WeakMap<WebSocket, { userId: string; shareId: string }>();

  server.on('upgrade', (request, socket, head) => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    } catch {
      socket.destroy();
      return;
    }
    if (requestUrl.pathname !== '/api/realtime') {
      socket.destroy();
      return;
    }

    if (!sameOriginRequest(request)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const shareToken = requestUrl.searchParams.get('share_token')?.trim();
    if (shareToken) {
      const share = new StoryShareRepository(effectiveConfig.databasePath).resolvePublicToken(shareToken);
      if (!share) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      websocketServer.handleUpgrade(request, socket, head, (client) => {
        shareBySocket.set(client, { userId: share.userId, shareId: share.shareId });
        websocketServer.emit('connection', client, request);
      });
      return;
    }

    const authContext = authService.resolveToken(readAuthCookie(request.headers.cookie));
    if (!authContext) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (client) => {
      authBySocket.set(client, authContext);
      websocketServer.emit('connection', client, request);
    });
  });

  websocketServer.on('connection', (client: WebSocket) => {
    const shared = shareBySocket.get(client);
    if (shared) {
      createRealtimeHandler(
        effectiveConfig,
        client,
        { userId: shared.userId },
        runtimeDependencies,
        observationBus,
        { externalShareId: shared.shareId },
      );
      return;
    }
    const authContext = authBySocket.get(client);
    if (!authContext) {
      client.close(1008, 'authentication required');
      return;
    }
    createRealtimeHandler(effectiveConfig, client, authContext, runtimeDependencies, observationBus);
  });
  server.on('close', () => {
    websocketServer.close();
    observationBus.dispose();
  });
  return server;
}

function startServer(): void {
  const config = readRuntimeConfig();
  const server = createInterviewServiceServer(config);
  server.listen(config.port, config.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    console.log(`人生采访局本机语音服务已启动：http://${config.host}:${port}/interview`);
    console.log(`Qwen Realtime 凭据：${config.apiKey && config.workspaceId ? '已配置' : '未配置'}`);
    console.log(`StepFun ${config.stepfunModel ?? DEFAULT_STEPFUN_MODEL} API Key：${config.stepfunApiKey ? '已配置' : '未配置'}`);
    writeDiagnosticLog('server', 'info', 'Interview service started.', {
      host: config.host,
      port,
      databasePath: resolveDatabasePath(config.databasePath),
      realtimeProvider: config.defaultRealtimeProvider ?? 'stepaudio2_mini',
      qwenConfigured: Boolean(config.apiKey && config.workspaceId),
      stepfunConfigured: Boolean(config.stepfunApiKey),
      stepfunModel: config.stepfunModel ?? DEFAULT_STEPFUN_MODEL,
      stepaudio3Model: config.stepaudio3Model ?? DEFAULT_STEPAUDIO3_MODEL,
      textProvider: config.closeoutProvider ?? 'openai-compatible',
      textModel: config.closeoutModel ?? 'qwen3.6-35b-a3b',
      diagnosticsRoot: resolveDiagnosticsPath(),
    });
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startServer();
}
