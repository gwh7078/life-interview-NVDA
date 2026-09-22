import assert from 'node:assert/strict';
import test from 'node:test';
import {
  errorContract,
  errorWithCode,
  parseCaseId,
  safeErrorMessage,
} from '../../scripts/agent-eval/nat-runner-contract.js';
import {
  createSyntheticFixtureRegistry,
  SYNTHETIC_FIXTURE_CASE_IDS,
} from '../../scripts/agent-eval/fixture-registry.js';
import { createSyntheticBackendValidator } from '../../scripts/agent-eval/backend-validator.js';
import { StubAgentTaskAdapter } from '../../src/agent-tasks/index.js';

test('NAT runner accepts JSON and plain case_id input', () => {
  assert.equal(parseCaseId('{"case_id":"story.completion"}'), 'story.completion');
  assert.equal(parseCaseId('story.completion'), 'story.completion');
  assert.throws(
    () => parseCaseId('{"case_id":""}'),
    (error: unknown) => (error as { code?: string }).code === 'NAT_INPUT_INVALID',
  );
});

test('synthetic registry has exactly the shared six cases and no duplicate run ids', () => {
  let nextRunId = 0;
  const registry = createSyntheticFixtureRegistry('nat-test-owner', () => `run-${++nextRunId}`);
  assert.deepEqual([...registry.keys()], SYNTHETIC_FIXTURE_CASE_IDS);
  assert.equal(new Set([...registry.values()].map((fixture) => fixture.request.runId)).size, 6);
});

test('unknown cases and runtime failures use the structured error contract', () => {
  const unknown = errorWithCode('NAT_CASE_NOT_FOUND', 'Unknown synthetic Agent case: x');
  assert.deepEqual(errorContract(unknown), {
    code: 'NAT_CASE_NOT_FOUND',
    message: 'Unknown synthetic Agent case: x',
    retryable: false,
  });
  assert.equal(
    errorContract(errorWithCode('AGENT_RUNTIME_TIMEOUT', 'timed out')).retryable,
    true,
  );
  assert.equal(safeErrorMessage(new Error('TOKEN=secret Bearer abc')), 'TOKEN=<redacted> Bearer <redacted>');
});

test('synthetic cases use the existing Backend Validators at the proposal boundary', async () => {
  const registry = createSyntheticFixtureRegistry('nat-validator-owner', () => 'run');
  const adapter = new StubAgentTaskAdapter();
  for (const fixture of registry.values()) {
    const result = await adapter.run(fixture.request);
    const validate = createSyntheticBackendValidator(fixture.request);
    assert.ok(validate);
    validate(result.output);
  }
});
