import type {
  AgentTaskResource,
  AgentTaskRuntimeMetadata,
  AgentTaskType,
} from '../contracts/common.js';
import type {
  AgentModelProfile,
  AgentTaskExecutionPolicy,
} from '../definitions/task-definition-registry.js';

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
  validateOutput(output: unknown): unknown;
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
