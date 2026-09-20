import type {
  AgentTaskResource,
  AgentTaskRuntimeMetadata,
  AgentTaskType,
} from '../contracts/common.js';
import type { AgentModelProfile } from '../definitions/task-definition-registry.js';

export interface AgentTaskExecutionRequest {
  runId: string;
  ownerId: string;
  taskType: AgentTaskType;
  mode?: string;
  resource: AgentTaskResource;
  schemaVersion: string;
  skill: string;
  modelProfile: AgentModelProfile;
  payload: unknown;
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
