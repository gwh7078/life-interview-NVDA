import { randomUUID } from 'node:crypto';
import type { CloseoutModelResult } from '../interview/llm-provider.js';
import type {
  CloseoutProcessor,
  ProcessStoryCloseoutInput,
  ProcessStoryCloseoutResult,
} from '../interview/closeout/processor.js';
import type { StoryCloseoutContext } from '../interview/closeout/context-builder.js';
import { CloseoutWorkflowError } from '../interview/closeout/errors.js';
import type { CompactPromptReferences } from '../interview/closeout/prompt-builder.js';
import { StoryCloseoutValidator } from '../interview/closeout/validator.js';
import { StoryCompletionValidator } from '../story/completion/validator.js';
import type {
  StoryCompletionContext,
  StoryCompletionExecutionContext,
  StoryCompletionOutput,
  StoryCompletionProcessorPort,
} from '../story/completion/types.js';
import { storyGenerationOutputSchema } from '../story/generation/schema.js';
import type {
  StoryGenerationContextModelPort,
  StoryGenerationModelResponse,
} from '../story/generation/types.js';
import type {
  OnboardingCloseoutProcessor,
  ProcessOnboardingCloseoutInput,
  ProcessOnboardingCloseoutResult,
} from '../onboarding/processor.js';
import { OnboardingWorkflowError } from '../onboarding/errors.js';
import type { OnboardingPromptReferences } from '../onboarding/types.js';
import { OnboardingCloseoutValidator } from '../onboarding/validator.js';
import {
  mapOnboardingCloseoutContextToTask,
  mapStoryCloseoutContextToTask,
  mapStoryCompletionContextToTask,
  mapStoryGenerationContextToTask,
} from './mappers/context-to-task.js';
import type {
  AgentRepairFeedback,
  AgentTaskPort,
} from './ports/agent-task-port.js';
import { getAgentTaskDefinition } from './definitions/task-definition-registry.js';
import type {
  AgentTaskReferenceMap,
  AgentTaskResultUnion,
} from './contracts/index.js';
import { AgentToolTokenService } from '../../agent/tools/token.js';

export interface StoryCloseoutScriptConfig {
  baseUrl: string;
  tokenService: AgentToolTokenService;
}

function modelResultFromAgent(result: AgentTaskResultUnion): CloseoutModelResult {
  const usage = result.runtime.usage
    ? {
        ...(result.runtime.usage.promptTokens !== undefined
          ? { prompt_tokens: result.runtime.usage.promptTokens } : {}),
        ...(result.runtime.usage.completionTokens !== undefined
          ? { completion_tokens: result.runtime.usage.completionTokens } : {}),
        ...(result.runtime.usage.totalTokens !== undefined
          ? { total_tokens: result.runtime.usage.totalTokens } : {}),
      }
    : undefined;
  return {
    output: result.output,
    model: result.runtime.model ?? result.runtime.runtime,
    latencyMs: result.runtime.latencyMs ?? 0,
    ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
  };
}

function storyReferences(
  context: StoryCloseoutContext,
  references: AgentTaskReferenceMap,
): CompactPromptReferences {
  const sourceMessageIds = new Map(Object.entries(references.messageIds ?? {}));
  const messageAliases = new Map(
    [...sourceMessageIds.entries()].map(([alias, original]) => [original, alias] as const),
  );
  const stageIds = new Map(Object.entries(references.stageIds ?? {}));
  const stageIdAliases = new Map(
    [...stageIds.entries()].map(([alias, original]) => [original, alias] as const),
  );
  return {
    messages: context.transcript.map((message) => ({
      message_id: messageAliases.get(message.message_id) ?? message.message_id,
      role: message.role,
      text: message.text,
    })),
    sourceMessageIds,
    stageIds,
    stageIdAliases,
  };
}

function onboardingReferences(references: AgentTaskReferenceMap): OnboardingPromptReferences {
  return {
    sourceReferences: new Map(Object.entries(references.onboardingSources ?? {})),
  };
}

