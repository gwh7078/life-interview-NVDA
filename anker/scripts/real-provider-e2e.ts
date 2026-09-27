import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import WebSocket, { type RawData } from 'ws';
import { startRealtimeSession } from './realtime-e2e-session.js';
import { readRuntimeConfig, createInterviewServiceServer } from '../src/server.js';
import { resolveDiagnosticsPath } from '../src/diagnostics/paths.js';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  interviewSessions,
  lifeStages,
  memoirDocuments,
  stories,
} from '../src/db/schema.js';
import {
  closeoutResultSchema,
  parseJsonColumn,
  parseTranscript,
  serializeTranscript,
  type TranscriptMessage,
} from '../src/db/transcript.js';
import { nowUtcIso } from '../src/db/time.js';
import {
  MemoirDocumentRepository,
  StoryRepository,
  TranscriptRepository,
} from '../src/repositories/domain-repositories.js';

const E2E_ROOT = resolveDiagnosticsPath('test-artifacts', 'real-provider');
const FINAL_REPORT_PATH = resolveDiagnosticsPath('reports', 'REAL_PROVIDER_E2E_REPORT.md');
const SILENCE_TAIL_MS = 1_500;
const PROVIDER_TIMEOUT_MS = 90_000;
const CLOSEOUT_TIMEOUT_MS = 240_000;

const createStoryAnswers = [
  '大约在2012年，我在杭州第一次负责一个跨团队项目，当时团队只有三个人。',
  '发布前一周，测试发现两个团队用的接口字段不一样，文档也有两个版本。',
  '上线当天早上页面打不开，我很紧张，担心延期，也担心大家互相责怪。',
  '我请团队先暂停发布，一起对照日志和配置，最后发现是测试环境参数写错了。',
  '修好以后我们按计划上线，晚上一起吃了碗面；我觉得先对齐事实再决定很重要。',
];

const continueStoryAnswers = [
  '2013年春天，我们在杭州办公室又遇到一次发布风险，大家想起上次先核对信息的做法。',
  '我把发布检查表交给新同事小林，让她负责逐项确认数据库地址和接口配置。',
  '她在灰度发布前发现数据库地址填错了，我们及时修正，没有影响用户。',
  '我为她感到高兴，也意识到团队不能只靠我一个人记住所有细节。',
  '我们把检查表固定进发布流程，让新同事也一起熟悉；我希望留下互相提醒、共同负责的习惯。',
];

type CaseStatus = 'NOT RUN' | 'PASS' | 'FAIL';
type WireMessage = Record<string, unknown>;

interface CaseReport {
  status: CaseStatus;
  mode: 'create' | 'continue';
  sessionId?: string;
  storyId?: string;
  stageId?: string;
  transcriptCountBeforeCloseout?: number;
  transcriptCountAfterCloseout?: number;
  userFinalCount?: number;
  assistantFinalCount?: number;
  audioBytesSent?: number;
  audioFramesSent?: number;
  sourceCitationCount?: number;
  providerSessionIdPersisted?: boolean;
  summaryChanged?: boolean;
  summary?: string;
  title?: string;
  historySessionCount?: number;
  historyMessageCounts?: number[];
  closeoutModelCalls?: number;
  repairAttempts?: number;
  openingTranscriptSource?: string;
  assistantAudioResponseCount?: number;
  assistantAudioBytes?: number;
  errorCode?: string;
  sessionStatus?: string;
  closeoutStatus?: string;
  storyCountAfterFailure?: number;
  failure?: string;
}

interface ModelAttempt {
  caseName: string;
  status: number | null;
  latencyMs: number;
  requestedModel?: string;
  returnedModel?: string;
  responseId?: string;
  strictSchema: boolean;
  strictObjectSchemas: boolean;
  outputJsonValid: boolean;
  outputKeys: string[];
  usage?: Record<string, number>;
  networkError?: string;
}

interface E2eReport {
  status: 'NOT READY' | 'READY';
  startedAt: string;
  endedAt?: string;
  databasePath: string;
  runDirectory: string;
  demoAuth: Record<string, unknown>;
  caseA: CaseReport;
  caseB: CaseReport;
  providers: Record<string, unknown>;
  transcript: Record<string, unknown>;
  isolation: Record<string, unknown>;
  closeoutAttempts: ModelAttempt[];
  errors: string[];
  regression: 'PENDING';
}

interface AuthenticatedDemoUser {
  accountId: string;
  userId: string;
  cookie: string;
}

interface IsolationFixtureIds {
  userStageId: string;
  otherStageId: string;
  otherStoryId: string;
  otherSessionId: string;
  otherDocumentId: string;
}

interface AudioClip {
  pcm: Buffer;
  sampleRate: number;
  speechBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanError(error: unknown): string {
  let value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const secret of [process.env.STEPFUN_API_KEY, process.env.CLOSEOUT_API_KEY, process.env.DASHSCOPE_API_KEY]) {
    if (secret?.trim()) value = value.split(secret.trim()).join('[redacted]');
  }
  return value
    .replace(/\b(?:ark|sk)-[A-Za-z0-9_-]{16,}\b/gi, '[redacted]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
}

function getWavPcm(wav: Buffer, expectedSampleRate: number): Buffer {
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF', 'TTS conversion did not produce a RIFF WAV');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE', 'TTS conversion did not produce a WAVE file');
  let offset = 12;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitsPerSample: number | undefined;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (payload + size > wav.length) throw new Error(`Invalid WAV chunk: ${id}`);
    if (id === 'fmt ' && size >= 16) {
      const format = wav.readUInt16LE(payload);
      channels = wav.readUInt16LE(payload + 2);
      sampleRate = wav.readUInt32LE(payload + 4);
      bitsPerSample = wav.readUInt16LE(payload + 14);
      assert.equal(format, 1, 'Expected uncompressed PCM audio');
    }
    if (id === 'data') {
      assert.equal(channels, 1, 'Expected mono TTS audio');
      assert.equal(sampleRate, expectedSampleRate, `Expected ${expectedSampleRate} Hz TTS audio`);
      assert.equal(bitsPerSample, 16, 'Expected 16-bit TTS audio');
      const pcm = wav.subarray(payload, payload + size);
      assert.ok(pcm.length > 0, 'TTS audio is empty');
      return pcm;
    }
    offset = payload + size + (size % 2);
  }
  throw new Error('WAV audio data chunk was not found.');
}

