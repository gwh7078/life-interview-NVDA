import type {
  AgentTaskResource,
  AgentTaskRuntimeMetadata,
  AgentTaskType,
} from '../contracts/common.js';
import type {
  AgentModelProfile,
  AgentTaskExecutionPolicy,
} from '../definitions/task-definition-registry.js';
import type { AgentRepairFeedback } from './agent-task-port.js';

export interface AgentTaskExecutionRequest {
  runId: string;
  ownerId: string;
  taskType: AgentTaskType;
  mode?: string;
  resource: AgentTaskResource;
  schemaVersion: string;
  contextVersion: string;
  skill: string;
  skillVersion: string;
  modelProfile: AgentModelProfile;
  executionPolicy: AgentTaskExecutionPolicy;
  payload: unknown;
  signal?: AbortSignal;
  validateOutput(output: unknown): unknown;
  validationFeedback(error: unknown): AgentRepairFeedback[];
}

export interface AgentTaskExecutionResult {
  output: unknown;
  runtime: Omit<AgentTaskRuntimeMetadata, 'skill'> & {
    skill?: string;
  };
}

export interface AgentTaskExecutor {
  execute(request: AgentTaskExecutionRequest): Promise<AgentTaskExecutionResult>;
}
