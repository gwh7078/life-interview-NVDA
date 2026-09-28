import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { createEraContextClientFromEnv } from '../../src/era-context/client.js';
import { BailianRealtimeCoach, buildRealtimeCoachGateInput } from '../../src/realtime/coach/service.js';
import { renderMiniCoachPacket } from '../../src/realtime/coach/mini-coach-renderer.js';
import { RealtimeCoachPipeline } from '../../src/realtime/coach/pipeline.js';
import type { CoachGateResult, CoachResolveInput } from '../../src/realtime/coach/types.js';
import { parseStepfunServerEvent } from '../../src/realtime/stepfun.js';
import { createRetrieverClientFromEnv } from '../../src/retriever/client.js';
import { buildStepAudio2MiniInstructions, type RealtimeInterviewContext } from '../../src/realtime/prompt.js';
import { createRealtimeInterviewProvider } from '../../src/realtime/provider.js';
import { resolveRealtimeProviderConfig } from '../../src/realtime/runtime-config.js';
import { NEXT_QUESTION_CASES } from './cases.js';

const STORY_SUMMARY = '1978—1980年在店子集公社中学读高中，后来进入莒县一中继续学习。1983年参加高考，随后考入山东建筑材料工业学院。';
const AGENT_MEMORY = '用户来自山东莒县农村，高中阶段偏爱数理化，尤其喜欢化学。杨立苗老师与一次重要升学转折有关；王明晨是莒县一中班主任兼化学老师。不确定的信息不得补全，发现前后不一致时应自然核对。';
const MAX_GATE_MS = 2_000;
const MAX_COACH_MS = 6_000;

type JsonRecord = Record<string, unknown>;
type InterviewBenchmarkVariant = 'A' | 'B' | 'C';
type Waiter = {
  predicate: (event: JsonRecord) => boolean;
  resolve: (event: JsonRecord) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

interface Options {
  caseIds: string[];
  variants: InterviewBenchmarkVariant[];
  runs: number;
  ownerId: string;
  storyId: string;
  outputDir?: string;
}

class BenchmarkFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function resolveProfile(variant: InterviewBenchmarkVariant) {
  return {
    variant,
    coachEnabled: variant !== 'A',
    memoryRetrievalEnabled: variant === 'C',
    eraRetrievalEnabled: variant === 'C',
  };
}

function constrainGate(gate: CoachGateResult, profile: ReturnType<typeof resolveProfile>): CoachGateResult {
  return {
    ...gate,
    ...(!profile.memoryRetrievalEnabled ? { retrieve_memory: false, memory_query: null } : {}),
    ...(!profile.eraRetrievalEnabled ? {
      retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
    } : {}),
  };
}

function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key?.startsWith('--') || !args[index + 1] || args[index + 1]?.startsWith('--')) {
      throw new Error('Use --cases, --runs, and owner/story IDs; see benchmark/next-question/README.md.');
    }
    values.set(key, args[index + 1]!);
    index += 1;
  }
  const caseIds = (values.get('--cases') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!caseIds.length || new Set(caseIds).size !== caseIds.length
    || caseIds.some((id) => !NEXT_QUESTION_CASES.some((item) => item.id === id))) {
    throw new Error('--cases must be a comma-separated list of unique C01-C10 IDs.');
  }
  const variants = (values.get('--variants') ?? 'A,B,C').split(',').map((value) => value.trim());
  if (new Set(variants).size !== variants.length || variants.some((item) => !['A', 'B', 'C'].includes(item))) {
    throw new Error('--variants must be a comma-separated subset of A,B,C.');
  }
  const runs = Number(values.get('--runs') ?? 1);
  if (!Number.isInteger(runs) || runs < 1 || runs > 3) throw new Error('--runs must be 1, 2, or 3.');
  const ownerId = values.get('--owner-id') ?? process.env.NEXT_QUESTION_BENCHMARK_OWNER_ID ?? '';
  const storyId = values.get('--story-id') ?? process.env.NEXT_QUESTION_BENCHMARK_STORY_ID ?? '';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (!uuid.test(ownerId) || !uuid.test(storyId)) {
    throw new Error('Set NEXT_QUESTION_BENCHMARK_OWNER_ID and NEXT_QUESTION_BENCHMARK_STORY_ID to the prepared Story scope.');
  }
  return {
    caseIds,
    variants: variants as InterviewBenchmarkVariant[],
    runs,
    ownerId,
    storyId,
    ...(values.get('--output-dir') ? { outputDir: values.get('--output-dir') } : {}),
  };
}