function synthesizeClip(text: string, voice: string, fileStem: string, directory: string, sampleRate: number): AudioClip {
  const aiffPath = path.join(directory, `${fileStem}.aiff`);
  const wavPath = path.join(directory, `${fileStem}-${sampleRate}-mono.wav`);
  execFileSync('say', ['-v', voice, '-o', aiffPath, text], { stdio: 'ignore' });
  execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${sampleRate}`, '-c', '1', aiffPath, wavPath], { stdio: 'ignore' });
  const pcm = getWavPcm(readFileSync(wavPath), sampleRate);
  return { pcm, sampleRate, speechBytes: pcm.length };
}

function listenForMessages(socket: WebSocket): {
  messages: WireMessage[];
  waitFor: (predicate: (message: WireMessage) => boolean, label: string, timeoutMs?: number, acceptError?: boolean) => Promise<WireMessage>;
} {
  const messages: WireMessage[] = [];
  const waiters = new Set<{
    predicate: (message: WireMessage) => boolean;
    acceptError: boolean;
    resolve: (message: WireMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  socket.on('message', (raw: RawData) => {
    let message: WireMessage;
    try {
      const parsed: unknown = JSON.parse(raw.toString());
      if (!isRecord(parsed)) return;
      message = parsed;
    } catch { return; }
    messages.push(message);
    const isError = message.type === 'error' || message.type === 'transcript_save_error';
    for (const waiter of [...waiters]) {
      if (isError && waiter.acceptError && waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(message);
      } else if (isError) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.reject(new Error(String(message.message ?? 'Realtime service returned an error.')));
      } else if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  });
  socket.on('error', (error) => {
    for (const waiter of [...waiters]) {
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.reject(new Error(`Browser WebSocket failed: ${error.message}`));
    }
  });

  return {
    messages,
    waitFor(predicate, label, timeoutMs = PROVIDER_TIMEOUT_MS, acceptError = false) {
      const existing = messages.find((message) => predicate(message));
      if (existing) return Promise.resolve(existing);
      const existingError = messages.find((message) => message.type === 'error' || message.type === 'transcript_save_error');
      if (existingError) return Promise.reject(new Error(String(existingError.message ?? 'Realtime service returned an error.')));
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          acceptError,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`Timed out waiting for ${label}.`));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
  };
}

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'Demo login should set a signed HttpOnly session cookie');
  return header.split(';', 1)[0]!;
}

async function postJson(baseUrl: string, route: string, body: Record<string, unknown>): Promise<{ response: Response; value: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const value: unknown = await response.json();
  assert.ok(isRecord(value), `${route} should return a JSON object`);
  return { response, value };
}

function createIsolationFixtures(databasePath: string, userOneId: string, userTwoId: string): IsolationFixtureIds {
  const ids = {
    userStageId: randomUUID(),
    otherStageId: randomUUID(),
    otherStoryId: randomUUID(),
    otherSessionId: randomUUID(),
    otherDocumentId: randomUUID(),
  };
  const timestamp = nowUtcIso();
  const transcript: TranscriptMessage[] = [{
    message_id: `fixture-${randomUUID()}`,
    role: 'user',
    text: '仅属于第二个虚构参测档案的隔离测试记录。',
    timestamp,
    provider: 'stepfun',
    provider_message_id: `fixture-provider-${randomUUID()}`,
  }];
  const connection = createDatabase(databasePath);
  try {
    connection.db.transaction((tx) => {
      tx.insert(lifeStages).values([
        {
          stageId: ids.userStageId,
          userId: userOneId,
          title: '2012 杭州项目阶段',
          startDate: '2012',
          endDate: '2014',
          datePrecision: 'year',
          summary: '虚构的跨团队项目经历。',
          sortOrder: 1,
          status: 'active',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          stageId: ids.otherStageId,
          userId: userTwoId,
          title: '账号 B 的隔离阶段',
          startDate: '2020',
          endDate: '2021',
          datePrecision: 'year',
          summary: '仅用于验证另一个档案不可被访问。',
          sortOrder: 1,
          status: 'active',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]).run();
      tx.insert(stories).values({
        storyId: ids.otherStoryId,
        userId: userTwoId,
        stageId: ids.otherStageId,
        title: '账号 B 的虚构隔离故事',
        summary: '仅属于第二个 Demo 手机号档案的内容。',
        status: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      }).run();
      tx.insert(interviewSessions).values({
        sessionId: ids.otherSessionId,
        provider: 'stepfun',
        userId: userTwoId,
        storyId: ids.otherStoryId,
        sessionType: 'story',
        status: 'ended',
        closeoutStatus: 'pending',
        transcriptJson: serializeTranscript(transcript),
        startedAt: timestamp,
        endedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      }).run();
      tx.insert(memoirDocuments).values({
        documentId: ids.otherDocumentId,
        userId: userTwoId,
        scopeType: 'story',
        scopeId: ids.otherStoryId,
        title: '账号 B 的隔离文稿',
        content: '仅用于 owner-scoped Repository 访问验证。',
        status: 'draft',
        createdAt: timestamp,
        updatedAt: timestamp,
      }).run();
    });
  } finally { connection.close(); }
  return ids;
}

async function loginDemoPhone(baseUrl: string, phone: string): Promise<{ user: AuthenticatedDemoUser; body: Record<string, unknown> }> {
  const { response, value } = await postJson(baseUrl, '/api/auth/demo-phone', { phone });
  assert.equal(response.status, 200, `Demo login should accept ${phone.length}-character phone input`);
  const profile = value.profile;
  assert.ok(isRecord(profile));
  assert.equal(value.authMode, 'demo_phone');
  assert.equal(profile.onboarding_status, 'not_started');
  const cookie = cookieFrom(response);
  return {
    user: {
      accountId: String(profile.account_id),
      userId: String(profile.user_id),
      cookie,
    },
    body: value,
  };
}

async function runDemoAuthChecks(baseUrl: string, databasePath: string, report: E2eReport): Promise<{
  userOne: AuthenticatedDemoUser;
  userTwo: AuthenticatedDemoUser;
}> {
  const phoneOne = '19900000001';
  const phoneTwo = '19900000002';
  const firstLogin = await loginDemoPhone(baseUrl, phoneOne);
  report.demoAuth.newPhone = 'PASS';

  const meResponse = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: firstLogin.user.cookie } });
  const meValue: unknown = await meResponse.json();
  assert.equal(meResponse.status, 200);
  assert.ok(isRecord(meValue) && isRecord(meValue.profile));
  assert.equal(meValue.authMode, 'demo_phone');
  assert.equal(meValue.profile.user_id, firstLogin.user.userId);
  assert.equal(meValue.profile.account_id, firstLogin.user.accountId);

  const repeated = await loginDemoPhone(baseUrl, '+86 199-0000-0001');
  assert.equal(repeated.user.accountId, firstLogin.user.accountId);
  assert.equal(repeated.user.userId, firstLogin.user.userId);
  report.demoAuth.repeatPhone = 'PASS';

  for (const invalidPhone of ['123', 'abcdefghijk', '01234567890']) {
    const { response, value } = await postJson(baseUrl, '/api/auth/demo-phone', { phone: invalidPhone });
    assert.equal(response.status, 400);
    assert.equal(value.errorCode, 'INVALID_PHONE');
    assert.equal(response.headers.get('set-cookie'), null);
  }
  report.demoAuth.invalidPhones = 'PASS';

  const secondLogin = await loginDemoPhone(baseUrl, phoneTwo);
  assert.notEqual(secondLogin.user.accountId, firstLogin.user.accountId);
  assert.notEqual(secondLogin.user.userId, firstLogin.user.userId);
  report.demoAuth.distinctAccounts = 'PASS';

  const connection = createDatabase(databasePath);
  try {
    const accounts = connection.sqlite.prepare(
      'SELECT account_id, phone, phone_verified FROM accounts WHERE phone IN (?, ?) ORDER BY phone',
    ).all('+8619900000001', '+8619900000002') as Array<Record<string, unknown>>;
    const profiles = connection.sqlite.prepare(
      'SELECT user_id, account_id, onboarding_status FROM users WHERE account_id IN (?, ?)',
    ).all(firstLogin.user.accountId, secondLogin.user.accountId) as Array<Record<string, unknown>>;
    assert.equal(accounts.length, 2);
    assert.ok(accounts.every((account) => account.phone_verified === 0));
    assert.equal(profiles.length, 2);
    assert.ok(profiles.every((profile) => profile.onboarding_status === 'not_started'));
    assert.equal(new Set(profiles.map((profile) => profile.user_id)).size, 2);
    report.demoAuth.accountUniqueness = 'PASS';
    report.demoAuth.defaultProfiles = 'PASS';
    report.demoAuth.phoneVerifiedPreserved = 'PASS';
  } finally { connection.close(); }

  return { userOne: firstLogin.user, userTwo: secondLogin.user };
}

function schemaAudit(value: unknown): { strictSchema: boolean; strictObjectSchemas: boolean } {
  if (!isRecord(value)) return { strictSchema: false, strictObjectSchemas: false };
  let schema: unknown;
  let strictSchema = false;
  const tools = Array.isArray(value.tools) ? value.tools : [];
  const tool = tools.find(isRecord);
  const functionSpec = isRecord(tool) && isRecord(tool.function) ? tool.function : undefined;
  if (functionSpec) {
    schema = functionSpec.parameters;
    strictSchema = functionSpec.strict === true;
  }
  const responseFormat = isRecord(value.response_format) ? value.response_format : undefined;
  const jsonSchema = responseFormat && isRecord(responseFormat.json_schema) ? responseFormat.json_schema : undefined;
  if (jsonSchema) {
    schema = jsonSchema.schema;
    strictSchema = jsonSchema.strict === true;
  }
  const text = isRecord(value.text) ? value.text : undefined;
  const format = text && isRecord(text.format) ? text.format : undefined;
  if (format) {
    schema = format.schema;
    strictSchema = format.strict === true;
  }
  const allObjectsStrict = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.every(allObjectsStrict);
    if (!isRecord(node)) return true;
    if (node.type === 'object' && node.additionalProperties !== false) return false;
    return Object.values(node).every(allObjectsStrict);
  };
  return { strictSchema, strictObjectSchemas: schema !== undefined && allObjectsStrict(schema) };
}

function outputJsonKeys(apiFormat: string, responseBody: unknown): string[] {
  if (!isRecord(responseBody)) return [];
  let output: unknown;
  if (apiFormat === 'responses') {
    const items = Array.isArray(responseBody.output) ? responseBody.output : [];
    const message = items.find((item) => isRecord(item) && item.type === 'message');
    const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
    const textPart = content.find((part) => isRecord(part) && part.type === 'output_text' && typeof part.text === 'string');
    if (isRecord(textPart)) output = textPart.text;
  } else {
    const choices = Array.isArray(responseBody.choices) ? responseBody.choices : [];
    const choice = choices.find(isRecord);
    const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
    const calls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const toolCall = calls.find(isRecord);
    const functionCall = isRecord(toolCall) && isRecord(toolCall.function) ? toolCall.function : undefined;
    output = typeof functionCall?.arguments === 'string'
      ? functionCall.arguments
      : typeof message?.content === 'string' ? message.content : undefined;
  }
  if (typeof output === 'string') {
    try { output = JSON.parse(output) as unknown; } catch { return []; }
  }
  return isRecord(output) ? Object.keys(output).sort() : [];
}

function interceptCloseoutCalls(
  endpoint: string,
  apiFormat: string,
  attempts: ModelAttempt[],
  currentCase: { name: string },
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    if (requestUrl !== endpoint) return originalFetch(input, init);
    let body: unknown;
    try { body = JSON.parse(String(init?.body ?? '{}')) as unknown; } catch { body = {}; }
    const audit = schemaAudit(body);
    const attempt: ModelAttempt = {
      caseName: currentCase.name,
      status: null,
      latencyMs: 0,
      requestedModel: isRecord(body) && typeof body.model === 'string' ? body.model : undefined,
      strictSchema: audit.strictSchema,
      strictObjectSchemas: audit.strictObjectSchemas,
      outputJsonValid: false,
      outputKeys: [],
    };
    const startedAt = Date.now();
    try {
      const response = await originalFetch(input, init);
      attempt.status = response.status;
      attempt.latencyMs = Date.now() - startedAt;
      if (response.ok) {
        const responseBody: unknown = await response.clone().json().catch(() => undefined);
        if (isRecord(responseBody)) {
          attempt.returnedModel = typeof responseBody.model === 'string' ? responseBody.model : undefined;
          attempt.responseId = typeof responseBody.id === 'string' ? responseBody.id : undefined;
          const usage = isRecord(responseBody.usage) ? responseBody.usage : undefined;
          if (usage) {
            const numericUsage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].flatMap((key) => {
              const count = usage[key];
              return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? [[key, count]] : [];
            }));
            if (Object.keys(numericUsage).length) attempt.usage = numericUsage;
          }
          attempt.outputKeys = outputJsonKeys(apiFormat, responseBody);
          attempt.outputJsonValid = attempt.outputKeys.length > 0;
        }
      }
      attempts.push(attempt);
      return response;
    } catch (error) {
      attempt.latencyMs = Date.now() - startedAt;
      attempt.networkError = cleanError(error);
      attempts.push(attempt);
      throw error;
    }
  }) as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

function createCloseoutEndpoint(baseUrl: string, apiFormat: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${apiFormat === 'responses' ? 'responses' : 'chat/completions'}`;
}

