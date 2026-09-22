import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRealtimeInterviewProvider } from '../src/realtime/provider.js';
import {
  DEFAULT_DOUBAO_MODEL,
  DOUBAO_END_SMOOTH_WINDOW_MS,
} from '../src/realtime/doubao.js';
import {
  buildStepfunSessionUpdate,
  DEFAULT_STEPFUN_MODEL,
  STEPFUN_CONTEXT_TOOL,
} from '../src/realtime/stepfun.js';

const storyContext = {
  user: { user_id: 'user-1', name: '测试用户' },
  life_stage: { stage_id: 'stage-1', title: '工作阶段' },
  story: {
    story_id: 'story-1',
    title: '第一次负责项目',
    agent_memory: '【故事背景】第一次独立负责跨团队项目。',
    status: 'interviewing',
    gaps: ['项目为什么会启动？'],
  },
  task_context: { mode: 'continue' as const },
};

const onboardingContext = {
  interview_type: 'onboarding' as const,
  profile: { name: '测试用户' },
  previousOnboardingTranscripts: [],
  taskContext: { mode: 'new' as const },
};

const externalContributorContext = {
  interview_type: 'external_contributor' as const,
  share_id: 'share-1',
  relationship: 'daughter',
  contributor_summary: '',
  subject: { name: '测试用户' },
  story: {
    story_id: 'story-1',
    title: '第一次负责项目',
    summary: '项目经历',
    status: 'interviewing',
    gaps: [],
  },
};