function errorCode(error: unknown): string {
  if (error instanceof BenchmarkFailure) return error.code;
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,96}$/u.test(code)) return code;
  return error instanceof Error && /^[A-Z][A-Za-z0-9]{0,95}$/u.test(error.name) ? error.name : 'UNKNOWN_ERROR';
}

function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function positiveBudget(name: string, fallback: number, maximum: number): number {
  const value = Number(env(name, String(fallback)));
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeContext(ownerId: string, storyId: string): RealtimeInterviewContext {
  return {
    interview_type: 'story',
    user: { user_id: ownerId },
    life_stage: { stage_id: '00000000-0000-4000-8000-000000000801', title: '高中求学', start_date: '1978', end_date: '1983' },
    story: {
      story_id: storyId,
      title: '高中求学',
      summary: STORY_SUMMARY,
      agent_memory: AGENT_MEMORY,
      status: 'active',
      gaps: [],
    },
    task_context: { mode: 'continue' },
    voiceProfile: 'stepaudio2_mini',
    memoryTriggerMode: 'supervisor_auto',
  };
}

function textItem(role: 'assistant' | 'user', text: string): JsonRecord {
  return {
    type: 'conversation.item.create',
    item: { type: 'message', role, content: [{ type: 'input_text', text }] },
  };
}

function itemAcknowledgedAs(event: JsonRecord, role: 'assistant' | 'user'): boolean {
  const item = event.item as JsonRecord | undefined;
  return event.type === 'conversation.item.created' && item?.type === 'message'
    && item.role === role && typeof item.id === 'string' && Array.isArray(item.content);
}

function ackSummary(event: JsonRecord): JsonRecord {
  const item = event.item as JsonRecord | undefined;
  const content = Array.isArray(item?.content) ? item.content as JsonRecord[] : [];
  return {
    event_type: event.type,
    role: item?.role ?? null,
    item_type: item?.type ?? null,
    item_id_present: typeof item?.id === 'string',
    content_types: content.map((part) => part.type ?? null),
    text_present: content.some((part) => typeof part.text === 'string' && part.text.length > 0),
  };
}

function makeCoach(envVars: NodeJS.ProcessEnv): BailianRealtimeCoach {
  const apiKey = envVars.REALTIME_COACH_API_KEY?.trim() || envVars.BAILIAN_API_KEY?.trim();
  if (!apiKey) throw new Error('B/C require REALTIME_COACH_API_KEY or BAILIAN_API_KEY.');
  const dialect = envVars.REALTIME_COACH_REQUEST_DIALECT?.trim() || 'dashscope';
  if (dialect !== 'dashscope' && dialect !== 'vllm') throw new Error('REALTIME_COACH_REQUEST_DIALECT must be dashscope or vllm.');
  return new BailianRealtimeCoach({
    provider: 'openai-compatible',
    baseUrl: envVars.REALTIME_COACH_BASE_URL?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: envVars.REALTIME_COACH_MODEL?.trim() || 'qwen3-8b',
    apiKey,
    requestDialect: dialect,
  });
}

function makeProvider(envVars: NodeJS.ProcessEnv) {
  const realtimeModel = envVars.STEPFUN_REALTIME_MODEL?.trim() || 'step-audio-2-mini';
  if (realtimeModel !== 'step-audio-2-mini') throw new Error('This benchmark requires STEPFUN_REALTIME_MODEL=step-audio-2-mini.');
  if ((envVars.STEPAUDIO2_EXECUTION?.trim() || 'stepfun-cloud') !== 'stepfun-cloud') {
    throw new Error('The controlled text smoke requires the StepFun Cloud Realtime adapter.');
  }
  const config = resolveRealtimeProviderConfig('stepaudio2_mini', {
    region: 'cn-beijing',
    model: 'qwen3-omni-flash-realtime',
    stepfunApiKey: envVars.STEPFUN_API_KEY?.trim(),
    stepfunModel: realtimeModel,
    stepaudio2Execution: 'stepfun-cloud',
  });
  const provider = createRealtimeInterviewProvider('stepaudio2_mini', config);
  return { provider, realtimeModel };
}

async function guideTurn(input: {
  variant: InterviewBenchmarkVariant;
  context: RealtimeInterviewContext;
  item: (typeof NEXT_QUESTION_CASES)[number];
  ownerId: string;
  storyId: string;
  sessionId: string;
  coach: BailianRealtimeCoach | undefined;
  pipeline: RealtimeCoachPipeline | undefined;
  gateTimeoutMs: number;
  totalTimeoutMs: number;
}): Promise<JsonRecord> {
  const profile = resolveProfile(input.variant);
  const result: JsonRecord = {
    coach_status: profile.coachEnabled ? 'pending' : 'disabled',
    gate: null,
    gate_model_output: null,
    memory_evidence_count: 0,
    memory_evidence: [],
    era_evidence_count: 0,
    era_evidence: [],
    gate_latency_ms: null,
    memory_retrieval_latency_ms: null,
    era_retrieval_latency_ms: null,
    resolve_latency_ms: null,
    coach_latency_ms: null,
    pipeline_trace: [],
    errors: [],
  };
  if (!profile.coachEnabled || !input.coach) return result;

  const startedAt = performance.now();
  const gateInput = buildRealtimeCoachGateInput(input.context, {
    lastAssistantQuestion: input.item.previousQuestion,
    currentUserAnswer: input.item.userAnswer,
    recentContext: [{ role: 'assistant', text: input.item.previousQuestion }],
  });
  let rawGate: CoachGateResult;
  try {
    rawGate = await input.coach.evaluate(gateInput, { signal: AbortSignal.timeout(input.gateTimeoutMs) });
    if (performance.now() - startedAt >= input.gateTimeoutMs) throw new BenchmarkFailure('COACH_GATE_TIMEOUT');
  } catch (error) {
    result.coach_status = 'failed_open';
    result.gate_latency_ms = Number((performance.now() - startedAt).toFixed(2));
    result.coach_latency_ms = result.gate_latency_ms;
    result.errors = [{ stage: 'gate', code: errorCode(error) }];
    return result;
  }

  const gate = constrainGate(rawGate, profile);
  result.gate = gate;
  result.gate_model_output = rawGate;
  result.gate_latency_ms = Number((performance.now() - startedAt).toFixed(2));
  if (gate.action === 'none') {
    result.coach_status = 'no_op';
    result.coach_latency_ms = result.gate_latency_ms;
    return result;
  }
  if (!gate.retrieve_memory && !gate.retrieve_era) {
    result.coach_status = 'completed';
    result.coach_latency_ms = result.gate_latency_ms;
    result.coach_packet = renderMiniCoachPacket({
      scenario: 'story_continue', currentUserAnswer: input.item.userAnswer, gate,
      scenarioState: gateInput.scenarioState,
    });
    return result;
  }
  if (!input.pipeline || (gate.retrieve_memory && !gate.memory_query)) {
    result.coach_status = 'failed_open';
    result.coach_latency_ms = Number((performance.now() - startedAt).toFixed(2));
    result.errors = [{ stage: 'pipeline', code: 'RETRIEVAL_SCOPE_UNAVAILABLE' }];
    return result;
  }

  let resolveInput: CoachResolveInput | undefined;
  const pipelineTrace: JsonRecord[] = [];
  const remainingMs = input.totalTimeoutMs - (performance.now() - startedAt);
  if (remainingMs <= 0) {
    result.coach_status = 'failed_open';
    result.coach_latency_ms = Number((performance.now() - startedAt).toFixed(2));
    result.errors = [{ stage: 'pipeline', code: 'COACH_TOTAL_TIMEOUT' }];
    return result;
  }
  try {
    const outcome = await input.pipeline.retrieveAndResolve({
      scenario: 'story_continue',
      currentUserAnswer: input.item.userAnswer,
      gate,
      request: {
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        storyId: input.storyId,
        turnId: randomUUID(),
        contextVersion: 1,
        query: gate.memory_query ?? '',
      },
      signal: AbortSignal.timeout(remainingMs),
      onProgress: (event) => pipelineTrace.push({ ...event }),
      onResolveInput: (value) => { resolveInput = value; },
    });
    if (performance.now() - startedAt >= input.totalTimeoutMs) throw new BenchmarkFailure('COACH_TOTAL_TIMEOUT');
    result.coach_status = 'completed';
    result.coach_packet = renderMiniCoachPacket({
      scenario: 'story_continue', currentUserAnswer: input.item.userAnswer, gate,
      packet: outcome.packet, scenarioState: gateInput.scenarioState,
    });
    result.memory_evidence = resolveInput?.memoryEvidence ?? [];
    result.era_evidence = resolveInput?.eraEvidence ?? [];
  } catch (error) {
    result.coach_status = 'failed_open';
    result.errors = [{ stage: 'pipeline', code: errorCode(error) }];
  }
  result.pipeline_trace = pipelineTrace;
  result.memory_evidence_count = resolveInput?.memoryEvidence.length
    ?? Number([...pipelineTrace].reverse().find((event) => event.stage === 'retrieval' && event.status === 'completed')?.evidenceCount ?? 0);
  result.era_evidence_count = resolveInput?.eraEvidence.length
    ?? Number([...pipelineTrace].reverse().find((event) => event.stage === 'era_retrieval' && event.status === 'completed')?.evidenceCount ?? 0);
  result.memory_retrieval_latency_ms = [...pipelineTrace].reverse().find((event) => event.stage === 'retrieval' && event.latencyMs !== undefined)?.latencyMs ?? null;
  result.era_retrieval_latency_ms = [...pipelineTrace].reverse().find((event) => event.stage === 'era_retrieval' && event.latencyMs !== undefined)?.latencyMs ?? null;
  result.resolve_latency_ms = [...pipelineTrace].reverse().find((event) => event.stage === 'resolve' && event.latencyMs !== undefined)?.latencyMs ?? null;
  result.coach_latency_ms = Number((performance.now() - startedAt).toFixed(2));
  return result;
}

async function runSample(input: {
  item: (typeof NEXT_QUESTION_CASES)[number];
  variant: InterviewBenchmarkVariant;
  run: number;
  options: Options;
  context: RealtimeInterviewContext;
  coach: BailianRealtimeCoach | undefined;
  pipeline: RealtimeCoachPipeline | undefined;
  realtimeModel: string;
  commitSha: string;
  gateTimeoutMs: number;
  totalTimeoutMs: number;
}): Promise<JsonRecord> {
  const profile = resolveProfile(input.variant);
  const sessionId = randomUUID();
  const startedAt = performance.now();
  const errors: JsonRecord[] = [];
  const events: string[] = [];
  const context = input.context;
  const { provider } = makeProvider(process.env);
  const baseInstructions = buildStepAudio2MiniInstructions(context, { memoryTriggerMode: 'supervisor_auto', omitOpeningGap: true });
  const sessionSetup = provider.setupSession(context);
  const basePromptHash = hash(baseInstructions);
  const sessionSetupHash = hash(JSON.stringify(sessionSetup));
  const caseInputHash = hash(JSON.stringify({ basePromptHash, previousQuestion: input.item.previousQuestion, userAnswer: input.item.userAnswer }));
  let turnStartedAt: number | undefined;
  let socket: WebSocket | undefined;
  let responseCreateCount = 0;
  let inputTextAccepted = false;
  let responseStatus: string | null = null;
  let assistantText = '';
  let previousQuestionAck: JsonRecord | undefined;
  let userTextAck: JsonRecord | undefined;
  let coachTrace: JsonRecord = {
    coach_status: profile.coachEnabled ? 'pending' : 'disabled', gate: null, gate_model_output: null,
    memory_evidence_count: 0, memory_evidence: [], era_evidence_count: 0, era_evidence: [],
    gate_latency_ms: null, memory_retrieval_latency_ms: null, era_retrieval_latency_ms: null,
    resolve_latency_ms: null, coach_latency_ms: null, pipeline_trace: [], errors: [],
  };

  const rawEvents: JsonRecord[] = [];
  const normalizedEvents: JsonRecord[] = [];
  const waiters: Waiter[] = [];
  let providerError: Error | undefined;
  const waitFor = (source: JsonRecord[], predicate: (event: JsonRecord) => boolean, label: string, timeoutMs: number): Promise<JsonRecord> => {
    if (providerError) return Promise.reject(providerError);
    const existing = source.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) waiters.splice(index, 1);
        reject(new BenchmarkFailure(`TIMEOUT_${label}`));
      }, timeoutMs);
      waiters.push({ predicate, resolve, reject, timer });
    });
  };
  const publish = (source: JsonRecord[], event: JsonRecord): void => {
    source.push(event);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(event)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  };
  const failWaiters = (error: Error): void => {
    providerError = error;
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };

  try {
    const connection = provider.connectOptions();
    socket = new WebSocket(connection.url, { headers: connection.headers, handshakeTimeout: 15_000, maxPayload: 2 * 1024 * 1024 });
    socket.on('message', (data) => {
      const raw = parseStepfunServerEvent(data);
      if (!raw || typeof raw.type !== 'string') return;
      events.push(`provider:${raw.type}`);
      publish(rawEvents, raw);
      for (const normalized of provider.normalizeServerMessage(data)) {
        const event = normalized as unknown as JsonRecord;
        events.push(`normalized:${normalized.type}`);
        publish(normalizedEvents, event);
        if (normalized.type === 'assistant.transcript.delta') assistantText += normalized.delta;
        if (normalized.type === 'assistant.transcript.final') assistantText = normalized.text;
        if (normalized.type === 'provider.error') failWaiters(new BenchmarkFailure('STEPFUN_PROVIDER_ERROR'));
      }
    });
    socket.on('error', () => failWaiters(new BenchmarkFailure('STEPFUN_SOCKET_ERROR')));
    socket.on('close', () => failWaiters(new BenchmarkFailure('STEPFUN_SOCKET_CLOSED')));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BenchmarkFailure('STEPFUN_CONNECT_TIMEOUT')), 15_000);
      socket!.once('open', () => { clearTimeout(timer); resolve(); });
      socket!.once('error', () => { clearTimeout(timer); reject(new BenchmarkFailure('STEPFUN_CONNECT_ERROR')); });
    });

    const configured = waitFor(normalizedEvents, (event) => event.type === 'session.configured', 'SESSION_CONFIGURED', 20_000);
    for (const message of sessionSetup) socket.send(JSON.stringify(message));
    await configured;
    events.push('session.configured');

    const previousAcknowledgement = waitFor(rawEvents, (event) => itemAcknowledgedAs(event, 'assistant'), 'PREVIOUS_QUESTION_ACK', 10_000);
    socket.send(JSON.stringify(textItem('assistant', input.item.previousQuestion)));
    previousQuestionAck = ackSummary(await previousAcknowledgement);

    turnStartedAt = performance.now();
    const userAcknowledgement = waitFor(rawEvents, (event) => itemAcknowledgedAs(event, 'user'), 'USER_TEXT_ACK', 10_000);
    socket.send(JSON.stringify(textItem('user', input.item.userAnswer)));
    userTextAck = ackSummary(await userAcknowledgement);
    inputTextAccepted = true;
    events.push('conversation.item.create.user_text.accepted');

    coachTrace = await guideTurn({
      variant: input.variant,
      context,
      item: input.item,
      ownerId: input.options.ownerId,
      storyId: input.options.storyId,
      sessionId,
      coach: input.coach,
      pipeline: input.pipeline,
      gateTimeoutMs: input.gateTimeoutMs,
      totalTimeoutMs: input.totalTimeoutMs,
    });
    for (const error of (coachTrace.errors as JsonRecord[] | undefined) ?? []) errors.push(error);
    const packet = typeof coachTrace.coach_packet === 'string' ? coachTrace.coach_packet : undefined;
    const instructions = buildStepAudio2MiniInstructions(context, {
      memoryTriggerMode: 'supervisor_auto',
      omitOpeningGap: true,
      ...(packet ? { coachPacket: packet } : {}),
    });
    const responseMessages = provider.requestAssistantTurnMessages(instructions);
    if (responseMessages.length !== 1) throw new BenchmarkFailure('UNEXPECTED_RESPONSE_CREATE_COUNT');
    const responseMessage = responseMessages[0]!;
    const responseConfig = { ...((responseMessage.response as JsonRecord | undefined) ?? {}) };
    delete responseConfig.instructions;
    const responseParameterHash = hash(JSON.stringify(responseConfig));
    const responseDone = waitFor(normalizedEvents, (event) => event.type === 'response.done', 'RESPONSE_DONE', 60_000);
    socket.send(JSON.stringify(responseMessage));
    responseCreateCount += 1;
    events.push('response.create.sent');
    const done = await responseDone;
    const rawDone = [...rawEvents].reverse().find((event) => event.type === 'response.done');
    const rawResponse = rawDone?.response as JsonRecord | undefined;
    responseStatus = typeof done.status === 'string' ? done.status
      : typeof rawResponse?.status === 'string' ? rawResponse.status
        : typeof rawDone?.status === 'string' ? rawDone.status : null;
    const finalText = typeof done.finalText === 'string' && done.finalText.trim() ? done.finalText : assistantText;
    if (!finalText.trim()) throw new BenchmarkFailure('ASSISTANT_TRANSCRIPT_EMPTY');
    if (responseStatus && responseStatus !== 'completed' && responseStatus !== 'unknown') {
      throw new BenchmarkFailure('RESPONSE_NOT_COMPLETED');
    }
    return {
      status: 'completed',
      case_id: input.item.id,
      variant: input.variant,
      run: input.run,
      previous_question: input.item.previousQuestion,
      user_answer: input.item.userAnswer,
      next_question: finalText.trim(),
      realtime_model: input.realtimeModel,
      commit_sha: input.commitSha,
      coach_enabled: profile.coachEnabled,
      memory_retrieval_enabled: profile.memoryRetrievalEnabled,
      era_enabled: profile.eraRetrievalEnabled,
      input_kind: 'conversation.item.create/input_text',
      input_text_accepted: inputTextAccepted,
      previous_question_ack: previousQuestionAck,
      input_text_ack: userTextAck,
      response_create_count: responseCreateCount,
      response_done_received: true,
      response_status: responseStatus,
      base_prompt_sha256: basePromptHash,
      session_setup_sha256: sessionSetupHash,
      case_input_sha256: caseInputHash,
      response_parameters_sha256: responseParameterHash,
      session_setup_latency_ms: Number((turnStartedAt === undefined ? 0 : turnStartedAt - startedAt).toFixed(2)),
      total_latency_ms: Number((performance.now() - (turnStartedAt ?? startedAt)).toFixed(2)),
      ...coachTrace,
      events,
      errors,
    };
  } catch (error) {
    errors.push({ stage: 'sample', code: errorCode(error) });
    return {
      status: 'failed',
      case_id: input.item.id,
      variant: input.variant,
      run: input.run,
      previous_question: input.item.previousQuestion,
      user_answer: input.item.userAnswer,
      next_question: '',
      realtime_model: input.realtimeModel,
      commit_sha: input.commitSha,
      coach_enabled: profile.coachEnabled,
      memory_retrieval_enabled: profile.memoryRetrievalEnabled,
      era_enabled: profile.eraRetrievalEnabled,
      input_kind: 'conversation.item.create/input_text',
      input_text_accepted: inputTextAccepted,
      previous_question_ack: previousQuestionAck,
      input_text_ack: userTextAck,
      response_create_count: responseCreateCount,
      response_done_received: normalizedEvents.some((event) => event.type === 'response.done'),
      response_status: responseStatus,
      assistant_transcript_partial: assistantText,
      total_latency_ms: Number((performance.now() - (turnStartedAt ?? startedAt)).toFixed(2)),
      ...coachTrace,
      events,
      errors,
    };
  } finally {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new BenchmarkFailure('SAMPLE_FINISHED'));
    }
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
  }
}

