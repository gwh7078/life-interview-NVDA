import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { createEraContextClientFromEnv } from '../../src/era-context/client.js';
import type { BailianRealtimeCoach } from '../../src/realtime/coach/service.js';
import { renderMiniCoachPacket } from '../../src/realtime/coach/mini-coach-renderer.js';
import { RealtimeCoachPipeline } from '../../src/realtime/coach/pipeline.js';
import type { CoachGateResult, CoachResolveInput } from '../../src/realtime/coach/types.js';
import { parseStepfunServerEvent } from '../../src/realtime/stepfun.js';
import { createRetrieverClientFromEnv } from '../../src/retriever/client.js';
import { buildStepAudio2MiniInstructions, type RealtimeInterviewContext } from '../../src/realtime/prompt.js';
import { createRealtimeInterviewProvider } from '../../src/realtime/provider.js';
import { resolveRealtimeProviderConfig } from '../../src/realtime/runtime-config.js';
import { NEXT_QUESTION_CASES } from './cases.js';
import { loadJudgeContext } from './judge-context.js';
import {
  normalizeAsrForEquivalence,
  readCanonicalWav,
  STEPFUN_INPUT_SAMPLE_RATE,
  STEPFUN_PCM_FRAME_BYTES,
  type CanonicalAudio,
} from './audio.js';
import {
  buildCaseGateInput,
  coachErrorDetails,
  createRealtimeCoach,
  loadNextQuestionFixture,
  makeNextQuestionContext,
  realtimeCoachDiagnostics,
} from './harness.js';
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
  stageId: string;
  retrieverCollection: string;
  databasePath: string;
  outputDir?: string;
  workerResultPath?: string;
  workerRun?: number;
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
      throw new Error('Use --cases, --variants, and --runs; scope comes from the fixture manifest.');
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
  const workerRun = values.has('--worker-run') ? Number(values.get('--worker-run')) : undefined;
  if (workerRun !== undefined && (!Number.isInteger(workerRun) || workerRun < 1 || workerRun > 3)) {
    throw new Error('--worker-run must be 1, 2, or 3.');
  }
  const fixture = loadNextQuestionFixture();
  const ownerId = values.get('--owner-id') ?? process.env.NEXT_QUESTION_BENCHMARK_OWNER_ID ?? fixture.owner_id;
  const storyId = values.get('--story-id') ?? process.env.NEXT_QUESTION_BENCHMARK_STORY_ID ?? fixture.story_id;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (!uuid.test(ownerId) || !uuid.test(storyId)) {
    throw new Error('The fixture manifest must provide valid Benchmark Story scope IDs.');
  }
  if (ownerId !== fixture.owner_id || storyId !== fixture.story_id) {
    throw new Error('The Runner only accepts the isolated Benchmark Story scope from the fixture manifest.');
  }
  return {
    caseIds,
    variants: variants as InterviewBenchmarkVariant[],
    runs,
    ownerId,
    storyId,
    stageId: fixture.stage_id,
    retrieverCollection: fixture.retriever_collection,
    databasePath: fixture.database_path,
    ...(values.get('--output-dir') ? { outputDir: values.get('--output-dir') } : {}),
    ...(values.get('--worker-result') ? { workerResultPath: values.get('--worker-result') } : {}),
    ...(workerRun !== undefined ? { workerRun } : {}),
  };
}

function errorCode(error: unknown): string {
  if (error instanceof BenchmarkFailure) return error.code;
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,96}$/u.test(code)) return code;
  if (error instanceof Error && /^[A-Z0-9_]{1,96}$/u.test(error.message)) return error.message;
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

function isRetryableInfrastructureFailure(sample: JsonRecord): boolean {
  const retryable = new Set([
    'STEPFUN_SOCKET_ERROR', 'STEPFUN_SOCKET_CLOSED', 'STEPFUN_CONNECT_TIMEOUT',
    'STEPFUN_CONNECT_ERROR', 'STEPFUN_HTTP_5XX', 'SAMPLE_WORKER_TIMEOUT', 'PROCESS_CRASH',
    'TIMEOUT_SESSION_CONFIGURED', 'TIMEOUT_USER_TRANSCRIPT_FINAL', 'TIMEOUT_RESPONSE_DONE',
  ]);
  const errors = Array.isArray(sample.errors) ? sample.errors as JsonRecord[] : [];
  return errors.some((error) => error.stage === 'sample' && typeof error.code === 'string' && retryable.has(error.code));
}

function sampleErrorCode(sample: JsonRecord): string {
  const errors = Array.isArray(sample.errors) ? sample.errors as JsonRecord[] : [];
  const error = errors.find((item) => item.stage === 'sample');
  return typeof error?.code === 'string' ? error.code : 'UNKNOWN_ERROR';
}

