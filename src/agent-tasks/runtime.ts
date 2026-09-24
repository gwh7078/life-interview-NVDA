import { AgentRunRepository } from '../../agent/tracing/agent-run-repository.js';
import {
  NemoClawAgentTaskExecutor,
  NemoClawOpenClawAttemptRunner,
} from '../../agent/runtime/nemoclaw-task-executor.js';
import type { AgentModelProfile } from './definitions/task-definition-registry.js';
import { NemoClawAgentTaskAdapter } from './adapters/nemoclaw-agent-task-adapter.js';
import { StubAgentTaskAdapter } from './adapters/stub-agent-task-adapter.js';
import { AgentTaskContractError } from './errors.js';
import type { AgentTaskPort } from './ports/agent-task-port.js';
import type { ObservationEvent } from '../observability/observation-event.js';

export type AgentTaskRuntimeId = 'direct' | 'stub' | 'agent';

function optionalEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

export function resolveAgentTaskModelRoutes(env: NodeJS.ProcessEnv = process.env): {
  defaultModel?: string;
  models: Partial<Record<AgentModelProfile, string>>;
} {
  const reasoningFast = optionalEnv(env, 'AGENT_MODEL_REASONING_FAST');
  const realtimeContext = optionalEnv(env, 'AGENT_MODEL_REALTIME_CONTEXT') ?? reasoningFast;
  return {
    ...(optionalEnv(env, 'AGENT_MODEL_DEFAULT')
      ? { defaultModel: optionalEnv(env, 'AGENT_MODEL_DEFAULT') }
      : {}),
    models: {
      ...(optionalEnv(env, 'AGENT_MODEL_REASONING')
        ? { reasoning: optionalEnv(env, 'AGENT_MODEL_REASONING') }
        : {}),
      ...(reasoningFast ? { 'reasoning-fast': reasoningFast } : {}),
      ...(realtimeContext ? { 'realtime-context': realtimeContext } : {}),
      ...(optionalEnv(env, 'AGENT_MODEL_WRITING')
        ? { writing: optionalEnv(env, 'AGENT_MODEL_WRITING') }
        : {}),
    },
  };
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
  options: { databasePath?: string; onObservationEvent?: (event: ObservationEvent) => void } = {},
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

  const modelRoutes = resolveAgentTaskModelRoutes(env);
  const attempts = new NemoClawOpenClawAttemptRunner({
    sandboxName,
    ...(optionalEnv(env, 'AGENT_PROVIDER') ? { provider: optionalEnv(env, 'AGENT_PROVIDER') } : {}),
    ...(modelRoutes.defaultModel ? { defaultModel: modelRoutes.defaultModel } : {}),
    ...(optionalEnv(env, 'AGENT_THINKING') ? { thinking: optionalEnv(env, 'AGENT_THINKING') } : {}),
    ...(optionalEnv(env, 'AGENT_RUNTIME_DIAGNOSTICS_PATH')
      ? { diagnosticsPath: optionalEnv(env, 'AGENT_RUNTIME_DIAGNOSTICS_PATH') }
      : {}),
    models: modelRoutes.models,
  });
  const runs = new AgentRunRepository(options.databasePath ?? optionalEnv(env, 'DATABASE_PATH'), {
    captureContent: env.DIAGNOSTICS_CAPTURE_CONTENT?.trim() === '1',
    ...(options.onObservationEvent ? { onObservationEvent: options.onObservationEvent } : {}),
  });
  return new NemoClawAgentTaskAdapter(new NemoClawAgentTaskExecutor(attempts, runs));
}
