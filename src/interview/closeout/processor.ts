import {
  storyCloseoutJsonSchema,
  storyCreationCloseoutJsonSchema,
} from '../closeout-schema.js';
import {
  CloseoutModelError,
  DEFAULT_CLOSEOUT_MAX_OUTPUT_TOKENS,
  MAX_CLOSEOUT_MAX_OUTPUT_TOKENS,
  type CloseoutModelConfig,
  type CloseoutModelResult,
} from '../llm-provider.js';
import { isLoopbackTextRuntimeUrl } from '../../models/text-runtime.js';
import { OpenAICompatibleTextModelProvider, type TextModelProvider } from '../../providers/text-model-provider.js';
import { CloseoutWorkflowError } from './errors.js';
import type { StoryCloseoutContext } from './context-builder.js';
import { buildStoryCloseoutPrompt } from './prompt-builder.js';
import { StoryCloseoutValidator } from './validator.js';
import type { ValidatedStoryCloseoutOutput } from './types.js';

export interface CloseoutProcessorConfig extends CloseoutModelConfig {
  provider?: string;
}

export interface ProcessStoryCloseoutInput {
  context: StoryCloseoutContext;
  config: CloseoutProcessorConfig;
  signal: AbortSignal;
  assertCurrentAttempt(): void;
  repairLog?: { count: number; recent: Array<{ code: string }> };
}

export interface ProcessStoryCloseoutResult {
  output: ValidatedStoryCloseoutOutput;
  modelResult: CloseoutModelResult;
  repairAttemptCount: number;
}

export interface CloseoutProcessor {
  process(input: ProcessStoryCloseoutInput): Promise<ProcessStoryCloseoutResult>;
}

export const STORY_CLOSEOUT_MAX_MODEL_CALLS = 3;
const MAX_RECORDED_REPAIR_ATTEMPTS = 30;
const RETRY_BACKOFF_BASE_MS = 500;
const RETRY_BACKOFF_MAX_MS = 30_000;

function retryFeedbackFor(error: unknown): Record<string, unknown> {
  const code = error instanceof CloseoutModelError || error instanceof CloseoutWorkflowError ? error.code : 'CLOSEOUT_FAILED';
  const path = error instanceof CloseoutWorkflowError && typeof error.diagnostics?.path === 'string'
    ? error.diagnostics.path
    : undefined;
  const instructions: Record<string, string> = {
    CLOSEOUT_OUTPUT_INVALID: '修正格式、必填字段和长度限制，只提交 Schema 定义的字段。',
    INVALID_SOURCE_MESSAGE_IDS: '来源 ID 必须来自本次 Transcript 的 role=user 消息；只保留确实支持摘要的 ID。',
    SOURCE_MESSAGE_IDS_REQUIRED: '为新建或发生变化的 Story 提供至少一个本次用户消息 ID。',
    UNSUPPORTED_YEAR: '删除输入中没有依据的年份。',
    UNCERTAINTY_NOT_PRESERVED: '保留原文对年份的不确定表达，不要改写成确定年份。',
    INVALID_STORY_STAGE: '为 new_stories 选择输入 life_stages 中存在的 stage_id。',
    DUPLICATE_STORY: '删除与已有故事重复的新故事，或为新建 Story 选择不重复且忠于原话的标题。',
    MODEL_OUTPUT_TRUNCATED: '输出被截断；缩短摘要，只保留必要内容并提交完整 JSON。',
    INVALID_MEMORY_CHANGE: '修正 memory_changes：previous_text/new_text 必须分别逐字来自旧/新 Agent Memory；add/correct/refine/remove 必须引用本轮用户证据，且 add/correct/refine 的新内容必须与引用消息存在直接文本依据。',
    MEMORY_INFORMATION_LOSS: '新版 Agent Memory 丢失了旧信息。恢复未被本轮纠正/删除的旧内容；如确需修改或删除，使用有证据的 memory_changes 明确解释。',
  };
  return { code, ...(path ? { path } : {}), instruction: instructions[code] ?? '根据错误修正后重新提交完整结果。' };
}

function canRetry(error: unknown): boolean {
  if (error instanceof CloseoutModelError) return error.retryable;
  return error instanceof CloseoutWorkflowError && new Set([
    'CLOSEOUT_OUTPUT_INVALID', 'INVALID_SOURCE_MESSAGE_IDS', 'SOURCE_MESSAGE_IDS_REQUIRED',
    'UNSUPPORTED_YEAR', 'UNCERTAINTY_NOT_PRESERVED', 'INVALID_STORY_STAGE', 'DUPLICATE_STORY',
    'INVALID_MEMORY_CHANGE', 'MEMORY_INFORMATION_LOSS',
  ]).has(error.code);
}

