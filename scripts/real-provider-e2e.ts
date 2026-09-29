import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import WebSocket, { type RawData } from 'ws';
import { startRealtimeSession } from './realtime-e2e-session.js';
import { readRuntimeConfig, createInterviewServiceServer } from '../src/server.js';
import { resolveDiagnosticsPath } from '../src/diagnostics/paths.js';
import { isLoopbackTextRuntimeUrl } from '../src/models/text-runtime.js';
import { DEFAULT_STEPAUDIO2_LOCAL_WS_URL } from '../src/realtime/stepaudio2-local.js';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  agentRuns,
  interviewSessions,
  lifeStages,
  memoirDocuments,
  retrieverIndexJobs,
  stories,
  storyShareLinks,
  users,
} from '../src/db/schema.js';
import { ONBOARDING_COMPLETION_UTTERANCE } from '../src/interview/onboarding/prompt.js';
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
const REPLAY_COMMAND = 'bash scripts/codex-node.sh npm run test:voice:e2e';

const createStoryAnswers = [
  '大约在2012年，我在杭州第一次负责一个跨团队项目，当时团队只有三个人。',
  '发布前一周，测试发现接口字段写法不一致：一个团队用 userId，另一个团队用 user_id，文档也有两个版本。',
  '上线当天早上页面打不开，我很紧张，担心延期，也担心大家互相责怪。',
  '我请团队先暂停发布，一起对照日志和配置，最后发现是测试环境参数写错了。',
  '修好以后我们按计划上线，晚上一起吃了碗面；我觉得先对齐事实再决定很重要。',
];

const continueStoryAnswers = [
  '2013年春天，我们在杭州办公室又遇到一次发布风险。上次接口字段不一致时，两个团队分别用了哪种写法？我记不清了，请查旧采访记录再告诉我，不要猜。',
  '我把发布检查表交给新同事小林，让她负责逐项确认数据库地址和接口配置。',
  '她在灰度发布前发现数据库地址填错了，我们及时修正，没有影响用户。',
  '我为她感到高兴，也意识到团队不能只靠我一个人记住所有细节。',
  '我们把检查表固定进发布流程，让新同事也一起熟悉；我希望留下互相提醒、共同负责的习惯。',
];

const onboardingAnswers = [
  '我叫林岚，小时候一直住在杭州，最早的记忆是和外婆一起生活，父母都在附近工作。',
  '小学和初中都在杭州读，初中时家里搬过一次家；后来我去外地读大学，学的是计算机。',
  '大学毕业后我回到杭州做软件测试，2012年第一次负责一个跨团队项目，后来慢慢转做项目管理。',
  '工作几年后我结婚并有了孩子，照顾家人和推进项目常常要一起安排，家里人也会互相帮忙。',
  '现在我还住在杭州，做项目管理。小时候搬家那段和刚工作时的变化以后可以再细讲，眼下生活比较稳定。',
];

const contributorAnswers = [
  '我是故事主人公的妹妹。我记得那次杭州项目上线前出了问题，他先请大家一起核对日志，没有急着责怪谁。',
  '当时测试和开发看到的接口字段不一致，他带着团队对照配置，最后发现测试环境参数填错了。',
  '他后来把发布检查表交给新同事一起维护。我觉得他愿意先确认事实，也愿意让团队共同承担责任。',
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
  retrieverIndexStatus?: string;
  agentMemoryCharacters?: number;
  agentMemoryChanged?: boolean;
  errorCode?: string;
  sessionStatus?: string;
  closeoutStatus?: string;
  storyCountAfterFailure?: number;
  failure?: string;
}

interface OnboardingReport {
  status: CaseStatus;
  sessionId?: string;
  provider?: string;
  localEndpoint?: boolean;
  userTurnCount?: number;
  assistantTurnCount?: number;
  transcriptCount?: number;
  exactAssistantUtterancePresent?: boolean;
  userTranscriptSuppliedUtterance?: boolean;
  terminalResponseStatus?: string;
  sessionEndReason?: string;
  transcriptDrainClean?: boolean;
  closeoutStatus?: string;
  onboardingStatus?: string;
  retrieverIndexStatus?: string;
  failure?: string;
  errorCode?: string;
}

interface BusinessFlowReport {
  status: CaseStatus;
  resourceId?: string;
  parentResourceId?: string;
  sessionId?: string;
  transcriptCount?: number;
  audioBytesSent?: number;
  audioFramesSent?: number;
  assistantAudioResponseCount?: number;
  assistantAudioBytes?: number;
  resultStatus?: number;
  errorCode?: string;
  contentCharacters?: number;
  versionNumber?: number;
  relationship?: string;
  localAudio?: boolean;
  sessionEndReason?: string;
  transcriptDrainClean?: boolean;
  providerSessionIdPersisted?: boolean;
  retrieverIndexStatus?: string;
  failure?: string;
}

interface AgentRunCheck {
  label: string;
  taskType: string;
  mode: string | null;
  status: CaseStatus;
  observedCount: number;
  succeededCount: number;
  scriptCallCount: number;
  runtime: string[];
  provider: string[];
  models: string[];
}

interface ModelAttempt {
  caseName: string;
  status: number | null;
  latencyMs: number;
  requestedModel?: string;
  returnedModel?: string;
  responseId?: string;
  usage?: Record<string, number>;
  strictSchema: boolean;
  strictObjectSchemas: boolean;
  outputJsonValid: boolean;
  outputKeys: string[];
  networkError?: string;
}

interface E2eReport {
  status: 'NOT READY' | 'READY';
  startedAt: string;
  endedAt?: string;
  replayCommand: string;
  databasePath: string;
  runDirectory: string;
  localProfile: Record<string, unknown>;
  demoAuth: Record<string, unknown>;
  onboarding: OnboardingReport;
  caseA: CaseReport;
  caseB: CaseReport;
  storyGeneration: BusinessFlowReport;
  contributor: BusinessFlowReport;
  providers: Record<string, unknown>;
  transcript: Record<string, unknown>;
  isolation: Record<string, unknown>;
  retriever: Record<string, unknown>;
  localRequestPaths: Record<string, unknown>;
  agentRuns: { runtime: string; status: CaseStatus; checks: AgentRunCheck[]; contentRows: number };
  codeLevelGuards: Record<string, unknown>;
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

function safeEndpointLabel(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return 'invalid-endpoint';
  }
}

function profileEvidenceReady(profile: Record<string, unknown>): boolean {
  return profile.deploymentProfile === 'spark'
    && profile.aiTaskRuntime === 'agent'
    && profile.agentProvider === 'vllm-local'
    && profile.nemoclawSandbox === 'my-assistant'
    && profile.httpEndpointsLoopback === true
    && profile.realtimeEndpointLoopback === true
    && profile.noCloudApiKeys === true;
}

function safeKeyPresence(): Record<string, boolean> {
  return Object.fromEntries([
    'STEPFUN_API_KEY', 'DASHSCOPE_API_KEY', 'BAILIAN_API_KEY', 'CLOSEOUT_API_KEY',
    'TEXT_MODEL_API_KEY', 'MODELBEST_API_KEY', 'OPENAI_API_KEY',
  ].map((name) => [name, Boolean(process.env[name]?.trim())]));
}