async function testForeignInterviewTarget(
  baseUrl: string,
  cookie: string,
  provider: 'stepfun' | 'stepaudio3_quality' | 'stepaudio2_mini' | 'qwen' | 'modelbest',
  target: { story_id?: string; stage_id?: string },
  expectedText: string,
): Promise<void> {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/api/realtime`, {
    headers: { cookie, origin: baseUrl },
  });
  try {
    await once(socket, 'open');
    const channel = listenForMessages(socket);
    socket.send(JSON.stringify({ type: 'start', ...target, provider }));
    const failure = await channel.waitFor((message) => message.type === 'error', 'owner-scoped Interview rejection', PROVIDER_TIMEOUT_MS, true);
    assert.match(String(failure.message), new RegExp(expectedText));
  } finally {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      const closed = once(socket, 'close');
      socket.close(1000, 'foreign target rejected');
      try { await closed; } catch { /* Socket may already be closed. */ }
    }
  }
}

async function runIsolationChecks(
  baseUrl: string,
  databasePath: string,
  provider: 'stepfun' | 'stepaudio3_quality' | 'stepaudio2_mini' | 'qwen' | 'modelbest',
  userOne: AuthenticatedDemoUser,
  userTwo: AuthenticatedDemoUser,
  ids: IsolationFixtureIds,
  report: E2eReport,
): Promise<void> {
  const [storiesOneResponse, stagesOneResponse, storiesTwoResponse, stagesTwoResponse] = await Promise.all([
    fetch(`${baseUrl}/api/stories`, { headers: { cookie: userOne.cookie } }),
    fetch(`${baseUrl}/api/life-stages`, { headers: { cookie: userOne.cookie } }),
    fetch(`${baseUrl}/api/stories`, { headers: { cookie: userTwo.cookie } }),
    fetch(`${baseUrl}/api/life-stages`, { headers: { cookie: userTwo.cookie } }),
  ]);
  const [storiesOne, stagesOne, storiesTwo, stagesTwo] = await Promise.all([
    storiesOneResponse.json() as Promise<{ stories?: Array<Record<string, unknown>> }>,
    stagesOneResponse.json() as Promise<{ life_stages?: Array<Record<string, unknown>> }>,
    storiesTwoResponse.json() as Promise<{ stories?: Array<Record<string, unknown>> }>,
    stagesTwoResponse.json() as Promise<{ life_stages?: Array<Record<string, unknown>> }>,
  ]);
  assert.equal(storiesOneResponse.status, 200);
  assert.equal(stagesOneResponse.status, 200);
  assert.equal(storiesTwoResponse.status, 200);
  assert.equal(stagesTwoResponse.status, 200);
  assert.ok(!storiesOne.stories?.some((story) => story.story_id === ids.otherStoryId));
  assert.ok(!stagesOne.life_stages?.some((stage) => stage.stage_id === ids.otherStageId));
  assert.ok(storiesTwo.stories?.some((story) => story.story_id === ids.otherStoryId));
  assert.ok(stagesTwo.life_stages?.some((stage) => stage.stage_id === ids.otherStageId));
  report.isolation.storyLists = 'PASS';
  report.isolation.lifeStageLists = 'PASS';

  const transcripts = new TranscriptRepository(databasePath);
  assert.equal(transcripts.getForSession(userOne.userId, ids.otherSessionId), null);
  assert.deepEqual(transcripts.getTranscriptsByStoryId(userOne.userId, ids.otherStoryId), []);
  assert.equal(transcripts.getTranscriptsByStoryId(userTwo.userId, ids.otherStoryId).length, 1);
  report.isolation.transcripts = 'PASS';

  const documents = new MemoirDocumentRepository(databasePath);
  assert.equal(documents.findByIdForUser(userOne.userId, ids.otherDocumentId), null);
  assert.equal(documents.findByIdForUser(userTwo.userId, ids.otherDocumentId)?.documentId, ids.otherDocumentId);
  report.isolation.documents = 'PASS';

  const foreignResult = await fetch(`${baseUrl}/api/interview-sessions/${encodeURIComponent(ids.otherSessionId)}/result`, {
    headers: { cookie: userOne.cookie },
  });
  const foreignResultBody: unknown = await foreignResult.json();
  assert.equal(foreignResult.status, 404);
  assert.ok(isRecord(foreignResultBody) && foreignResultBody.code === 'SESSION_NOT_FOUND');
  const foreignCloseout = await fetch(`${baseUrl}/api/interview-sessions/${encodeURIComponent(ids.otherSessionId)}/closeout`, {
    method: 'POST',
    headers: { cookie: userOne.cookie },
  });
  const foreignCloseoutBody: unknown = await foreignCloseout.json();
  assert.equal(foreignCloseout.status, 404);
  assert.ok(isRecord(foreignCloseoutBody) && foreignCloseoutBody.errorCode === 'SESSION_NOT_FOUND');
  report.isolation.closeoutAndSession = 'PASS';

  await testForeignInterviewTarget(baseUrl, userOne.cookie, provider, { story_id: ids.otherStoryId }, '当前人生档案中的故事');
  await testForeignInterviewTarget(baseUrl, userOne.cookie, provider, { stage_id: ids.otherStageId }, '当前人生档案中的人生阶段');
  report.isolation.interviewTargets = 'PASS';

  const connection = createDatabase(databasePath);
  try {
    const foreign = connection.db.select().from(interviewSessions)
      .where(eq(interviewSessions.sessionId, ids.otherSessionId)).get();
    assert.equal(foreign?.userId, userTwo.userId);
    assert.equal(foreign?.closeoutStatus, 'pending');
  } finally { connection.close(); }
  report.isolation.status = 'PASS';
}

async function sendAudioTurn(
  socket: WebSocket,
  channel: ReturnType<typeof listenForMessages>,
  clip: AudioClip,
  turnControl: { manual: boolean; silenceTimeoutMs: number },
  knownUserIds: Set<string>,
  knownResponseIds: Set<string>,
  reportAudio: {
    totalBytes: number;
    frames: number;
    silenceTailMs: number;
    assistantAudioResponseCount: number;
    assistantAudioBytes: number;
  },
  label: string,
): Promise<{ userTextCharacters: number; assistantTextCharacters: number; userMessageId: string; assistantResponseId: string }> {
  const frameBytes = clip.sampleRate / 50 * 2;
  const silenceTailMs = turnControl.manual
    ? Math.max(reportAudio.silenceTailMs, turnControl.silenceTimeoutMs)
    : reportAudio.silenceTailMs;
  const silenceTail = Buffer.alloc(clip.sampleRate * 2 * silenceTailMs / 1_000);
  const audio = Buffer.concat([clip.pcm, silenceTail]);
  if (turnControl.manual) socket.send(JSON.stringify({ type: 'manual_turn_started' }));
  for (let offset = 0; offset < audio.length; offset += frameBytes) {
    const frame = audio.subarray(offset, Math.min(offset + frameBytes, audio.length));
    socket.send(frame, { binary: true });
    reportAudio.totalBytes += frame.length;
    reportAudio.frames += 1;
    await sleep(20);
  }
  if (turnControl.manual) socket.send(JSON.stringify({
    type: 'manual_turn_commit',
    silenceObservedMs: silenceTailMs,
  }));

  const silenceFrame = Buffer.alloc(frameBytes);
  const keepalive = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(silenceFrame, { binary: true });
    reportAudio.totalBytes += silenceFrame.length;
    reportAudio.frames += 1;
  }, 20);
  try {
    const userFinal = await channel.waitFor((message) => message.type === 'user_final'
      && typeof message.itemId === 'string' && !knownUserIds.has(String(message.itemId)), `${label} ASR final`, 60_000);
    const userMessageId = String(userFinal.itemId);
    const userText = String(userFinal.text ?? '').trim();
    assert.ok(userText.length > 0, `${label} ASR should return a non-empty user answer`);
    knownUserIds.add(userMessageId);
    await channel.waitFor((message) => message.type === 'transcript_saved'
      && message.role === 'user' && message.providerMessageId === userMessageId, `${label} saved user Transcript`);

    const assistantFinal = await channel.waitFor((message) => message.type === 'assistant_final'
      && typeof message.responseId === 'string' && !knownResponseIds.has(String(message.responseId)), `${label} Realtime follow-up`, 60_000);
    const assistantResponseId = String(assistantFinal.responseId);
    const assistantText = String(assistantFinal.text ?? '').trim();
    assert.ok(assistantText.length > 0, `${label} Realtime follow-up should be non-empty`);
    knownResponseIds.add(assistantResponseId);
    await channel.waitFor((message) => message.type === 'transcript_saved'
      && message.role === 'assistant' && message.providerMessageId === assistantFinal.itemId, `${label} saved assistant Transcript`);
    await channel.waitFor((message) => message.type === 'response_done'
      && message.responseId === assistantResponseId && message.status === 'completed', `${label} Realtime response completion`);
    const assistantAudio = getResponseAudioStats(channel.messages, assistantResponseId);
    assert.ok(assistantAudio.bytes > 0, `${label} should receive real Realtime Provider audio for the AI follow-up`);
    reportAudio.assistantAudioResponseCount += 1;
    reportAudio.assistantAudioBytes += assistantAudio.bytes;
    return {
      userTextCharacters: userText.length,
      assistantTextCharacters: assistantText.length,
      userMessageId,
      assistantResponseId,
    };
  } finally {
    clearInterval(keepalive);
  }
}

function getResponseAudioStats(messages: WireMessage[], responseId: string): { chunks: number; bytes: number } {
  const chunks = messages.filter((message) => message.type === 'assistant_audio'
    && message.responseId === responseId && typeof message.delta === 'string');
  return {
    chunks: chunks.length,
    bytes: chunks.reduce((total, message) => total + Buffer.from(String(message.delta), 'base64').byteLength, 0),
  };
}

function modelOutputForCase(attempts: ModelAttempt[], caseName: string): ModelAttempt[] {
  return attempts.filter((attempt) => attempt.caseName === caseName);
}

function readSession(databasePath: string, sessionId: string) {
  const connection = createDatabase(databasePath);
  try {
    return connection.db.select().from(interviewSessions).where(eq(interviewSessions.sessionId, sessionId)).get() ?? null;
  } finally { connection.close(); }
}

async function runStoryCase(input: {
  name: string;
  mode: 'create' | 'continue';
  baseUrl: string;
  databasePath: string;
  cookie: string;
  provider: 'stepfun' | 'stepaudio3_quality' | 'stepaudio2_mini' | 'qwen' | 'modelbest';
  target: { story_id?: string; stage_id?: string; story_title?: string };
  expectedStoryId?: string;
  expectedStageId: string;
  expectedUserId: string;
  expectedStoryTitle?: string;
  priorSummary?: string;
  clips: AudioClip[];
  attempts: ModelAttempt[];
  currentModelCase: { name: string };
  reportCase: CaseReport;
  report: E2eReport;
}): Promise<{ storyId: string; summary: string; sessionId: string; transcriptCount: number }> {
  const socket = new WebSocket(`${input.baseUrl.replace(/^http/, 'ws')}/api/realtime`, {
    headers: { cookie: input.cookie, origin: input.baseUrl },
  });
  let sessionId: string | undefined;
  let ended = false;
  let channel: ReturnType<typeof listenForMessages> | undefined;
  const audioStats = {
    totalBytes: 0,
    frames: 0,
    silenceTailMs: SILENCE_TAIL_MS,
    assistantAudioResponseCount: 0,
    assistantAudioBytes: 0,
  };
  input.currentModelCase.name = input.name;
  input.reportCase.status = 'FAIL';
  input.reportCase.mode = input.mode;
  process.stdout.write(`${input.name}: starting authenticated Realtime session (${input.mode})\n`);

  try {
    await once(socket, 'open');
    const realtimeChannel = listenForMessages(socket);
    channel = realtimeChannel;
    const ready = await startRealtimeSession(
      socket,
      { type: 'start', ...input.target, provider: input.provider },
      () => realtimeChannel.waitFor((message) => message.type === 'ready', `${input.name} Realtime ready`),
    );
    sessionId = String(ready.sessionId);
    const turnControl = {
      manual: ready.manualTurnControl === true,
      silenceTimeoutMs: typeof ready.localVadSilenceTimeoutMs === 'number'
        ? ready.localVadSilenceTimeoutMs
        : 2_000,
    };
    input.reportCase.sessionId = sessionId;
    const startingSession = readSession(input.databasePath, sessionId);
    assert.ok(startingSession, `${input.name} should create its Session after target ownership is validated`);
    assert.equal(startingSession.userId, input.expectedUserId);
    assert.equal(startingSession.sessionType, 'story');
    assert.equal(startingSession.provider, input.provider);
    if (input.mode === 'create') {
      assert.equal(startingSession.storyId, null, 'new Story interview must start unlinked');
      assert.equal(startingSession.stageId, input.expectedStageId, 'new Story interview must start scoped to its target LifeStage');
    } else {
      assert.equal(startingSession.storyId, input.expectedStoryId, 'continued Story interview must link its existing Story');
      assert.equal(startingSession.stageId, null, 'continued Story interview must not duplicate the LifeStage link');
    }

    const knownUserIds = new Set<string>();
    const knownResponseIds = new Set<string>();
    const opening = await channel.waitFor((message) => message.type === 'assistant_final'
      && typeof message.responseId === 'string', `${input.name} AI opening response`);
    const openingText = String(opening.text ?? '').trim();
    assert.ok(openingText.length > 0, `${input.name} should receive the provider's AI opening response`);
    input.reportCase.openingTranscriptSource = 'Realtime Provider transcript';
    const openingResponseId = String(opening.responseId);
    knownResponseIds.add(openingResponseId);
    await channel.waitFor((message) => message.type === 'transcript_saved'
      && message.role === 'assistant' && message.providerMessageId === opening.itemId, `${input.name} saved opening Transcript`);
    await channel.waitFor((message) => message.type === 'response_done'
      && message.responseId === openingResponseId && message.status === 'completed', `${input.name} opening response completion`);
    const openingAudio = getResponseAudioStats(channel.messages, openingResponseId);
    assert.ok(openingAudio.bytes > 0, `${input.name} opening must contain audio from the live Realtime Provider`);
    audioStats.assistantAudioResponseCount += 1;
    audioStats.assistantAudioBytes += openingAudio.bytes;

    for (let index = 0; index < input.clips.length; index += 1) {
      await sendAudioTurn(
        socket,
        channel,
        input.clips[index]!,
        turnControl,
        knownUserIds,
        knownResponseIds,
        audioStats,
        `${input.name} user answer ${index + 1}`,
      );
      process.stdout.write(`${input.name}: synthetic audio turn ${index + 1}/5 and AI follow-up saved\n`);
    }
    assert.equal(knownUserIds.size, 5, `${input.name} should contain five real user audio turns`);
    assert.equal(audioStats.assistantAudioResponseCount, 6,
      `${input.name} opening and all five AI follow-ups should return Realtime Provider audio`);

    const transcriptRepository = new TranscriptRepository(input.databasePath);
    const beforeCloseout = transcriptRepository.getForSession(input.expectedUserId, sessionId);
    assert.ok(beforeCloseout && beforeCloseout.length >= 11, `${input.name} should persist opening and all interview turns before Closeout`);
    const transcriptSnapshot = JSON.stringify(beforeCloseout);
    input.reportCase.transcriptCountBeforeCloseout = beforeCloseout.length;
    input.reportCase.userFinalCount = beforeCloseout.filter((message) => message.role === 'user').length;
    input.reportCase.assistantFinalCount = beforeCloseout.filter((message) => message.role === 'assistant').length;
    input.reportCase.audioBytesSent = audioStats.totalBytes;
    input.reportCase.audioFramesSent = audioStats.frames;
    input.reportCase.assistantAudioResponseCount = audioStats.assistantAudioResponseCount;
    input.reportCase.assistantAudioBytes = audioStats.assistantAudioBytes;
    assert.equal(input.reportCase.userFinalCount, 5);
    assert.ok(audioStats.totalBytes > 0 && audioStats.frames > 0, `${input.name} must send synthesized audio to the Realtime Provider`);

    input.currentModelCase.name = input.name;
    const modelCallStart = modelOutputForCase(input.attempts, input.name).length;
    socket.send(JSON.stringify({ type: 'end', reason: 'user' }));
    const endedMessage = await channel.waitFor((message) => message.type === 'ended', `${input.name} ended Session`);
    ended = true;
    assert.equal(endedMessage.sessionId, sessionId);
    assert.equal(endedMessage.drainTimedOut, false, `${input.name} Realtime drain should finish`);
    assert.equal(endedMessage.pendingWriteCount, 0, `${input.name} Transcript write queue should drain`);
    assert.deepEqual(endedMessage.transcriptSaveErrors, [], `${input.name} Transcript should have no write errors`);
    assert.equal(endedMessage.transcriptCount, endedMessage.savedTranscriptCount);

    const deadline = Date.now() + CLOSEOUT_TIMEOUT_MS;
    let result: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      const response: Response = await fetch(`${input.baseUrl}/api/interview-sessions/${encodeURIComponent(sessionId)}/result`, {
        headers: { cookie: input.cookie, accept: 'application/json' },
        cache: 'no-store',
      });
      const value: unknown = await response.json();
      assert.equal(response.status, 200, `${input.name} owner should be able to poll its result`);
      assert.ok(isRecord(value));
      result = value;
      if (result.closeoutStatus === 'completed' || result.closeoutStatus === 'failed') break;
      await sleep(1_000);
    }
    assert.ok(result, `${input.name} result endpoint should return a value`);
    if (result.closeoutStatus !== 'completed') {
      input.reportCase.errorCode = String(result.errorCode ?? 'CLOSEOUT_NOT_COMPLETED');
      input.reportCase.failure = cleanError(new Error(`${input.reportCase.errorCode}: ${String(result.error ?? 'Closeout failed')}`));
      throw new Error(`${input.name} real Closeout finished with ${input.reportCase.errorCode}`);
    }
    process.stdout.write(`${input.name}: real Closeout completed\n`);

    const session = readSession(input.databasePath, sessionId);
    assert.ok(session, `${input.name} Session should persist`);
    const afterCloseout = transcriptRepository.getForSession(session.userId, sessionId);
    assert.ok(afterCloseout);
    assert.equal(JSON.stringify(afterCloseout), transcriptSnapshot, `${input.name} Closeout must not rewrite or replace the raw Transcript`);
    input.reportCase.transcriptCountAfterCloseout = afterCloseout.length;
    input.reportCase.sessionStatus = session.status;
    input.reportCase.closeoutStatus = session.closeoutStatus;
    input.reportCase.closeoutModelCalls = modelOutputForCase(input.attempts, input.name).length - modelCallStart;

    const closeoutResult = parseJsonColumn(session.closeoutResultJson, closeoutResultSchema);
    assert.ok(closeoutResult?.model_metadata, `${input.name} should persist safe real model metadata`);
    assert.equal(closeoutResult.model_metadata.provider, 'volcengine-agent-plan');
    assert.ok(typeof closeoutResult.model_metadata.model === 'string' && closeoutResult.model_metadata.model.length > 0);
    input.reportCase.repairAttempts = Number(closeoutResult.model_metadata.repair_attempt_count ?? 0);

    const sourceUserMessageIds = new Set(afterCloseout.filter((message) => message.role === 'user').map((message) => message.message_id));
    let appliedStoryId: string;
    let appliedStory: typeof stories.$inferSelect | null;
    let sourceIds: string[] = [];
    if (input.mode === 'create') {
      const createdStories = (() => {
        const connection = createDatabase(input.databasePath);
        try {
          return connection.db.select().from(stories).where(eq(stories.createdSourceSessionId, sessionId)).all();
        } finally { connection.close(); }
      })();
      assert.equal(createdStories.length, 1, 'create-mode Closeout should apply one new Story');
      appliedStory = createdStories[0]!;
      appliedStoryId = appliedStory.storyId;
      input.reportCase.storyId = appliedStoryId;
      sourceIds = closeoutResult.new_stories?.flatMap((story) => story.source_message_ids ?? []) ?? [];
      assert.ok(sourceIds.length > 0, 'new Story Closeout should persist source message references');
      assert.ok(sourceIds.every((id) => sourceUserMessageIds.has(id)), 'new Story references must point to this Session user messages');
      assert.equal(appliedStory.userId, session.userId);
      assert.equal(appliedStory.stageId, input.expectedStageId);
      assert.equal(appliedStory.createdSourceSessionId, sessionId);
      assert.equal(session.storyId, appliedStoryId);
      assert.equal(session.stageId, null);
      if (input.expectedStoryId) assert.equal(appliedStoryId, input.expectedStoryId);
    } else {
      assert.equal(session.storyId, input.expectedStoryId);
      assert.equal(session.stageId, null);
      appliedStoryId = String(input.expectedStoryId);
      const connection = createDatabase(input.databasePath);
      try {
        appliedStory = connection.db.select().from(stories).where(eq(stories.storyId, appliedStoryId)).get() ?? null;
      } finally { connection.close(); }
      assert.ok(appliedStory);
      assert.equal(appliedStory.userId, session.userId);
      assert.equal(appliedStory.stageId, input.expectedStageId);
      assert.notEqual(appliedStory.summary, input.priorSummary, 'continue-mode Closeout should update the existing Story summary');
      sourceIds = closeoutResult.current_story_source_message_ids ?? [];
      assert.ok(sourceIds.length > 0, 'continued Story summary should cite this Session user messages');
      assert.ok(sourceIds.every((id) => sourceUserMessageIds.has(id)), 'continued Story references must point to this Session user messages');
      input.reportCase.summaryChanged = true;
      const histories = new StoryRepository(input.databasePath).getTranscriptsByStoryId(session.userId, appliedStoryId);
      input.reportCase.historySessionCount = histories.length;
      input.reportCase.historyMessageCounts = histories.map((history) => history.messages.length);
      assert.equal(histories.length, 2, 'continued Story history should include both Sessions');
      assert.ok(histories.every((history) => history.messages.length > 0));
    }

    assert.equal(session.status, 'completed');
    assert.equal(session.closeoutStatus, 'completed');
    assert.equal(session.provider, input.provider);
    assert.ok(session.providerSessionId, `${input.name} should persist the external Realtime Provider session ID`);
    assert.ok(appliedStory.title.trim().length > 0);
    assert.ok(appliedStory.summary.trim().length > 20);
    input.reportCase.title = appliedStory.title;
    input.reportCase.summary = appliedStory.summary;
    input.reportCase.providerSessionIdPersisted = true;
    input.reportCase.sourceCitationCount = sourceIds.length;
    input.reportCase.stageId = appliedStory.stageId;
    input.reportCase.storyId = appliedStory.storyId;
    assert.equal(result.session && isRecord(result.session) ? result.session.closeout_status : undefined, 'completed');
    input.reportCase.status = 'PASS';
    return { storyId: appliedStoryId, summary: appliedStory.summary, sessionId, transcriptCount: afterCloseout.length };
  } catch (error) {
    input.reportCase.status = 'FAIL';
    input.reportCase.failure = cleanError(error);
    if (sessionId) {
      const session = readSession(input.databasePath, sessionId);
      input.reportCase.sessionStatus = session?.status;
      input.reportCase.closeoutStatus = session?.closeoutStatus;
      input.reportCase.errorCode ??= session?.closeoutStatus === 'failed' ? 'CLOSEOUT_FAILED' : undefined;
      const connection = createDatabase(input.databasePath);
      try { input.reportCase.storyCountAfterFailure = connection.db.select().from(stories).all().length; }
      finally { connection.close(); }
    }
    throw error;
  } finally {
    if (socket.readyState === WebSocket.OPEN) {
      if (!ended && channel) {
        socket.send(JSON.stringify({ type: 'end', reason: 'user' }));
        try { await channel.waitFor((message) => message.type === 'ended', `${input.name} failure cleanup`, 30_000); } catch { /* Keep the original failure. */ }
      }
      socket.close(1000, `${input.name} acceptance finished`);
      try { await once(socket, 'close'); } catch { /* Socket may already be closed. */ }
    }
  }
}