function makeProvider(envVars: NodeJS.ProcessEnv) {
  const realtimeModel = envVars.STEPFUN_REALTIME_MODEL?.trim() || 'step-audio-2-mini';
  if (realtimeModel !== 'step-audio-2-mini') throw new Error('This benchmark requires STEPFUN_REALTIME_MODEL=step-audio-2-mini.');
  if ((envVars.STEPAUDIO2_EXECUTION?.trim() || 'stepfun-cloud') !== 'stepfun-cloud') {
    throw new Error('The fixed-audio benchmark requires the StepFun Cloud Realtime adapter.');
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
  userAnswer: string;
  coach: BailianRealtimeCoach | undefined;
  pipeline: RealtimeCoachPipeline | undefined;
  coachRuntime: Record<string, string | number> | null;
  gateTimeoutMs: number;
  totalTimeoutMs: number;
}): Promise<JsonRecord> {
  const profile = resolveProfile(input.variant);
  const result: JsonRecord = {
    coach_status: profile.coachEnabled ? 'pending' : 'disabled',
    coach_runtime: input.coachRuntime,
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
  const gateInput = buildCaseGateInput(input.context, { ...input.item, userAnswer: input.userAnswer });
  let rawGate: CoachGateResult;
  try {
    rawGate = await input.coach.evaluate(gateInput, { signal: AbortSignal.timeout(input.gateTimeoutMs) });
    if (performance.now() - startedAt >= input.gateTimeoutMs) throw new BenchmarkFailure('COACH_GATE_TIMEOUT');
  } catch (error) {
    result.coach_status = 'failed_open';
    result.gate_latency_ms = Number((performance.now() - startedAt).toFixed(2));
    result.coach_latency_ms = result.gate_latency_ms;
    result.errors = [{ stage: 'gate', ...coachErrorDetails(error, process.env) }];
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
      scenario: 'story_continue', currentUserAnswer: input.userAnswer, gate,
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
      currentUserAnswer: input.userAnswer,
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
      scenario: 'story_continue', currentUserAnswer: input.userAnswer, gate,
      packet: outcome.packet, scenarioState: gateInput.scenarioState,
    });
    result.memory_evidence = resolveInput?.memoryEvidence ?? [];
    result.era_evidence = resolveInput?.eraEvidence ?? [];
  } catch (error) {
    result.coach_status = 'failed_open';
    result.errors = [{ stage: 'pipeline', ...coachErrorDetails(error, process.env) }];
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
  coachRuntime: Record<string, string | number> | null;
  realtimeModel: string;
  commitSha: string;
  gateTimeoutMs: number;
  totalTimeoutMs: number;
  canonicalAudio: CanonicalAudio;
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
  const caseInputHash = hash(JSON.stringify({
    basePromptHash,
    previousQuestion: input.item.previousQuestion,
    audioSha256: input.canonicalAudio.sha256,
  }));
  let turnStartedAt: number | undefined;
  let socket: WebSocket | undefined;
  let responseCreateCount = 0;
  let inputAudioAppendCount = 0;
  let inputAudioCommitted = false;
  let actualAsrText = '';
  let responseStatus: string | null = null;
  let assistantText = '';
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
        if (normalized.type === 'provider.error') {
          const providerFailure = normalized.error && typeof normalized.error === 'object'
            ? normalized.error as JsonRecord : {};
          const status = Number(providerFailure.status ?? providerFailure.status_code ?? providerFailure.http_status ?? 0);
          failWaiters(new BenchmarkFailure(status >= 500 ? 'STEPFUN_HTTP_5XX' : 'STEPFUN_PROVIDER_ERROR'));
        }
      }
    });
    socket.on('unexpected-response', (_request, response) => {
      const code = response.statusCode >= 500 ? 'STEPFUN_HTTP_5XX' : `STEPFUN_HTTP_${response.statusCode}`;
      response.resume();
      failWaiters(new BenchmarkFailure(code));
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

    turnStartedAt = performance.now();
    const asrFinal = waitFor(
      normalizedEvents,
      (event) => event.type === 'user.transcript.final' && typeof event.text === 'string',
      'USER_TRANSCRIPT_FINAL',
      60_000,
    );
    for (let index = 0; index < input.canonicalAudio.frames.length; index += 1) {
      const messages = provider.appendAudioMessages(input.canonicalAudio.frames[index]!);
      if (messages.length === 0) throw new BenchmarkFailure('STEPFUN_AUDIO_APPEND_EMPTY');
      for (const message of messages) {
        if (message.type !== 'input_audio_buffer.append') throw new BenchmarkFailure('UNEXPECTED_AUDIO_APPEND_MESSAGE');
        socket.send(JSON.stringify(message));
        inputAudioAppendCount += 1;
      }
      if (index + 1 < input.canonicalAudio.frames.length) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const commitSteps = provider.commitInputTurn?.() ?? [];
    if (commitSteps.length === 0) throw new BenchmarkFailure('STEPFUN_AUDIO_COMMIT_UNAVAILABLE');
    for (const step of commitSteps) {
      const message = step.message as JsonRecord;
      if (message.type !== 'input_audio_buffer.commit') throw new BenchmarkFailure('UNEXPECTED_AUDIO_COMMIT_MESSAGE');
      socket.send(JSON.stringify(message));
      if (step.delayAfterMs) await new Promise((resolve) => setTimeout(resolve, step.delayAfterMs));
    }
    inputAudioCommitted = true;
    events.push('input_audio_buffer.commit.sent');
    const transcript = await asrFinal;
    actualAsrText = typeof transcript.text === 'string' ? transcript.text.trim() : '';
    if (!actualAsrText) throw new BenchmarkFailure('STEPFUN_ASR_TRANSCRIPT_EMPTY');
    events.push('user.transcript.final.received');

    coachTrace = await guideTurn({
      variant: input.variant,
      context,
      item: input.item,
      ownerId: input.options.ownerId,
      storyId: input.options.storyId,
      sessionId,
      userAnswer: actualAsrText,
      coach: input.coach,
      pipeline: input.pipeline,
      coachRuntime: input.coachRuntime,
      gateTimeoutMs: input.gateTimeoutMs,
      totalTimeoutMs: input.totalTimeoutMs,
    });
    for (const error of (coachTrace.errors as JsonRecord[] | undefined) ?? []) errors.push(error);
    coachTrace.memory_latency_ms = coachTrace.memory_retrieval_latency_ms ?? null;
    coachTrace.era_latency_ms = coachTrace.era_retrieval_latency_ms ?? null;
    const packet = typeof coachTrace.coach_packet === 'string' ? coachTrace.coach_packet : undefined;
    const instructions = [
      buildStepAudio2MiniInstructions(context, {
        memoryTriggerMode: 'supervisor_auto',
        omitOpeningGap: true,
        ...(packet ? { coachPacket: packet } : {}),
      }),
      `本轮固定的上一问（访谈上下文）：${input.item.previousQuestion}`,
    ].join('\n\n');
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
      realtime_session_id: sessionId,
      variant: input.variant,
      run: input.run,
      previous_question: input.item.previousQuestion,
      expected_user_text: input.item.userAnswer,
      actual_asr_text: actualAsrText,
      input_equivalence: 'NOT_TESTED',
      normalized_asr_text: normalizeAsrForEquivalence(actualAsrText),
      next_question: finalText.trim(),
      realtime_model: input.realtimeModel,
      realtime_provider: 'stepfun-cloud',
      commit_sha: input.commitSha,
      coach_enabled: profile.coachEnabled,
      coach_model: input.coachRuntime?.coach_model ?? null,
      memory_enabled: profile.memoryRetrievalEnabled,
      memory_retrieval_enabled: profile.memoryRetrievalEnabled,
      era_enabled: profile.eraRetrievalEnabled,
      input_kind: 'canonical_wav/pcm16_audio_buffer',
      audio_sha256: input.canonicalAudio.sha256,
      adapter_pcm_sha256: input.canonicalAudio.adapterPcmSha256,
      adapter_sample_rate_hz: STEPFUN_INPUT_SAMPLE_RATE,
      adapter_frame_bytes: STEPFUN_PCM_FRAME_BYTES,
      input_audio_append_count: inputAudioAppendCount,
      input_audio_committed: inputAudioCommitted,
      response_create_count: responseCreateCount,
      response_done_received: true,
      response_status: responseStatus,
      base_prompt_sha256: basePromptHash,
      session_setup_sha256: sessionSetupHash,
      case_input_sha256: caseInputHash,
      response_parameters_sha256: responseParameterHash,
      response_parameters: responseConfig,
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
      realtime_session_id: sessionId,
      variant: input.variant,
      run: input.run,
      previous_question: input.item.previousQuestion,
      expected_user_text: input.item.userAnswer,
      actual_asr_text: actualAsrText,
      input_equivalence: 'NOT_TESTED',
      normalized_asr_text: actualAsrText ? normalizeAsrForEquivalence(actualAsrText) : '',
      next_question: '',
      realtime_model: input.realtimeModel,
      realtime_provider: 'stepfun-cloud',
      commit_sha: input.commitSha,
      coach_enabled: profile.coachEnabled,
      coach_model: input.coachRuntime?.coach_model ?? null,
      memory_enabled: profile.memoryRetrievalEnabled,
      memory_retrieval_enabled: profile.memoryRetrievalEnabled,
      era_enabled: profile.eraRetrievalEnabled,
      input_kind: 'canonical_wav/pcm16_audio_buffer',
      audio_sha256: input.canonicalAudio.sha256,
      adapter_pcm_sha256: input.canonicalAudio.adapterPcmSha256,
      adapter_sample_rate_hz: STEPFUN_INPUT_SAMPLE_RATE,
      adapter_frame_bytes: STEPFUN_PCM_FRAME_BYTES,
      input_audio_append_count: inputAudioAppendCount,
      input_audio_committed: inputAudioCommitted,
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

function verifyCanonicalAudioManifest(
  cases: (typeof NEXT_QUESTION_CASES)[number][],
  canonicalAudio: Map<string, CanonicalAudio>,
): void {
  const manifestPath = path.resolve('benchmark/next-question/audio/manifest.json');
  const audioManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    complete?: boolean;
    cases?: Array<{ case_id?: string; source_text?: string; sha256?: string; sample_rate?: number; channels?: number; bit_depth?: number }>;
  };
  if (audioManifest.complete !== true || audioManifest.cases?.length !== NEXT_QUESTION_CASES.length) {
    throw new BenchmarkFailure('CANONICAL_AUDIO_MANIFEST_INCOMPLETE');
  }
  for (const item of cases) {
    const entry = audioManifest.cases.find((candidate) => candidate.case_id === item.id);
    const audio = canonicalAudio.get(item.id);
    if (!entry || !audio || entry.source_text !== item.userAnswer || entry.sha256 !== audio.sha256
      || entry.sample_rate !== 16_000 || entry.channels !== 1 || entry.bit_depth !== 16) {
      throw new BenchmarkFailure(`CANONICAL_AUDIO_MANIFEST_MISMATCH_${item.id}`);
    }
  }
}

function failedWorkerSample(input: {
  item: (typeof NEXT_QUESTION_CASES)[number];
  variant: InterviewBenchmarkVariant;
  run: number;
  audio: CanonicalAudio;
  realtimeModel: string;
  coachRuntime: Record<string, string | number> | null;
  commitSha: string;
}): JsonRecord {
  const profile = resolveProfile(input.variant);
  return {
    status: 'failed',
    case_id: input.item.id,
    realtime_session_id: null,
    variant: input.variant,
    run: input.run,
    previous_question: input.item.previousQuestion,
    expected_user_text: input.item.userAnswer,
    actual_asr_text: '',
    normalized_asr_text: '',
    input_equivalence: 'NOT_TESTED',
    next_question: '',
    realtime_model: input.realtimeModel,
    realtime_provider: 'stepfun-cloud',
    coach_model: input.coachRuntime?.coach_model ?? null,
    coach_runtime: input.coachRuntime,
    commit_sha: input.commitSha,
    coach_enabled: profile.coachEnabled,
    memory_enabled: profile.memoryRetrievalEnabled,
    memory_retrieval_enabled: profile.memoryRetrievalEnabled,
    era_enabled: profile.eraRetrievalEnabled,
    input_kind: 'canonical_wav/pcm16_audio_buffer',
    audio_sha256: input.audio.sha256,
    adapter_pcm_sha256: input.audio.adapterPcmSha256,
    gate: null,
    memory_evidence_count: 0,
    memory_evidence: [],
    era_evidence_count: 0,
    era_evidence: [],
    coach_packet: null,
    gate_latency_ms: null,
    memory_latency_ms: null,
    era_latency_ms: null,
    resolve_latency_ms: null,
    coach_latency_ms: null,
    total_latency_ms: null,
    errors: [{ stage: 'sample', code: 'PROCESS_CRASH' }],
  };
}

function runIsolatedSample(input: {
  item: (typeof NEXT_QUESTION_CASES)[number];
  variant: InterviewBenchmarkVariant;
  run: number;
  outputDir: string;
  audio: CanonicalAudio;
  realtimeModel: string;
  coachRuntime: Record<string, string | number> | null;
  commitSha: string;
}): JsonRecord {
  const attemptDirectory = path.join(input.outputDir, 'attempts');
  mkdirSync(attemptDirectory, { recursive: true, mode: 0o700 });
  const resultPath = path.join(attemptDirectory, `${input.item.id}-${input.variant}-run${input.run}-${randomUUID()}.json`);
  const args = [
    '--import', 'tsx', fileURLToPath(import.meta.url),
    '--cases', input.item.id,
    '--variants', input.variant,
    '--runs', '1',
    '--worker-run', String(input.run),
    '--worker-result', resultPath,
  ];
  const child = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'ignore',
    timeout: 180_000,
  });
  if (existsSync(resultPath)) {
    try {
      const result = JSON.parse(readFileSync(resultPath, 'utf8')) as JsonRecord;
      unlinkSync(resultPath);
      return result;
    } catch {
      unlinkSync(resultPath);
    }
  }
  const sample = failedWorkerSample(input);
  if (child.error?.code === 'ETIMEDOUT') sample.errors = [{ stage: 'sample', code: 'SAMPLE_WORKER_TIMEOUT' }];
  return sample;
}