test('PROVIDER-CONTRACT-01 Doubao exposes generic capabilities, audio and lifecycle plans without changing wire parameters', () => {
  const adapter = createRealtimeInterviewProvider('doubao', {
    doubaoApiKey: 'test-only-key',
    region: 'cn-beijing',
    model: DEFAULT_DOUBAO_MODEL,
  });

  assert.equal(adapter.id, 'doubao');
  assert.deepEqual(adapter.capabilities, {
    fullDuplex: true,
    supportsInterrupt: true,
    supportsExplicitTurnRequest: true,
    supportsPlaybackAck: false,
    supportsExplicitSessionClose: true,
  });
  assert.deepEqual(adapter.audio, {
    input: { encoding: 'pcm_s16le', sampleRate: 16_000, frameBytes: 640 },
    output: { encoding: 'pcm_f32le', sampleRate: 24_000 },
  });
  assert.match(adapter.connectOptions().url, /^wss:\/\/openspeech\.bytedance\.com\//);
  const setup = adapter.setupSession(storyContext);
  assert.equal(setup.length, 1);
  const session = setup[0]?.session as Record<string, unknown>;
  const asr = ((session.extension as Record<string, unknown>).asr as Record<string, unknown>).extra as Record<string, unknown>;
  assert.equal(asr.end_smooth_window_ms, DOUBAO_END_SMOOTH_WINDOW_MS);
  assert.equal(DOUBAO_END_SMOOTH_WINDOW_MS, 1_500);
  const opening = adapter.initialResponsePlan(storyContext);
  assert.equal(opening.steps.length, 1);
  assert.equal(opening.steps[0]?.message.type, 'speech_text_buffer.commit');
  assert.match(String(opening.fallbackText), /项目为什么会启动/);
  assert.equal(adapter.appendAudioMessages(Buffer.from([0, 1]))[0]?.type, 'input_audio_buffer.append');
  assert.equal(adapter.recoverStalledUserTurn?.()[0]?.message.type, 'input_audio_buffer.commit');
  assert.equal(adapter.beginInputShutdown()[0]?.message.type, 'input_audio_mute.commit');
  assert.equal(adapter.closePlan()?.steps[0]?.message.type, 'session.close');
  assert.equal(adapter.closePlan()?.waitFor, 'session.closed');
});

test('PROVIDER-CONTRACT-02 Qwen satisfies the same generic contract with its legacy wire protocol', () => {
  const adapter = createRealtimeInterviewProvider('qwen', {
    apiKey: 'test-only-key',
    workspaceId: 'workspace-123',
    region: 'cn-beijing',
    model: 'qwen-audio-3.0-realtime-plus',
  });

  assert.equal(adapter.id, 'qwen');
  assert.deepEqual(adapter.capabilities, {
    fullDuplex: true,
    supportsInterrupt: true,
    supportsExplicitTurnRequest: true,
    supportsPlaybackAck: false,
    supportsExplicitSessionClose: false,
  });
  assert.deepEqual(adapter.audio, {
    input: { encoding: 'pcm_s16le', sampleRate: 16_000, frameBytes: 640 },
    output: { encoding: 'pcm_s16le', sampleRate: 24_000 },
  });
  assert.match(adapter.connectOptions().url, /^wss:\/\/workspace-123\.cn-beijing\.maas\.aliyuncs\.com\//);
  assert.equal(adapter.setupSession(storyContext)[0]?.type, 'session.update');
  assert.equal(adapter.initialResponsePlan(storyContext).steps[0]?.message.type, 'response.create');
  assert.equal(adapter.appendAudioMessages(Buffer.from([0, 1]))[0]?.type, 'input_audio_buffer.append');
  const shutdown = adapter.beginInputShutdown();
  assert.equal(shutdown.length, 40);
  assert.ok(shutdown.every((step) => step.delayAfterMs === 20));
  assert.equal(adapter.closePlan(), null);
});

test('PROVIDER-CONTRACT-04 Step-Audio exposes 24 kHz audio and its context tool', () => {
  const adapter = createRealtimeInterviewProvider('stepfun', {
    stepfunApiKey: 'test-only-key',
    region: 'cn-beijing',
    model: DEFAULT_STEPFUN_MODEL,
  });

  assert.equal(adapter.id, 'stepfun');
  assert.deepEqual(adapter.audio, {
    input: { encoding: 'pcm_s16le', sampleRate: 24_000, frameBytes: 960 },
    output: { encoding: 'pcm_s16le', sampleRate: 24_000 },
  });
  assert.equal(adapter.connectOptions().url, 'wss://api.stepfun.com/v1/realtime?model=step-audio-2-mini');
  const session = adapter.setupSession(storyContext)[0]?.session as Record<string, unknown>;
  const tools = session.tools as Array<Record<string, unknown>>;
  assert.equal((tools[0]?.function as Record<string, unknown>).name, STEPFUN_CONTEXT_TOOL);
  assert.equal(adapter.appendAudioMessages(Buffer.from([0, 1]))[0]?.type, 'input_audio_buffer.append');

  adapter.normalizeServerMessage(JSON.stringify({
    type: 'response.function_call_arguments.delta',
    call_id: 'call-1',
    delta: '{"query":"王师傅"}',
  }));
  const calls = adapter.normalizeServerMessage(JSON.stringify({
    type: 'response.function_call_arguments.done',
    call_id: 'call-1',
    response_id: 'response-1',
    name: STEPFUN_CONTEXT_TOOL,
    arguments: '{"query":"王师傅"}',
  }));
  assert.deepEqual(calls, [{
    type: 'tool.call.requested',
    name: STEPFUN_CONTEXT_TOOL,
    callId: 'call-1',
    arguments: { query: '王师傅' },
    rawArguments: '{"query":"王师傅"}',
    responseId: 'response-1',
  }]);
  const toolCall = calls[0];
  assert.equal(toolCall?.type, 'tool.call.requested');
  if (toolCall?.type !== 'tool.call.requested') throw new Error('StepFun tool call was not normalized.');
  const toolMessages = adapter.handleToolResult?.(toolCall, { facts: [] });
  assert.equal(toolMessages?.[0]?.type, 'conversation.item.create');
  assert.equal((toolMessages?.[0]?.item as Record<string, unknown>).call_id, 'call-1');
  assert.equal(toolMessages?.[1]?.type, 'response.create');
  assert.equal(adapter.handleToolResult?.(toolCall, { status: 'stale' }, { resume: false })?.length, 1);
});

test('Step-Audio does not expose owner history context to external contributors', () => {
  const session = buildStepfunSessionUpdate(externalContributorContext).session as Record<string, unknown>;
  assert.equal('tools' in session, false);
  assert.equal(String(session.instructions).includes(STEPFUN_CONTEXT_TOOL), false);
});

test('NORMALIZE contract maps Doubao and Qwen speech, transcript, audio and response events to the same event vocabulary', () => {
  const doubao = createRealtimeInterviewProvider('doubao', {
    doubaoApiKey: 'test-only-key',
    region: 'cn-beijing',
    model: DEFAULT_DOUBAO_MODEL,
  });
  const qwen = createRealtimeInterviewProvider('qwen', {
    apiKey: 'test-only-key',
    workspaceId: 'workspace-123',
    region: 'cn-beijing',
    model: 'qwen-audio-3.0-realtime-plus',
  });

  assert.deepEqual(doubao.normalizeServerMessage(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.started',
    event_id: 'speech-1',
  })), [{ type: 'speech.started', eventId: 'speech-1' }]);
  assert.deepEqual(qwen.normalizeServerMessage(JSON.stringify({
    type: 'input_audio_buffer.speech_started',
    event_id: 'speech-1',
  })), [{ type: 'speech.started', eventId: 'speech-1' }]);

  assert.deepEqual(doubao.normalizeServerMessage(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'user-1',
    text: '最终用户原话',
  })), [{ type: 'user.transcript.final', itemId: 'user-1', text: '最终用户原话' }]);
  assert.deepEqual(qwen.normalizeServerMessage(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'user-1',
    transcript: '最终用户原话',
  })), [{ type: 'user.transcript.final', itemId: 'user-1', text: '最终用户原话' }]);

  const doubaoAudio = doubao.normalizeServerMessage(JSON.stringify({
    type: 'response.output_audio.delta',
    response_id: 'resp-1',
    delta: 'AAAA',
  }));
  const doubaoAudioDelta = doubaoAudio.at(-1);
  assert.equal(doubaoAudioDelta?.type, 'assistant.audio.delta');
  if (doubaoAudioDelta?.type === 'assistant.audio.delta') {
    assert.equal(doubaoAudioDelta.encoding, 'pcm_f32le');
  }
  const qwenAudio = qwen.normalizeServerMessage(JSON.stringify({
    type: 'response.audio.delta',
    response_id: 'resp-1',
    delta: 'AAAA',
  }));
  const qwenAudioDelta = qwenAudio.at(-1);
  assert.equal(qwenAudioDelta?.type, 'assistant.audio.delta');
  if (qwenAudioDelta?.type === 'assistant.audio.delta') {
    assert.equal(qwenAudioDelta.encoding, 'pcm_s16le');
  }
});

