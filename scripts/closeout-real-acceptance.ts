import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { assertPathInsideDiagnostics, resolveDiagnosticsPath } from '../src/diagnostics/paths.js';

let createDatabase: typeof import('../src/db/client.js').createDatabase;
let runMigrations: typeof import('../src/db/migrate.js').runMigrations;
let interviewSessions: typeof import('../src/db/schema.js').interviewSessions;
let accounts: typeof import('../src/db/schema.js').accounts;
let lifeStages: typeof import('../src/db/schema.js').lifeStages;
let stories: typeof import('../src/db/schema.js').stories;
let users: typeof import('../src/db/schema.js').users;
let parseTranscript: typeof import('../src/db/transcript.js').parseTranscript;
let nowUtcIso: typeof import('../src/db/time.js').nowUtcIso;
let endRealtimeInterviewSession: typeof import('../src/interview/session.js').endRealtimeInterviewSession;
let createStoryInterviewCore: typeof import('../src/interview/core.js').createStoryInterviewCore;
let TranscriptRepository: typeof import('../src/repositories/domain-repositories.js').TranscriptRepository;
let createInterviewServiceServer: typeof import('../src/server.js').createInterviewServiceServer;

interface Scenario {
  sessionId: string;
  storyId: string;
  userId: string;
  stageId: string;
  initialSummary: string;
  expectedTranscript: ReturnType<typeof parseTranscript>;
  initialStoryCount: number;
}

interface ProviderCapture {
  request?: Record<string, unknown>;
  outputText?: string;
  responseModel?: string;
  responseId?: string;
  latenciesMs: number[];
  strictSchemaRequests: number;
  attempts: Array<{
    maxTokens: number | null;
    thinking: unknown;
    strictSchema: boolean;
    strictObjectSchemas: boolean;
    retryFeedbackCode: string | null;
    latencyMs: number | null;
    outputCharacters: number | null;
    usage: Record<string, number> | null;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function allObjectSchemasAreStrict(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(allObjectSchemasAreStrict);
  if (!isRecord(value)) return true;
  if (value.type === 'object' && value.additionalProperties !== false) return false;
  return Object.values(value).every(allObjectSchemasAreStrict);
}

function compactAliases(values: string[], prefix: string): string[] {
  const originals = new Set(values);
  const aliases = new Set<string>();
  return values.map((_, index) => {
    let alias = `${prefix}${index + 1}`;
    while (originals.has(alias) || aliases.has(alias)) alias = `_${alias}`;
    aliases.add(alias);
    return alias;
  });
}

function requestAudit(
  request: Record<string, unknown>,
  attempts: ProviderCapture['attempts'],
  expectedTranscript: Scenario['expectedTranscript'],
): { audit: Record<string, unknown>; passed: boolean } {
  const payload = isRecord(request.user_payload) ? request.user_payload : {};
  const payloadKeys = Object.keys(payload).sort();
  const expectedPayloadKeys = ['current_stage_id', 'current_story', 'life_stages', 'other_stories', 'transcript'].sort();
  const transcript = Array.isArray(payload.transcript) ? payload.transcript.filter(isRecord) : [];
  const lifeStages = Array.isArray(payload.life_stages) ? payload.life_stages.filter(isRecord) : [];
  const otherStories = Array.isArray(payload.other_stories) ? payload.other_stories.filter(isRecord) : [];
  const expectedMessageIds = compactAliases(expectedTranscript.map((message) => message.message_id), 'm');
  const expectedTranscriptPayload = expectedTranscript.map((message, index) => ({
    message_id: expectedMessageIds[index],
    role: message.role,
    text: message.text,
  }));
  const transcriptMatches = JSON.stringify(transcript) === JSON.stringify(expectedTranscriptPayload);
  const transcriptIdsCompact = transcript.length === expectedTranscript.length
    && transcript.every((message) => typeof message.message_id === 'string' && /^_*m\d+$/.test(message.message_id));
  const stageIds = [
    payload.current_stage_id,
    ...lifeStages.map((stage) => stage.stage_id),
    ...otherStories.map((story) => story.stage_id),
  ].filter((value): value is string => typeof value === 'string');
  const lifeStageIds = new Set(lifeStages.flatMap((stage) =>
    typeof stage.stage_id === 'string' ? [stage.stage_id] : []));
  const currentStageInLifeStages = typeof payload.current_stage_id === 'string'
    && lifeStageIds.has(payload.current_stage_id);
  const otherStoryStagesInLifeStages = otherStories.every((story) =>
    typeof story.stage_id === 'string' && lifeStageIds.has(story.stage_id));
  const stageIdsCompact = stageIds.length > 0
    && stageIds.every((value) => /^_*s\d+$/.test(value))
    && currentStageInLifeStages
    && otherStoryStagesInLifeStages;
  const forbiddenKeys = new Set([
    'session_id', 'sessionId', 'story_id', 'storyId', 'user_id', 'userId', 'profile', 'story_state', 'storyState',
    'completeness', 'changes', 'conflicts', 'candidates',
  ]);
  const objectKeys: string[] = [];
  const visitKeys = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visitKeys);
    } else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        objectKeys.push(key);
        visitKeys(child);
      }
    }
  };
  visitKeys(payload);
  const forbiddenFieldsAbsent = objectKeys.every((key) => !forbiddenKeys.has(key));
  const parameterChecks = attempts.map((attempt) => ({
    maxTokens: attempt.maxTokens,
    maxTokensInRange: attempt.maxTokens !== null && attempt.maxTokens >= 2_048 && attempt.maxTokens <= 16_384,
    thinkingDisabled: isRecord(attempt.thinking) && attempt.thinking.type === 'disabled',
    strictSchema: attempt.strictSchema && attempt.strictObjectSchemas,
  }));
  const firstRequestParametersVerified = parameterChecks.length > 0
    && parameterChecks[0]?.maxTokens === 8_192;
  const allRequestParametersVerified = parameterChecks.length > 0
    && parameterChecks.every((attempt) => attempt.maxTokensInRange && attempt.thinkingDisabled && attempt.strictSchema);
  const passed = payloadKeys.join('|') === expectedPayloadKeys.join('|')
    && transcriptMatches
    && transcriptIdsCompact
    && stageIdsCompact
    && forbiddenFieldsAbsent
    && firstRequestParametersVerified
    && allRequestParametersVerified;
  return {
    passed,
    audit: {
      firstPayloadKeys: payloadKeys,
      expectedPayloadKeys,
      onlyCompactContextFields: payloadKeys.join('|') === expectedPayloadKeys.join('|'),
      fullTranscriptSent: transcriptMatches,
      transcriptMessageCount: transcript.length,
      transcriptIdsCompact,
      stageIdsCompact,
      currentStageInLifeStages,
      otherStoryStagesInLifeStages,
      forbiddenLegacyFieldsAbsent: forbiddenFieldsAbsent,
      allObjectSchemasStrict: attempts.length > 0 && attempts.every((attempt) => attempt.strictObjectSchemas),
      thinkingDisabledEveryRequest: attempts.length > 0 && attempts.every((attempt) =>
        isRecord(attempt.thinking) && attempt.thinking.type === 'disabled'),
      maxOutputTokensStartsAt2048: firstRequestParametersVerified,
      maxOutputTokensWithin2048To8192: attempts.length > 0 && attempts.every((attempt) =>
        attempt.maxTokens !== null && attempt.maxTokens >= 2_048 && attempt.maxTokens <= 8_192),
      requestParameters: parameterChecks,
    },
  };
}