function retryDelayMs(error: unknown, retryNumber: number): number {
  if (!(error instanceof CloseoutModelError) || !error.retryable
    || !['MODEL_NETWORK_ERROR', 'MODEL_TIMEOUT', 'MODEL_HTTP_ERROR', 'MODEL_RESPONSE_INVALID'].includes(error.code)) return 0;
  const exponent = Math.min(Math.max(retryNumber - 1, 0), 6);
  const backoff = Math.min(RETRY_BACKOFF_MAX_MS, RETRY_BACKOFF_BASE_MS * 2 ** exponent);
  return backoff + Math.floor(Math.random() * Math.min(500, backoff / 2));
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CloseoutWorkflowError('已停止访谈整理。', 'CLOSEOUT_CANCELLED', 409);
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(new CloseoutWorkflowError('已停止访谈整理。', 'CLOSEOUT_CANCELLED', 409));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function retryMetadata(modelResult: CloseoutModelResult, provider: string | undefined, configuredModel: string | undefined, repairAttemptCount: number): Record<string, unknown> {
  const usage = modelResult.usage
    ? Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].flatMap((key) => {
        const value = modelResult.usage?.[key];
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? [[key, value]] : [];
      }))
    : undefined;
  return {
    provider: provider ?? 'volcengine-agent-plan',
    model: modelResult.model || configuredModel || 'deepseek-v4-flash',
    ...(modelResult.responseId ? { response_id: modelResult.responseId } : {}),
    latency_ms: modelResult.latencyMs,
    ...(usage && Object.keys(usage).length ? { usage } : {}),
    repair_attempt_count: repairAttemptCount,
  };
}

/** DirectModelCloseoutProcessor owns model retries and validation, but never writes domain data. */
export class DirectModelCloseoutProcessor implements CloseoutProcessor {
  private readonly validator = new StoryCloseoutValidator();

  constructor(private readonly textModel: TextModelProvider = new OpenAICompatibleTextModelProvider()) {}

  async process(input: ProcessStoryCloseoutInput): Promise<ProcessStoryCloseoutResult> {
    if (!input.config.apiKey?.trim() && !isLoopbackTextRuntimeUrl(input.config.baseUrl)) {
      throw new CloseoutWorkflowError('尚未配置访谈整理模型密钥。', 'LLM_NOT_CONFIGURED', 503);
    }
    let validated: ValidatedStoryCloseoutOutput | undefined;
    let modelResult: CloseoutModelResult | undefined;
    let lastError: unknown;
    let callCount = 0;
    const repairLog = input.repairLog ?? { count: 0, recent: [] };
    let maxOutputTokens = input.config.maxOutputTokens ?? DEFAULT_CLOSEOUT_MAX_OUTPUT_TOKENS;
    while (!validated || !modelResult) {
      throwIfCancelled(input.signal);
      input.assertCurrentAttempt();
      const prompt = buildStoryCloseoutPrompt(
        input.context,
        callCount > 0 && lastError ? retryFeedbackFor(lastError) : undefined,
      );
      const attempt = callCount;
      callCount += 1;
      try {
        const config: CloseoutModelConfig = {
          ...input.config,
          ...(input.config.apiFormat === 'responses' || input.config.apiFormat === 'chat-json-schema'
            ? { temperature: attempt >= 2 ? 0 : (input.config.temperature ?? 0.3) }
            : {}),
          maxOutputTokens,
          signal: input.signal,
          structuredOutput: input.context.mode === 'create'
            ? {
                name: input.config.apiFormat === undefined || input.config.apiFormat === 'chat-completions'
                  ? 'submit_story_closeout'
                  : 'story_create_closeout',
                schema: storyCreationCloseoutJsonSchema as Record<string, unknown>,
              }
            : {
                name: input.config.apiFormat === undefined || input.config.apiFormat === 'chat-completions'
                  ? 'submit_story_closeout'
                  : 'story_closeout',
                schema: storyCloseoutJsonSchema as Record<string, unknown>,
              },
        };
        const currentModelResult = await this.textModel.complete(prompt.prompt, config);
        input.assertCurrentAttempt();
        const currentOutput = this.validator.validate(currentModelResult.output, input.context, prompt.references);
        validated = currentOutput;
        modelResult = currentModelResult;
      } catch (error) {
        lastError = error;
        if (!canRetry(error)) throw error;
        repairLog.count = Math.min(repairLog.count + 1, Number.MAX_SAFE_INTEGER);
        const code = error instanceof CloseoutModelError || error instanceof CloseoutWorkflowError ? error.code : 'CLOSEOUT_FAILED';
        repairLog.recent.push({ code });
        if (repairLog.recent.length > MAX_RECORDED_REPAIR_ATTEMPTS) {
          repairLog.recent.splice(0, repairLog.recent.length - MAX_RECORDED_REPAIR_ATTEMPTS);
        }
        if (error instanceof CloseoutModelError && error.code === 'MODEL_OUTPUT_TRUNCATED') {
          maxOutputTokens = Math.min(maxOutputTokens * 2, MAX_CLOSEOUT_MAX_OUTPUT_TOKENS);
        }
        if (callCount >= STORY_CLOSEOUT_MAX_MODEL_CALLS) throw error;
        await waitForRetry(retryDelayMs(error, repairLog.count), input.signal);
      }
    }
    if (!validated || !modelResult) throw lastError ?? new Error('Closeout model did not return a valid result.');
    return {
      output: validated,
      modelResult,
      repairAttemptCount: repairLog.count,
    };
  }
}
