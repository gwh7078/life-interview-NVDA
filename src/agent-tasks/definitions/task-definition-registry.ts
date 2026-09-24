import type { ZodType } from 'zod';
import {
  contributorCloseoutTaskOutputSchema,
  interviewContextHintTaskInputSchema,
  interviewContextHintTaskOutputSchema,
  interviewCloseoutModes,
  onboardingCloseoutTaskInputSchema,
  onboardingCloseoutTaskOutputSchema,
  storyCompletionTaskInputSchema,
  storyCompletionTaskOutputSchema,
  storyGenerationTaskInputSchema,
  storyGenerationTaskOutputSchema,
  type AgentTaskType,
  type InterviewCloseoutMode,
} from '../contracts/index.js';
import {
  interviewCloseoutInputSchemas,
  interviewCloseoutOutputSchemas,
} from '../contracts/interview-closeout.js';
import { AgentTaskContractError } from '../errors.js';

export type AgentModelProfile = 'reasoning' | 'reasoning-fast' | 'realtime-context' | 'writing';

export interface AgentTaskExecutionPolicy {
  agentId?: string;
  thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'adaptive' | 'max';
  maxAttempts: number;
  timeoutMs: number;
  scriptCapabilities: readonly string[];
  allowFormatRepair: boolean;
  allowValidationRepair?: boolean;
}

export interface AgentTaskDefinition {
  taskType: AgentTaskType;
  mode?: InterviewCloseoutMode;
  skill: string;
  skillVersion: 'v1';
  modelProfile: AgentModelProfile;
  inputSchema: ZodType;
  outputSchema: ZodType;
  contextVersion: 'v1';
  schemaVersion: 'v1';
  executionPolicy: AgentTaskExecutionPolicy;
}

const standardReasoningPolicy: AgentTaskExecutionPolicy = Object.freeze({
  maxAttempts: 3,
  timeoutMs: 180_000,
  scriptCapabilities: Object.freeze([]),
  allowFormatRepair: true,
});

const storyContinuePolicy: AgentTaskExecutionPolicy = Object.freeze({
  ...standardReasoningPolicy,
  scriptCapabilities: Object.freeze(['memory-search']),
});

const completionPolicy: AgentTaskExecutionPolicy = Object.freeze({
  maxAttempts: 3,
  timeoutMs: 120_000,
  scriptCapabilities: Object.freeze([]),
  allowFormatRepair: true,
});

const generationPolicy: AgentTaskExecutionPolicy = Object.freeze({
  maxAttempts: 3,
  timeoutMs: 300_000,
  scriptCapabilities: Object.freeze([]),
  allowFormatRepair: true,
});

const realtimeContextHintPolicy: AgentTaskExecutionPolicy = Object.freeze({
  agentId: 'realtime-context',
  thinking: 'off',
  maxAttempts: 1,
  timeoutMs: 4_800,
  scriptCapabilities: Object.freeze([]),
  allowFormatRepair: false,
  allowValidationRepair: false,
});

const definitions: AgentTaskDefinition[] = [
  {
    taskType: 'onboarding.closeout',
    skill: 'onboarding-closeout',
    skillVersion: 'v1',
    modelProfile: 'reasoning',
    inputSchema: onboardingCloseoutTaskInputSchema,
    outputSchema: onboardingCloseoutTaskOutputSchema,
    contextVersion: 'v1',
    schemaVersion: 'v1',
    executionPolicy: standardReasoningPolicy,
  },
  ...interviewCloseoutModes.map((mode): AgentTaskDefinition => ({
    taskType: 'interview.closeout',
    mode,
    skill: 'interview-closeout',
    skillVersion: 'v1',
    modelProfile: 'reasoning',
    inputSchema: interviewCloseoutInputSchemas[mode],
    outputSchema: mode === 'contributor'
      ? contributorCloseoutTaskOutputSchema
      : interviewCloseoutOutputSchemas[mode],
    contextVersion: 'v1',
    schemaVersion: 'v1',
    executionPolicy: mode === 'story_continue' ? storyContinuePolicy : standardReasoningPolicy,
  })),
  {
    taskType: 'interview.context_hint',
    skill: 'interview-observer',
    skillVersion: 'v1',
    modelProfile: 'realtime-context',
    inputSchema: interviewContextHintTaskInputSchema,
    outputSchema: interviewContextHintTaskOutputSchema,
    contextVersion: 'v1',
    schemaVersion: 'v1',
    executionPolicy: realtimeContextHintPolicy,
  },
  {
    taskType: 'story.completion',
    skill: 'story-completion',
    skillVersion: 'v1',
    modelProfile: 'reasoning-fast',
    inputSchema: storyCompletionTaskInputSchema,
    outputSchema: storyCompletionTaskOutputSchema,
    contextVersion: 'v1',
    schemaVersion: 'v1',
    executionPolicy: completionPolicy,
  },
  {
    taskType: 'story.generation',
    skill: 'story-generation',
    skillVersion: 'v1',
    modelProfile: 'writing',
    inputSchema: storyGenerationTaskInputSchema,
    outputSchema: storyGenerationTaskOutputSchema,
    contextVersion: 'v1',
    schemaVersion: 'v1',
    executionPolicy: generationPolicy,
  },
];

function definitionKey(taskType: AgentTaskType, mode?: string): string {
  return mode ? `${taskType}:${mode}` : taskType;
}

const definitionMap = new Map(
  definitions.map((definition) => [definitionKey(definition.taskType, definition.mode), definition] as const),
);

export const agentTaskDefinitions = Object.freeze([...definitions]);

export function getAgentTaskDefinition(
  taskType: AgentTaskType,
  mode?: string,
): AgentTaskDefinition {
  const definition = definitionMap.get(definitionKey(taskType, mode));
  if (!definition) {
    throw new AgentTaskContractError(
      `No Agent Task definition for ${definitionKey(taskType, mode)}.`,
      'AGENT_TASK_DEFINITION_NOT_FOUND',
      { taskType, ...(mode ? { mode } : {}) },
    );
  }
  return definition;
}
