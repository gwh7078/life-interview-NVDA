import { AgentRunRepository } from '../../agent/tracing/agent-run-repository.js';
import {
  NemoClawAgentTaskExecutor,
  NemoClawOpenClawAttemptRunner,
} from '../../agent/runtime/nemoclaw-task-executor.js';
import { NemoClawAgentTaskAdapter } from './adapters/nemoclaw-agent-task-adapter.js';
import { StubAgentTaskAdapter } from './adapters/stub-agent-task-adapter.js';
import { AgentTaskContractError } from './errors.js';
import type { AgentTaskPort } from './ports/agent-task-port.js';

export type AgentTaskRuntimeId = 'direct' | 'stub' | 'agent';

function optionalEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

export function resolveAgentTaskRuntime(env: NodeJS.ProcessEnv = process.env): AgentTaskRuntimeId {
  const runtime = env.AI_TASK_RUNTIME?.trim() || 'direct';
  if (runtime !== 'direct' && runtime !== 'stub' && runtime !== 'agent') {
    throw new AgentTaskContractError(
      'AI_TASK_RUNTIME must be direct, stub or agent.',
      'AGENT_TASK_RUNTIME_INVALID',
      { runtime },
    );
  }
  return runtime;
}

export function createAgentTaskPort(
  env: NodeJS.ProcessEnv = process.env,
  options: { databasePath?: string } = {},
): AgentTaskPort | null {
  const runtime = resolveAgentTaskRuntime(env);
  if (runtime === 'direct') return null;
  if (runtime === 'stub') return new StubAgentTaskAdapter();

  const sandboxName = optionalEnv(env, 'NEMOCLAW_SANDBOX');
  if (!sandboxName) {
    throw new AgentTaskContractError(
      'NEMOCLAW_SANDBOX is required when AI_TASK_RUNTIME=agent.',
      'AGENT_RUNTIME_CONFIG_INVALID',
      { runtime },
    );
  }

  const attempts = new NemoClawOpenClawAttemptRunner({
    sandboxName,
    ...(optionalEnv(env, 'AGENT_PROVIDER') ? { provider: optionalEnv(env, 'AGENT_PROVIDER') } : {}),
    ...(optionalEnv(env, 'AGENT_MODEL_DEFAULT') ? { defaultModel: optionalEnv(env, 'AGENT_MODEL_DEFAULT') } : {}),
    models: {
      ...(optionalEnv(env, 'AGENT_MODEL_REASONING') ? { reasoning: optionalEnv(env, 'AGENT_MODEL_REASONING') } : {}),
      ...(optionalEnv(env, 'AGENT_MODEL_REASONING_FAST') ? { 'reasoning-fast': optionalEnv(env, 'AGENT_MODEL_REASONING_FAST') } : {}),
      ...(optionalEnv(env, 'AGENT_MODEL_WRITING') ? { writing: optionalEnv(env, 'AGENT_MODEL_WRITING') } : {}),
    },
  });
  const runs = new AgentRunRepository(options.databasePath ?? optionalEnv(env, 'DATABASE_PATH'));
  return new NemoClawAgentTaskAdapter(new NemoClawAgentTaskExecutor(attempts, runs));
}
