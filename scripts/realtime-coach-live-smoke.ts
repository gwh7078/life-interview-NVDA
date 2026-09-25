import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import { resolveDiagnosticsPath } from '../src/diagnostics/paths.js';
import { BailianRealtimeCoach, buildRealtimeCoachGateInput } from '../src/realtime/coach/service.js';
import { renderMiniCoachPacket } from '../src/realtime/coach/mini-coach-renderer.js';
import type { RealtimeInterviewContext } from '../src/realtime/prompt.js';
import { buildStepAudio2MiniInstructions } from '../src/realtime/prompt.js';
import { createRealtimeInterviewProvider } from '../src/realtime/provider.js';
import { resolveRealtimeProviderConfig } from '../src/realtime/runtime-config.js';

type EventWaiter = {
  predicate: (event: Record<string, unknown>) => boolean;
  resolve: (event: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function timeoutMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

const context: RealtimeInterviewContext = {
  interview_type: 'story',
  user: { user_id: 'synthetic-live-smoke' },
  life_stage: { stage_id: 'synthetic-live-smoke', title: '青年时期' },
  story: null,
  task_context: { mode: 'create', target_title: '第一次去深圳做家具' },
  voiceProfile: 'stepaudio2_mini',
  memoryTriggerMode: 'supervisor_auto',
};

const currentAnswer = '这个问题刚才已经问过了，我已经说过是因为工作机会。我想换个角度讲讲到了深圳以后怎么开始做家具。';
const repeatedQuestion = '当时你为什么决定去深圳？';

function pcmFromWave(wave: Buffer): Buffer {
  if (wave.subarray(0, 4).toString('ascii') !== 'RIFF' || wave.subarray(8, 12).toString('ascii') !== 'WAVE') {
    throw new Error('macOS audio conversion did not produce a WAV file.');
  }
  let offset = 12;
  while (offset + 8 <= wave.length) {
    const chunk = wave.subarray(offset, offset + 4).toString('ascii');
    const length = wave.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (chunk === 'data') return wave.subarray(start, start + length);
    offset = start + length + (length % 2);
  }
  throw new Error('Converted WAV has no data chunk.');
}

function makeSyntheticPcm(text: string): Buffer {
  if (process.platform !== 'darwin') throw new Error('This live smoke needs macOS say/afconvert or a dedicated PCM fixture.');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'realtime-coach-live-'));
  const aiffPath = path.join(directory, 'input.aiff');
  const wavPath = path.join(directory, 'input.wav');
  try {
    const speech = spawnSync('say', ['-v', env('REALTIME_COACH_SMOKE_VOICE', 'Tingting'), '-o', aiffPath, text], { encoding: 'utf8' });
    if (speech.status !== 0) throw new Error(`macOS speech synthesis failed: ${speech.stderr || speech.stdout || 'unknown error'}`);
    const conversion = spawnSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@24000', '-c', '1', aiffPath, wavPath], { encoding: 'utf8' });
    if (conversion.status !== 0) throw new Error(`PCM conversion failed: ${conversion.stderr || conversion.stdout || 'unknown error'}`);
    const pcm = pcmFromWave(readFileSync(wavPath));
    if (pcm.length < 2 || pcm.length % 2) throw new Error('Synthesized PCM is empty or misaligned.');
    return pcm;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const coachApiKey = env('REALTIME_COACH_API_KEY', env('BAILIAN_API_KEY'));
  const stepfunApiKey = env('STEPFUN_API_KEY');
  if (!coachApiKey || !stepfunApiKey) {
    throw new Error('需要配置 REALTIME_COACH_API_KEY（或 BAILIAN_API_KEY）和 STEPFUN_API_KEY。');
  }

  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    status: 'FAIL',
    scenario: 'story_create',
    voiceProfile: 'stepaudio2_mini',
    triggerMode: 'supervisor_auto',
    coachModel: env('REALTIME_COACH_MODEL', 'qwen3-8b'),
    stepfunModel: env('STEPFUN_REALTIME_MODEL', 'step-audio-2-mini'),
    inputKind: 'synthetic-audio-24khz-pcm',
    configuredGateTimeoutMs: timeoutMs('REALTIME_COACH_GATE_TIMEOUT_MS', 1_200),
    productionGateTimeoutMs: 1_200,
    order: [],
  };
  let socket: WebSocket | undefined;
  let packet = '';
  let assistantText = '';
  let instructions = '';
  const waiters: EventWaiter[] = [];
  const seenEvents: string[] = [];
  const seenNormalizedEvents: string[] = [];
  let outputAudioBytes = 0;
  let finalAnswer = '';

  const artifactDir = resolveDiagnosticsPath('test-artifacts', 'realtime-coach-live-smoke');
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  const artifactPath = path.join(artifactDir, `${new Date().toISOString().replaceAll(':', '-')}.json`);

  function waitForEvent(
    predicate: (event: Record<string, unknown>) => boolean,
    label: string,
    durationMs: number,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for ${label} (${durationMs} ms).`));
      }, durationMs);
      waiters.push({ predicate, resolve, reject, timer });
    });
  }

  try {
    const providerConfig = resolveRealtimeProviderConfig('stepaudio2_mini', {
      region: 'cn-beijing',
      model: env('QWEN_REALTIME_MODEL', 'qwen3-omni-flash-realtime'),
      stepfunApiKey,
      stepfunModel: env('STEPFUN_REALTIME_MODEL', 'step-audio-2-mini'),
    });
    const provider = createRealtimeInterviewProvider('stepaudio2_mini', providerConfig);
    const connection = provider.connectOptions();
    socket = new WebSocket(connection.url, { headers: connection.headers });
    socket.on('message', (data) => {
      let raw: Record<string, unknown> | undefined;
      try { raw = record(JSON.parse(data.toString())); } catch { return; }
      if (!raw || typeof raw.type !== 'string') return;
      seenEvents.push(raw.type);
      if (raw.type === 'response.audio.delta' && typeof raw.delta === 'string') {
        outputAudioBytes += Buffer.from(raw.delta, 'base64').byteLength;
      }
      const normalizedEvents = provider.normalizeServerMessage(data);
      for (const normalized of normalizedEvents) {
        seenNormalizedEvents.push(normalized.type);
        if (normalized.type === 'assistant.transcript.delta') assistantText += normalized.delta;
        if (normalized.type === 'assistant.transcript.final') assistantText = normalized.text;
        if (normalized.type === 'provider.error') {
          report.stepfunProviderError = normalized.message;
          for (const waiter of waiters.splice(0)) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error(normalized.message));
          }
        }
        for (const waiter of [...waiters]) {
          if (!waiter.predicate(normalized as unknown as Record<string, unknown>)) continue;
          waiters.splice(waiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(normalized as unknown as Record<string, unknown>);
        }
      }
    });
    socket.on('error', (error) => {
      report.stepfunSocketError = error.message.replace(/Bearer\s+[^\s"']+/giu, 'Bearer [redacted]');
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    });
    socket.on('close', (code, reason) => {
      report.stepfunClose = { code, reason: reason.toString().slice(0, 200) };
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('StepFun WebSocket connect timeout (15 s).')), 15_000);
      socket!.once('open', () => { clearTimeout(timer); resolve(); });
      socket!.once('error', (error) => { clearTimeout(timer); reject(error); });
    });

    const sessionConfigured = waitForEvent((event) => event.type === 'session.configured', 'manual session configuration', 20_000);
    for (const message of provider.setupSession(context)) socket.send(JSON.stringify(message));
    await sessionConfigured;
    report.order = ['session.configured'];

    const pcm = makeSyntheticPcm(currentAnswer);
    report.inputAudioBytes = pcm.byteLength;
    const userTranscriptFinal = waitForEvent((event) => event.type === 'user.transcript.final', 'StepFun ASR final transcript', 30_000);
    for (let offset = 0; offset < pcm.length; offset += 960) {
      const frame = pcm.subarray(offset, Math.min(offset + 960, pcm.length));
      for (const message of provider.appendAudioMessages(frame)) socket.send(JSON.stringify(message));
      await sleep(20);
    }
    report.order = [...report.order as string[], 'input_audio_buffer.commit.sent'];
    for (const step of provider.commitInputTurn?.() ?? []) socket.send(JSON.stringify(step.message));
    const transcriptEvent = await userTranscriptFinal;
    finalAnswer = typeof transcriptEvent.text === 'string' ? transcriptEvent.text.trim() : '';
    if (!finalAnswer) throw new Error('StepFun returned an empty final ASR transcript.');
    report.asrTranscript = finalAnswer;
    report.order = [...report.order as string[], 'user.transcript.final'];

    const gateInput = buildRealtimeCoachGateInput(context, {
      lastAssistantQuestion: repeatedQuestion,
      currentUserAnswer: finalAnswer,
      recentContext: [
        { role: 'assistant', text: repeatedQuestion },
        { role: 'user', text: '我当时主要是想出去闯一闯。' },
        { role: 'assistant', text: repeatedQuestion },
      ],
    });
    const coach = new BailianRealtimeCoach({
      provider: 'openai-compatible',
      baseUrl: env('REALTIME_COACH_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
      model: env('REALTIME_COACH_MODEL', 'qwen3-8b'),
      apiKey: coachApiKey,
    });
    const gateStartedAt = performance.now();
    const gate = await coach.evaluate(gateInput, {
      signal: AbortSignal.timeout(timeoutMs('REALTIME_COACH_GATE_TIMEOUT_MS', 1_200)),
    });
    const gateMs = Number((performance.now() - gateStartedAt).toFixed(1));
    report.gate = {
      action: gate.action,
      retrieve: gate.retrieve,
      reason: gate.reason,
      latencyMs: gateMs,
      withinProductionBudget: gateMs <= 1_200,
    };
    report.order = [...report.order as string[], 'coach.gate.completed'];
    if (gate.action === 'none' || !gate.direction) {
      throw new Error(`Live Gate did not guide the repeated-question scenario (action=${gate.action}, reason=${gate.reason}).`);
    }

    packet = renderMiniCoachPacket({ scenario: 'story_create', currentUserAnswer: finalAnswer, gate });
    if (!packet || Array.from(packet).length > 160) throw new Error('Coach packet is empty or exceeds its hard character limit.');
    instructions = buildStepAudio2MiniInstructions(context, {
      memoryTriggerMode: 'supervisor_auto', omitOpeningGap: true, coachPacket: packet,
    });
    report.coachPacket = packet;
    report.coachPacketChars = Array.from(packet).length;
    report.responseInstructionsChars = Array.from(instructions).length;

    const responseDone = waitForEvent((event) => event.type === 'response.done', 'Coach-guided current response', 60_000);
    socket.send(JSON.stringify(provider.requestAssistantTurnMessages(instructions)[0]));
    report.order = [...report.order as string[], 'response.create.with_coach_packet.sent'];
    const done = await responseDone;
    report.order = [...report.order as string[], 'assistant.response.done'];
    report.responseStatus = done.status;
    report.assistantTranscript = assistantText || (typeof done.finalText === 'string' ? done.finalText : '');
    report.assistantTranscriptChars = Array.from(String(report.assistantTranscript)).length;
    report.outputAudioBytes = outputAudioBytes;
    report.sameResponseVerified = done.status === 'completed'
      && Array.isArray(report.order)
      && (report.order as string[]).indexOf('coach.gate.completed') < (report.order as string[]).indexOf('response.create.with_coach_packet.sent')
      && (report.order as string[]).indexOf('response.create.with_coach_packet.sent') < (report.order as string[]).indexOf('assistant.response.done');
    const assistantReply = String(report.assistantTranscript);
    const questionMarks = assistantReply.match(/[?？]/gu)?.length ?? 0;
    const internalStoryMarkup = /<tool_call>|<story>|<\/story>|<content>|<\/content>/iu.test(assistantReply);
    report.responseBehavior = { questionMarks, oneQuestion: questionMarks === 1, internalStoryMarkup };
    const providerTurnCompleted = report.sameResponseVerified
      && outputAudioBytes > 0
      && Boolean(report.assistantTranscript);
    report.sameTurnProviderStatus = providerTurnCompleted ? 'PASS' : 'FAIL';
    report.replyBehaviorStatus = questionMarks === 1 && !internalStoryMarkup ? 'PASS' : 'FAIL';
    report.status = providerTurnCompleted && report.replyBehaviorStatus === 'PASS' ? 'PASS' : 'FAIL';
    if (!providerTurnCompleted) throw new Error('StepFun did not complete the same-turn response with audio and transcript.');
    if (report.replyBehaviorStatus !== 'PASS') {
      throw new Error(`Same-turn response completed, but reply behavior failed (questionMarks=${questionMarks}, internalStoryMarkup=${internalStoryMarkup}).`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.error = message.replace(/Bearer\s+[^\s"']+/giu, 'Bearer [redacted]');
  } finally {
    report.stepfunEventCounts = Object.fromEntries([...new Set(seenEvents)].map((type) => [type, seenEvents.filter((seen) => seen === type).length]));
    report.stepfunNormalizedEventCounts = Object.fromEntries([...new Set(seenNormalizedEvents)].map((type) => [type, seenNormalizedEvents.filter((seen) => seen === type).length]));
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Smoke ended before this event arrived.'));
    }
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        socket!.once('close', () => { clearTimeout(timer); resolve(); });
        socket!.close();
      });
    }
    writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    const markdownPath = artifactPath.replace(/\.json$/u, '.md');
    writeFileSync(markdownPath, [
      '# Realtime Coach same-turn live smoke',
      '',
      `- Result: ${String(report.status)}`,
      `- Gate: ${JSON.stringify(report.gate ?? null)}`,
      `- Same response: ${String(report.sameResponseVerified ?? false)}`,
      `- Provider turn: ${String(report.sameTurnProviderStatus ?? 'FAIL')}`,
      `- Response behavior: ${JSON.stringify(report.responseBehavior ?? null)}`,
      `- Packet chars: ${String(report.coachPacketChars ?? 0)}`,
      `- StepFun response: ${String(report.responseStatus ?? 'not reached')}`,
      `- Repeat: \`bash scripts/codex-node.sh node --env-file-if-exists=.env --import tsx scripts/realtime-coach-live-smoke.ts\``,
      `- JSON evidence: ${path.basename(artifactPath)}`,
      ...(typeof report.error === 'string' ? [`- Error: ${report.error}`] : []),
      '',
      'The test speaks a fixed synthetic story-create answer through macOS TTS, waits for StepFun ASR final, runs the live Coach Gate, then sends the compact packet only with this turn\'s `response.create` instructions. The packet is not persisted.',
      '',
    ].join('\n'), { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({
      status: report.status,
      gate: report.gate ?? null,
      packetChars: report.coachPacketChars ?? null,
      responseStatus: report.responseStatus ?? null,
      assistantTranscript: report.assistantTranscript ?? null,
      outputAudioBytes: report.outputAudioBytes ?? null,
      stepfunEventCounts: report.stepfunEventCounts ?? {},
      stepfunNormalizedEventCounts: report.stepfunNormalizedEventCounts ?? {},
      stepfunProviderError: report.stepfunProviderError ?? null,
      stepfunSocketError: report.stepfunSocketError ?? null,
      stepfunClose: report.stepfunClose ?? null,
      sameResponseVerified: report.sameResponseVerified ?? false,
      artifactPath,
      error: report.error ?? null,
    }, null, 2)}\n`);
    if (report.status !== 'PASS') process.exitCode = 1;
  }
}

await main();
