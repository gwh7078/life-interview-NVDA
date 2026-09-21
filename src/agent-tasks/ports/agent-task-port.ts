import type {
  AgentTaskRequestUnion,
  AgentTaskResultUnion,
} from '../contracts/index.js';

export interface AgentRepairFeedback {
  code: string;
  path?: string;
  instruction: string;
}

export interface AgentTaskRunOptions {
  signal?: AbortSignal;
  // Deterministic Backend validation. Throw to request Validation Repair.
  validateProposal?(output: unknown): void;
  // Convert a validation error into compact, model-safe repair instructions.
  repairFeedback?(error: unknown): AgentRepairFeedback[];
}

export interface AgentTaskPort {
  run(
    request: AgentTaskRequestUnion,
    options?: AgentTaskRunOptions,
  ): Promise<AgentTaskResultUnion>;
}
