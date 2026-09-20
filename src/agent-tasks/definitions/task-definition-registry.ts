import type { z } from 'zod';
import {
  contributorCloseoutTaskOutputSchema,
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
  interviewCloseoutTaskInputSchema,
  interviewCloseoutOutputSchemas,
} from '../contracts/interview-closeout.js';
import { AgentTaskContractError } from '../errors.js';

export type AgentModelProfile = 'reasoning' | 'reasoning-fast' | 'writing';

export interface AgentTaskDefinition {
  taskType: AgentTaskType;
  mode?: InterviewCloseoutMode;
  skill: string;
  modelProfile: AgentModelProfile;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  contextVersion: 'v1';
  schemaVersion: 'v1';
}

const definitions: AgentTaskDefinition[] = [
  {
    taskType: 'onboarding.closeout',
    skill: 'onboarding-closeout',
    modelProfile: 'reasoning',
    inputSchema: onboardingCloseoutTaskInputSchema,
    outputSchema: onboardingCloseoutTaskOutputSchema,
    contextVersion: 'v1',
    schemaVersion: 'v1',
  },
  ...interviewCloseoutModes.map((mode): AgentTaskDefinition => ({
    taskType: 'interview.closeout',
    mode,
    skill: 'interview-closeout',
    modelProfile: 'reasoning',
    inputSchema: interviewCloseoutTaskInputSchema,
    outputSchema: mode === 'contributor'
      ? contributorCloseoutTaskOutputSchema
      : interviewCloseoutOutputSchemas[mode],
    contextVersion: 'v1',
    schemaVersion: 'v1',
  })),
  {
    taskType: 'story.completion',
    skill: 'story-completion',
    modelProfile: 'reasoning-fast',
    inputSchema: storyCompletionTaskInputSchema,
    outputSchema: storyCompletionTaskOutputSchema,
    contextVersion: 'v1',
    schemaVersion: 'v1',
  },
  {
    taskType: 'story.generation',
    skill: 'story-generation',
    modelProfile: 'writing',
    inputSchema: storyGenerationTaskInputSchema,
    outputSchema: storyGenerationTaskOutputSchema,
    contextVersion: 'v1',
    schemaVersion: 'v1',
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