function aggregateUsage(attempts: ProviderCapture['attempts']): Record<string, number> | null {
  const keys = ['prompt_tokens', 'completion_tokens', 'total_tokens'];
  const totals = Object.fromEntries(keys.map((key) => [key, 0])) as Record<string, number>;
  let foundUsage = false;
  for (const attempt of attempts) {
    if (!attempt.usage) continue;
    for (const key of keys) {
      if (typeof attempt.usage[key] === 'number') {
        totals[key] += attempt.usage[key]!;
        foundUsage = true;
      }
    }
  }
  return foundUsage ? totals : null;
}

function outputText(apiFormat: string, value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (apiFormat === 'responses') {
    const outputItems = Array.isArray(value.output) ? value.output : [];
    const text = outputItems.flatMap((item) => {
      if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) return [];
      return item.content.flatMap((part) =>
        isRecord(part) && part.type === 'output_text' && typeof part.text === 'string' ? [part.text] : []);
    }).join('');
    return text || undefined;
  }

  const choices = Array.isArray(value.choices) ? value.choices : [];
  const choice = choices.find(isRecord);
  const message = choice && isRecord(choice.message) ? choice.message : undefined;
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const call = calls.find(isRecord);
  const fn = call && isRecord(call.function) ? call.function : undefined;
  if (typeof fn?.arguments === 'string') return fn.arguments;
  return typeof message?.content === 'string' ? message.content : undefined;
}

