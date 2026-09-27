import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { after, test } from 'node:test';
import { AgentToolTokenService } from '../../agent/tools/token.js';
import { createInterviewServiceServer } from '../../src/server.js';
import { EraContextScriptGateway } from '../../src/era-context/script-gateway.js';

const temporaryDirectories: string[] = [];
after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

test('internal era context route keeps global background scope separate from Story memory', async () => {
  const directory = mkdtempSync(path.resolve('data/test-tmp/era-context-server-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'memoir.db');
  const secret = 'era-context-server-secret-012345678901234567890';
  const tokenService = new AgentToolTokenService(secret);
  const gateway = new EraContextScriptGateway({
    async search(input) {
      assert.equal(input.start_year, 1998);
      assert.equal(input.end_year, 2002);
      return [{
        start_year: 1999,
        end_year: 2002,
        category: '互联网',
        title: '网吧和QQ逐渐普及',
        summary: '网吧和即时通信逐渐进入年轻人的日常生活。',
        score: 0.88,
      }];
    },
  }, tokenService);
  const server = createInterviewServiceServer({
    host: '127.0.0.1',
    port: 0,
    databasePath,
    apiKey: '',
    workspaceId: '',
    region: 'cn-beijing',
    model: 'test-model',
    developmentAuthEnabled: true,
  }, { agentTasks: null, eraContextScriptGateway: gateway });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const token = tokenService.issue({
    runId: 'run-era-route-1',
    userId: 'user-1',
    tool: 'era_context_search',
    resourceType: 'era_context',
    resourceId: 'global',
    ttlMs: 60_000,
  });

  try {
    const unauthorized = await fetch(`${baseUrl}/internal/agent-retrieval/era-context-search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '北京', start_year: 1998, end_year: 2002 }),
    });
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${baseUrl}/internal/agent-retrieval/era-context-search`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: '刚参加工作时的娱乐生活', start_year: 1998, end_year: 2002 }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      matches: [{
        start_year: 1999,
        end_year: 2002,
        category: '互联网',
        title: '网吧和QQ逐渐普及',
        summary: '网吧和即时通信逐渐进入年轻人的日常生活。',
        score: 0.88,
      }],
    });
  } finally {
    server.close();
    await once(server, 'close');
  }
});
