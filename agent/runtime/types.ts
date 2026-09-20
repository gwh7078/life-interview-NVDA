export type AgentRunStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface AgentRunRequest {
  runId: string;
  userId: string;
  agentType: string;
  taskType: string;
  resourceType: string;
  resourceId: string;
}

export interface AgentRunResult<T = unknown> {
  runId: string;
  status: 'succeeded';
  output: T;
}

export interface AgentGateway {
  run<T = unknown>(request: AgentRunRequest): Promise<AgentRunResult<T>>;
}