function promptRequestSnapshot(
  body: Record<string, unknown>,
  apiFormat: string,
  endpoint: string,
): Record<string, unknown> {
  let systemPrompt: unknown;
  let userPrompt: unknown;
  let jsonSchema: unknown;
  if (Array.isArray(body.messages)) {
    const messages = body.messages.filter(isRecord);
    systemPrompt = messages.find((message) => message.role === 'system')?.content;
    userPrompt = messages.find((message) => message.role === 'user')?.content;
  } else if (Array.isArray(body.input)) {
    const inputs = body.input.filter(isRecord);
    const userMessage = inputs.find((message) => message.role === 'user');
    if (isRecord(userMessage) && Array.isArray(userMessage.content)) {
      const inputText = userMessage.content.find((item) => isRecord(item) && item.type === 'input_text');
      if (isRecord(inputText)) userPrompt = inputText.text;
    } else if (isRecord(userMessage)) {
      userPrompt = userMessage.content;
    }
    systemPrompt = body.instructions;
  }

  if (apiFormat === 'responses') {
    const text = isRecord(body.text) ? body.text : undefined;
    const format = text && isRecord(text.format) ? text.format : undefined;
    jsonSchema = format?.schema;
  } else if (apiFormat === 'chat-json-schema') {
    const responseFormat = isRecord(body.response_format) ? body.response_format : undefined;
    const schemaDefinition = responseFormat && isRecord(responseFormat.json_schema)
      ? responseFormat.json_schema
      : undefined;
    jsonSchema = schemaDefinition?.schema;
  } else {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const tool = tools.find(isRecord);
    const fn = tool && isRecord(tool.function) ? tool.function : undefined;
    jsonSchema = fn?.parameters;
  }

  let userPayload = userPrompt;
  if (typeof userPrompt === 'string') {
    try { userPayload = JSON.parse(userPrompt) as unknown; } catch { /* Preserve a non-JSON payload as text. */ }
  }
  const providerParameters = Object.fromEntries(
    ['temperature', 'thinking', 'enable_thinking', 'max_tokens', 'max_output_tokens', 'tool_choice', 'response_format']
      .filter((key) => key in body)
      .map((key) => [key, body[key]]),
  );
  const strictSchema = apiFormat === 'responses'
    ? isRecord(body.text) && isRecord(body.text.format)
      && body.text.format.type === 'json_schema' && body.text.format.strict === true
    : apiFormat === 'chat-json-schema'
      ? isRecord(body.response_format) && body.response_format.type === 'json_schema'
        && isRecord(body.response_format.json_schema) && body.response_format.json_schema.strict === true
      : Array.isArray(body.tools) && body.tools.some((item) =>
        isRecord(item) && isRecord(item.function) && item.function.strict === true);

  return {
    endpoint,
    api_format: apiFormat,
    model: body.model ?? null,
    provider_parameters: providerParameters,
    strict_schema: strictSchema,
    system_prompt: typeof systemPrompt === 'string' ? systemPrompt : null,
    user_prompt_text: typeof userPrompt === 'string' ? userPrompt : null,
    user_payload: userPayload ?? null,
    json_schema: jsonSchema ?? null,
  };
}

function validateCapturePath(value: string | undefined, label: string): string | undefined {
  const requested = value?.trim();
  if (!requested) return undefined;
  const target = path.isAbsolute(requested)
    ? assertPathInsideDiagnostics(requested)
    : resolveDiagnosticsPath('captures', 'closeout-real', requested);
  if (existsSync(target)) throw new Error('Refusing to overwrite the requested capture file: ' + target);
  return target;
}

function writeCapture(target: string | undefined, contents: string): void {
  if (!target) return;
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, { encoding: 'utf8', flag: 'wx' });
}