function reportMarkdown(report: E2eReport): string {
  const status = report.status === 'READY' ? 'READY FOR MANUAL TEST' : 'NOT READY FOR MANUAL TEST';
  const line = (label: string, value: unknown) => `- ${label}: ${String(value ?? 'NOT RUN')}`;
  const auth = report.demoAuth;
  const provider = report.providers;
  const attempts = report.closeoutAttempts;
  const attemptSummary = attempts.map((attempt) =>
    `${attempt.caseName}: HTTP ${attempt.status ?? 'network error'}, strict schema=${attempt.strictSchema}, `
    + `valid JSON=${attempt.outputJsonValid}, ${attempt.latencyMs} ms${attempt.networkError ? `, ${attempt.networkError}` : ''}`,
  ).join('\n') || '未调用 TextModelProvider。';
  return [
    '# Real Provider E2E 验收报告',
    '',
    `- 总结论：**${status}**`,
    `- 开始时间：${report.startedAt}`,
    `- 结束时间：${report.endedAt ?? '未完成'}`,
    `- 隔离数据库：\`${report.databasePath}\``,
    `- 完整运行目录：\`${report.runDirectory}\``,
    '',
    '## Demo Auth',
    '',
    line('新手机号登录', auth.newPhone),
    line('同手机号再次登录复用 Account/Profile', auth.repeatPhone),
    line('非法手机号拒绝', auth.invalidPhones),
    line('不同手机号映射不同 Account/Profile', auth.distinctAccounts),
    line('Account 唯一性', auth.accountUniqueness),
    line('默认 Profile 创建', auth.defaultProfiles),
    line('phone_verified 保持真实语义', auth.phoneVerifiedPreserved),
    '',
    '## CASE A：新建 Story',
    '',
    line('结果', report.caseA.status),
    line('Session ID', report.caseA.sessionId),
    line('Story ID', report.caseA.storyId),
    line('Stage ID', report.caseA.stageId),
    line('Session 状态 / Closeout 状态', `${report.caseA.sessionStatus ?? '?'} / ${report.caseA.closeoutStatus ?? '?'}`),
    line('Transcript 数量（Closeout 前/后）', `${report.caseA.transcriptCountBeforeCloseout ?? '?'} / ${report.caseA.transcriptCountAfterCloseout ?? '?'}`),
    line('真实用户语音回合 / AI 回复', `${report.caseA.userFinalCount ?? '?'} / ${report.caseA.assistantFinalCount ?? '?'}`),
    line('开场 Transcript 来源', report.caseA.openingTranscriptSource),
    line('AI Realtime 音频回复数 / 音频量', `${report.caseA.assistantAudioResponseCount ?? '?'} / ${report.caseA.assistantAudioBytes ?? '?'} bytes`),
    line('合成音频发送量 / 帧数', `${report.caseA.audioBytesSent ?? '?'} bytes / ${report.caseA.audioFramesSent ?? '?'}`),
    line('来源引用数', report.caseA.sourceCitationCount),
    line('Provider Session ID 落库', report.caseA.providerSessionIdPersisted),
    line('Story 标题', report.caseA.title),
    line('Story 摘要', report.caseA.summary),
    ...(report.caseA.failure ? [line('失败原因', report.caseA.failure)] : []),
    '',
    '## CASE B：继续已有 Story',
    '',
    line('结果', report.caseB.status),
    line('Session ID', report.caseB.sessionId),
    line('Story ID', report.caseB.storyId),
    line('Session 状态 / Closeout 状态', `${report.caseB.sessionStatus ?? '?'} / ${report.caseB.closeoutStatus ?? '?'}`),
    line('Summary 更新', report.caseB.summaryChanged),
    line('Transcript 数量（Closeout 前/后）', `${report.caseB.transcriptCountBeforeCloseout ?? '?'} / ${report.caseB.transcriptCountAfterCloseout ?? '?'}`),
    line('真实用户语音回合 / AI 回复', `${report.caseB.userFinalCount ?? '?'} / ${report.caseB.assistantFinalCount ?? '?'}`),
    line('开场 Transcript 来源', report.caseB.openingTranscriptSource),
    line('AI Realtime 音频回复数 / 音频量', `${report.caseB.assistantAudioResponseCount ?? '?'} / ${report.caseB.assistantAudioBytes ?? '?'} bytes`),
    line('合成音频发送量 / 帧数', `${report.caseB.audioBytesSent ?? '?'} bytes / ${report.caseB.audioFramesSent ?? '?'}`),
    line('来源引用数', report.caseB.sourceCitationCount),
    line('Provider Session ID 落库', report.caseB.providerSessionIdPersisted),
    line('Story 历史 Session / Transcript 条数', `${report.caseB.historySessionCount ?? '?'} / ${(report.caseB.historyMessageCounts ?? []).join(', ') || '?'}`),
    line('最终 Story 摘要', report.caseB.summary),
    ...(report.caseB.failure ? [line('失败原因', report.caseB.failure)] : []),
    '',
    '## Provider 与结构化 Closeout',
    '',
    line('Realtime Provider / Model', `${String(provider.realtimeProvider ?? '?')} / ${String(provider.realtimeModel ?? '?')}`),
    line('Text Provider / Model', `${String(provider.textProvider ?? '?')} / ${String(provider.textModel ?? '?')}`),
    line('Structured Output Schema / Validator', report.caseA.status === 'PASS' && report.caseB.status === 'PASS'
      && ['CASE A', 'CASE B'].every((name) => modelOutputForCase(attempts, name).some((attempt) => attempt.outputJsonValid))
      && attempts.every((attempt) => attempt.strictSchema && attempt.strictObjectSchemas) ? 'PASS' : 'FAIL'),
    line('Text Model 调用数', attempts.length),
    attemptSummary,
    '',
    '## Transcript 与数据隔离',
    '',
    line('Closeout 前后 Transcript 保持不变', report.transcript.closeoutPreserved),
    line('Story 历史 Transcript 完整', report.transcript.storyHistory),
    line('IDOR isolation', report.isolation.status),
    line('Story / LifeStage / Session / Closeout / Interview / Transcript / Document', Object.entries(report.isolation)
      .filter(([key]) => key !== 'status').map(([key, value]) => `${key}=${String(value)}`).join('; ') || 'NOT RUN'),
    '',
    '## Regression 与结论',
    '',
    line('codex-verify', report.regression),
    line('最终判断', status),
    ...(report.errors.length ? ['', '### 错误记录', '', ...report.errors.map((error) => `- ${error}`)] : []),
    '',
    '> 仅使用虚构人物和合成语音。数据库、音频、JSON 报告均保存在隔离 E2E 目录；未执行短信验证码测试。',
    '',
  ].join('\n');
}

