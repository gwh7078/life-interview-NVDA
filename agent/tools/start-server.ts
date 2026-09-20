import { createDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { AgentToolTokenService } from './token.js';
import { FileAgentTaskContextStore } from './task-context-store.js';
import { createAgentToolServer } from './server.js';

const secret = process.env.AGENT_TOOL_TOKEN_SECRET;
if (!secret) throw new Error('AGENT_TOOL_TOKEN_SECRET is required.');

const connection = createDatabase();
try {
  runMigrations(connection);
} finally {
  connection.close();
}

const host = process.env.AGENT_TOOL_HOST ?? '127.0.0.1';
const port = Number(process.env.AGENT_TOOL_PORT ?? '4175');
if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error('AGENT_TOOL_PORT is invalid.');

const server = createAgentToolServer({
  tokenService: new AgentToolTokenService(secret),
  taskContexts: new FileAgentTaskContextStore(),
});
server.listen(port, host, () => {
  console.log(JSON.stringify({ service: 'life-interview-agent-tools', host, port }));
});