function createScenario(databasePath: string): Scenario {
  const userId = randomUUID();
  const accountId = randomUUID();
  const stageId = randomUUID();
  const storyId = randomUUID();
  const timestamp = nowUtcIso();
  const initialSummary = '我在南京参与过社区志愿服务。';
  const connection = createDatabase(databasePath);
  try {
    connection.db.transaction((tx) => {
      tx.insert(accounts).values({
        accountId,
        phone: null,
        phoneVerified: false,
        status: 'legacy',
        createdAt: timestamp,
        updatedAt: timestamp,
      }).run();
      tx.insert(users).values({
        userId,
        accountId,
        name: '合成 Closeout 验收用户',
        onboardingStatus: 'completed',
        createdAt: timestamp,
        updatedAt: timestamp,
      }).run();
      tx.insert(lifeStages).values({
        stageId,
        userId,
        title: '初入社会',
        startDate: '2013',
        endDate: '2020',
        datePrecision: 'year',
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
      }).run();
      tx.insert(stories).values({
        storyId,
        userId,
        stageId,
        title: '第一次组织社区义卖',
        summary: initialSummary,
        agentMemory: initialSummary,
        status: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      }).run();
    });
  } finally {
    connection.close();
  }

  const core = createStoryInterviewCore(databasePath);
  const transcripts = new TranscriptRepository(databasePath);
  const context = core.prepare(userId, { mode: 'continue', storyId });
  const interview = core.start(userId, context, 'doubao');
  const transcriptEntries: Array<{ role: 'user' | 'assistant'; text: string }> = [
    {
      role: 'user',
      text: '大约2016年10月，我在南京鼓楼区旧文化站参与组织社区义卖，目的是为儿童图书角募款。',
    },
    {
      role: 'assistant',
      text: '当时谁负责协调，你具体承担了什么工作？',
    },
    {
      role: 'user',
      text: '社区工作人员周岚负责协调。我把居民捐来的书和手工品分摊位分类，前一晚整理很晚，担心下雨和卖不出去。',
    },
    {
      role: 'assistant',
      text: '活动当天有什么变化，最后结果怎么样？',
    },
    {
      role: 'user',
      text: '当天早上下了小雨，周岚把桌子搬进文化站走廊。下午书和手工品基本卖完，收入交给社区用于儿童图书角。',
    },
    {
      role: 'user',
      text: '这件事让我觉得遇到变化时先核对信息再调整分工，比自己硬扛更有效。另外一件独立的事是2019年我陪母亲在苏州做膝盖手术，出院后每天陪她做康复训练；第二周她第一次自己走到病房走廊，我松了一口气。这是完整的另一段经历，我希望单独留成一个故事。',
    },
  ];
  for (const [index, entry] of transcriptEntries.entries()) {
    const saved = transcripts.appendForSession(userId, interview.sessionId, {
      role: entry.role,
      text: entry.text,
      provider: 'test',
      providerMessageId: 'synthetic-' + (index + 1),
    });
    assert.ok(saved.message_id, 'synthetic transcript message should be persisted');
  }

  const transcriptConnection = createDatabase(databasePath);
  let expectedTranscript: Scenario['expectedTranscript'];
  try {
    const savedSession = transcriptConnection.db.select().from(interviewSessions)
      .where(eq(interviewSessions.sessionId, interview.sessionId)).get();
    assert.ok(savedSession);
    expectedTranscript = parseTranscript(savedSession.transcriptJson);
  } finally {
    transcriptConnection.close();
  }
  endRealtimeInterviewSession(databasePath, userId, interview.sessionId);
  return {
    sessionId: interview.sessionId,
    storyId,
    userId,
    stageId,
    initialSummary,
    expectedTranscript,
    initialStoryCount: 1,
  };
}

async function waitForResult(
  fetcher: typeof fetch,
  baseUrl: string,
  sessionId: string,
  timeoutMs: number,
  authCookie: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetcher(baseUrl + '/api/interview-sessions/' + encodeURIComponent(sessionId) + '/result', {
      cache: 'no-store',
      headers: { cookie: authCookie },
    });
    const value = await response.json() as Record<string, unknown>;
    if (value.closeoutStatus === 'completed' || value.closeoutStatus === 'failed') return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for the synthetic Closeout result.');
}