function hasRetrievedMemoryEvidence(sample: JsonRecord | undefined): boolean {
  return sample?.status === 'completed'
    && Array.isArray(sample.memory_evidence)
    && sample.memory_evidence.length > 0;
}

function printSmokeReports(samples: JsonRecord[], equivalence: JsonRecord[]): void {
  for (const caseId of ['C06', 'C07']) {
    const runs = [...new Set(samples.filter((sample) => sample.case_id === caseId).map((sample) => Number(sample.run)))].sort();
    for (const run of runs) {
      const group = samples.filter((sample) => sample.case_id === caseId && Number(sample.run) === run);
      if (group.length === 0) continue;
      const get = (variant: InterviewBenchmarkVariant) => group.find((sample) => sample.variant === variant);
      const a = get('A');
      const b = get('B');
      const c = get('C');
      const inputEquivalence = equivalence.find((item) => item.case_id === caseId && Number(item.run) === run);
      process.stdout.write(`SMOKE ${caseId} run ${run}\n${JSON.stringify({
        audio_sha256: group[0]?.audio_sha256 ?? null,
        expected_user_text: group[0]?.expected_user_text ?? null,
        A: a ? { asr: a.actual_asr_text, next_question: a.next_question } : null,
        B: b ? { asr: b.actual_asr_text, gate: b.gate, next_question: b.next_question } : null,
        C: c ? {
          asr: c.actual_asr_text,
          gate: c.gate,
          memory_evidence: c.memory_evidence,
          era_evidence: c.era_evidence,
          coach_packet: c.coach_packet ?? null,
          next_question: c.next_question,
          memory_evidence_observed: hasRetrievedMemoryEvidence(c) ? 'FOUND' : c.status === 'completed' ? 'NO_EVIDENCE' : 'NOT_RUN',
        } : null,
        INPUT_EQUIVALENCE: inputEquivalence?.status ?? 'NOT_TESTED',
      }, null, 2)}\n`);
    }
  }
}