function localProfileEvidence(runtime: ReturnType<typeof readRuntimeConfig>): Record<string, unknown> {
  const agentBaseUrl = process.env.AGENT_MODEL_BASE_URL?.trim() ?? '';
  const retrieverBaseUrl = process.env.NEMO_RETRIEVER_BASE_URL?.trim() || 'http://127.0.0.1:7670';
  const speechUrl = process.env.E2E_LOCAL_TTS_URL?.trim() ?? '';
  const endpointValues = {
    agent: agentBaseUrl,
    closeout: runtime.closeoutBaseUrl ?? '',
    onboardingCloseout: runtime.onboardingCloseoutBaseUrl ?? '',
    storyCompletion: runtime.storyCompletionBaseUrl ?? '',
    storyGeneration: runtime.storyGenerationBaseUrl ?? '',
    coach: runtime.realtimeCoachBaseUrl ?? '',
    retriever: retrieverBaseUrl,
    speech: speechUrl,
    realtime: runtime.stepaudio2LocalUrl ?? '',
  };
  const httpEndpointsLoopback = Object.entries(endpointValues)
    .filter(([name]) => name !== 'realtime')
    .every(([, endpoint]) => isLoopbackHttpUrl(endpoint));
  const realtimeEndpointLoopback = isLoopbackWebSocketUrl(endpointValues.realtime);
  const keyPresence = safeKeyPresence();
  return {
    deploymentProfile: process.env.DEPLOYMENT_PROFILE ?? '',
    aiTaskRuntime: process.env.AI_TASK_RUNTIME ?? '',
    agentProvider: process.env.AGENT_PROVIDER ?? '',
    nemoclawSandbox: process.env.NEMOCLAW_SANDBOX ?? '',
    models: {
      realtime: runtime.stepfunModel,
      closeout: runtime.closeoutModel,
      onboardingCloseout: runtime.onboardingCloseoutModel,
      storyCompletion: runtime.storyCompletionModel,
      storyGeneration: runtime.storyGenerationModel,
      coach: runtime.realtimeCoachModel,
      reasoning: process.env.AGENT_MODEL_REASONING ?? '',
      writing: process.env.AGENT_MODEL_WRITING ?? '',
    },
    endpoints: Object.fromEntries(Object.entries(endpointValues).map(([name, endpoint]) => [name, safeEndpointLabel(endpoint)])),
    httpEndpointsLoopback,
    realtimeEndpointLoopback,
    cloudKeyPresence: keyPresence,
    noCloudApiKeys: Object.values(keyPresence).every((present) => !present),
  };
}

interface LocalRequestFamily {
  baseUrl: string;
  calls: number;
  paths: Record<string, number>;
}

function installLocalRequestPathCapture(input: {
  speechUrl: string;
  coachUrl?: string;
  retrieverUrl: string;
}): { snapshot: () => Record<string, unknown>; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const families: Record<'speech' | 'coach' | 'retriever', LocalRequestFamily> = {
    speech: { baseUrl: input.speechUrl, calls: 0, paths: {} },
    coach: { baseUrl: input.coachUrl ?? '', calls: 0, paths: {} },
    retriever: { baseUrl: input.retrieverUrl, calls: 0, paths: {} },
  };
  let nonLoopbackFetchCount = 0;
  const matches = (requestUrl: URL, baseUrl: string): boolean => {
    if (!baseUrl || !isLoopbackHttpUrl(baseUrl)) return false;
    const base = new URL(baseUrl);
    return requestUrl.origin === base.origin
      && (requestUrl.pathname === base.pathname.replace(/\/+$/u, '')
        || requestUrl.pathname.startsWith(`${base.pathname.replace(/\/+$/u, '')}/`));
  };
  const routeLabel = (family: 'speech' | 'coach' | 'retriever', method: string, requestUrl: URL): string => {
    if (family === 'speech') return `${method} speech`;
    const pathname = requestUrl.pathname.replace(/\/+$/u, '');
    if (family === 'coach') {
      const route = ['/chat/completions', '/responses'].find((suffix) => pathname.endsWith(suffix));
      return `${method} ${route ? pathname.slice(-route.length) : 'other'}`;
    }
    if (pathname.endsWith('/v1/query')) return `${method} /v1/query`;
    if (pathname.endsWith('/v1/ingest/job')) return `${method} /v1/ingest/job`;
    if (/\/v1\/ingest\/job\/[^/]+\/document$/u.test(pathname)) return `${method} /v1/ingest/job/{job_id}/document`;
    if (/\/v1\/ingest\/job\/[^/]+\/documents$/u.test(pathname)) return `${method} /v1/ingest/job/{job_id}/documents`;
    if (/\/v1\/ingest\/job\/[^/]+$/u.test(pathname)) return `${method} /v1/ingest/job/{job_id}`;
    return `${method} other`;
  };

  globalThis.fetch = (async (inputValue: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = inputValue instanceof Request ? inputValue.url : String(inputValue);
    let requestUrl: URL | undefined;
    try { requestUrl = new URL(rawUrl); } catch { /* Leave malformed URLs to native fetch. */ }
    if (requestUrl) {
      if (requestUrl.protocol === 'http:' || requestUrl.protocol === 'https:') {
        if (!isLoopbackHttpUrl(requestUrl.origin)) nonLoopbackFetchCount += 1;
      }
      const method = (init?.method ?? (inputValue instanceof Request ? inputValue.method : 'GET')).toUpperCase();
      for (const [family, evidence] of Object.entries(families) as Array<[keyof typeof families, LocalRequestFamily]>) {
        if (!matches(requestUrl, evidence.baseUrl)) continue;
        evidence.calls += 1;
        const label = routeLabel(family, method, requestUrl);
        evidence.paths[label] = (evidence.paths[label] ?? 0) + 1;
      }
    }
    return originalFetch(inputValue, init);
  }) as typeof fetch;

  const snapshot = (): Record<string, unknown> => ({
    ...Object.fromEntries(Object.entries(families).map(([family, evidence]) => [family, {
      configured: Boolean(evidence.baseUrl && isLoopbackHttpUrl(evidence.baseUrl)),
      calls: evidence.calls,
      paths: { ...evidence.paths },
    }])),
    nonLoopbackFetchCount,
  });
  return { snapshot, restore: () => { globalThis.fetch = originalFetch; } };
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

function isLoopbackWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
    return (url.protocol === 'ws:' || url.protocol === 'wss:')
      && ['127.0.0.1', 'localhost', '::1'].includes(hostname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
    return url.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '::1'].includes(hostname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

async function synthesizeClip(
  text: string,
  voice: string,
  fileStem: string,
  directory: string,
  sampleRate: number,
  localSpeechUrl?: string,
  model?: string,
): Promise<AudioClip> {
  if (localSpeechUrl) {
    const response = await fetch(localSpeechUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: text, voice: 'default', response_format: 'wav' }),
    });
    if (!response.ok) throw new Error(`Local Step-Audio TTS returned HTTP ${response.status}.`);
    const pcm = getWavPcm(Buffer.from(await response.arrayBuffer()), sampleRate);
    return { pcm, sampleRate, speechBytes: pcm.length };
  }
  if (process.platform !== 'darwin') {
    throw new Error('Local E2E audio requires E2E_LOCAL_TTS_URL on non-macOS hosts.');
  }
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

async function postJson(
  baseUrl: string,
  route: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ response: Response; value: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const value: unknown = await response.json();
  assert.ok(isRecord(value), `${route} should return a JSON object`);
  return { response, value };
}