function storyRepairFeedback(error: unknown): AgentRepairFeedback[] {
  const code = error instanceof CloseoutWorkflowError ? error.code : 'CLOSEOUT_OUTPUT_INVALID';
  const path = error instanceof CloseoutWorkflowError && typeof error.diagnostics?.path === 'string'
    ? error.diagnostics.path
    : undefined;
  const instructions: Record<string, string> = {
    CLOSEOUT_OUTPUT_INVALID: '修正 Schema、必填字段和长度，只返回定义字段。',
    INVALID_SOURCE_MESSAGE_IDS: '只引用当前 Transcript 中 role=user 的 message_id，并删除重复或无关来源。',
    SOURCE_MESSAGE_IDS_REQUIRED: '为新建或发生变化的 Story 提供至少一个当前用户消息来源。',
    UNSUPPORTED_YEAR: '删除输入中没有依据的年份。',
    UNCERTAINTY_NOT_PRESERVED: '保留用户原始的不确定表达，不要把近似年份改成确定年份。',
    INVALID_STORY_STAGE: 'new_stories 只能选择输入 life_stages 中存在的 stage_id。',
    DUPLICATE_STORY: '删除与当前或已有 Story 重复的新 Story，或修正标题使其忠于独立事件。',
    INVALID_MEMORY_CHANGE: '修正 memory_changes，使旧/新片段分别来自对应 Agent Memory，并为需要证据的变化引用当前用户消息。',
    MEMORY_INFORMATION_LOSS: '恢复未被明确纠正、删除或合并解释的旧 Agent Memory 信息。',
  };
  return [{
    code,
    ...(path ? { path } : {}),
    instruction: instructions[code] ?? '根据 Backend Validator 错误修正 Proposal 后重新提交。',
  }];
}

function onboardingRepairFeedback(error: unknown): AgentRepairFeedback[] {
  const code = error instanceof OnboardingWorkflowError ? error.code : 'ONBOARDING_OUTPUT_INVALID';
  const path = error instanceof OnboardingWorkflowError
    && typeof error.diagnostics?.field === 'string'
    ? error.diagnostics.field
    : undefined;
  const instructions: Record<string, string> = {
    ONBOARDING_OUTPUT_INVALID: '修正首次建档输出的 Schema、必填字段和长度。',
    INVALID_SOURCE_REFS: 'source_refs 只能引用输入用户消息提供的 source_ref，且不得重复。',
    SOURCE_REFS_REQUIRED: '所有非空 Profile 候选、Life Stage 和 Story Seed 必须提供直接用户来源。',
  };
  return [{
    code,
    ...(path ? { path } : {}),
    instruction: instructions[code] ?? '根据 Backend Validator 错误修正首次建档 Proposal。',
  }];
}

export class AgentStoryCloseoutProcessor implements CloseoutProcessor {
  private readonly validator = new StoryCloseoutValidator();

  constructor(
    private readonly tasks: AgentTaskPort,
    private readonly scriptConfig?: StoryCloseoutScriptConfig,
  ) {}

  async process(input: ProcessStoryCloseoutInput): Promise<ProcessStoryCloseoutResult> {
    input.assertCurrentAttempt();
    const mapped = mapStoryCloseoutContextToTask(input.context, randomUUID());
    const references = storyReferences(input.context, mapped.references);
    let validated: ProcessStoryCloseoutResult['output'] | undefined;
    const storyContinuePolicy = getAgentTaskDefinition('interview.closeout', 'story_continue').executionPolicy;
    const scriptContext = input.context.mode === 'continue' && this.scriptConfig && input.context.currentStory
      ? {
          baseUrl: this.scriptConfig.baseUrl,
          token: this.scriptConfig.tokenService.issue({
            runId: mapped.request.runId,
            userId: input.context.userId,
            tool: 'memory_search',
            resourceType: 'story',
            resourceId: input.context.currentStory.story_id,
            ttlMs: storyContinuePolicy.timeoutMs * storyContinuePolicy.maxAttempts
              + 60_000,
          }),
        }
      : undefined;

    const result = await this.tasks.run(mapped.request, {
      signal: input.signal,
      ...(scriptContext ? { scriptContext } : {}),
      validateProposal: (candidate) => {
        input.assertCurrentAttempt();
        validated = this.validator.validate(candidate, input.context, references);
      },
      repairFeedback: storyRepairFeedback,
    });

    input.assertCurrentAttempt();
    if (!validated) {
      validated = this.validator.validate(result.output, input.context, references);
    }
    const repairAttemptCount = result.runtime.repairCount ?? 0;
    if (input.repairLog && repairAttemptCount > 0) {
      input.repairLog.count = Math.min(
        input.repairLog.count + repairAttemptCount,
        Number.MAX_SAFE_INTEGER,
      );
    }
    return {
      output: validated,
      modelResult: modelResultFromAgent(result),
      repairAttemptCount,
    };
  }
}

