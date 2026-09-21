import {
  agentTaskRequestEnvelopeSchema,
  agentTaskResultEnvelopeSchema,
  type AgentTaskRequestUnion,
  type AgentTaskResultUnion,
} from '../contracts/index.js';
import { getAgentTaskDefinition } from '../definitions/task-definition-registry.js';
import { AgentTaskContractError } from '../errors.js';
import type {
  AgentRepairFeedback,
  AgentTaskPort,
  AgentTaskRunOptions,
} from '../ports/agent-task-port.js';
import type { AgentTaskExecutor } from '../ports/agent-task-executor.js';

function formatValidationError(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') return {};
  const candidate = error as { issues?: unknown };
  return Array.isArray(candidate.issues) ? { issues: candidate.issues } : {};
}

function defaultRepairFeedback(error: unknown): AgentRepairFeedback[] {
  if (error && typeof error === 'object' && Array.isArray((error as { issues?: unknown }).issues)) {
    const issues = (error as { issues: Array<{ path?: unknown; code?: unknown }> }).issues.slice(0, 8);
    return issues.map((issue) => ({
      code: 'AGENT_OUTPUT_SCHEMA_INVALID',
      ...(Array.isArray(issue.path) && issue.path.length
        ? { path: issue.path.map(String).join('.') }
        : {}),
      instruction: `修正输出结构以满足注册 Schema${typeof issue.code === 'string' ? `（${issue.code}）` : ''}。`,
    }));
  }
  return [{
    code: 'AGENT_OUTPUT_VALIDATION_FAILED',
    instruction: error instanceof Error
      ? `根据 Backend Validator 反馈修正 Proposal：${error.message.slice(0, 500)}`
      : '根据 Backend Validator 反馈修正 Proposal。',
  }];
}

export class NemoClawAgentTaskAdapter implements AgentTaskPort {
  constructor(private readonly executor: AgentTaskExecutor) {}

  async run(
    request: AgentTaskRequestUnion,
    options: AgentTaskRunOptions = {},
  ): Promise<AgentTaskResultUnion> {
    try {
      agentTaskRequestEnvelopeSchema.parse(request);
    } catch (error) {
      throw new AgentTaskContractError(
        'Agent Task request envelope is invalid.',
        'AGENT_TASK_INPUT_INVALID',
        formatValidationError(error),
      );
    }

    const definition = getAgentTaskDefinition(request.taskType, request.mode);
    if (request.schemaVersion !== definition.schemaVersion) {
      throw new AgentTaskContractError(
        `Agent Task schema version ${request.schemaVersion} is not supported; expected ${definition.schemaVersion}.`,
        'AGENT_TASK_SCHEMA_VERSION_MISMATCH',
        {
          taskType: request.taskType,
          ...(request.mode ? { mode: request.mode } : {}),
          requested: request.schemaVersion,
          expected: definition.schemaVersion,
        },
      );
    }

    try {
      definition.inputSchema.parse(request.payload);
    } catch (error) {
      throw new AgentTaskContractError(
        'Agent Task payload is invalid.',
        'AGENT_TASK_INPUT_INVALID',
        {
          taskType: request.taskType,
          ...(request.mode ? { mode: request.mode } : {}),
          ...formatValidationError(error),
        },
      );
    }

    const executed = await this.executor.execute({
      runId: request.runId,
      ownerId: request.ownerId,
      taskType: request.taskType,
      ...(request.mode ? { mode: request.mode } : {}),
      resource: request.resource,
      schemaVersion: request.schemaVersion,
      contextVersion: definition.contextVersion,
      skill: definition.skill,
      skillVersion: definition.skillVersion,
      modelProfile: definition.modelProfile,
      executionPolicy: definition.executionPolicy,
      payload: request.payload,
      ...(options.signal ? { signal: options.signal } : {}),
      validateOutput(output) {
        const parsed = definition.outputSchema.parse(output);
        options.validateProposal?.(parsed);
        return parsed;
      },
      validationFeedback(error) {
        const feedback = options.repairFeedback?.(error);
        return feedback && feedback.length > 0 ? feedback : defaultRepairFeedback(error);
      },
    });

    let output: unknown;
    try {
      output = definition.outputSchema.parse(executed.output);
    } catch (error) {
      throw new AgentTaskContractError(
        'Agent Task output does not satisfy the registered schema.',
        'AGENT_TASK_OUTPUT_INVALID',
        {
          taskType: request.taskType,
          ...(request.mode ? { mode: request.mode } : {}),
          ...formatValidationError(error),
        },
      );
    }

    const result = {
      runId: request.runId,
      taskType: request.taskType,
      ...(request.mode ? { mode: request.mode } : {}),
      schemaVersion: request.schemaVersion,
      output,
      runtime: {
        ...executed.runtime,
        skill: definition.skill,
        skillVersion: definition.skillVersion,
      },
    } as AgentTaskResultUnion;

    agentTaskResultEnvelopeSchema.parse(result);
    return result;
  }
}
