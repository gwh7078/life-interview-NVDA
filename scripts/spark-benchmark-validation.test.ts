import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isNatPathPassing, isCoachGatePassing } from './spark-benchmark-validation.js';

const passingNatResult = {
  status: 'succeeded',
  validation: {
    contract_valid: true,
    backend_validation: 'passed',
    semantic_valid: true,
    semantic_checks: [],
  },
};

test('NAT benchmark path passes only when runtime and every validator pass', () => {
  assert.equal(isNatPathPassing(passingNatResult), true);
  assert.equal(isNatPathPassing({
    ...passingNatResult,
    validation: { ...passingNatResult.validation, semantic_valid: false },
  }), false);
  assert.equal(isNatPathPassing({
    ...passingNatResult,
    validation: { ...passingNatResult.validation, contract_valid: false },
  }), false);
  assert.equal(isNatPathPassing({
    ...passingNatResult,
    validation: { ...passingNatResult.validation, backend_validation: 'not_applicable' },
  }), false);
  assert.equal(isNatPathPassing({
    ...passingNatResult,
    validation: {
      ...passingNatResult.validation,
      semantic_checks: [{ name: 'uncertainty', passed: false }],
    },
  }), false);
});

test('Coach Gate benchmark requires expected routes and the inclusive 2s budget', () => {
  assert.equal(isCoachGatePassing('memory', [
    { route: 'memory', latency_ms: 1_999 },
    { route: 'memory', latency_ms: 2_000 },
  ], 2_000), true);
  assert.equal(isCoachGatePassing('memory', [{ route: 'era', latency_ms: 100 }], 2_000), false);
  assert.equal(isCoachGatePassing('memory', [{ route: 'memory', latency_ms: 2_001 }], 2_000), false);
  assert.equal(isCoachGatePassing('memory', [], 2_000), false);
});
