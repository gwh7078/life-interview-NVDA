import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import WebSocket from 'ws';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { accounts, users } from '../src/db/schema.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { createInterviewServiceServer } from '../src/server.js';

const temporaryDirectories: string[] = [];
const testTempRoot = path.resolve('data/test-tmp');
mkdirSync(testTempRoot, { recursive: true });

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

test('Local interview service exposes both provider states without exposing secrets', async () => {
  const directory = mkdtempSync(path.join(testTempRoot, 'rensheng-server-test-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'memoir.db');
  const connection = createDatabase(databasePath);
  try {
    runMigrations(connection);
    seedDatabase(connection);
  } finally {
    connection.close();
  }

  let generationInput: unknown;
  const server = createInterviewServiceServer({
    host: '127.0.0.1',
    port: 0,
    databasePath,
    apiKey: 'qwen-secret-test-value',
    workspaceId: 'workspace-test',
    region: 'cn-beijing',
    model: 'qwen-audio-3.0-realtime-plus',
    doubaoApiKey: 'doubao-secret-test-value',
    wrapUpMs: 1_080_000,
    maxSessionMs: 1_200_000,
    closeGraceMs: 45_000,
  }, {
    storyGeneration: {
      async generate(input) {
        generationInput = input;
        return {
          documentId: 'server-test-generated-document',
          ownerId: seedIds.user,
          scopeType: 'story',
          scopeId: 'server-test-story',
          title: '测试故事',
          content: '根据原始访谈整理的正文。',
          versionNumber: 1,
          status: 'draft',
          sourceJson: '{}',
        };
      },
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const healthResponse = await fetch(`${baseUrl}/api/health`);
    const health = await healthResponse.json() as Record<string, unknown>;
    assert.equal(healthResponse.status, 200);
    assert.equal(health.defaultProvider, 'doubao');
    assert.equal(health.databaseAvailable, true);
    assert.deepEqual(health.interviewLimits, {
      wrapUpMs: 1_080_000,
      maxSessionMs: 1_200_000,
      closeGraceMs: 45_000,
      openingResponseTimeoutMs: 8_000,
      userTurnStallTimeoutMs: 4_000,
    });
    const providers = health.providers as Record<string, Record<string, unknown>>;
    assert.equal(providers.doubao?.configured, true);
    assert.equal(providers.doubao?.model, 'Seeduplex 1.0 (1.2.6.1)');
    assert.equal(providers.qwen?.configured, true);
    const healthText = JSON.stringify(health);
    assert.equal(healthText.includes('qwen-secret-test-value'), false);
    assert.equal(healthText.includes('doubao-secret-test-value'), false);

    const unauthorizedStories = await fetch(`${baseUrl}/api/stories`);
    assert.equal(unauthorizedStories.status, 401);
    assert.equal((await unauthorizedStories.json() as Record<string, unknown>).errorCode, 'AUTH_REQUIRED');
    assert.equal((await fetch(`${baseUrl}/api/life-stages`)).status, 401);

    const loginResponse = await fetch(`${baseUrl}/api/auth/development/legacy-session`, { method: 'POST' });
    assert.equal(loginResponse.status, 200);
    const setCookie = loginResponse.headers.get('set-cookie');
    assert.ok(setCookie);
    const authCookie = setCookie.split(';', 1)[0]!;
    const storiesResponse = await fetch(`${baseUrl}/api/stories`, { headers: { cookie: authCookie } });
    const storiesPayload = await storiesResponse.json() as { stories?: Array<Record<string, unknown>> };
    assert.equal(storiesResponse.status, 200);
    assert.ok(storiesPayload.stories?.some((story) => story.story_id === '00000000-0000-4000-8000-000000000204'));
    const stagesResponse = await fetch(`${baseUrl}/api/life-stages`, { headers: { cookie: authCookie } });
    assert.equal(stagesResponse.status, 200);
    const stagesPayload = await stagesResponse.json() as { life_stages?: Array<Record<string, unknown>> };
    assert.ok((stagesPayload.life_stages?.length ?? 0) > 0);
    assert.ok(stagesPayload.life_stages?.every((stage) => Object.hasOwn(stage, 'start_year') && Object.hasOwn(stage, 'end_year')));
    assert.ok(stagesPayload.life_stages?.every((stage) => !Object.hasOwn(stage, 'date_precision') && !Object.hasOwn(stage, 'summary')));

    const createStage = async (body: Record<string, unknown>) => fetch(`${baseUrl}/api/life-stages`, {
      method: 'POST',
      headers: { cookie: authCookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const titleOnlyResponse = await createStage({ title: '开放年份阶段' });
    assert.equal(titleOnlyResponse.status, 201);
    const titleOnlyStage = (await titleOnlyResponse.json() as { life_stage: Record<string, unknown> }).life_stage;
    assert.equal(titleOnlyStage.start_year, null);
    assert.equal(titleOnlyStage.end_year, null);
    const datedStageResponse = await createStage({ title: '开放年份阶段', start_year: 2010, end_year: 'now' });
    assert.equal(datedStageResponse.status, 201, 'duplicate stage titles are allowed');
    const datedStage = (await datedStageResponse.json() as { life_stage: Record<string, unknown> }).life_stage;
    assert.equal(datedStage.start_year, 2010);
    assert.equal(datedStage.end_year, 'now');
    const stageId = String(datedStage.stage_id);
    const nowToUnknownResponse = await fetch(`${baseUrl}/api/life-stages/${encodeURIComponent(stageId)}`, {
      method: 'PATCH',
      headers: { cookie: authCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ end_year: null }),
    });
    assert.equal(nowToUnknownResponse.status, 200);
    assert.equal((await nowToUnknownResponse.json() as { life_stage: Record<string, unknown> }).life_stage.end_year, null);
    const unknownToNowResponse = await fetch(`${baseUrl}/api/life-stages/${encodeURIComponent(stageId)}`, {
      method: 'PATCH',
      headers: { cookie: authCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ end_year: 'now' }),
    });
    assert.equal(unknownToNowResponse.status, 200);
    assert.equal((await unknownToNowResponse.json() as { life_stage: Record<string, unknown> }).life_stage.end_year, 'now');
    const emptyStageDelete = await fetch(`${baseUrl}/api/life-stages/${encodeURIComponent(stageId)}`, {
      method: 'DELETE',
      headers: { cookie: authCookie },
    });
    assert.equal(emptyStageDelete.status, 200);

    const seededStory = storiesPayload.stories?.[0];
    assert.ok(seededStory && typeof seededStory.story_id === 'string' && typeof seededStory.stage_id === 'string');
    const storyId = String(seededStory.story_id);
    const storyPage = await fetch(`${baseUrl}/stories/${encodeURIComponent(storyId)}`);
    assert.equal(storyPage.status, 200);
    assert.match(await storyPage.text(), /id="story-title-heading"/);
    const storyDetailResponse = await fetch(`${baseUrl}/api/stories/${encodeURIComponent(storyId)}`, { headers: { cookie: authCookie } });
    const storyDetailPayload = await storyDetailResponse.json() as { story?: Record<string, unknown> };
    assert.equal(storyDetailResponse.status, 200);
    assert.ok(Array.isArray(storyDetailPayload.story?.gaps));
    assert.equal(Object.hasOwn(storyDetailPayload.story ?? {}, 'gaps_json'), false);
    const titleResponse = await fetch(`${baseUrl}/api/stories/${encodeURIComponent(storyId)}/title`, {
      method: 'PATCH',
      headers: { cookie: authCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'HTTP 更新的故事标题' }),
    });
    assert.equal(titleResponse.status, 200);
    assert.equal((await titleResponse.json() as { story: Record<string, unknown> }).story.title, 'HTTP 更新的故事标题');
    const documentsPage = await fetch(`${baseUrl}/stories/${encodeURIComponent(storyId)}/documents`);
    assert.equal(documentsPage.status, 200);
    assert.match(await documentsPage.text(), /id="version-list"/);
    const documentListResponse = await fetch(`${baseUrl}/api/stories/${encodeURIComponent(storyId)}/documents`, { headers: { cookie: authCookie } });
    assert.equal(documentListResponse.status, 200);
    assert.deepEqual((await documentListResponse.json() as { documents: unknown[] }).documents, []);
    const generateResponse = await fetch(`${baseUrl}/api/stories/${encodeURIComponent(storyId)}/documents/generate`, {
      method: 'POST',
      headers: { cookie: authCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        style: 'documentary', user_instruction: '按时间顺序整理。', base_document_id: null,
        owner_id: 'forged-other-user',
      }),
    });
    assert.equal(generateResponse.status, 201);
    assert.deepEqual(generationInput, {
      ownerId: seedIds.user,
      storyId,
      style: 'documentary',
      userInstruction: '按时间顺序整理。',
      baseDocumentId: null,
    });
    const generatedPayload = await generateResponse.json() as { document: Record<string, unknown> };
    assert.equal(generatedPayload.document.document_id, 'server-test-generated-document');
    assert.equal(generatedPayload.document.version_number, 1);
    const documentPage = await fetch(`${baseUrl}/stories/${encodeURIComponent(storyId)}/documents/server-test-generated-document`);
    assert.equal(documentPage.status, 200);
    assert.match(await documentPage.text(), /id="document-content"/);
    const protectedDeleteResponse = await fetch(`${baseUrl}/api/life-stages/${encodeURIComponent(String(seededStory.stage_id))}`, {
      method: 'DELETE',
      headers: { cookie: authCookie },
    });
    assert.equal(protectedDeleteResponse.status, 409);
    assert.equal((await protectedDeleteResponse.json() as Record<string, unknown>).errorCode, 'STAGE_HAS_STORIES');
    const moveStoryResponse = await fetch(`${baseUrl}/api/stories/${encodeURIComponent(String(seededStory.story_id))}/stage`, {
      method: 'PATCH',
      headers: { cookie: authCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ stage_id: titleOnlyStage.stage_id }),
    });
    assert.equal(moveStoryResponse.status, 200);
    const storiesAfterMove = await (await fetch(`${baseUrl}/api/stories`, { headers: { cookie: authCookie } })).json() as { stories: Array<Record<string, unknown>> };
    assert.equal(storiesAfterMove.stories.find((story) => story.story_id === seededStory.story_id)?.stage_id, titleOnlyStage.stage_id);
    const movedStageDeleteResponse = await fetch(`${baseUrl}/api/life-stages/${encodeURIComponent(String(titleOnlyStage.stage_id))}`, {
      method: 'DELETE',
      headers: { cookie: authCookie },
    });
    assert.equal(movedStageDeleteResponse.status, 409, 'stage deletion must not cascade to its Story');

    const homePage = await fetch(`${baseUrl}/`);
    assert.equal(homePage.status, 200);
    assert.match(await homePage.text(), /我的人生/);
    const timelineModel = await fetch(`${baseUrl}/life-model.js`);
    assert.equal(timelineModel.status, 200);
    assert.match(await timelineModel.text(), /sortLifeStages/);
    const page = await fetch(`${baseUrl}/interview`);
    const pageText = await page.text();
    assert.equal(page.status, 200);
    assert.match(pageText, /id="provider-select"/);
    assert.match(pageText, /id="auth-card"/);
    assert.match(pageText, /value="create"/);
    assert.match(pageText, /豆包火山引擎 · Seeduplex 1\.0 全双工/);
    assert.doesNotMatch(pageText, /Qwen Realtime/);

    const onboardingPage = await fetch(`${baseUrl}/onboarding`);
    assert.equal(onboardingPage.status, 200);
    assert.match(onboardingPage.headers.get('content-security-policy') ?? '', /connect-src 'self' ws: wss:/);
    assert.equal(onboardingPage.headers.get('permissions-policy'), 'microphone=(self)');
    assert.match(await onboardingPage.text(), /id="onboarding-welcome"/);
    for (const assetPath of ['/onboarding-ui.js', '/onboarding.css', '/onboarding-processing.js', '/onboarding-result.js']) {
      const assetResponse = await fetch(`${baseUrl}${assetPath}`);
      assert.equal(assetResponse.status, 200, `${assetPath} should be served`);
    }

    const unauthenticatedSocket = new WebSocket(`ws://127.0.0.1:${address.port}/api/realtime`);
    const rejectedHandshake = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Expected unauthenticated WebSocket handshake rejection.')), 2_000);
      unauthenticatedSocket.once('unexpected-response', (_request, response) => {
        clearTimeout(timer);
        resolve(response.statusCode ?? 0);
      });
      unauthenticatedSocket.once('error', () => {});
    });
    assert.equal(rejectedHandshake, 401);

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/realtime`, { headers: { cookie: authCookie } });
    await once(socket, 'open');
    const errorMessage = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for provider validation.')), 2_000);
      socket.once('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      });
    });
    socket.send(JSON.stringify({
      type: 'start',
      story_id: '00000000-0000-4000-8000-000000000204',
      provider: 'unknown',
    }));
    const error = await errorMessage;
    assert.equal(error.type, 'error');
    assert.match(String(error.message), /不支持的语音 Provider/);
    socket.close();
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('Production mode disables development login and verification even if a caller requests the adapter', async () => {
  const directory = mkdtempSync(path.join(testTempRoot, 'rensheng-production-auth-test-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'memoir.db');
  const connection = createDatabase(databasePath);
  try {
    runMigrations(connection);
    seedDatabase(connection);
  } finally {
    connection.close();
  }

  const previousNodeEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const server = createInterviewServiceServer({
    host: '127.0.0.1',
    port: 0,
    databasePath,
    apiKey: 'test-qwen-key',
    workspaceId: 'test-workspace',
    region: 'cn-beijing',
    model: 'test-model',
    authSessionSecret: 'production-test-session-secret-at-least-32-chars',
    developmentAuthEnabled: true,
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const legacy = await fetch(`${baseUrl}/api/auth/development/legacy-session`, { method: 'POST' });
    assert.equal(legacy.status, 404);
    const verification = await fetch(`${baseUrl}/api/auth/verification`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '+14155550134' }),
    });
    assert.equal(verification.status, 503);
  } finally {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
    if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnvironment;
  }
});

test('Demo auth HTTP flow logs in by valid phone and preserves an unverified phone flag', async () => {
  const directory = mkdtempSync(path.join(testTempRoot, 'rensheng-demo-phone-http-test-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'memoir.db');
  const connection = createDatabase(databasePath);
  try { runMigrations(connection); } finally { connection.close(); }

  const server = createInterviewServiceServer({
    host: '127.0.0.1',
    port: 0,
    databasePath,
    region: 'cn-beijing',
    model: 'test-model',
    authSessionSecret: 'demo-phone-http-test-secret-at-least-32-chars',
    authMode: 'demo_phone',
    developmentAuthEnabled: false,
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const unauthenticatedMe = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(unauthenticatedMe.status, 401);
    assert.equal((await unauthenticatedMe.json() as Record<string, unknown>).authMode, 'demo_phone');

    const login = await fetch(`${baseUrl}/api/auth/demo-phone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '10000000000' }),
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie');
    assert.ok(setCookie);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    const cookie = setCookie.split(';', 1)[0]!;
    const loginPayload = await login.json() as { profile: Record<string, unknown>; authMode: string };
    assert.equal(loginPayload.authMode, 'demo_phone');
    assert.equal(loginPayload.profile.onboarding_status, 'not_started');

    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
    const mePayload = await me.json() as { profile?: Record<string, unknown>; authMode?: string };
    assert.equal(me.status, 200);
    assert.equal(mePayload.authMode, 'demo_phone');
    assert.equal(mePayload.profile?.phone, '+8610000000000');
    assert.equal(mePayload.profile?.account_id, loginPayload.profile.account_id);
    assert.equal(mePayload.profile?.user_id, loginPayload.profile.user_id);

    const repeatLogin = await fetch(`${baseUrl}/api/auth/demo-phone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '+86 100-0000-0000' }),
    });
    assert.equal(repeatLogin.status, 200);
    const repeatPayload = await repeatLogin.json() as { profile: Record<string, unknown> };
    assert.equal(repeatPayload.profile.account_id, loginPayload.profile.account_id);
    assert.equal(repeatPayload.profile.user_id, loginPayload.profile.user_id);

    for (const phone of ['123', 'abcdefghijk', '01234567890']) {
      const invalid = await fetch(`${baseUrl}/api/auth/demo-phone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json() as Record<string, unknown>).errorCode, 'INVALID_PHONE');
      assert.equal(invalid.headers.get('set-cookie'), null);
    }

    const verify = createDatabase(databasePath);
    try {
      const savedAccounts = verify.db.select().from(accounts).all();
      const savedProfiles = verify.db.select().from(users).all();
      assert.equal(savedAccounts.length, 1);
      assert.equal(savedAccounts[0]?.phone, '+8610000000000');
      assert.equal(savedAccounts[0]?.phoneVerified, false);
      assert.equal(savedProfiles.length, 1);
      assert.equal(savedProfiles[0]?.accountId, savedAccounts[0]?.accountId);
    } finally { verify.close(); }

    const pageResponse = await fetch(`${baseUrl}/interview`);
    const pageText = await pageResponse.text();
    assert.equal(pageResponse.status, 200);
    assert.match(pageText, /中国大陆 11 位手机号即可登录/);
    assert.match(pageText, /id="auth-copy"/);
  } finally {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
});
