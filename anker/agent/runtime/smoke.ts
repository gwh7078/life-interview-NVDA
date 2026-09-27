import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { AgentRunRepository } from '../tracing/agent-run-repository.js';
import { AgentToolTokenService } from '../tools/token.js';
import { NemoClawOpenClawGateway } from './nemoclaw-openclaw-gateway.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + ' is required for the Phase 1 smoke test.');
  return value;
}

const connection = createDatabase();
try {
  runMigrations(connection);
} finally {
  connection.close();
}

const timeoutMs = Number(process.env.AGENT_RUNTIME_TIMEOUT_MS ?? '120000');
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('AGENT_RUNTIME_TIMEOUT_MS is invalid.');

const gateway = new NemoClawOpenClawGateway({
  sandboxName: required('NEMOCLAW_SANDBOX'),
  toolBaseUrl: required('AGENT_TOOL_BASE_URL'),
  model: process.env.AGENT_MODEL?.trim() || null,
  timeoutMs,
}, new AgentToolTokenService(required('AGENT_TOOL_TOKEN_SECRET')), new AgentRunRepository());

const result = await gateway.run({
  runId: randomUUID(),
  userId: required('AGENT_SMOKE_USER_ID'),
  agentType: 'story-context-inspector',
  taskType: 'inspect-story-context',
  resourceType: 'story',
  resourceId: required('AGENT_SMOKE_STORY_ID'),
});

console.log(JSON.stringify(result, null, 2));