async function verifyResultPage(fetcher: typeof fetch, baseUrl: string, sessionId: string): Promise<boolean> {
  const page = await fetcher(baseUrl + '/interview/result?session_id=' + encodeURIComponent(sessionId));
  assert.equal(page.status, 200, 'result page should be served');
  const markup = await page.text();
  assert.match(markup, /result\.js/);
  assert.match(markup, /result\.css/);
  const [script, stylesheet] = await Promise.all([
    fetcher(baseUrl + '/result.js'),
    fetcher(baseUrl + '/result.css'),
  ]);
  assert.equal(script.status, 200);
  assert.equal(stylesheet.status, 200);
  assert.match(await script.text(), /访谈整理/);
  assert.match(await stylesheet.text(), /\[hidden\]\s*\{\s*display:\s*none\s*!important\s*;/);
  return true;
}

async function closeServer(server: ReturnType<typeof createInterviewServiceServer>): Promise<void> {
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
}

async function main(): Promise<void> {
  const apiKey = process.env.CLOSEOUT_API_KEY?.trim();
  if (!apiKey) throw new Error('CLOSEOUT_API_KEY is not configured; refusing to call the provider.');

  const modelOutputCapturePath = validateCapturePath(process.env.CLOSEOUT_SAVE_MODEL_OUTPUT_TO, 'CLOSEOUT_SAVE_MODEL_OUTPUT_TO');
  const requestCapturePath = validateCapturePath(process.env.CLOSEOUT_SAVE_REQUEST_TO, 'CLOSEOUT_SAVE_REQUEST_TO');
  const keepServer = process.argv.includes('--serve');
  const acceptanceTempRoot = resolveDiagnosticsPath('test-artifacts', 'closeout-real');
  mkdirSync(acceptanceTempRoot, { recursive: true });
  const directory = mkdtempSync(path.join(acceptanceTempRoot, 'rensheng-compact-closeout-'));
  const databasePath = path.join(directory, 'synthetic-memoir.db');
  const originalDatabasePath = process.env.DATABASE_PATH;
  const originalFetch = globalThis.fetch;
  let server: ReturnType<typeof createInterviewServiceServer> | undefined;
  let providerCapture: ProviderCapture = { latenciesMs: [], strictSchemaRequests: 0, attempts: [] };

  try {
    process.env.DATABASE_PATH = databasePath;
    const [dbClient, migrations, schema, transcript, time, interviewCore, sessionModule, repositories, workflow, serverModule] =
      await Promise.all([
        import('../src/db/client.js'),
        import('../src/db/migrate.js'),
        import('../src/db/schema.js'),
        import('../src/db/transcript.js'),
        import('../src/db/time.js'),
        import('../src/interview/core.js'),
        import('../src/interview/session.js'),
        import('../src/repositories/domain-repositories.js'),
        import('../src/interview/closeout-workflow.js'),
        import('../src/server.js'),
      ]);
    createDatabase = dbClient.createDatabase;
    runMigrations = migrations.runMigrations;
    ({ accounts, interviewSessions, lifeStages, stories, users } = schema);
    parseTranscript = transcript.parseTranscript;
    nowUtcIso = time.nowUtcIso;
    createStoryInterviewCore = interviewCore.createStoryInterviewCore;
    ({ endRealtimeInterviewSession } = sessionModule);
    ({ TranscriptRepository } = repositories);
    createInterviewServiceServer = serverModule.createInterviewServiceServer;
    const getResult = workflow.getInterviewCloseoutResult;

    const migrationConnection = createDatabase(databasePath);
    try { runMigrations(migrationConnection); } finally { migrationConnection.close(); }
    const scenario = createScenario(databasePath);

    const closeoutApiFormat = process.env.CLOSEOUT_API_FORMAT?.trim() || 'chat-completions';
    assert.ok(['chat-completions', 'chat-json-schema', 'responses'].includes(closeoutApiFormat));
    const closeoutModel = process.env.CLOSEOUT_MODEL?.trim() || 'deepseek-v4-flash';
    const closeoutBaseUrl = process.env.CLOSEOUT_BASE_URL?.trim()
      || 'https://ark.cn-beijing.volces.com/api/plan/v3';
    const modelEndpoint = closeoutBaseUrl.replace(/\/+$/, '') + '/'
      + (closeoutApiFormat === 'responses' ? 'responses' : 'chat/completions');
    const closeoutTimeoutMs = Number(process.env.CLOSEOUT_TIMEOUT_MS ?? 60_000);
    const resultTimeoutMs = Number(process.env.CLOSEOUT_RESULT_TIMEOUT_MS ?? Math.max(180_000, closeoutTimeoutMs * 3));

    server = createInterviewServiceServer({
      host: '127.0.0.1',
      port: 0,
      databasePath,
      region: 'cn-beijing',
      model: 'qwen-audio-3.0-realtime-plus',
      closeoutApiKey: apiKey,
      closeoutBaseUrl,
      closeoutApiFormat: closeoutApiFormat as 'chat-completions' | 'chat-json-schema' | 'responses',
      closeoutModel,
      closeoutTimeoutMs,
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = 'http://127.0.0.1:' + address.port;
    const developmentLogin = await originalFetch(baseUrl + '/api/auth/development/legacy-session', { method: 'POST' });
    assert.equal(developmentLogin.status, 200, 'isolated seeded legacy profile should receive a local development session');
    const authCookie = developmentLogin.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(authCookie);

    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== modelEndpoint) return originalFetch(input, init);

      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const requestSnapshot = promptRequestSnapshot(body, closeoutApiFormat, modelEndpoint);
      if (!providerCapture.request) providerCapture.request = requestSnapshot;
      const parameters = isRecord(requestSnapshot.provider_parameters) ? requestSnapshot.provider_parameters : {};
      const userPayload = isRecord(requestSnapshot.user_payload) ? requestSnapshot.user_payload : {};
      const feedback = isRecord(userPayload.retry_feedback) ? userPayload.retry_feedback : undefined;
      const attempt = {
        maxTokens: typeof parameters.max_tokens === 'number'
          ? parameters.max_tokens
          : typeof parameters.max_output_tokens === 'number' ? parameters.max_output_tokens : null,
        thinking: parameters.thinking ?? (parameters.enable_thinking === false ? { type: 'disabled' } : null),
        strictSchema: requestSnapshot.strict_schema === true,
        strictObjectSchemas: allObjectSchemasAreStrict(requestSnapshot.json_schema),
        retryFeedbackCode: typeof feedback?.code === 'string' ? feedback.code : null,
        latencyMs: null as number | null,
        outputCharacters: null as number | null,
        usage: null as Record<string, number> | null,
      };
      providerCapture.attempts.push(attempt);
      if (attempt.strictSchema) providerCapture.strictSchemaRequests += 1;
      const startedAt = Date.now();
      try {
        const response = await originalFetch(input, init);
        if (response.ok) {
          try {
            const responseBody = await response.clone().json() as Record<string, unknown>;
            const parsedOutput = outputText(closeoutApiFormat, responseBody);
            providerCapture.outputText = parsedOutput ?? providerCapture.outputText;
            attempt.outputCharacters = parsedOutput?.length ?? null;
            const responseUsage = responseBody.usage;
            if (isRecord(responseUsage)) {
              const numericUsage = Object.fromEntries(
                ['prompt_tokens', 'completion_tokens', 'total_tokens'].flatMap((key) => {
                  const value = responseUsage[key];
                  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? [[key, value]] : [];
                }),
              );
              attempt.usage = numericUsage;
            }
            providerCapture.responseModel = typeof responseBody.model === 'string'
              ? responseBody.model
              : providerCapture.responseModel;
            providerCapture.responseId = typeof responseBody.id === 'string'
              ? responseBody.id
              : providerCapture.responseId;
          } catch { /* The Closeout workflow records a safe parse diagnostic if the provider response is invalid. */ }
        }
        return response;
      } finally {
        attempt.latencyMs = Date.now() - startedAt;
        providerCapture.latenciesMs.push(attempt.latencyMs);
      }
    }) as typeof fetch;

    const startedAt = Date.now();
    const start = await originalFetch(baseUrl + '/api/interview-sessions/' + scenario.sessionId + '/closeout', {
      method: 'POST',
      headers: { cookie: authCookie },
    });
    const accepted = await start.json() as Record<string, unknown>;
    assert.ok(start.status === 202 || start.status === 200, 'synthetic Closeout should be accepted');
    assert.equal(accepted.closeoutStatus, 'processing');
    const result = await waitForResult(originalFetch, baseUrl, scenario.sessionId, resultTimeoutMs, authCookie);
    const elapsedMs = Date.now() - startedAt;
    const resultPageVerified = await verifyResultPage(originalFetch, baseUrl, scenario.sessionId);
    const persisted = getResult(databasePath, scenario.sessionId, scenario.userId);
    const connection = createDatabase(databasePath);

    let databaseSummary: Record<string, unknown>;
    let qualityChecks: Record<string, unknown>;
    try {
      const session = connection.db.select().from(interviewSessions)
        .where(eq(interviewSessions.sessionId, scenario.sessionId)).get();
      const currentStory = connection.db.select().from(stories)
        .where(eq(stories.storyId, scenario.storyId)).get();
      assert.ok(session && currentStory);
      const transcriptPreserved = JSON.stringify(parseTranscript(session.transcriptJson))
        === JSON.stringify(scenario.expectedTranscript);
      const actualRequestAudit = requestAudit(providerCapture.request ?? {}, providerCapture.attempts, scenario.expectedTranscript);
      const userMessageIds = new Set(scenario.expectedTranscript
        .filter((message) => message.role === 'user')
        .map((message) => message.message_id));
      const currentSourceIds = Array.isArray(persisted.currentStorySourceMessageIds)
        ? persisted.currentStorySourceMessageIds.filter((item): item is string => typeof item === 'string')
        : [];
      const newStories = Array.isArray(persisted.newStories)
        ? persisted.newStories.filter(isRecord)
        : [];
      const createdStories = connection.db.select().from(stories)
        .where(eq(stories.createdSourceSessionId, scenario.sessionId)).all();
      const allSourceIdsValid = [
        ...currentSourceIds,
        ...newStories.flatMap((story) => Array.isArray(story.source_message_ids)
          ? story.source_message_ids.filter((item): item is string => typeof item === 'string')
          : []),
      ].every((messageId) => userMessageIds.has(messageId));
      const sourceRowsAgree = createdStories.length === newStories.length
        && createdStories.every((story) => story.status === 'pending'
          && story.userId === scenario.userId
          && story.createdSourceSessionId === scenario.sessionId);
      const currentSummarySourceValid = currentStory.summary === scenario.initialSummary || currentSourceIds.length > 0;
      const candidateTableExists = Boolean(connection.sqlite.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='story_candidates'",
      ).get());
      const closeoutJson = session.closeoutResultJson ? JSON.parse(session.closeoutResultJson) as Record<string, unknown> : {};
      const closeoutJsonKeysValid = Object.keys(closeoutJson)
        .every((key) => ['current_story_source_message_ids', 'new_stories', 'model_metadata'].includes(key));
      const currentSummary = currentStory.summary;
      const currentAgentMemory = currentStory.agentMemory;
      const newStoryText = newStories.map((story) => String(story.title ?? '') + ' ' + String(story.summary ?? '')).join('\n');
      const expectedCurrentTerms = ['南京', '周岚', '儿童图书角'];
      const expectedNewStoryTerms = ['母亲', '苏州', '手术'];
      const forbiddenCurrentStoryTerms = ['母亲', '苏州', '手术', '康复', '2019年'];
      const forbiddenNewStoryTerms = ['南京', '义卖', '周岚', '儿童图书角'];
      const currentTermsFound = expectedCurrentTerms.filter((term) => currentSummary.includes(term));
      const newStoryTermsFound = expectedNewStoryTerms.filter((term) => newStoryText.includes(term));
      const currentStoryContamination = forbiddenCurrentStoryTerms.filter((term) => currentSummary.includes(term));
      const newStoryContamination = forbiddenNewStoryTerms.filter((term) => newStoryText.includes(term));
      const uncertaintyPreserved = /大约|大概|约|前后|左右|可能|好像|不确定/.test(currentSummary);

      const technicalChecks = {
        closeoutCompleted: result.closeoutStatus === 'completed' && session.closeoutStatus === 'completed',
        transcriptPreserved,
        allSourceIdsValid,
        currentSummarySourceValid,
        sourceRowsAgree,
        noCandidateTable: !candidateTableExists,
        compactCloseoutJson: closeoutJsonKeysValid,
        resultPageVerified,
        strictSchemaRequested: providerCapture.strictSchemaRequests > 0
          && providerCapture.attempts.every((attempt) => attempt.strictObjectSchemas),
        actualRequestVerified: actualRequestAudit.passed,
      };
      const qualityChecksValue = {
        expectedCurrentTerms,
        currentTermsFound,
        expectedNewStoryTerms,
        newStoryTermsFound,
        forbiddenCurrentStoryTerms,
        currentStoryContamination,
        forbiddenNewStoryTerms,
        newStoryContamination,
        uncertaintyPreserved,
        currentStoryUpdated: currentSummary !== scenario.initialSummary,
        agentMemoryUpdated: currentAgentMemory !== scenario.initialSummary,
        agentMemoryContainsCoreFacts: expectedCurrentTerms.every((term) => currentAgentMemory.includes(term)),
        exactlyOneIndependentStoryCreated: createdStories.length === 1 && newStories.length === 1,
        qualityPass: currentTermsFound.length === expectedCurrentTerms.length
          && newStoryTermsFound.length === expectedNewStoryTerms.length
          && currentStoryContamination.length === 0
          && newStoryContamination.length === 0
          && uncertaintyPreserved
          && currentSummary !== scenario.initialSummary
          && currentAgentMemory !== scenario.initialSummary
          && expectedCurrentTerms.every((term) => currentAgentMemory.includes(term))
          && createdStories.length === 1
          && newStories.length === 1,
      };
      databaseSummary = {
        isolatedTemporaryDatabase: true,
        sessionCount: connection.db.select().from(interviewSessions).all().length,
        storyCountBefore: scenario.initialStoryCount,
        storyCountAfter: connection.db.select().from(stories).all().length,
        currentStoryId: currentStory.storyId,
        currentStoryTitle: currentStory.title,
        currentStorySummary: currentSummary,
        currentStoryAgentMemory: currentAgentMemory,
        newStories: createdStories.map((story) => ({
          story_id: story.storyId,
          title: story.title,
          summary: story.summary,
          agent_memory: story.agentMemory,
          stage_id: story.stageId,
          status: story.status,
          created_source_session_id: story.createdSourceSessionId,
        })),
        transcriptMessageCount: scenario.expectedTranscript.length,
        candidateTableExists,
        transcriptPreserved,
      };
      qualityChecks = { ...technicalChecks, ...qualityChecksValue };
    } finally {
      connection.close();
    }

    let capturedOutputChars: number | null = null;
    let capturedOutputBytes: number | null = null;
    let validJsonOutput = false;
    if (providerCapture.outputText !== undefined) {
      capturedOutputChars = providerCapture.outputText.length;
      capturedOutputBytes = Buffer.byteLength(providerCapture.outputText, 'utf8');
      try {
        const parsedOutput: unknown = JSON.parse(providerCapture.outputText);
        validJsonOutput = isRecord(parsedOutput);
      } catch { /* A successful workflow result should never reach this branch with invalid JSON. */ }
      if (modelOutputCapturePath) {
        const parsedOutput: unknown = JSON.parse(providerCapture.outputText);
        assert.ok(isRecord(parsedOutput), 'captured model result should be one JSON object');
        writeCapture(modelOutputCapturePath, providerCapture.outputText + '\n');
      }
    }
    qualityChecks.validJsonOutput = validJsonOutput;
    if (requestCapturePath && providerCapture.request) {
      writeCapture(requestCapturePath, JSON.stringify(providerCapture.request, null, 2) + '\n');
    }

    const technicalPass = Object.entries(qualityChecks)
      .filter(([key]) => [
        'closeoutCompleted', 'transcriptPreserved', 'allSourceIdsValid', 'currentSummarySourceValid', 'sourceRowsAgree',
        'noCandidateTable', 'compactCloseoutJson', 'resultPageVerified', 'strictSchemaRequested', 'actualRequestVerified', 'validJsonOutput',
      ].includes(key))
      .every(([, value]) => value === true);
    const qualityPass = qualityChecks.qualityPass === true;
    const request = providerCapture.request ?? {};
    const userPayload = isRecord(request.user_payload) ? request.user_payload : {};
    const systemPrompt = typeof request.system_prompt === 'string' ? request.system_prompt : '';
    const userPromptText = typeof request.user_prompt_text === 'string'
      ? request.user_prompt_text
      : JSON.stringify(userPayload);
    const schemaText = JSON.stringify(request.json_schema ?? {});
    const report = {
      runDirectory: directory,
      databasePath,
      provider: 'Volcengine Ark',
      endpoint: modelEndpoint,
      apiFormat: closeoutApiFormat,
      modelRequested: closeoutModel,
      modelReturned: providerCapture.responseModel ?? null,
      responseId: providerCapture.responseId ?? null,
      strictSchemaRequests: providerCapture.strictSchemaRequests,
      modelCallCount: providerCapture.latenciesMs.length,
      modelCallLatenciesMs: providerCapture.latenciesMs,
      modelCallAttempts: providerCapture.attempts.map((attempt) => ({
        maxTokens: attempt.maxTokens,
        thinking: attempt.thinking,
        strictSchema: attempt.strictSchema,
        strictObjectSchemas: attempt.strictObjectSchemas,
        retryFeedbackCode: attempt.retryFeedbackCode,
        latencyMs: attempt.latencyMs,
        outputCharacters: attempt.outputCharacters,
        usage: attempt.usage,
      })),
      totalElapsedMs: elapsedMs,
      outputCharacters: capturedOutputChars,
      outputUtf8Bytes: capturedOutputBytes,
      usage: aggregateUsage(providerCapture.attempts),
      requestAudit: requestAudit(providerCapture.request ?? {}, providerCapture.attempts, scenario.expectedTranscript).audit,
      promptCharacters: systemPrompt.length + userPromptText.length,
      schemaCharacters: schemaText.length,
      resultPage: baseUrl + '/interview/result?session_id=' + scenario.sessionId,
      capturedModelOutputPath: modelOutputCapturePath ?? null,
      capturedRequestPath: requestCapturePath ?? null,
      status: result.closeoutStatus,
      errorCode: result.errorCode ?? null,
      technicalPass,
      qualityPass,
      database: databaseSummary,
      checks: qualityChecks,
    };
    const reportPath = path.join(directory, 'closeout-real-acceptance-report.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    process.stdout.write(JSON.stringify({ ...report, reportPath }, null, 2) + '\n');
    if (!technicalPass || !qualityPass || result.closeoutStatus !== 'completed') process.exitCode = 1;

    if (keepServer) {
      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    try {
      if (server?.listening) await closeServer(server);
    } finally {
      if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = originalDatabasePath;
    }
  }
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : 'Synthetic Closeout acceptance failed.';
  process.stderr.write(name + ': ' + message + '\n');
  process.exitCode = 1;
});