async function closeServer(server: ReturnType<typeof createInterviewServiceServer>): Promise<void> {
  if (!server.listening) return;
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
}

async function main(): Promise<void> {
  mkdirSync(E2E_ROOT, { recursive: true });
  mkdirSync(path.dirname(FINAL_REPORT_PATH), { recursive: true });
  const runDirectory = mkdtempSync(path.join(E2E_ROOT, `${new Date().toISOString().replace(/[:.]/g, '-')}-real-provider-`));
  const databasePath = path.join(runDirectory, 'real-provider-e2e.db');
  const report: E2eReport = {
    status: 'NOT READY',
    startedAt: new Date().toISOString(),
    databasePath,
    runDirectory,
    demoAuth: {},
    caseA: { status: 'NOT RUN', mode: 'create' },
    caseB: { status: 'NOT RUN', mode: 'continue' },
    providers: {},
    transcript: { closeoutPreserved: 'NOT RUN', storyHistory: 'NOT RUN' },
    isolation: { status: 'NOT RUN' },
    closeoutAttempts: [],
    errors: [],
    regression: 'PENDING',
  };
  let server: ReturnType<typeof createInterviewServiceServer> | undefined;
  let restoreFetch: (() => void) | undefined;
  let runtime: ReturnType<typeof readRuntimeConfig> | undefined;

  try {
    runtime = readRuntimeConfig();
    const realtimeProvider = runtime.defaultRealtimeProvider ?? 'stepaudio3_quality';
    const isStepFunProfile = realtimeProvider === 'stepfun'
      || realtimeProvider === 'stepaudio3_quality'
      || realtimeProvider === 'stepaudio2_mini';
    const realtimeConfigured = isStepFunProfile
      ? Boolean(runtime.stepfunApiKey)
      : realtimeProvider === 'modelbest'
        ? Boolean(runtime.modelbestApiKey)
        : Boolean(runtime.apiKey && runtime.workspaceId);
    const realtimeModel = realtimeProvider === 'stepaudio3_quality'
      ? runtime.stepaudio3Model
      : isStepFunProfile
        ? runtime.stepfunModel
      : realtimeProvider === 'modelbest' ? runtime.modelbestModel : runtime.qwenModel;
    const closeoutApiFormat = runtime.closeoutApiFormat ?? 'chat-completions';
    const closeoutEndpoint = createCloseoutEndpoint(runtime.closeoutBaseUrl ?? 'https://ark.cn-beijing.volces.com/api/plan/v3', closeoutApiFormat);
    report.providers = {
      realtimeProvider,
      realtimeModel,
      realtimeConfigured,
      textProvider: runtime.closeoutProvider ?? 'volcengine-agent-plan',
      textModel: runtime.closeoutModel ?? 'deepseek-v4-flash',
      textConfigured: Boolean(runtime.closeoutApiKey),
      apiFormat: closeoutApiFormat,
      endpoint: closeoutEndpoint,
    };
    process.stdout.write(`Isolated acceptance directory: ${runDirectory}\n`);
    process.stdout.write(`Live providers: ${realtimeProvider}/${realtimeModel} + ${runtime.closeoutProvider ?? 'volcengine-agent-plan'}/${runtime.closeoutModel ?? 'deepseek-v4-flash'}\n`);
    if (!realtimeConfigured) throw new Error(`Configured Realtime Provider ${realtimeProvider} is missing credentials.`);
    if (!runtime.closeoutApiKey?.trim()) throw new Error('CLOSEOUT_API_KEY is not configured in the current Worktree.');

    const migrationDb = createDatabase(databasePath);
    try { runMigrations(migrationDb); } finally { migrationDb.close(); }

    const voice = process.env.E2E_TTS_VOICE?.trim() || 'Tingting';
    const sampleRate = isStepFunProfile ? 24_000 : 16_000;
    const createClips = createStoryAnswers.map((answer, index) => synthesizeClip(answer, voice, `case-a-answer-${index + 1}`, runDirectory, sampleRate));
    const continueClips = continueStoryAnswers.map((answer, index) => synthesizeClip(answer, voice, `case-b-answer-${index + 1}`, runDirectory, sampleRate));
    report.providers = { ...report.providers, syntheticSpeechVoice: voice, syntheticUserAnswersPerCase: 5 };

    server = createInterviewServiceServer({
      ...runtime,
      host: '127.0.0.1',
      port: 0,
      databasePath,
      authMode: 'demo_phone',
      authSessionSecret: randomBytes(32).toString('base64url'),
      developmentAuthEnabled: false,
      secureCookies: false,
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const healthResponse = await fetch(`${baseUrl}/api/health`, { cache: 'no-store' });
    assert.equal(healthResponse.status, 200);
    const health: unknown = await healthResponse.json();
    assert.ok(isRecord(health));
    assert.equal(health.databaseAvailable, true);
    const healthProviders = isRecord(health.providers) ? health.providers : {};
    const activeProviderState = healthProviders[realtimeProvider];
    assert.ok(isRecord(activeProviderState) && activeProviderState.configured === true);
    const healthCloseout = isRecord(health.closeout) ? health.closeout : {};
    assert.equal(healthCloseout.configured, true);

    const users = await runDemoAuthChecks(baseUrl, databasePath, report);
    process.stdout.write('Demo Auth new/repeat/invalid phone checks passed for two isolated accounts\n');
    const fixtureIds = createIsolationFixtures(databasePath, users.userOne.userId, users.userTwo.userId);
    report.isolation.fixtureSessionId = fixtureIds.otherSessionId;
    report.isolation.fixtureStoryId = fixtureIds.otherStoryId;
    await runIsolationChecks(baseUrl, databasePath, realtimeProvider, users.userOne, users.userTwo, fixtureIds, report);
    process.stdout.write('Two-account Story/Stage/Session/Transcript/Closeout/Interview/Document isolation checks passed\n');

    const currentModelCase = { name: '' };
    restoreFetch = interceptCloseoutCalls(closeoutEndpoint, closeoutApiFormat, report.closeoutAttempts, currentModelCase);
    const caseA = await runStoryCase({
      name: 'CASE A',
      mode: 'create',
      baseUrl,
      databasePath,
      cookie: users.userOne.cookie,
      provider: realtimeProvider,
      target: { stage_id: fixtureIds.userStageId, story_title: '杭州首次跨团队项目上线' },
      expectedStageId: fixtureIds.userStageId,
      expectedUserId: users.userOne.userId,
      clips: createClips,
      attempts: report.closeoutAttempts,
      currentModelCase,
      reportCase: report.caseA,
      report,
    });
    const caseB = await runStoryCase({
      name: 'CASE B',
      mode: 'continue',
      baseUrl,
      databasePath,
      cookie: users.userOne.cookie,
      provider: realtimeProvider,
      target: { story_id: caseA.storyId },
      expectedStoryId: caseA.storyId,
      expectedStageId: fixtureIds.userStageId,
      expectedUserId: users.userOne.userId,
      expectedStoryTitle: report.caseA.title,
      priorSummary: caseA.summary,
      clips: continueClips,
      attempts: report.closeoutAttempts,
      currentModelCase,
      reportCase: report.caseB,
      report,
    });
    assert.equal(caseB.storyId, caseA.storyId);
    assert.notEqual(caseB.summary, caseA.summary);
    assert.equal(report.caseB.historySessionCount, 2);
    report.transcript.closeoutPreserved = 'PASS';
    report.transcript.storyHistory = 'PASS';
    report.status = report.caseA.status === 'PASS' && report.caseB.status === 'PASS'
      && report.isolation.status === 'PASS'
      && report.demoAuth.newPhone === 'PASS'
      && report.demoAuth.repeatPhone === 'PASS'
      && report.demoAuth.invalidPhones === 'PASS'
      && ['CASE A', 'CASE B'].every((name) => modelOutputForCase(report.closeoutAttempts, name)
        .some((attempt) => attempt.status !== null && attempt.status >= 200 && attempt.status < 300 && attempt.outputJsonValid))
      && report.closeoutAttempts.every((attempt) => attempt.strictSchema && attempt.strictObjectSchemas)
      ? 'READY'
      : 'NOT READY';
  } catch (error) {
    report.status = 'NOT READY';
    report.errors.push(cleanError(error));
    if (report.caseA.status === 'FAIL' && report.caseA.failure) report.errors.push(report.caseA.failure);
    if (report.caseB.status === 'FAIL' && report.caseB.failure) report.errors.push(report.caseB.failure);
  } finally {
    restoreFetch?.();
    if (server) {
      try { await closeServer(server); } catch (error) { report.errors.push(cleanError(error)); }
    }
    report.endedAt = new Date().toISOString();
    const markdown = reportMarkdown(report);
    writeFileSync(path.join(runDirectory, 'real-provider-e2e-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    writeFileSync(path.join(runDirectory, 'real-provider-e2e-report.md'), markdown, 'utf8');
    writeFileSync(FINAL_REPORT_PATH, markdown, 'utf8');
  }

  process.stdout.write(`${JSON.stringify({
    status: report.status,
    databasePath: report.databasePath,
    runDirectory: report.runDirectory,
    reportPath: FINAL_REPORT_PATH,
    demoAuth: report.demoAuth,
    caseA: report.caseA,
    caseB: report.caseB,
    providers: report.providers,
    isolation: report.isolation,
    transcript: report.transcript,
    closeoutAttempts: report.closeoutAttempts,
    errors: report.errors,
  }, null, 2)}\n`);
  if (report.status !== 'READY') process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`REAL_PROVIDER_E2E_FAILED: ${cleanError(error)}\n`);
  process.exitCode = 1;
});
