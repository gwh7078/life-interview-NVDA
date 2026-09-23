import { performance } from 'node:perf_hooks';
import {
  closeoutModelReturnedAttempt,
  CloseoutModelError,
  type CloseoutModelAttemptEvent,
  type CloseoutModelConfig,
  type CloseoutModelResult,
} from '../interview/llm-provider.js';
import { isLoopbackTextRuntimeUrl } from '../models/text-runtime.js';
import { OpenAICompatibleTextModelProvider, type TextModelProvider } from '../providers/text-model-provider.js';
import { buildOnboardingCloseoutPrompt } from './prompt-builder.js';
import { onboardingCloseoutJsonSchema } from './schema.js';
import { OnboardingWorkflowError } from './errors.js';
import type { OnboardingCloseoutContext, ValidatedOnboardingCloseoutOutput } from './types.js';
import { OnboardingCloseoutValidator } from './validator.js';

export interface OnboardingCloseoutConfig extends CloseoutModelConfig {
  provider?: string;
}
export interface ProcessOnboardingCloseoutInput {
  context: OnboardingCloseoutContext;
  config: OnboardingCloseoutConfig;
  signal: AbortSignal;
  assertCurrentAttempt(): void;
  onModelAttempt?: (event: CloseoutModelAttemptEvent) => void;
}

export interface ProcessOnboardingCloseoutResult {
  output: ValidatedOnboardingCloseoutOutput;
  modelResult: CloseoutModelResult;
}

export interface OnboardingCloseoutProcessor {
  process(input: ProcessOnboardingCloseoutInput): Promise<ProcessOnboardingCloseoutResult>;
}

function reportModelAttempt(input: ProcessOnboardingCloseoutInput, event: CloseoutModelAttemptEvent): void {
  try { input.onModelAttempt?.(event); } catch { /* Diagnostics must not change closeout behavior. */ }
}

/** Direct structured model call for onboarding; it never writes user or life-map data. */
export class DirectOnboardingCloseoutProcessor implements OnboardingCloseoutProcessor {
  private readonly validator = new OnboardingCloseoutValidator();

  constructor(private readonly textModel: TextModelProvider = new OpenAICompatibleTextModelProvider()) {}

  async process(input: ProcessOnboardingCloseoutInput): Promise<ProcessOnboardingCloseoutResult> {
    if (!input.config.apiKey?.trim() && !isLoopbackTextRuntimeUrl(input.config.baseUrl)) {
      throw new OnboardingWorkflowError('尚未配置首次建档整理模型密钥。', 'LLM_NOT_CONFIGURED', 503);
    }
    input.assertCurrentAttempt();
    const built = buildOnboardingCloseoutPrompt(input.context);
    let modelResult: CloseoutModelResult;
    const attemptStartedAt = performance.now();
    reportModelAttempt(input, {
      phase: 'started',
      attempt: 1,
      ...(input.config.model ? { model: input.config.model } : {}),
    });
    try {
      modelResult = await this.textModel.complete(built.prompt, {
        ...input.config,
        signal: input.signal,
        structuredOutput: {
          name: 'onboarding_closeout',
          schema: onboardingCloseoutJsonSchema as Record<string, unknown>,
        },
      });
    } catch (error) {
      reportModelAttempt(input, {
        phase: 'failed',
        attempt: 1,
        latencyMs: Math.max(0, Math.round(performance.now() - attemptStartedAt)),
        errorCode: error instanceof CloseoutModelError ? error.code : error instanceof Error ? error.name : 'unknown',
        retryable: error instanceof CloseoutModelError && error.retryable,
        ...(error instanceof CloseoutModelError && error.diagnostics?.responseStatus !== undefined
          ? { responseStatus: error.diagnostics.responseStatus }
          : {}),
        ...(error instanceof CloseoutModelError && error.diagnostics?.responseId
          ? { responseId: error.diagnostics.responseId }
          : {}),
      });
      if (error instanceof CloseoutModelError) throw error;
      throw new OnboardingWorkflowError('首次建档整理模型调用失败。', 'ONBOARDING_MODEL_FAILED', 503);
    }
    reportModelAttempt(input, closeoutModelReturnedAttempt(modelResult, 1));
    input.assertCurrentAttempt();
    let output: ValidatedOnboardingCloseoutOutput;
    try {
      output = this.validator.validate(modelResult.output, built.references);
    } catch (error) {
      reportModelAttempt(input, {
        phase: 'validation_failed',
        attempt: 1,
        errorCode: error instanceof OnboardingWorkflowError ? error.code : 'ONBOARDING_OUTPUT_INVALID',
        retryable: false,
      });
      throw error;
    }
    return {
      output,
      modelResult,
    };
  }
}