function createIsolationFixtures(
  databasePath: string,
  userOneId: string,
  userTwoId: string,
  onboardingStageId?: string,
): IsolationFixtureIds {
  const ids = {
    userStageId: onboardingStageId ?? randomUUID(),
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
      const stageRows = [
        ...(!onboardingStageId ? [{
          stageId: ids.userStageId,
          userId: userOneId,
          title: '2012 杭州项目阶段',
          startDate: '2012',
          endDate: '2014',
          datePrecision: 'year' as const,
          summary: '虚构的跨团队项目经历。',
          sortOrder: 1,
          status: 'active' as const,
          createdAt: timestamp,
          updatedAt: timestamp,
        }] : []),
        {
          stageId: ids.otherStageId,
          userId: userTwoId,
          title: '账号 B 的隔离阶段',
          startDate: '2020',
          endDate: '2021',
          datePrecision: 'year' as const,
          summary: '仅用于验证另一个档案不可被访问。',
          sortOrder: 1,
          status: 'active' as const,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ];
      tx.insert(lifeStages).values(stageRows).run();
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
): Promise<{
  userTextCharacters: number;
  assistantTextCharacters: number;
  userText: string;
  assistantText: string;
  userMessageId: string;
  assistantResponseId: string;
  assistantItemId: string;
  assistantEndAfterPlayback: boolean;
  assistantEndReason?: string;
  responseStatus: string;
}> {
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
    const responseDone = await channel.waitFor((message) => message.type === 'response_done'
      && message.responseId === assistantResponseId, `${label} Realtime response completion`);
    const responseStatus = String(responseDone.status ?? 'unknown');
    if (responseStatus !== 'completed') throw new Error(`${label} Realtime response did not complete successfully.`);
    const assistantAudio = getResponseAudioStats(channel.messages, assistantResponseId);
    assert.ok(assistantAudio.bytes > 0, `${label} should receive real Realtime Provider audio for the AI follow-up`);
    reportAudio.assistantAudioResponseCount += 1;
    reportAudio.assistantAudioBytes += assistantAudio.bytes;
    return {
      userTextCharacters: userText.length,
      assistantTextCharacters: assistantText.length,
      userText,
      assistantText,
      userMessageId,
      assistantResponseId,
      assistantItemId: String(assistantFinal.itemId),
      assistantEndAfterPlayback: assistantFinal.endAfterPlayback === true,
      ...(typeof responseDone.endReason === 'string' ? { assistantEndReason: responseDone.endReason } : {}),
      responseStatus,
    };
  } finally {
    clearInterval(keepalive);
  }
}

async function runOnboardingCase(input: {
  baseUrl: string;
  databasePath: string;
  cookie: string;
  userId: string;
  provider: 'stepaudio2_mini';
  localVoiceUrl: string;
  clips: AudioClip[];
  report: OnboardingReport;
}): Promise<{ sessionId: string; stageId: string }> {
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
  const userTexts: string[] = [];
  input.report.status = 'FAIL';
  input.report.provider = input.provider;
  input.report.localEndpoint = isLoopbackWebSocketUrl(input.localVoiceUrl);
  try {
    await once(socket, 'open');
    const realtimeChannel = listenForMessages(socket);
    channel = realtimeChannel;
    const ready = await startRealtimeSession(
      socket,
      { type: 'start', interview_type: 'onboarding', provider: input.provider },
      () => realtimeChannel.waitFor((message) => message.type === 'ready', 'Onboarding Realtime ready'),
    );
    sessionId = String(ready.sessionId);
    input.report.sessionId = sessionId;
    const session = readSession(input.databasePath, sessionId);
    assert.ok(session, 'Onboarding must persist its actual Session before audio is sent');
    assert.equal(session.userId, input.userId);
    assert.equal(session.sessionType, 'onboarding');
    assert.equal(session.provider, input.provider);

    const knownUserIds = new Set<string>();
    const knownResponseIds = new Set<string>();
    const opening = await channel.waitFor((message) => message.type === 'assistant_final'
      && typeof message.responseId === 'string', 'Onboarding AI opening response');
    const openingText = String(opening.text ?? '').trim();
    assert.ok(openingText.length > 0, 'Onboarding should receive a real AI opening response');
    const openingResponseId = String(opening.responseId);
    knownResponseIds.add(openingResponseId);
    await channel.waitFor((message) => message.type === 'transcript_saved'
      && message.role === 'assistant' && message.providerMessageId === opening.itemId, 'Onboarding saved opening Transcript');
    await channel.waitFor((message) => message.type === 'response_done'
      && message.responseId === openingResponseId && message.status === 'completed', 'Onboarding opening completion');
    const openingAudio = getResponseAudioStats(channel.messages, openingResponseId);
    assert.ok(openingAudio.bytes > 0, 'Onboarding opening must contain local StepAudio response audio');
    audioStats.assistantAudioResponseCount += 1;
    audioStats.assistantAudioBytes += openingAudio.bytes;

    let exactAssistantCompletion: Awaited<ReturnType<typeof sendAudioTurn>> | undefined;
    for (let index = 0; index < input.clips.length; index += 1) {
      const turn = await sendAudioTurn(
        socket,
        channel,
        input.clips[index]!,
        { manual: ready.manualTurnControl === true, silenceTimeoutMs: Number(ready.localVadSilenceTimeoutMs) || 2_000 },
        knownUserIds,
        knownResponseIds,
        audioStats,
        `Onboarding answer ${index + 1}`,
      );
      userTexts.push(turn.userText);
      if (turn.assistantText === ONBOARDING_COMPLETION_UTTERANCE) {
        exactAssistantCompletion = turn;
        break;
      }
    }

    input.report.userTurnCount = userTexts.length;
    input.report.assistantTurnCount = audioStats.assistantAudioResponseCount;
    input.report.exactAssistantUtterancePresent = Boolean(exactAssistantCompletion);
    input.report.userTranscriptSuppliedUtterance = userTexts.some((text) => text.includes(ONBOARDING_COMPLETION_UTTERANCE));
    assert.equal(input.report.userTranscriptSuppliedUtterance, false,
      'The synthetic user audio must not supply the onboarding completion utterance');
    assert.ok(exactAssistantCompletion,
      'Local StepAudio must speak the exact onboarding completion utterance after timeline coverage');
    assert.equal(exactAssistantCompletion.responseStatus, 'completed', 'Completion utterance response must finish successfully');
    assert.equal(exactAssistantCompletion.assistantEndReason, 'model_complete',
      'Only the successful exact assistant transcript may authorize model_complete');
    assert.equal(exactAssistantCompletion.assistantEndAfterPlayback, true,
      'Completion response must end only after playback');
    input.report.terminalResponseStatus = exactAssistantCompletion.responseStatus;

    socket.send(JSON.stringify({ type: 'end', reason: 'model_complete' }));
    const endedMessage = await channel.waitFor((message) => message.type === 'ended', 'Onboarding ended Session');
    ended = true;
    assert.equal(endedMessage.sessionId, sessionId);
    assert.equal(endedMessage.end_reason, 'model_complete');
    assert.equal(endedMessage.drainTimedOut, false, 'Onboarding Transcript drain must finish');
    assert.equal(endedMessage.pendingWriteCount, 0, 'Onboarding Transcript queue must drain');
    assert.deepEqual(endedMessage.transcriptSaveErrors, [], 'Onboarding Transcript must have no save errors');
    assert.equal(endedMessage.transcriptCount, endedMessage.savedTranscriptCount);
    input.report.sessionEndReason = String(endedMessage.end_reason ?? '');
    input.report.transcriptDrainClean = endedMessage.drainTimedOut === false
      && endedMessage.pendingWriteCount === 0
      && Array.isArray(endedMessage.transcriptSaveErrors)
      && endedMessage.transcriptSaveErrors.length === 0
      && endedMessage.transcriptCount === endedMessage.savedTranscriptCount;

    const deadline = Date.now() + CLOSEOUT_TIMEOUT_MS;
    let result: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      const response = await fetch(`${input.baseUrl}/api/onboarding/result?session_id=${encodeURIComponent(sessionId)}`, {
        headers: { cookie: input.cookie, accept: 'application/json' },
        cache: 'no-store',
      });
      const value: unknown = await response.json();
      assert.equal(response.status, 200, 'Onboarding owner should read the result');
      assert.ok(isRecord(value));
      result = value;
      const sessionResult = isRecord(result.session) ? result.session : {};
      if (sessionResult.closeout_status === 'completed' || sessionResult.closeout_status === 'failed') break;
      await sleep(1_000);
    }
    assert.ok(result, 'Onboarding result endpoint should return a result');
    const sessionResult = isRecord(result.session) ? result.session : {};
    input.report.closeoutStatus = String(sessionResult.closeout_status ?? 'missing');
    input.report.onboardingStatus = String(result.onboarding_status ?? 'missing');
    assert.equal(input.report.closeoutStatus, 'completed', 'Onboarding Agent closeout must complete');
    assert.equal(input.report.onboardingStatus, 'completed', 'Profile onboarding status must become completed');
    assert.ok(Array.isArray(result.life_stages) && result.life_stages.length > 0,
      'Onboarding closeout must create real LifeStages from its transcript');

    const stageRows = result.life_stages.filter(isRecord);
    const selectedStage = stageRows.find((stage) => /工作|职业|软件/u.test(String(stage.title ?? '')))
      ?? stageRows[0];
    assert.ok(selectedStage && typeof selectedStage.stage_id === 'string' && selectedStage.stage_id,
      'Onboarding result must provide an owner-created LifeStage for Story Create');
    const connection = createDatabase(input.databasePath);
    try {
      const persistedStage = connection.db.select().from(lifeStages).where(and(
        eq(lifeStages.stageId, selectedStage.stage_id),
        eq(lifeStages.userId, input.userId),
      )).get();
      assert.ok(persistedStage, 'Selected LifeStage must exist in the owner profile');
      assert.equal(persistedStage.createdSourceSessionId, sessionId,
        'Selected LifeStage must originate from the completed Onboarding Session');
    } finally { connection.close(); }

    const transcriptRepository = new TranscriptRepository(input.databasePath);
    const transcripts = transcriptRepository.getForSession(input.userId, sessionId);
    assert.ok(transcripts && transcripts.length >= 3, 'Onboarding must persist its user and assistant transcript');
    input.report.transcriptCount = transcripts.length;
    input.report.retrieverIndexStatus = await waitForRetrieverIndex(input.databasePath, sessionId, 'Onboarding');
    input.report.status = 'PASS';
    return { sessionId, stageId: selectedStage.stage_id };
  } catch (error) {
    input.report.status = 'FAIL';
    input.report.failure = cleanError(error);
    throw error;
  } finally {
    if (socket.readyState === WebSocket.OPEN) {
      if (!ended && channel) {
        socket.send(JSON.stringify({ type: 'end', reason: 'user' }));
        try { await channel.waitFor((message) => message.type === 'ended', 'Onboarding failure cleanup', 30_000); }
        catch { /* Keep the original failure. */ }
      }
      socket.close(1000, 'Onboarding acceptance finished');
      try { await once(socket, 'close'); } catch { /* Socket may already be closed. */ }
    }
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

function readRetrieverIndexStatus(databasePath: string, sessionId: string): string | undefined {
  const connection = createDatabase(databasePath);
  try {
    return connection.db.select({ status: retrieverIndexJobs.status })
      .from(retrieverIndexJobs)
      .where(eq(retrieverIndexJobs.sessionId, sessionId))
      .get()?.status;
  } finally { connection.close(); }
}

async function waitForRetrieverIndex(databasePath: string, sessionId: string, label: string): Promise<string> {
  const deadline = Date.now() + CLOSEOUT_TIMEOUT_MS;
  let status: string | undefined;
  while (Date.now() < deadline) {
    status = readRetrieverIndexStatus(databasePath, sessionId);
    if (status === 'indexed' || status === 'failed') break;
    await sleep(1_000);
  }
  assert.equal(status, 'indexed', `${label} transcript must be indexed by the local NeMo Retriever`);
  return status;
}

function retrieverQueryRequestCount(capture: Record<string, unknown>): number {
  const retriever = isRecord(capture.retriever) ? capture.retriever : {};
  const paths = isRecord(retriever.paths) ? retriever.paths : {};
  return Number(paths['POST /v1/query'] ?? 0);
}

async function runStoryCase(input: {
  name: string;
  mode: 'create' | 'continue';
  baseUrl: string;
  databasePath: string;
  cookie: string;
  provider: 'stepfun' | 'stepaudio3_quality' | 'stepaudio2_mini' | 'qwen' | 'modelbest';
  expectedCloseoutProvider: string;
  target: { story_id?: string; stage_id?: string; story_title?: string };
  expectedStoryId?: string;
  expectedStageId: string;
  expectedUserId: string;
  expectedStoryTitle?: string;
  priorSummary?: string;
  priorAgentMemory?: string;
  requireAgentMemory?: boolean;
  requireRetrieverIndex?: boolean;
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
    assert.equal(closeoutResult.model_metadata.provider, input.expectedCloseoutProvider);
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
      input.reportCase.agentMemoryCharacters = appliedStory.agentMemory.trim().length;
      input.reportCase.agentMemoryChanged = appliedStory.agentMemory !== (input.priorAgentMemory ?? '');
      if (input.requireAgentMemory) {
        assert.ok(appliedStory.agentMemory.trim().length > 0,
          'Story Continue must persist Agent Memory derived from the session and prior story');
        assert.equal(input.reportCase.agentMemoryChanged, true,
          'Story Continue must update Agent Memory with the new contributor-provided context');
      }
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
    input.reportCase.retrieverIndexStatus = input.requireRetrieverIndex
      ? await waitForRetrieverIndex(input.databasePath, sessionId, input.name)
      : readRetrieverIndexStatus(input.databasePath, sessionId) ?? 'NOT REQUIRED';
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
    `- 重放命令：\`${report.replayCommand}\``,
    '',
    '## Spark 本地运行画像',
    '',
    line('部署 Profile / Agent Runtime / Agent Provider / Sandbox', `${report.localProfile.deploymentProfile ?? '?'} / ${report.localProfile.aiTaskRuntime ?? '?'} / ${report.localProfile.agentProvider ?? '?'} / ${report.localProfile.nemoclawSandbox ?? '?'}`),
    line('HTTP 服务全部 loopback / Realtime WebSocket loopback', `${report.localProfile.httpEndpointsLoopback ?? 'NOT RUN'} / ${report.localProfile.realtimeEndpointLoopback ?? 'NOT RUN'}`),
    line('云 API Key 均未注入进程', report.localProfile.noCloudApiKeys),
    line('推理模型', JSON.stringify(report.localProfile.models ?? {})),
    line('服务端点', JSON.stringify(report.localProfile.endpoints ?? {})),
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
    '## Onboarding',
    '',
    line('结果 / Session', `${report.onboarding.status} / ${report.onboarding.sessionId ?? '?'}`),
    line('Provider / 本地语音端点', `${report.onboarding.provider ?? '?'} / ${report.onboarding.localEndpoint ?? '?'}`),
    line('用户回合 / 助手回合 / Transcript 数', `${report.onboarding.userTurnCount ?? '?'} / ${report.onboarding.assistantTurnCount ?? '?'} / ${report.onboarding.transcriptCount ?? '?'}`),
    line('仅助手逐字说出完成句 / 用户未提供完成句', `${report.onboarding.exactAssistantUtterancePresent ?? '?'} / ${report.onboarding.userTranscriptSuppliedUtterance ?? '?'}`),
    line('终止 response / session end reason / Transcript drain', `${report.onboarding.terminalResponseStatus ?? '?'} / ${report.onboarding.sessionEndReason ?? '?'} / ${report.onboarding.transcriptDrainClean ?? '?'}`),
    line('Onboarding / closeout / Retriever', `${report.onboarding.onboardingStatus ?? '?'} / ${report.onboarding.closeoutStatus ?? '?'} / ${report.onboarding.retrieverIndexStatus ?? '?'}`),
    ...(report.onboarding.failure ? [line('失败原因', report.onboarding.failure)] : []),
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
    line('Retriever Index', report.caseA.retrieverIndexStatus),
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
    line('Story Agent Memory 字符数 / 内容变化', `${report.caseB.agentMemoryCharacters ?? '?'} / ${report.caseB.agentMemoryChanged ?? '?'}`),
    line('Retriever Index', report.caseB.retrieverIndexStatus),
    line('最终 Story 摘要', report.caseB.summary),
    ...(report.caseB.failure ? [line('失败原因', report.caseB.failure)] : []),
    '',
    '## Story Generation 与 Contributor',
    '',
    line('Story Generation 结果 / HTTP', `${report.storyGeneration.status} / ${report.storyGeneration.resultStatus ?? '?'}`),
    line('Story ID / 文稿 ID / 版本 / 正文字符数', `${report.storyGeneration.parentResourceId ?? '?'} / ${report.storyGeneration.resourceId ?? '?'} / ${report.storyGeneration.versionNumber ?? '?'} / ${report.storyGeneration.contentCharacters ?? '?'}`),
    ...(report.storyGeneration.failure ? [line('Generation 失败原因', report.storyGeneration.failure)] : []),
    line('Contributor 结果 / Session / 关系', `${report.contributor.status} / ${report.contributor.sessionId ?? '?'} / ${report.contributor.relationship ?? '?'}`),
    line('Transcript drain / AI 音频回复数 / 合成音频帧数', `${report.contributor.transcriptDrainClean ?? '?'} / ${report.contributor.assistantAudioResponseCount ?? '?'} / ${report.contributor.audioFramesSent ?? '?'}`),
    line('Contributor closeout', report.contributor.status),
    ...(report.contributor.failure ? [line('Contributor 失败原因', report.contributor.failure)] : []),
    '',
    '## Retriever、Coach 与 Agent 证据',
    '',
    line('Onboarding / Story Create / Story Continue 索引', `${report.retriever.onboarding ?? '?'} / ${report.retriever.storyCreate ?? '?'} / ${report.retriever.storyContinue ?? '?'}`),
    line('Retriever requests / total query / Story Continue host query / evidence-search calls and results / ingest job / document upload', `${report.retriever.requests ?? '?'} / ${report.retriever.queryRequests ?? '?'} / ${report.retriever.storyContinueQueryRequests ?? '?'} / ${report.retriever.storyContinueEvidenceSearchScriptCalls ?? '?'} calls, ${report.retriever.storyContinueEvidenceSearchResultCount ?? '?'} results / ${report.retriever.ingestJobRequests ?? '?'} / ${report.retriever.documentUploadRequests ?? '?'}`),
    line('Agent runtime / 总结果 / run 数', `${report.agentRuns.runtime} / ${report.agentRuns.status} / ${report.agentRuns.contentRows}`),
    ...report.agentRuns.checks.map((check) => line(`${check.label} (${check.taskType}/${check.mode ?? 'default'})`,
      `${check.status}, ${check.succeededCount}/${check.observedCount}, evidence-search=${check.scriptCallCount}, runtime=${check.runtime.join(',') || '?'}, provider=${check.provider.join(',') || '?'}, model=${check.models.join(',') || '?'}`)),
    line('Local request paths', JSON.stringify(report.localRequestPaths)),
    '',
    '## Provider 与结构化 Closeout',
    '',
    line('Realtime Provider / Model', `${String(provider.realtimeProvider ?? '?')} / ${String(provider.realtimeModel ?? '?')}`),
    line('Text Provider / Model', `${String(provider.textProvider ?? '?')} / ${String(provider.textModel ?? '?')}`),
    line('Structured Output Schema / Validator', report.localProfile.aiTaskRuntime === 'agent'
      ? report.agentRuns.status
      : report.caseA.status === 'PASS' && report.caseB.status === 'PASS'
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

function readStoryRow(databasePath: string, storyId: string) {
  const connection = createDatabase(databasePath);
  try { return connection.db.select().from(stories).where(eq(stories.storyId, storyId)).get() ?? null; }
  finally { connection.close(); }
}

async function runStoryGenerationCase(input: {
  baseUrl: string;
  databasePath: string;
  cookie: string;
  storyId: string;
  report: BusinessFlowReport;
}): Promise<string> {
  input.report.status = 'FAIL';
  input.report.parentResourceId = input.storyId;
  try {
    const deadline = Date.now() + CLOSEOUT_TIMEOUT_MS;
    let story = readStoryRow(input.databasePath, input.storyId);
    while (story?.status !== 'complete' && Date.now() < deadline) {
      await sleep(1_000);
      story = readStoryRow(input.databasePath, input.storyId);
    }
    assert.ok(story, 'Generated Story must persist');
    assert.equal(story.status, 'complete', 'Story Completion Agent must finish before Generation');

    const { response, value } = await postJson(
      input.baseUrl,
      `/api/stories/${encodeURIComponent(input.storyId)}/documents/generate`,
      { style: 'warm' },
      { cookie: input.cookie, origin: input.baseUrl },
    );
    input.report.resultStatus = response.status;
    if (response.status !== 201) {
      input.report.errorCode = String(value.errorCode ?? 'STORY_GENERATION_FAILED');
      throw new Error(`Story Generation returned HTTP ${response.status} (${input.report.errorCode}).`);
    }
    assert.ok(isRecord(value.document), 'Story Generation response must include a document');
    const documentId = String(value.document.document_id ?? '');
    const content = String(value.document.content ?? '');
    const versionNumber = Number(value.document.version_number);
    assert.ok(documentId, 'Story Generation must return the persisted document id');
    input.report.resourceId = documentId;
    assert.ok(content.trim().length > 0, 'Story Generation must return non-empty memoir content');
    assert.equal(value.document.story_id, input.storyId);
    assert.ok(Number.isInteger(versionNumber) && versionNumber >= 1);

    const connection = createDatabase(input.databasePath);
    try {
      const persisted = connection.db.select().from(memoirDocuments)
        .where(eq(memoirDocuments.documentId, documentId)).get();
      assert.ok(persisted, 'Generated document must be saved in SQLite');
      assert.equal(persisted.scopeType, 'story');
      assert.equal(persisted.scopeId, input.storyId);
      assert.equal(persisted.status, 'draft');
      assert.equal(persisted.versionNumber, versionNumber);
      assert.equal(persisted.content, content);
    } finally { connection.close(); }

    input.report.contentCharacters = content.trim().length;
    input.report.versionNumber = versionNumber;
    input.report.status = 'PASS';
    return documentId;
  } catch (error) {
    input.report.status = 'FAIL';
    input.report.failure = cleanError(error);
    throw error;
  }
}

async function runContributorCase(input: {
  baseUrl: string;
  databasePath: string;
  cookie: string;
  userId: string;
  storyId: string;
  provider: 'stepaudio2_mini';
  clips: AudioClip[];
  report: BusinessFlowReport;
}): Promise<{ sessionId: string; shareId: string }> {
  const audioStats = {
    totalBytes: 0,
    frames: 0,
    silenceTailMs: SILENCE_TAIL_MS,
    assistantAudioResponseCount: 0,
    assistantAudioBytes: 0,
  };
  input.report.status = 'FAIL';
  input.report.resourceId = input.storyId;
  input.report.relationship = 'daughter';
  input.report.localAudio = true;
  let socket: WebSocket | undefined;
  let channel: ReturnType<typeof listenForMessages> | undefined;
  let ended = false;
  try {
    const created = await postJson(
      input.baseUrl,
      `/api/stories/${encodeURIComponent(input.storyId)}/share-links`,
      { relationship: 'daughter' },
      { cookie: input.cookie, origin: input.baseUrl },
    );
    assert.equal(created.response.status, 201, 'Owner should create a contributor share link');
    const shareId = String(created.value.share_id ?? '');
    const shareUrl = new URL(String(created.value.share_url ?? ''), input.baseUrl);
    const token = shareUrl.pathname.match(/^\/share\/story\/([^/]+)$/u)?.[1];
    assert.ok(shareId && token, 'Share link should return an id and route token');

    const publicResponse = await fetch(`${input.baseUrl}/api/public/story-share/${encodeURIComponent(token)}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    const publicValue: unknown = await publicResponse.json();
    assert.equal(publicResponse.status, 200);
    assert.ok(isRecord(publicValue));
    assert.equal(publicValue.relationship, 'daughter');
    assert.equal(publicValue.has_previous_interview, false);

    socket = new WebSocket(
      `${input.baseUrl.replace(/^http/, 'ws')}/api/realtime?share_token=${encodeURIComponent(token)}`,
      { headers: { origin: input.baseUrl } },
    );
    await once(socket, 'open');
    const realtimeChannel = listenForMessages(socket);
    channel = realtimeChannel;
    const ready = await startRealtimeSession(
      socket,
      { type: 'start', interview_type: 'external_contributor', provider: input.provider },
      () => realtimeChannel.waitFor((message) => message.type === 'ready', 'Contributor Realtime ready'),
    );
    const sessionId = String(ready.sessionId);
    input.report.sessionId = sessionId;
    const session = readSession(input.databasePath, sessionId);
    assert.ok(session, 'Contributor Session must persist');
    assert.equal(session.userId, input.userId);
    assert.equal(session.sourceType, 'external_contributor');
    assert.equal(session.sourceShareId, shareId);
    assert.equal(session.provider, input.provider);

    const knownUserIds = new Set<string>();
    const knownResponseIds = new Set<string>();
    const opening = await channel.waitFor((message) => message.type === 'assistant_final'
      && typeof message.responseId === 'string', 'Contributor AI opening response');
    assert.ok(String(opening.text ?? '').trim().length > 0);
    const openingResponseId = String(opening.responseId);
    knownResponseIds.add(openingResponseId);
    await channel.waitFor((message) => message.type === 'transcript_saved'
      && message.role === 'assistant' && message.providerMessageId === opening.itemId, 'Contributor opening saved');
    await channel.waitFor((message) => message.type === 'response_done'
      && message.responseId === openingResponseId && message.status === 'completed', 'Contributor opening completion');
    const openingAudio = getResponseAudioStats(channel.messages, openingResponseId);
    assert.ok(openingAudio.bytes > 0, 'Contributor opening must contain live Realtime audio');
    audioStats.assistantAudioResponseCount += 1;
    audioStats.assistantAudioBytes += openingAudio.bytes;

    for (const [index, clip] of input.clips.entries()) {
      await sendAudioTurn(
        socket,
        channel,
        clip,
        { manual: ready.manualTurnControl === true, silenceTimeoutMs: Number(ready.localVadSilenceTimeoutMs) || 2_000 },
        knownUserIds,
        knownResponseIds,
        audioStats,
        `Contributor answer ${index + 1}`,
      );
    }
    assert.equal(knownUserIds.size, input.clips.length, 'Contributor interview must persist all real speech turns');
    socket.send(JSON.stringify({ type: 'end', reason: 'user' }));
    const endedMessage = await channel.waitFor((message) => message.type === 'ended', 'Contributor ended Session');
    ended = true;
    assert.equal(endedMessage.sessionId, sessionId);
    assert.equal(endedMessage.drainTimedOut, false);
    assert.equal(endedMessage.pendingWriteCount, 0);
    assert.deepEqual(endedMessage.transcriptSaveErrors, []);
    assert.equal(endedMessage.transcriptCount, endedMessage.savedTranscriptCount);
    input.report.sessionEndReason = 'user';
    input.report.transcriptDrainClean = true;
    input.report.transcriptCount = Number(endedMessage.transcriptCount);
    input.report.audioBytesSent = audioStats.totalBytes;
    input.report.audioFramesSent = audioStats.frames;
    input.report.assistantAudioResponseCount = audioStats.assistantAudioResponseCount;
    input.report.assistantAudioBytes = audioStats.assistantAudioBytes;

    const deadline = Date.now() + CLOSEOUT_TIMEOUT_MS;
    let settled: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      const response = await fetch(`${input.baseUrl}/api/public/story-share/${encodeURIComponent(token)}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      const value: unknown = await response.json();
      assert.equal(response.status, 200);
      assert.ok(isRecord(value));
      settled = value;
      if (value.contributor_closeout_status === 'completed' || value.contributor_closeout_status === 'failed') break;
      await sleep(1_000);
    }
    assert.ok(settled);
    assert.equal(settled.contributor_session_status, 'completed');
    assert.equal(settled.contributor_closeout_status, 'completed', 'Contributor Agent closeout must complete');
    assert.equal(settled.has_previous_interview, true);

    const connection = createDatabase(input.databasePath);
    try {
      const savedSession = connection.db.select().from(interviewSessions)
        .where(eq(interviewSessions.sessionId, sessionId)).get();
      const savedShare = connection.db.select().from(storyShareLinks)
        .where(eq(storyShareLinks.shareId, shareId)).get();
      assert.ok(savedSession);
      assert.equal(savedSession.status, 'completed');
      assert.equal(savedSession.closeoutStatus, 'completed');
      assert.equal(savedSession.sourceType, 'external_contributor');
      assert.ok(savedShare);
      assert.equal(savedShare.interviewCount, 1);
      assert.ok(savedShare.contributorSummary.trim().length > 0);
    } finally { connection.close(); }
    input.report.status = 'PASS';
    return { sessionId, shareId };
  } catch (error) {
    input.report.status = 'FAIL';
    input.report.failure = cleanError(error);
    throw error;
  } finally {
    if (socket?.readyState === WebSocket.OPEN) {
      if (!ended && channel) {
        socket.send(JSON.stringify({ type: 'end', reason: 'user' }));
        try { await channel.waitFor((message) => message.type === 'ended', 'Contributor failure cleanup', 30_000); }
        catch { /* Keep the original failure. */ }
      }
      socket.close(1000, 'Contributor acceptance finished');
      try { await once(socket, 'close'); } catch { /* Socket may already be closed. */ }
    }
  }
}

function collectAgentRunEvidence(databasePath: string, userId: string): { rows: Array<{
  runId: string; taskType: string; mode: string | null; runtime: string; provider: string | null; model: string | null; status: string; scriptCallCount: number;
}>; checks: AgentRunCheck[] } {
  const connection = createDatabase(databasePath);
  try {
    const rows = connection.db.select({
      runId: agentRuns.runId,
      taskType: agentRuns.taskType,
      mode: agentRuns.mode,
      runtime: agentRuns.runtime,
      provider: agentRuns.provider,
      model: agentRuns.model,
      status: agentRuns.status,
      scriptCallCount: agentRuns.scriptCallCount,
    }).from(agentRuns).where(eq(agentRuns.userId, userId)).all();
    const expected = [
      { label: 'Onboarding closeout', taskType: 'onboarding.closeout', mode: null },
      { label: 'Story create closeout', taskType: 'interview.closeout', mode: 'story_create' },
      { label: 'Story continue closeout', taskType: 'interview.closeout', mode: 'story_continue' },
      { label: 'Story completion', taskType: 'story.completion', mode: undefined },
      { label: 'Contributor closeout', taskType: 'interview.closeout', mode: 'contributor' },
      { label: 'Story generation', taskType: 'story.generation', mode: undefined },
    ];
    const checks: AgentRunCheck[] = expected.map((item) => {
      const matches = rows.filter((row) => row.taskType === item.taskType
        && (item.mode === undefined || row.mode === item.mode));
      const succeededCount = matches.filter((row) => row.status === 'succeeded').length;
      const allLocal = matches.length > 0 && matches.every((row) => row.runtime === 'nemoclaw-openclaw'
        && row.provider === 'vllm-local'
        && /Qwen3\.6/i.test(row.model ?? '')
        && /35B/i.test(row.model ?? ''));
      return {
        label: item.label,
        taskType: item.taskType,
        mode: item.mode ?? null,
        status: matches.length > 0 && succeededCount === matches.length && allLocal ? 'PASS' : 'FAIL',
        observedCount: matches.length,
        succeededCount,
        scriptCallCount: matches.reduce((total, row) => total + row.scriptCallCount, 0),
        runtime: [...new Set(matches.map((row) => row.runtime))],
        provider: [...new Set(matches.flatMap((row) => row.provider ? [row.provider] : []))],
        models: [...new Set(matches.flatMap((row) => row.model ? [row.model] : []))],
      };
    });
    return { rows, checks };
  } finally { connection.close(); }
}

function readStoryContinueEvidenceSearchResultCount(runId: string): number {
  const diagnosticsPath = process.env.AGENT_RUNTIME_DIAGNOSTICS_PATH?.trim();
  assert.ok(diagnosticsPath, 'Agent runtime diagnostics path must be configured for retrieval verification');
  const events = readFileSync(path.resolve(diagnosticsPath), 'utf8')
    .split(/\r?\n/u)
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const event: unknown = JSON.parse(line);
        return isRecord(event) ? [event] : [];
      } catch {
        return [];
      }
    })
    .filter((event) => event.runId === runId
      && event.taskType === 'interview.closeout'
      && event.mode === 'story_continue'
      && event.errorCode === undefined)
    .map((event) => event.scriptResultCount)
    .filter((count): count is number => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0);
  return Math.max(0, ...events);
}

async function main(): Promise<void> {
  mkdirSync(E2E_ROOT, { recursive: true });
  mkdirSync(path.dirname(FINAL_REPORT_PATH), { recursive: true });
  const runDirectory = mkdtempSync(path.join(E2E_ROOT, `${new Date().toISOString().replace(/[:.]/g, '-')}-real-provider-`));
  const databasePath = path.join(runDirectory, 'real-provider-e2e.db');
  const report: E2eReport = {
    status: 'NOT READY',
    startedAt: new Date().toISOString(),
    replayCommand: REPLAY_COMMAND,
    databasePath,
    runDirectory,
    localProfile: {},
    demoAuth: {},
    onboarding: { status: 'NOT RUN' },
    caseA: { status: 'NOT RUN', mode: 'create' },
    caseB: { status: 'NOT RUN', mode: 'continue' },
    storyGeneration: { status: 'NOT RUN' },
    contributor: { status: 'NOT RUN' },
    providers: {},
    transcript: { closeoutPreserved: 'NOT RUN', storyHistory: 'NOT RUN' },
    isolation: { status: 'NOT RUN' },
    retriever: { onboarding: 'NOT RUN', storyCreate: 'NOT RUN', storyContinue: 'NOT RUN' },
    localRequestPaths: {},
    agentRuns: { runtime: 'NOT RUN', status: 'NOT RUN', checks: [], contentRows: 0 },
    closeoutAttempts: [],
    errors: [],
    regression: 'PENDING',
  };
  let server: ReturnType<typeof createInterviewServiceServer> | undefined;
  let restoreFetch: (() => void) | undefined;
  let restoreRequestCapture: (() => void) | undefined;
  let requestPathCapture: ReturnType<typeof installLocalRequestPathCapture> | undefined;
  let runtime: ReturnType<typeof readRuntimeConfig> | undefined;

  try {
    runtime = readRuntimeConfig();
    const realtimeProvider = runtime.defaultRealtimeProvider ?? 'stepaudio3_quality';
    const isStepFunProfile = realtimeProvider === 'stepfun'
      || realtimeProvider === 'stepaudio3_quality'
      || realtimeProvider === 'stepaudio2_mini';
    const isLocalStepAudio = realtimeProvider === 'stepaudio2_mini' && runtime.stepaudio2Execution === 'local';
    const localVoiceUrl = runtime.stepaudio2LocalUrl ?? DEFAULT_STEPAUDIO2_LOCAL_WS_URL;
    const closeoutProvider = runtime.closeoutProvider ?? 'volcengine-agent-plan';
    const closeoutModel = runtime.closeoutModel ?? 'deepseek-v4-flash';
    const closeoutBaseUrl = runtime.closeoutBaseUrl ?? 'https://ark.cn-beijing.volces.com/api/plan/v3';
    const localCloseout = closeoutProvider === 'openai-compatible' && isLoopbackTextRuntimeUrl(closeoutBaseUrl);
    const localSpeechUrl = process.env.E2E_LOCAL_TTS_URL?.trim();
    const isSparkAgentProfile = process.env.DEPLOYMENT_PROFILE?.trim() === 'spark';
    report.localProfile = localProfileEvidence(runtime);
    const realtimeConfigured = isStepFunProfile
      ? isLocalStepAudio
        ? isLoopbackWebSocketUrl(localVoiceUrl)
        : Boolean(runtime.stepfunApiKey)
      : realtimeProvider === 'modelbest'
        ? Boolean(runtime.modelbestApiKey)
        : Boolean(runtime.apiKey && runtime.workspaceId);
    const realtimeModel = realtimeProvider === 'stepaudio3_quality'
      ? runtime.stepaudio3Model
      : isStepFunProfile
        ? runtime.stepfunModel
      : realtimeProvider === 'modelbest' ? runtime.modelbestModel : runtime.qwenModel;
    const closeoutApiFormat = runtime.closeoutApiFormat ?? 'chat-completions';
    const closeoutEndpoint = createCloseoutEndpoint(closeoutBaseUrl, closeoutApiFormat);
    report.providers = {
      realtimeProvider,
      realtimeModel,
      realtimeConfigured,
      textProvider: closeoutProvider,
      textModel: closeoutModel,
      textConfigured: Boolean(runtime.closeoutApiKey?.trim()) || localCloseout,
      apiFormat: closeoutApiFormat,
      endpoint: safeEndpointLabel(closeoutEndpoint),
      ...(isLocalStepAudio ? { localVoiceEndpoint: safeEndpointLabel(localVoiceUrl) } : {}),
      ...(localSpeechUrl ? { localSpeechEndpoint: safeEndpointLabel(localSpeechUrl) } : {}),
    };

    requestPathCapture = installLocalRequestPathCapture({
      speechUrl: localSpeechUrl ?? '',
      coachUrl: runtime.realtimeCoachBaseUrl,
      retrieverUrl: process.env.NEMO_RETRIEVER_BASE_URL?.trim() || 'http://127.0.0.1:7670',
    });
    restoreRequestCapture = requestPathCapture.restore;

    process.stdout.write(`Isolated acceptance directory: ${runDirectory}\n`);
    process.stdout.write(`Live providers: ${realtimeProvider}/${realtimeModel} + ${closeoutProvider}/${closeoutModel}\n`);
    if (!realtimeConfigured) throw new Error(`Configured Realtime Provider ${realtimeProvider} is missing credentials.`);
    if (!runtime.closeoutApiKey?.trim() && !localCloseout) {
      throw new Error('CLOSEOUT_API_KEY is required unless Closeout uses a loopback OpenAI-compatible endpoint.');
    }
    if (isLocalStepAudio && (!localSpeechUrl || !isLoopbackHttpUrl(localSpeechUrl))) {
      throw new Error('E2E_LOCAL_TTS_URL must point to a loopback HTTP Step-Audio speech endpoint for local Step-Audio runs.');
    }
    if (isSparkAgentProfile) {
      const profile = report.localProfile;
      assert.equal(profile.deploymentProfile, 'spark', 'Spark E2E requires DEPLOYMENT_PROFILE=spark');
      assert.equal(profile.aiTaskRuntime, 'agent', 'Spark E2E requires AI_TASK_RUNTIME=agent');
      assert.equal(profile.agentProvider, 'vllm-local', 'Spark E2E requires the local vLLM Agent provider');
      assert.equal(profile.nemoclawSandbox, 'my-assistant', 'Spark E2E must use the my-assistant NemoClaw sandbox');
      assert.equal(realtimeProvider, 'stepaudio2_mini');
      assert.equal(runtime.stepaudio2Execution, 'local');
      assert.equal(profile.httpEndpointsLoopback, true, 'All configured text, Coach, Retriever, and TTS endpoints must be loopback');
      assert.equal(profile.realtimeEndpointLoopback, true, 'Step-Audio must use a loopback WebSocket endpoint');
      assert.equal(profile.noCloudApiKeys, true, 'Cloud inference credentials must be absent from the E2E process');
      assert.equal(process.env.NEMO_RETRIEVER_ENABLED?.trim(), 'true', 'Spark E2E requires local Retriever indexing');
      assert.equal(isLocalStepAudio, true, 'Spark E2E requires local Step-Audio execution');
      const reasoningModel = String(process.env.AGENT_MODEL_REASONING ?? '');
      assert.match(reasoningModel, /Qwen3\.6/i, 'Agent reasoning model must be the requested Qwen3.6 family');
      assert.match(reasoningModel, /35B/i, 'Agent reasoning model must be the requested 35B local model');
    }

    const migrationDb = createDatabase(databasePath);
    try { runMigrations(migrationDb); } finally { migrationDb.close(); }

    const voice = process.env.E2E_TTS_VOICE?.trim() || 'Tingting';
    const sampleRate = isStepFunProfile ? 24_000 : 16_000;
    const onboardingClips: AudioClip[] = [];
    const createClips: AudioClip[] = [];
    const continueClips: AudioClip[] = [];
    const contributorClips: AudioClip[] = [];
    if (isSparkAgentProfile) {
      for (const [index, answer] of onboardingAnswers.entries()) {
        onboardingClips.push(await synthesizeClip(answer, voice, `onboarding-answer-${index + 1}`, runDirectory, sampleRate, localSpeechUrl, realtimeModel));
      }
    }
    for (const [index, answer] of createStoryAnswers.entries()) {
      createClips.push(await synthesizeClip(answer, voice, `case-a-answer-${index + 1}`, runDirectory, sampleRate, isLocalStepAudio ? localSpeechUrl : undefined, realtimeModel));
    }
    for (const [index, answer] of continueStoryAnswers.entries()) {
      continueClips.push(await synthesizeClip(answer, voice, `case-b-answer-${index + 1}`, runDirectory, sampleRate, isLocalStepAudio ? localSpeechUrl : undefined, realtimeModel));
    }
    if (isSparkAgentProfile) {
      for (const [index, answer] of contributorAnswers.entries()) {
        contributorClips.push(await synthesizeClip(answer, voice, `contributor-answer-${index + 1}`, runDirectory, sampleRate, localSpeechUrl, realtimeModel));
      }
    }
    report.providers = {
      ...report.providers,
      syntheticSpeechVoice: isLocalStepAudio ? 'Step-Audio-2-mini local TTS' : voice,
      syntheticUserAnswersPerCase: 5,
      ...(isSparkAgentProfile ? { onboardingAudioTurns: onboardingClips.length, contributorAudioTurns: contributorClips.length } : {}),
    };

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
    let onboardingStageId: string | undefined;
    if (isSparkAgentProfile) {
      const onboarding = await runOnboardingCase({
        baseUrl,
        databasePath,
        cookie: users.userOne.cookie,
        userId: users.userOne.userId,
        provider: 'stepaudio2_mini',
        localVoiceUrl,
        clips: onboardingClips,
        report: report.onboarding,
      });
      onboardingStageId = onboarding.stageId;
      report.retriever.onboarding = report.onboarding.retrieverIndexStatus;
      process.stdout.write('Onboarding exact local completion, Transcript drain, Agent closeout, and LifeStage checks passed\n');
    }
    const fixtureIds = createIsolationFixtures(databasePath, users.userOne.userId, users.userTwo.userId, onboardingStageId);
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
      expectedCloseoutProvider: closeoutProvider,
      target: { stage_id: fixtureIds.userStageId, story_title: '杭州首次跨团队项目上线' },
      expectedStageId: fixtureIds.userStageId,
      expectedUserId: users.userOne.userId,
      clips: createClips,
      attempts: report.closeoutAttempts,
      currentModelCase,
      reportCase: report.caseA,
      requireRetrieverIndex: isSparkAgentProfile,
      report,
    });
    report.retriever.storyCreate = report.caseA.retrieverIndexStatus;
    const storyAfterCreate = readStoryRow(databasePath, caseA.storyId);
    assert.ok(storyAfterCreate, 'Story Create should persist the new Story');
    const retrieverQueriesBeforeContinue = requestPathCapture
      ? retrieverQueryRequestCount(requestPathCapture.snapshot())
      : 0;
    const caseB = await runStoryCase({
      name: 'CASE B',
      mode: 'continue',
      baseUrl,
      databasePath,
      cookie: users.userOne.cookie,
      provider: realtimeProvider,
      expectedCloseoutProvider: closeoutProvider,
      target: { story_id: caseA.storyId },
      expectedStoryId: caseA.storyId,
      expectedStageId: fixtureIds.userStageId,
      expectedUserId: users.userOne.userId,
      expectedStoryTitle: report.caseA.title,
      priorSummary: caseA.summary,
      priorAgentMemory: storyAfterCreate.agentMemory,
      requireAgentMemory: isSparkAgentProfile,
      requireRetrieverIndex: isSparkAgentProfile,
      clips: continueClips,
      attempts: report.closeoutAttempts,
      currentModelCase,
      reportCase: report.caseB,
      report,
    });
    assert.equal(caseB.storyId, caseA.storyId);
    assert.notEqual(caseB.summary, caseA.summary);
    assert.equal(report.caseB.historySessionCount, 2);
    report.retriever.storyContinue = report.caseB.retrieverIndexStatus;
    report.retriever.storyContinueQueryRequests = requestPathCapture
      ? retrieverQueryRequestCount(requestPathCapture.snapshot()) - retrieverQueriesBeforeContinue
      : 0;
    report.transcript.closeoutPreserved = 'PASS';
    report.transcript.storyHistory = 'PASS';
    if (isSparkAgentProfile) {
      assert.ok(caseA.storyId, 'Story Create must return a Story ID before Generation');
      await runStoryGenerationCase({
        baseUrl,
        databasePath,
        cookie: users.userOne.cookie,
        storyId: caseA.storyId,
        report: report.storyGeneration,
      });
      await runContributorCase({
        baseUrl,
        databasePath,
        cookie: users.userOne.cookie,
        userId: users.userOne.userId,
        storyId: caseA.storyId,
        provider: 'stepaudio2_mini',
        clips: contributorClips,
        report: report.contributor,
      });

      const agentEvidence = collectAgentRunEvidence(databasePath, users.userOne.userId);
      const storyContinueRun = agentEvidence.checks.find((check) => check.taskType === 'interview.closeout'
        && check.mode === 'story_continue');
      assert.ok(storyContinueRun && storyContinueRun.scriptCallCount > 0,
        'Story Continue Agent must execute the authorized evidence-search script');
      const storyContinueAgentRun = agentEvidence.rows.find((row) => row.taskType === 'interview.closeout'
        && row.mode === 'story_continue' && row.status === 'succeeded');
      assert.ok(storyContinueAgentRun, 'Story Continue must have a successful Agent run for retrieval evidence');
      const storyContinueEvidenceSearchResultCount = readStoryContinueEvidenceSearchResultCount(storyContinueAgentRun.runId);
      assert.ok(storyContinueEvidenceSearchResultCount > 0,
        'Story Continue evidence-search must return at least one historical Transcript match');
      report.agentRuns = {
        runtime: 'nemoclaw-openclaw',
        status: agentEvidence.checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL',
        checks: agentEvidence.checks,
        contentRows: agentEvidence.rows.length,
      };
      const capture = requestPathCapture.snapshot();
      report.localRequestPaths = capture;
      const retrieverCapture = isRecord(capture.retriever) ? capture.retriever : {};
      const retrieverPaths = isRecord(retrieverCapture.paths) ? retrieverCapture.paths : {};
      const coachCapture = isRecord(capture.coach) ? capture.coach : {};
      const speechCapture = isRecord(capture.speech) ? capture.speech : {};
      const retrieverRequests = Number(retrieverCapture.calls ?? 0);
      const retrieverQueryRequests = Number(retrieverPaths['POST /v1/query'] ?? 0);
      const retrieverIngestRequests = Number(retrieverPaths['POST /v1/ingest/job'] ?? 0);
      const retrieverDocumentRequests = Number(retrieverPaths['POST /v1/ingest/job/{job_id}/document'] ?? 0);
      const coachRequests = Number(coachCapture.calls ?? 0);
      const speechRequests = Number(speechCapture.calls ?? 0);
      const nonLoopbackFetchCount = Number(capture.nonLoopbackFetchCount ?? -1);
      report.retriever = {
        ...report.retriever,
        configured: retrieverCapture.configured === true,
        requests: retrieverRequests,
        queryRequests: retrieverQueryRequests,
        ingestJobRequests: retrieverIngestRequests,
        documentUploadRequests: retrieverDocumentRequests,
        storyContinueEvidenceSearchScriptCalls: storyContinueRun.scriptCallCount,
        storyContinueEvidenceSearchResultCount,
      };
      assert.ok(speechRequests > 0, 'Synthetic interview speech must be generated by the local Step-Audio TTS endpoint');
      assert.ok(coachRequests > 0, 'Realtime Coach requests must reach the local Qwen3-8B endpoint');
      assert.ok(retrieverIngestRequests > 0 && retrieverDocumentRequests > 0,
        'Completed interview Transcripts must be submitted to local NeMo Retriever');
      assert.equal(nonLoopbackFetchCount, 0, 'Spark E2E must make no non-loopback HTTP inference or service requests');
      assert.equal(report.onboarding.status, 'PASS');
      assert.equal(report.caseA.retrieverIndexStatus, 'indexed');
      assert.equal(report.caseB.retrieverIndexStatus, 'indexed');
      assert.equal(report.storyGeneration.status, 'PASS');
      assert.equal(report.contributor.status, 'PASS');
      assert.equal(report.agentRuns.status, 'PASS');
      report.status = report.caseA.status === 'PASS' && report.caseB.status === 'PASS'
        && report.onboarding.status === 'PASS'
        && report.storyGeneration.status === 'PASS'
        && report.contributor.status === 'PASS'
        && report.agentRuns.status === 'PASS'
        && report.isolation.status === 'PASS'
        && report.demoAuth.newPhone === 'PASS'
        && report.demoAuth.repeatPhone === 'PASS'
        && report.demoAuth.invalidPhones === 'PASS'
        && profileEvidenceReady(report.localProfile)
        ? 'READY'
        : 'NOT READY';
    } else {
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
    }
  } catch (error) {
    report.status = 'NOT READY';
    report.errors.push(cleanError(error));
    if (report.caseA.status === 'FAIL' && report.caseA.failure) report.errors.push(report.caseA.failure);
    if (report.caseB.status === 'FAIL' && report.caseB.failure) report.errors.push(report.caseB.failure);
  } finally {
    restoreFetch?.();
    if (requestPathCapture) report.localRequestPaths = requestPathCapture.snapshot();
    restoreRequestCapture?.();
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
    localProfile: report.localProfile,
    demoAuth: report.demoAuth,
    onboarding: report.onboarding,
    caseA: report.caseA,
    caseB: report.caseB,
    storyGeneration: report.storyGeneration,
    contributor: report.contributor,
    providers: report.providers,
    isolation: report.isolation,
    transcript: report.transcript,
    retriever: report.retriever,
    localRequestPaths: report.localRequestPaths,
    agentRuns: report.agentRuns,
    closeoutAttempts: report.closeoutAttempts,
    errors: report.errors,
  }, null, 2)}\n`);
  if (report.status !== 'READY') process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`REAL_PROVIDER_E2E_FAILED: ${cleanError(error)}\n`);
  process.exitCode = 1;
});