export class AgentOnboardingCloseoutProcessor implements OnboardingCloseoutProcessor {
  private readonly validator = new OnboardingCloseoutValidator();

  constructor(private readonly tasks: AgentTaskPort) {}

  async process(input: ProcessOnboardingCloseoutInput): Promise<ProcessOnboardingCloseoutResult> {
    input.assertCurrentAttempt();
    const mapped = mapOnboardingCloseoutContextToTask(input.context, randomUUID());
    const references = onboardingReferences(mapped.references);
    let validated: ProcessOnboardingCloseoutResult['output'] | undefined;

    const result = await this.tasks.run(mapped.request, {
      signal: input.signal,
      validateProposal: (candidate) => {
        input.assertCurrentAttempt();
        validated = this.validator.validate(candidate, references);
      },
      repairFeedback: onboardingRepairFeedback,
    });

    input.assertCurrentAttempt();
    if (!validated) validated = this.validator.validate(result.output, references);
    return {
      output: validated,
      modelResult: modelResultFromAgent(result),
    };
  }
}

function completionRepairFeedback(error: unknown): AgentRepairFeedback[] {
  const candidate = error as { code?: unknown; path?: unknown; message?: unknown };
  return [{
    code: typeof candidate?.code === 'string'
      ? candidate.code
      : 'STORY_COMPLETION_OUTPUT_INVALID',
    ...(typeof candidate?.path === 'string' ? { path: candidate.path } : {}),
    instruction: typeof candidate?.message === 'string'
      ? candidate.message.slice(0, 500)
      : '修正 Completion Proposal，使 status 与 gaps 满足业务约束。',
  }];
}

export class AgentStoryCompletionProcessor implements StoryCompletionProcessorPort {
  private readonly validator = new StoryCompletionValidator();

  constructor(private readonly tasks: AgentTaskPort) {}

  async process(
    context: StoryCompletionContext,
    execution?: StoryCompletionExecutionContext,
  ): Promise<StoryCompletionOutput> {
    if (!execution) throw new Error('AGENT_COMPLETION_EXECUTION_CONTEXT_REQUIRED');
    const mapped = mapStoryCompletionContextToTask(context, {
      runId: randomUUID(),
      ownerId: execution.userId,
      storyId: execution.storyId,
    });
    let validated: StoryCompletionOutput | undefined;
    const result = await this.tasks.run(mapped.request, {
      ...(execution.signal ? { signal: execution.signal } : {}),
      validateProposal: (candidate) => {
        validated = this.validator.validate(candidate);
      },
      repairFeedback: completionRepairFeedback,
    });
    return validated ?? this.validator.validate(result.output);
  }
}

function generationRepairFeedback(error: unknown): AgentRepairFeedback[] {
  const candidate = error as { issues?: Array<{ path?: unknown; code?: unknown }> };
  const first = Array.isArray(candidate?.issues) ? candidate.issues[0] : undefined;
  return [{
    code: 'GENERATION_OUTPUT_INVALID',
    ...(first && Array.isArray(first.path) && first.path.length
      ? { path: first.path.map(String).join('.') }
      : {}),
    instruction: '只返回 Schema 要求的 content 正文，并确保正文非空。',
  }];
}

export class AgentStoryGenerationContextModel implements StoryGenerationContextModelPort {
  constructor(private readonly tasks: AgentTaskPort) {}

  async generateContext(input: {
    ownerId: string;
    storyId: string;
    resourceVersion: string;
    context: Parameters<StoryGenerationContextModelPort['generateContext']>[0]['context'];
  }): Promise<StoryGenerationModelResponse> {
    const mapped = mapStoryGenerationContextToTask(input.context, {
      runId: randomUUID(),
      ownerId: input.ownerId,
      storyId: input.storyId,
      resourceVersion: input.resourceVersion,
    });
    let validated: { content: string } | undefined;
    const result = await this.tasks.run(mapped.request, {
      validateProposal: (candidate) => {
        validated = storyGenerationOutputSchema.parse(candidate);
      },
      repairFeedback: generationRepairFeedback,
    });
    const output = validated ?? storyGenerationOutputSchema.parse(result.output);
    return {
      output,
      provider: result.runtime.provider ?? result.runtime.runtime,
      model: result.runtime.model,
    };
  }
}
