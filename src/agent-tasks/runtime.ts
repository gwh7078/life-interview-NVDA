import { StubAgentTaskAdapter } from './adapters/stub-agent-task-adapter.js';
import { AgentTaskContractError } from './errors.js';
import type { AgentTaskPort } from './ports/agent-task-port.js';

export type AgentTaskRuntimeId = 'stub' | 'agent';

export function resolveAgentTaskRuntime(env: NodeJS.ProcessEnv = process.env): AgentTaskRuntimeId {
  const runtime = env.AI_TASK_RUNTIME?.trim() || 'stub';
  if (runtime !== 'stub' && runtime !== 'agent') {
    throw new AgentTaskContractError(
      'AI_TASK_RUNTIME must be stub or agent.',
      'AGENT_TASK_RUNTIME_INVALID',
      { runtime },
    );
  }
  return runtime;
}

export function createAgentTaskPort(env: NodeJS.ProcessEnv = process.env): AgentTaskPort {
  const runtime = resolveAgentTaskRuntime(env);
  if (runtime === 'stub') return new StubAgentTaskAdapter();
  throw new AgentTaskContractError(
    'The production Agent runtime is intentionally not implemented in Phase 2A.',
    'AGENT_RUNTIME_NOT_IMPLEMENTED',
    { runtime },
  );
}
