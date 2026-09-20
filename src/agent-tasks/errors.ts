export type AgentTaskContractErrorCode =
  | 'AGENT_TASK_DEFINITION_NOT_FOUND'
  | 'AGENT_TASK_INPUT_INVALID'
  | 'AGENT_TASK_OUTPUT_INVALID'
  | 'AGENT_TASK_RUNTIME_INVALID'
  | 'AGENT_RUNTIME_NOT_IMPLEMENTED';

export class AgentTaskContractError extends Error {
  constructor(
    message: string,
    readonly code: AgentTaskContractErrorCode,
    readonly diagnostics?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AgentTaskContractError';
  }
}
