import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentToolTokenError, AgentToolTokenService } from '../../agent/tools/token.js';

const secret = 'phase1-test-secret-0123456789-abcdef';

test('agent tool token verifies exact run resource scope', () => {
  const service = new AgentToolTokenService(secret, () => 1_000);
  const token = service.issue({
    runId: 'run-1', userId: 'user-1', tool: 'get_story_context',
    resourceType: 'story', resourceId: 'story-1', ttlMs: 5_000,
  });
  const payload = service.verify(token, { tool: 'get_story_context', resourceType: 'story', resourceId: 'story-1' });
  assert.equal(payload.runId, 'run-1');
  assert.equal(payload.userId, 'user-1');
});

test('agent tool token rejects resource mismatch and expiry', () => {
  const issuer = new AgentToolTokenService(secret, () => 1_000);
  const token = issuer.issue({
    runId: 'run-1', userId: 'user-1', tool: 'get_story_context',
    resourceType: 'story', resourceId: 'story-1', ttlMs: 1_000,
  });
  assert.throws(
    () => issuer.verify(token, { tool: 'get_story_context', resourceType: 'story', resourceId: 'story-2' }),
    (error: unknown) => error instanceof AgentToolTokenError && error.code === 'TOKEN_SCOPE_MISMATCH',
  );
  const expired = new AgentToolTokenService(secret, () => 2_001);
  assert.throws(
    () => expired.verify(token, { tool: 'get_story_context', resourceType: 'story', resourceId: 'story-1' }),
    (error: unknown) => error instanceof AgentToolTokenError && error.code === 'TOKEN_EXPIRED',
  );
});
