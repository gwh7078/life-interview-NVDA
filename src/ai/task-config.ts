import {
  DEFAULT_CLOUD_TEXT_BASE_URL,
  isTextRuntimeProviderId,
  type TextRuntimeProviderId,
} from '../models/text-runtime.js';
import { DEFAULT_MODELBEST_MODEL } from '../realtime/modelbest.js';

export type AiTaskName =
  | 'interview.story'
  | 'closeout.story'
  | 'closeout.onboarding'
  | 'completion.story'
  | 'generation.story';

export type RealtimeModelProviderId = 'qwen' | 'stepfun' | 'modelbest';
export interface AiTaskConfig {
  provider: RealtimeModelProviderId | TextRuntimeProviderId;
  model: string;
  parameters: Record<string, string | number | boolean>;
}

export type AiTaskConfigMap = Record<AiTaskName, AiTaskConfig>;

function independentTextTask(
  env: NodeJS.ProcessEnv,
  prefix: 'STORY_COMPLETION' | 'STORY_GENERATION',
  fallback: AiTaskConfig,
): AiTaskConfig {
  const provider = env[`${prefix}_PROVIDER`]?.trim() || fallback.provider;
  if (!isTextRuntimeProviderId(provider)) {
    throw new Error(`${prefix}_PROVIDER must be volcengine-agent-plan or openai-compatible.`);
  }
  return {
    provider,
    model: env[`${prefix}_MODEL`]?.trim() || fallback.model,
    parameters: {
      apiFormat: env[`${prefix}_API_FORMAT`]?.trim() || fallback.parameters.apiFormat || 'chat-completions',
      baseUrl: env[`${prefix}_BASE_URL`]?.trim() || fallback.parameters.baseUrl || DEFAULT_CLOUD_TEXT_BASE_URL,
      timeoutMs: Number(env[`${prefix}_TIMEOUT_MS`] ?? fallback.parameters.timeoutMs ?? 60_000),
    },
  };
}

/** Task-specific model routing. Credentials deliberately remain outside this configuration object. */
export function resolveAiTaskConfig(env: NodeJS.ProcessEnv = process.env): AiTaskConfigMap {
  const interviewProvider = env.STORY_INTERVIEW_PROVIDER?.trim() || 'modelbest';
  if (interviewProvider !== 'qwen' && interviewProvider !== 'stepfun' && interviewProvider !== 'modelbest') {
    throw new Error('STORY_INTERVIEW_PROVIDER must be qwen, stepfun or modelbest.');
  }
  const textProvider = env.TEXT_MODEL_PROVIDER?.trim() || 'openai-compatible';
  if (!isTextRuntimeProviderId(textProvider)) {
    throw new Error('TEXT_MODEL_PROVIDER must be volcengine-agent-plan or openai-compatible.');
  }
  const textModel = env.TEXT_MODEL?.trim() || 'qwen3.6-35b-a3b';
  const textApiFormat = env.TEXT_MODEL_API_FORMAT?.trim() || 'chat-completions';
  const textBaseUrl = env.TEXT_MODEL_BASE_URL?.trim() || DEFAULT_CLOUD_TEXT_BASE_URL;
  const textTimeoutMs = Number(env.TEXT_MODEL_TIMEOUT_MS ?? 60_000);

  const closeoutProvider = env.CLOSEOUT_PROVIDER?.trim() || textProvider;
  if (!isTextRuntimeProviderId(closeoutProvider)) {
    throw new Error('CLOSEOUT_PROVIDER must be volcengine-agent-plan or openai-compatible.');
  }
  const closeoutStory: AiTaskConfig = {
    provider: closeoutProvider,
    model: env.CLOSEOUT_MODEL?.trim() || textModel,
    parameters: {
      apiFormat: env.CLOSEOUT_API_FORMAT?.trim() || textApiFormat,
      baseUrl: env.CLOSEOUT_BASE_URL?.trim() || textBaseUrl,
      timeoutMs: Number(env.CLOSEOUT_TIMEOUT_MS ?? textTimeoutMs),
    },
  };
  const completionStory = independentTextTask(env, 'STORY_COMPLETION', closeoutStory);
  const generationStory = independentTextTask(env, 'STORY_GENERATION', closeoutStory);

  return {
    'interview.story': {
      provider: interviewProvider,
      model: env.STORY_INTERVIEW_MODEL?.trim()
        || (interviewProvider === 'stepfun'
          ? env.STEPFUN_REALTIME_MODEL?.trim() || 'step-audio-2-mini'
          : interviewProvider === 'modelbest'
            ? env.MODELBEST_REALTIME_MODEL?.trim() || DEFAULT_MODELBEST_MODEL
            : env.DASHSCOPE_MODEL?.trim() || 'qwen-audio-3.0-realtime-plus'),
      parameters: {
        region: env.DASHSCOPE_REGION?.trim() || 'cn-beijing',
        workspaceId: env.DASHSCOPE_WORKSPACE_ID?.trim() || '',
      },
    },
    'closeout.story': closeoutStory,
    'closeout.onboarding': {
      provider: closeoutProvider,
      model: env.ONBOARDING_CLOSEOUT_MODEL?.trim() || env.CLOSEOUT_MODEL?.trim() || textModel,
      parameters: {
        apiFormat: env.CLOSEOUT_API_FORMAT?.trim() || textApiFormat,
        baseUrl: env.CLOSEOUT_BASE_URL?.trim() || textBaseUrl,
        timeoutMs: Number(env.CLOSEOUT_TIMEOUT_MS ?? textTimeoutMs),
      },
    },
    'completion.story': completionStory,
    'generation.story': generationStory,
  };
}