test('NORMALIZE-06 hides Doubao onboarding sentinel and maps both completion protocols to onboarding.completion.requested', () => {
  const doubao = createRealtimeInterviewProvider('doubao', {
    doubaoApiKey: 'test-only-key',
    region: 'cn-beijing',
    model: DEFAULT_DOUBAO_MODEL,
  });
  const qwen = createRealtimeInterviewProvider('qwen', {
    apiKey: 'test-only-key',
    workspaceId: 'workspace-123',
    region: 'cn-beijing',
    model: 'qwen-audio-3.0-realtime-plus',
  });
  doubao.setupSession(onboardingContext);
  qwen.setupSession(onboardingContext);

  const doubaoEvents = doubao.normalizeServerMessage(JSON.stringify({
    type: 'response.output_text.done',
    response_id: 'resp-d',
    text: '感谢你愿意分享。\n[[ONBOARDING_COMPLETE]]',
  }));
  assert.ok(doubaoEvents.some((event) => event.type === 'onboarding.completion.requested'));
  assert.ok(doubaoEvents.every((event) => JSON.stringify(event).includes('ONBOARDING_COMPLETE') === false));

  const qwenEvents = qwen.normalizeServerMessage(JSON.stringify({
    type: 'response.function_call_arguments.done',
    name: 'complete_onboarding',
    call_id: 'call-1',
    response_id: 'resp-q',
  }));
  assert.deepEqual(qwenEvents, [{
    type: 'onboarding.completion.requested',
    responseId: 'resp-q',
    controlToken: 'call-1',
    requiresAck: true,
  }]);
  const ack = qwen.handleControlEvent(qwenEvents[0]!);
  assert.equal(ack[0]?.type, 'conversation.item.create');
  assert.equal(ack[1]?.type, 'response.create');
});

test('ARCH-REALTIME-01 server lifecycle contains no provider wire protocol or provider-name branching', () => {
  const source = readFileSync(path.resolve('src/server.ts'), 'utf8');
  for (const forbidden of [
    'parseDoubaoServerEvent',
    'normalizeDoubaoAssistantTranscriptEvent',
    'readDoubaoTranscriptionText',
    'doubaoResponseId',
    'ensureDoubaoResponseStarted',
    'handleDoubaoServerEvent',
    'finishDoubaoProviderSession',
    'QWEN_END_SILENCE_FRAMES',
    'DOUBAO_PCM_FRAME_BYTES',
    'DOUBAO_OUTPUT_ENCODING',
    "selectedProvider === 'doubao'",
    "selectedProvider === 'qwen'",
    "providerName === 'doubao'",
    "providerName === 'qwen'",
    'response.function_call_arguments.done',
    '[[ONBOARDING_COMPLETE]]',
  ]) {
    assert.equal(source.includes(forbidden), false, `server.ts must not contain provider-specific lifecycle token: ${forbidden}`);
  }
});

test('PROVIDER-CONTRACT-03 connection failures are sanitized and owned by adapters', () => {
  const secret = 'top-secret-key';
  const doubao = createRealtimeInterviewProvider('doubao', {
    doubaoApiKey: secret,
    region: 'cn-beijing',
    model: DEFAULT_DOUBAO_MODEL,
  });
  const message = doubao.connectionFailureMessage({
    kind: 'socket-error',
    message: `socket failed with ${secret}`,
  });
  assert.doesNotMatch(message, new RegExp(secret));
  assert.match(message, /\[redacted\]/);
});
