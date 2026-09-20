import {
  agentTaskRequestEnvelopeSchema,
  agentTaskResultEnvelopeSchema,
  type AgentTaskRequestUnion,
  type AgentTaskResultUnion,
} from '../contracts/index.js';
import { getAgentTaskDefinition } from '../definitions/task-definition-registry.js';
import { AgentTaskContractError } from '../errors.js';
import type { AgentTaskPort } from '../ports/agent-task-port.js';
import type { AgentTaskExecutor } from '../ports/agent-task-executor.js';

function formatValidationError(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') return {};
  const candidate = error as { issues?: unknown };
  return Array.isArray(candidate.issues) ? { issues: candidate.issues } : {};
}

// Product-side Phase 2B adapter. Contract/route validation lives here;
// structured payload transport into NemoClaw/OpenClaw belongs to the injected executor.
export class NemoClawAgentTaskAdapter implements AgentTaskPort {
  constructor(private readonly executor: AgentTaskExecutor) {}

  async run(request: AgentTaskRequestUnion): Promise<AgentTaskResultUnion> {
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
      skill: definition.skill,
      modelProfile: definition.modelProfile,
      payload: request.payload,
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
      },
    } as AgentTaskResultUnion;

    try {
      agentTaskResultEnvelopeSchema.parse(result);
    } catch (error) {
      throw new AgentTaskContractError(
        'Agent Task result envelope is invalid.',
        'AGENT_TASK_OUTPUT_INVALID',
        formatValidationError(error),
      );
    }
    return result;
  }
}