async function runWorker(options: Options): Promise<void> {
  if (!options.workerResultPath || options.caseIds.length !== 1 || options.variants.length !== 1 || options.runs !== 1) {
    throw new BenchmarkFailure('SAMPLE_WORKER_OPTIONS_INVALID');
  }
  const item = NEXT_QUESTION_CASES.find((candidate) => candidate.id === options.caseIds[0])!;
  const canonicalAudio = readCanonicalWav(path.resolve('benchmark/next-question/audio', `${item.id}.wav`));
  const profile = options.variants[0]!;
  const { realtimeModel } = makeProvider(process.env);
  const needsCoach = profile !== 'A';
  const needsC = profile === 'C';
  const coach = needsCoach ? createRealtimeCoach(process.env) : undefined;
  if (needsC && env('NEMO_RETRIEVER_ENABLED') !== 'true') throw new Error('Variant C requires NEMO_RETRIEVER_ENABLED=true.');
  const retriever = needsC ? createRetrieverClientFromEnv({
    ...process.env,
    NEMO_RETRIEVER_COLLECTION: options.retrieverCollection,
  }) : undefined;
  const era = needsC ? createEraContextClientFromEnv(process.env) : undefined;
  const pipeline = needsC && coach ? new RealtimeCoachPipeline(coach, retriever, era) : undefined;
  const gateTimeoutMs = positiveBudget('REALTIME_COACH_GATE_TIMEOUT_MS', MAX_GATE_MS, MAX_GATE_MS);
  const totalTimeoutMs = positiveBudget('REALTIME_COACH_TOTAL_TIMEOUT_MS', MAX_COACH_MS, MAX_COACH_MS);
  const coachRuntime = coach ? realtimeCoachDiagnostics(process.env, gateTimeoutMs, totalTimeoutMs) : null;
  const context = makeNextQuestionContext(options.ownerId, options.storyId, options.databasePath);
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const sample = await runSample({
    item, variant: profile, run: options.workerRun ?? 1, options, context, coach, pipeline, coachRuntime,
    realtimeModel, commitSha, gateTimeoutMs, totalTimeoutMs, canonicalAudio,
  });
  writePrivate(path.resolve(options.workerResultPath), JSON.stringify(sample));
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.workerResultPath) {
    await runWorker(options);
    return;
  }
  const cases = options.caseIds.map((id) => NEXT_QUESTION_CASES.find((item) => item.id === id)!);
  const canonicalAudio = new Map<string, CanonicalAudio>();
  for (const item of cases) {
    const audioPath = path.resolve('benchmark/next-question/audio', `${item.id}.wav`);
    try {
      canonicalAudio.set(item.id, readCanonicalWav(audioPath));
    } catch (error) {
      throw new BenchmarkFailure(`CANONICAL_AUDIO_${item.id}_${errorCode(error)}`);
    }
  }
  verifyCanonicalAudioManifest(cases, canonicalAudio);
  const needsCoach = options.variants.some((variant) => variant !== 'A');
  const needsC = options.variants.includes('C');
  const { provider: unusedProvider, realtimeModel } = makeProvider(process.env);
  void unusedProvider;
  const coach = needsCoach ? createRealtimeCoach(process.env) : undefined;
  if (needsC && env('NEMO_RETRIEVER_ENABLED') !== 'true') {
    throw new Error('Variant C requires NEMO_RETRIEVER_ENABLED=true.');
  }
  // Retrieval health is observed inside each C turn so an outage remains a measured fail-open result.
  const gateTimeoutMs = positiveBudget('REALTIME_COACH_GATE_TIMEOUT_MS', MAX_GATE_MS, MAX_GATE_MS);
  const totalTimeoutMs = positiveBudget('REALTIME_COACH_TOTAL_TIMEOUT_MS', MAX_COACH_MS, MAX_COACH_MS);
  const coachRuntime = coach ? realtimeCoachDiagnostics(process.env, gateTimeoutMs, totalTimeoutMs) : null;
  if (coachRuntime) process.stdout.write(`COACH_CONFIG ${JSON.stringify(coachRuntime)}\n`);
  const context = makeNextQuestionContext(options.ownerId, options.storyId, options.databasePath);
  const judgeContext = loadJudgeContext({
    databasePath: options.databasePath,
    ownerId: options.ownerId,
    storyId: options.storyId,
    storySummary: context.story.summary,
    agentMemory: context.story.agent_memory,
    lifeStageTitle: context.life_stage.title,
    lifeStageStartDate: context.life_stage.start_date,
    lifeStageEndDate: context.life_stage.end_date,
  });
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const runId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`;
  const benchmarkType = env('NEXT_QUESTION_BENCHMARK_TYPE', 'controlled_fixed_audio');
  const outputDir = options.outputDir
    ? path.resolve(options.outputDir)
    : path.resolve('benchmark/next-question/results', runId);
  mkdirSync(outputDir, { recursive: false, mode: 0o700 });
  const technicalPath = path.join(outputDir, 'technical.jsonl');
  const judgePath = path.join(outputDir, 'judge.jsonl');
  const manifestPath = path.join(outputDir, 'manifest.json');
  const planned = cases.length * options.variants.length * options.runs;
  const manifest: JsonRecord = {
    benchmark: 'controlled-next-question',
    benchmark_type: benchmarkType,
    run_id: runId,
    generated_at: new Date().toISOString(),
    commit_sha: commitSha,
    sample_count_planned: planned,
    audio_manifest_sha256: hash(readFileSync(path.resolve('benchmark/next-question/audio/manifest.json'))),
    fixture_scope: {
      owner_id: options.ownerId,
      story_id: options.storyId,
      stage_id: options.stageId,
      retriever_collection: options.retrieverCollection,
    },
    canonical_audio: Object.fromEntries(cases.map((item) => [item.id, {
      path: `benchmark/next-question/audio/${item.id}.wav`,
      audio_sha256: canonicalAudio.get(item.id)!.sha256,
      adapter_pcm_sha256: canonicalAudio.get(item.id)!.adapterPcmSha256,
      adapter_sample_rate_hz: STEPFUN_INPUT_SAMPLE_RATE,
      frame_bytes: STEPFUN_PCM_FRAME_BYTES,
    }])),
    samples: [],
  };
  const repeatArgs = ['--cases', options.caseIds.join(','), '--variants', options.variants.join(','), '--runs', String(options.runs)];
  writePrivate(path.join(outputDir, 'run.json'), JSON.stringify({
    benchmark: 'controlled-next-question',
    benchmark_type: benchmarkType,
    run_id: runId,
    generated_at: new Date().toISOString(),
    commit_sha: commitSha,
    cases: options.caseIds,
    variants: options.variants,
    runs: options.runs,
    samples_planned: planned,
    realtime_model: realtimeModel,
    realtime_provider: 'stepfun-cloud',
    voice_profile: context.voiceProfile,
    story_context_sha256: hash(JSON.stringify(context)),
    judge_model: 'step-5-preview',
    judge_endpoint: 'https://api.stepfun.com/step_plan/v1/chat/completions',
    judge_temperature: 0,
    coach: coachRuntime,
    coach_temperature: coach ? 0 : null,
    coach_gate_timeout_ms: gateTimeoutMs,
    coach_total_timeout_ms: totalTimeoutMs,
    input: 'The fixed previous question is included in response instructions; canonical mono PCM16 16 kHz WAV is resampled to StepFun production PCM16 24 kHz and sent with the existing adapter appendAudioMessages/commitInputTurn path. No user input_text is sent; user.transcript.final must come from StepFun ASR.',
    response_rule: 'Capture the first completed response transcript and trim surrounding whitespace only.',
    repeat_command: `bash scripts/codex-node.sh npm run benchmark:next-question -- ${repeatArgs.join(' ')}`,
    verification: ['Each sample starts a fresh StepFun websocket.', 'All variants reuse the same in-memory canonical WAV bytes per case.', 'User ASR is provider-generated after input_audio_buffer.commit.', 'Exactly one response.create is sent after the ASR final and Coach path.', 'A has no Coach/Retriever/Era calls.', 'B constrains both retrieval paths off.', 'C uses the production RealtimeCoachPipeline and current Retriever/Era clients.'],
  }, null, 2));
  writePrivate(technicalPath, '');
  writePrivate(judgePath, '');
  writePrivate(manifestPath, JSON.stringify(manifest, null, 2));

  let technicalIndex = 0;
  let completed = 0;
  const technicalSamples: JsonRecord[] = [];
  const judgeCandidates: Array<{ sample: JsonRecord; judge: JsonRecord; mapping: JsonRecord }> = [];
  for (const item of cases) {
    for (const variant of options.variants) {
      for (let run = 1; run <= options.runs; run += 1) {
        let sample = failedWorkerSample({
          item, variant, run, audio: canonicalAudio.get(item.id)!, realtimeModel, coachRuntime, commitSha,
        });
        const retryHistory: JsonRecord[] = [];
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          sample = runIsolatedSample({
            item, variant, run, outputDir, audio: canonicalAudio.get(item.id)!, realtimeModel, coachRuntime, commitSha,
          });
          sample.attempt_count = attempt;
          if (sample.status !== 'failed' || !isRetryableInfrastructureFailure(sample) || attempt === 3) break;
          retryHistory.push({ attempt, reason: sampleErrorCode(sample) });
          process.stdout.write(`RETRY ${item.id}-${variant} run ${run} after ${sampleErrorCode(sample)} (attempt ${attempt}/3)\n`);
        }
        sample.retry_reason = retryHistory.length ? retryHistory : null;
        sample.attempt_failures = retryHistory;
        technicalSamples.push(sample);
        appendFileSync(technicalPath, `${JSON.stringify(sample)}\n`, { encoding: 'utf8', mode: 0o600 });
        if (sample.status === 'completed') {
          completed += 1;
          const candidateId = randomUUID();
          const mapping: JsonRecord = {
            candidate_id: candidateId,
            variant,
            run,
            technical_record_index: technicalIndex,
          };
          judgeCandidates.push({ sample, mapping, judge: {
            case_id: sample.case_id,
            candidate_id: candidateId,
            previous_question: sample.previous_question,
            user_answer: sample.actual_asr_text,
            known_context: judgeContext[String(sample.case_id)]?.known_context ?? {},
            historical_known_facts: judgeContext[String(sample.case_id)]?.historical_known_facts ?? [],
            next_question: sample.next_question,
          } });
          (manifest.samples as JsonRecord[]).push(mapping);
          writePrivate(manifestPath, JSON.stringify(manifest, null, 2));
        }
        technicalIndex += 1;
        process.stdout.write(`${sample.status.toUpperCase()} ${item.id}-${variant} run ${run} attempts=${sample.attempt_count}: audio ${String(sample.audio_sha256 ?? '').slice(0, 12)}; ASR chars ${String(sample.actual_asr_text ?? '').length}; ${outputDir}\n`);
      }
    }
  }
  const equivalence: JsonRecord[] = [];
  const mismatched = new Set<string>();
  for (const item of cases) {
    for (let run = 1; run <= options.runs; run += 1) {
      const group = technicalSamples.filter((sample) => sample.case_id === item.id && Number(sample.run) === run);
      const expectedVariants = ['A', 'B', 'C'];
      const byVariant = new Map(group.map((sample) => [String(sample.variant), sample]));
      let status: 'PASS' | 'FAIL' | 'NOT_TESTED' = 'NOT_TESTED';
      const expected = normalizeAsrForEquivalence(item.userAnswer);
      const normalized = expectedVariants.map((variant) => byVariant.get(variant)?.normalized_asr_text);
      if (options.variants.length === 3 && expectedVariants.every((variant) => options.variants.includes(variant as InterviewBenchmarkVariant))
        && expectedVariants.every((variant) => typeof byVariant.get(variant)?.actual_asr_text === 'string'
          && String(byVariant.get(variant)?.actual_asr_text).trim().length > 0)) {
        status = normalized.every((text) => text === expected) ? 'PASS' : 'FAIL';
      }
      const row = {
        case_id: item.id,
        run,
        expected_normalized_asr: expected,
        status,
        normalized_asr_by_variant: Object.fromEntries(expectedVariants.map((variant, index) => [variant, normalized[index] ?? null])),
      };
      equivalence.push(row);
      if (status === 'FAIL') mismatched.add(`${item.id}:${run}`);
      for (const sample of group) {
        const sampleStatus = sample.status === 'completed' && sample.normalized_asr_text === expected ? 'PASS'
          : sample.status === 'completed' && typeof sample.actual_asr_text === 'string' && sample.actual_asr_text.trim() ? 'FAIL' : 'NOT_TESTED';
        sample.input_equivalence = sampleStatus;
        sample.input_transcript_mismatch = sampleStatus === 'FAIL';
        sample.primary_score_eligible = sampleStatus === 'PASS';
        if (sampleStatus === 'FAIL') {
          const errors = Array.isArray(sample.errors) ? sample.errors as JsonRecord[] : [];
          errors.push({ stage: 'input_equivalence', code: 'INPUT_TRANSCRIPT_MISMATCH' });
          sample.errors = errors;
        }
      }
      for (const candidate of judgeCandidates.filter((entry) => entry.sample.case_id === item.id && Number(entry.sample.run) === run)) {
        candidate.mapping.input_equivalence = candidate.sample.input_equivalence;
        candidate.mapping.primary_score_eligible = candidate.sample.primary_score_eligible;
      }
    }
  }
  const cMemoryEvidenceReadiness: JsonRecord[] = [];
  if (options.variants.includes('C')) {
    for (const item of cases.filter((candidate) => ['C06', 'C07'].includes(candidate.id))) {
      for (let run = 1; run <= options.runs; run += 1) {
        const c = technicalSamples.find((sample) => sample.case_id === item.id
          && sample.variant === 'C' && Number(sample.run) === run);
        cMemoryEvidenceReadiness.push({
          case_id: item.id,
          run,
          status: hasRetrievedMemoryEvidence(c) ? 'EVIDENCE_FOUND' : c?.status === 'completed' ? 'NO_EVIDENCE' : 'SAMPLE_FAILED',
          memory_evidence_count: Array.isArray(c?.memory_evidence) ? c.memory_evidence.length : 0,
        });
      }
    }
  }
  const judgeRows = judgeCandidates.map((entry) => entry.judge);
  manifest.input_equivalence = equivalence;
  manifest.c_memory_evidence_readiness = cMemoryEvidenceReadiness;
  manifest.primary_score_excluded_candidates = judgeCandidates
    .filter((entry) => entry.sample.primary_score_eligible !== true)
    .map((entry) => entry.mapping.candidate_id);
  writePrivate(technicalPath, technicalSamples.map((sample) => JSON.stringify(sample)).join('\n') + (technicalSamples.length ? '\n' : ''));
  writePrivate(manifestPath, JSON.stringify(manifest, null, 2));
  for (let index = judgeRows.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [judgeRows[index], judgeRows[swapIndex]] = [judgeRows[swapIndex]!, judgeRows[index]!];
  }
  writePrivate(judgePath, judgeRows.map((row) => JSON.stringify(row)).join('\n') + (judgeRows.length ? '\n' : ''));
  printSmokeReports(technicalSamples, equivalence);
  for (const key of mismatched) process.stderr.write(`INPUT_TRANSCRIPT_MISMATCH ${key}\n`);
  for (const row of equivalence) process.stdout.write(`INPUT_EQUIVALENCE ${row.case_id} run ${row.run} = ${row.status}\n`);
  for (const row of cMemoryEvidenceReadiness) {
    process.stdout.write(`C_MEMORY_EVIDENCE ${row.case_id} run ${row.run} = ${row.status}\n`);
  }
  process.stdout.write(`Completed ${completed}/${planned} samples. Results: ${outputDir}\n`);
  if (completed !== planned) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`Benchmark stopped: ${errorCode(error)}\n`);
  process.exitCode = 1;
});
