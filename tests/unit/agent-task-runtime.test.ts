import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAgentTaskDefinition } from '../../src/agent-tasks/definitions/task-definition-registry.js';
import { resolveAgentTaskModelRoutes } from '../../src/agent-tasks/runtime.js';

test('Realtime context model prefers its override, then fast reasoning, then the default', () => {
  assert.deepEqual(resolveAgentTaskModelRoutes({
    AGENT_MODEL_REALTIME_CONTEXT: 'context-model',
    AGENT_MODEL_REASONING_FAST: 'fast-model',
    AGENT_MODEL_DEFAULT: 'default-model',
  }), {
    defaultModel: 'default-model',
    models: {
      'reasoning-fast': 'fast-model',
      'realtime-context': 'context-model',
    },
  });
  assert.equal(resolveAgentTaskModelRoutes({
    AGENT_MODEL_REASONING_FAST: 'fast-model',
    AGENT_MODEL_DEFAULT: 'default-model',
  }).models['realtime-context'], 'fast-model');

  const defaultOnly = resolveAgentTaskModelRoutes({ AGENT_MODEL_DEFAULT: 'default-model' });
  assert.deepEqual(defaultOnly, {
    defaultModel: 'default-model',
    models: {},
  });
});

test('Realtime context hint uses one no-repair low-latency OpenClaw attempt', () => {
  const policy = getAgentTaskDefinition('interview.context_hint').executionPolicy;
  assert.deepEqual(policy, {
    agentId: 'realtime-context',
    thinking: 'off',
    maxAttempts: 1,
    timeoutMs: 4_800,
    scriptCapabilities: [],
    allowFormatRepair: false,
    allowValidationRepair: false,
  });
});
