import { z } from 'zod';

export const agentTaskTypes = [
  'onboarding.closeout',
  'interview.closeout',
  'story.completion',
  'story.generation',
] as const;

export type AgentTaskType = (typeof agentTaskTypes)[number];

export const interviewCloseoutModes = [
  'story_create',
  'story_continue',
  'contributor',
] as const;

export type InterviewCloseoutMode = (typeof interviewCloseoutModes)[number];

export const agentTaskResourceSchema = z.object({
  type: z.string().trim().min(1).max(80),
  id: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(200).optional(),
}).strict();

export type AgentTaskResource = z.infer<typeof agentTaskResourceSchema>;

export const agentTaskRuntimeMetadataSchema = z.object({
  runtime: z.string().trim().min(1).max(128),
  skill: z.string().trim().min(1).max(128),
  skillVersion: z.string().trim().min(1).max(128).optional(),
  provider: z.string().trim().min(1).max(128).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  latencyMs: z.number().finite().nonnegative().optional(),
  attemptCount: z.number().int().positive().optional(),
  repairCount: z.number().int().nonnegative().optional(),
  execCallCount: z.number().int().nonnegative().optional(),
  scriptCallCount: z.number().int().nonnegative().optional(),
  formatRepairUsed: z.boolean().optional(),
  usage: z.object({
    promptTokens: z.number().int().nonnegative().optional(),
    completionTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  }).strict().optional(),
}).strict();

export type AgentTaskRuntimeMetadata = z.infer<typeof agentTaskRuntimeMetadataSchema>;

export const agentTaskRequestEnvelopeSchema = z.object({
  runId: z.string().trim().min(1).max(200),
  taskType: z.enum(agentTaskTypes),
  mode: z.string().trim().min(1).max(80).optional(),
  ownerId: z.string().trim().min(1).max(200),
  resource: agentTaskResourceSchema,
  schemaVersion: z.string().trim().min(1).max(40),
  payload: z.unknown(),
}).strict();

export const agentTaskResultEnvelopeSchema = z.object({
  runId: z.string().trim().min(1).max(200),
  taskType: z.enum(agentTaskTypes),
  mode: z.string().trim().min(1).max(80).optional(),
  schemaVersion: z.string().trim().min(1).max(40),
  output: z.unknown(),
  runtime: agentTaskRuntimeMetadataSchema,
}).strict();

export interface AgentTaskRequest<TPayload> {
  runId: string;
  taskType: AgentTaskType;
  mode?: string;
  ownerId: string;
  resource: AgentTaskResource;
  schemaVersion: string;
  payload: TPayload;
}

export interface AgentTaskResult<TOutput> {
  runId: string;
  taskType: AgentTaskType;
  mode?: string;
  schemaVersion: string;
  output: TOutput;
  runtime: AgentTaskRuntimeMetadata;
}

export interface AgentTaskReferenceMap {
  messageIds?: Record<string, string>;
  stageIds?: Record<string, string>;
  onboardingSources?: Record<string, { session_id: string; message_id: string }>;
}

export interface MappedAgentTask<TRequest> {
  request: TRequest;
  references: AgentTaskReferenceMap;
}

export const taskTranscriptMessageSchema = z.object({
  message_id: z.string().trim().min(1).max(64),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  timestamp: z.string().min(1).max(100),
}).strict();

export const taskLifeStageSchema = z.object({
  stage_id: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(160),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
}).strict();

export const taskOtherStorySchema = z.object({
  title: z.string().trim().min(1).max(160),
  summary: z.string().max(4000),
  stage_id: z.string().trim().min(1).max(64),
}).strict();