function writePrivate(pathname: string, value: string): void {
  writeFileSync(pathname, value, { encoding: 'utf8', mode: 0o600 });
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const needsCoach = options.variants.some((variant) => variant !== 'A');
  const needsC = options.variants.includes('C');
  const { provider: unusedProvider, realtimeModel } = makeProvider(process.env);
  void unusedProvider;
  const coach = needsCoach ? makeCoach(process.env) : undefined;
  if (needsC && env('NEMO_RETRIEVER_ENABLED') !== 'true') {
    throw new Error('Variant C requires NEMO_RETRIEVER_ENABLED=true.');
  }
  const retriever = needsC ? createRetrieverClientFromEnv(process.env) : undefined;
  if (retriever) await retriever.health();
  const era = needsC ? createEraContextClientFromEnv(process.env) : undefined;
  const pipeline = needsC && coach ? new RealtimeCoachPipeline(coach, retriever, era) : undefined;
  const gateTimeoutMs = positiveBudget('REALTIME_COACH_GATE_TIMEOUT_MS', MAX_GATE_MS, MAX_GATE_MS);
  const totalTimeoutMs = positiveBudget('REALTIME_COACH_TOTAL_TIMEOUT_MS', MAX_COACH_MS, MAX_COACH_MS);
  const context = makeContext(options.ownerId, options.storyId);
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const runId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`;
  const outputDir = options.outputDir
    ? path.resolve(options.outputDir)
    : path.resolve('benchmark/next-question/results', runId);
  mkdirSync(outputDir, { recursive: false, mode: 0o700 });
  const technicalPath = path.join(outputDir, 'technical.jsonl');
  const judgePath = path.join(outputDir, 'judge.jsonl');
  const manifestPath = path.join(outputDir, 'manifest.json');
  const cases = options.caseIds.map((id) => NEXT_QUESTION_CASES.find((item) => item.id === id)!);
  const planned = cases.length * options.variants.length * options.runs;
  const manifest: JsonRecord = {
    benchmark: 'controlled-next-question',
    run_id: runId,
    generated_at: new Date().toISOString(),
    commit_sha: commitSha,
    sample_count_planned: planned,
    samples: [],
  };
  const repeatArgs = [
    '--cases', options.caseIds.join(','), '--variants', options.variants.join(','), '--runs', String(options.runs),
    '--owner-id', options.ownerId, '--story-id', options.storyId,
  ];
  writePrivate(path.join(outputDir, 'run.json'), JSON.stringify({
    benchmark: 'controlled-next-question',
    run_id: runId,
    generated_at: new Date().toISOString(),
    commit_sha: commitSha,
    cases: options.caseIds,
    variants: options.variants,
    runs: options.runs,
    samples_planned: planned,
    realtime_model: realtimeModel,
    input: 'real StepFun conversation.item.create user message with input_text; no audio or ASR',
    response_rule: 'Capture the first completed response transcript and trim surrounding whitespace only.',
    repeat_command: `bash scripts/codex-node.sh npm run benchmark:next-question -- ${repeatArgs.join(' ')}`,
    verification: ['Each sample starts a fresh StepFun websocket.', 'Exactly one response.create is sent.', 'A has no Coach/Retriever/Era calls.', 'B constrains both retrieval paths off.', 'C uses the production RealtimeCoachPipeline and current Retriever/Era clients.'],
  }, null, 2));
  writePrivate(technicalPath, '');
  writePrivate(judgePath, '');
  writePrivate(manifestPath, JSON.stringify(manifest, null, 2));

  let technicalIndex = 0;
  let completed = 0;
  const judgeRows: JsonRecord[] = [];
  for (const item of cases) {
    for (const variant of options.variants) {
      for (let run = 1; run <= options.runs; run += 1) {
        const sample = await runSample({
          item, variant, run, options, context, coach, pipeline, realtimeModel, commitSha, gateTimeoutMs, totalTimeoutMs,
        });
        appendFileSync(technicalPath, `${JSON.stringify(sample)}\n`, { encoding: 'utf8', mode: 0o600 });
        if (sample.status === 'completed') {
          completed += 1;
          const candidateId = randomUUID();
          judgeRows.push({
            case_id: sample.case_id,
            candidate_id: candidateId,
            previous_question: sample.previous_question,
            user_answer: sample.user_answer,
            next_question: sample.next_question,
          });
          (manifest.samples as JsonRecord[]).push({
            candidate_id: candidateId,
            variant,
            run,
            technical_record_index: technicalIndex,
          });
          writePrivate(manifestPath, JSON.stringify(manifest, null, 2));
        }
        technicalIndex += 1;
        process.stdout.write(`${sample.status.toUpperCase()} ${item.id}-${variant} run ${run}: ${sample.input_text_accepted ? 'text turn accepted' : 'text turn not accepted'}; ${outputDir}\n`);
      }
    }
  }
  for (let index = judgeRows.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [judgeRows[index], judgeRows[swapIndex]] = [judgeRows[swapIndex]!, judgeRows[index]!];
  }
  writePrivate(judgePath, judgeRows.map((row) => JSON.stringify(row)).join('\n') + (judgeRows.length ? '\n' : ''));
  process.stdout.write(`Completed ${completed}/${planned} samples. Results: ${outputDir}\n`);
  if (completed !== planned) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`Benchmark stopped: ${errorCode(error)}\n`);
  process.exitCode = 1;
});
