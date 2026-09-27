import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import WebSocket from 'ws';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { createInterviewServiceServer } from '../src/server.js';
import { createInterviewRuntimeCore } from '../src/interview/core.js';
import { endRealtimeInterviewSession } from '../src/interview/session.js';
import { TranscriptRepository } from '../src/repositories/domain-repositories.js';
import type { TextModelProvider } from '../src/providers/text-model-provider.js';

const temporaryDirectories: string[] = [];
const root = path.resolve('data/test-tmp');
mkdirSync(root, { recursive: true });

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

async function waitForJson(socket: WebSocket, predicate: (value: Record<string, unknown>) => boolean) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for websocket message')), 3_000);
    const onMessage = (data: WebSocket.RawData) => {
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(value);
    };
    socket.on('message', onMessage);
  });
}

test('Story Share HTTP and websocket boundaries support public access without exposing owner identity', async () => {
  const directory = mkdtempSync(path.join(root, 'story-share-api-test-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'memoir.db');
  const database = createDatabase(databasePath);
  try {
    runMigrations(database);
    seedDatabase(database);
    database.sqlite.prepare('UPDATE stories SET gaps_json = ? WHERE story_id = ?')
      .run(JSON.stringify(['家人当时怎么看这个决定？']), seedIds.firstProject);
  } finally {
    database.close();
  }

  const retryModel: TextModelProvider = {
    async complete() {
      return {
        output: { summary: '重试后成功保存的亲友补充摘要。' },
        model: 'fake-model',
        latencyMs: 1,
      };
    },
  };
  const server = createInterviewServiceServer({
    host: '127.0.0.1',
    port: 0,
    databasePath,
    region: 'cn-beijing',
    model: 'test-qwen-model',
    apiKey: 'test-qwen-key',
    workspaceId: 'test-workspace',
    wrapUpMs: 60_000,
    maxSessionMs: 120_000,
    closeGraceMs: 5_000,
  }, {
    closeout: { textModelProvider: retryModel },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsBase = `ws://127.0.0.1:${address.port}`;
  let socket: WebSocket | undefined;

  try {
    const login = await fetch(`${baseUrl}/api/auth/development/legacy-session`, { method: 'POST' });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);

    const invalidRelationship = await fetch(
      `${baseUrl}/api/stories/${encodeURIComponent(seedIds.firstProject)}/share-links`,
      {
        method: 'POST',
        headers: {
          cookie,
          origin: baseUrl,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ relationship: 'random-stranger' }),
      },
    );
    assert.equal(invalidRelationship.status, 400);
    assert.equal(
      (await invalidRelationship.json() as Record<string, unknown>).errorCode,
      'INVALID_RELATIONSHIP',
    );

    const create = await fetch(
      `${baseUrl}/api/stories/${encodeURIComponent(seedIds.firstProject)}/share-links`,
      {
        method: 'POST',
        headers: {
          cookie,
          origin: baseUrl,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ relationship: 'daughter' }),
      },
    );
    assert.equal(create.status, 201);
    const created = await create.json() as {
      share_id: string;
      relationship: string;
      expires_at: string;
      share_url: string;
    };
    assert.equal(created.relationship, 'daughter');
    assert.match(created.share_url, /^\/share\/story\/[A-Za-z0-9_-]+$/);
    assert.ok(Date.parse(created.expires_at) > Date.now());
    const token = created.share_url.split('/').at(-1);
    assert.ok(token);

    const publicPage = await fetch(`${baseUrl}${created.share_url}`);
    assert.equal(publicPage.status, 200);
    const publicHtml = await publicPage.text();
    assert.match(publicHtml, /亲友补充采访/);
    assert.match(publicHtml, /id="interview-link"/);

    const publicApi = await fetch(
      `${baseUrl}/api/public/story-share/${encodeURIComponent(token)}`,
      { cache: 'no-store' },
    );
    assert.equal(publicApi.status, 200);
    const publicPayload = await publicApi.json() as Record<string, unknown>;
    assert.equal(publicPayload.relationship, 'daughter');
    assert.equal(Object.hasOwn(publicPayload, 'user_id'), false);
    assert.equal(Object.hasOwn(publicPayload, 'share_id'), false);
    assert.equal(Object.hasOwn(publicPayload, 'contributor_summary'), false);
    assert.equal(Object.hasOwn(publicPayload, 'contributor_session_status'), false);
    assert.equal(Object.hasOwn(publicPayload, 'contributor_closeout_status'), false);
    const story = publicPayload.story as Record<string, unknown>;
    assert.equal(story.title, '第一次独立负责跨团队项目');
    assert.deepEqual(story.gaps, ['家人当时怎么看这个决定？']);
    assert.equal(Object.hasOwn(story, 'story_id'), false);

    const list = await fetch(
      `${baseUrl}/api/stories/${encodeURIComponent(seedIds.firstProject)}/share-links`,
      { headers: { cookie } },
    );
    assert.equal(list.status, 200);
    const listPayload = await list.json() as { share_links: Array<Record<string, unknown>> };
    assert.equal(listPayload.share_links.length, 1);
    assert.equal(listPayload.share_links[0]?.share_id, created.share_id);
    assert.equal(listPayload.share_links[0]?.relationship, 'daughter');
    assert.equal(JSON.stringify(listPayload).includes(token), false, 'plaintext token must not be recoverable from list API');

    socket = new WebSocket(
      `${wsBase}/api/realtime?share_token=${encodeURIComponent(token)}`,
      { headers: { origin: baseUrl } },
    );
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'ping' }));
    const pong = await waitForJson(socket, (message) => message.type === 'pong');
    assert.equal(pong.type, 'pong');
    socket.close();
    await once(socket, 'close');
    socket = undefined;

    const invalidSocket = new WebSocket(
      `${wsBase}/api/realtime?share_token=not-a-valid-share-token`,
      { headers: { origin: baseUrl } },
    );
    const invalidStatus = await new Promise<number>((resolve, reject) => {
      invalidSocket.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.resume();
      });
      invalidSocket.once('open', () => reject(new Error('invalid share token unexpectedly opened websocket')));
      invalidSocket.once('error', () => {
        // ws may emit error after the HTTP rejection; unexpected-response is authoritative.
      });
    });
    assert.equal(invalidStatus, 401);

    const core = createInterviewRuntimeCore(databasePath);
    const retryContext = core.prepare(seedIds.user, {
      interview_type: 'external_contributor',
      shareId: created.share_id,
    });
    const retrySession = core.start(seedIds.user, retryContext, 'stepfun');
    new TranscriptRepository(databasePath).appendForSession(seedIds.user, retrySession.sessionId, {
      role: 'user',
      text: '这条内容第一次整理失败，但不应该要求受访者重新讲。',
      provider: 'stepfun',
      providerMessageId: 'public-retry-user',
    });
    endRealtimeInterviewSession(databasePath, seedIds.user, retrySession.sessionId);
    const stateBeforeFailure = await fetch(
      `${baseUrl}/api/public/story-share/${encodeURIComponent(token)}`,
      { cache: 'no-store' },
    );
    const stateBeforeFailurePayload = await stateBeforeFailure.json() as Record<string, unknown>;
    assert.equal(stateBeforeFailurePayload.contributor_session_status, 'ended');
    assert.equal(stateBeforeFailurePayload.contributor_closeout_status, 'pending');
    const retryDatabase = createDatabase(databasePath);
    try {
      retryDatabase.sqlite.prepare(`
        UPDATE interview_sessions
        SET closeout_status = 'failed', closeout_result_json = ?
        WHERE session_id = ?
      `).run(JSON.stringify({ error: 'temporary failure' }), retrySession.sessionId);
    } finally {
      retryDatabase.close();
    }

    const revoke = await fetch(
      `${baseUrl}/api/story-share-links/${encodeURIComponent(created.share_id)}`,
      {
        method: 'DELETE',
        headers: { cookie, origin: baseUrl },
      },
    );
    assert.equal(revoke.status, 200);

    const retry = await fetch(
      `${baseUrl}/api/public/story-share/${encodeURIComponent(token)}/retry-closeout`,
      { method: 'POST', headers: { origin: baseUrl } },
    );
    assert.equal(retry.status, 200);
    assert.equal((await retry.json() as Record<string, unknown>).ok, true);
    const retriedDatabase = createDatabase(databasePath);
    try {
      const row = retriedDatabase.sqlite.prepare(`
        SELECT closeout_status AS closeoutStatus
        FROM interview_sessions
        WHERE session_id = ?
      `).get(retrySession.sessionId) as { closeoutStatus: string };
      assert.equal(row.closeoutStatus, 'completed');
      const shareRow = retriedDatabase.sqlite.prepare(`
        SELECT contributor_summary AS contributorSummary, interview_count AS interviewCount
        FROM story_share_links
        WHERE share_id = ?
      `).get(created.share_id) as { contributorSummary: string; interviewCount: number };
      assert.equal(shareRow.contributorSummary, '重试后成功保存的亲友补充摘要。');
      assert.equal(shareRow.interviewCount, 1);
    } finally {
      retriedDatabase.close();
    }

    const revokedPublic = await fetch(
      `${baseUrl}/api/public/story-share/${encodeURIComponent(token)}`,
    );
    assert.equal(revokedPublic.status, 410);
    assert.equal(
      (await revokedPublic.json() as Record<string, unknown>).errorCode,
      'SHARE_LINK_UNAVAILABLE',
    );
  } finally {
    socket?.terminate();
    server.close();
    await once(server, 'close');
  }
});
