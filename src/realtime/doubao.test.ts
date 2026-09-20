import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDoubaoAudioAppend,
  buildDoubaoAudioCommit,
  buildDoubaoMuteInput,
  buildDoubaoOpeningGreetingText,
  buildDoubaoRealtimeHeaders,
  buildDoubaoSessionClose,
  buildDoubaoSessionCreate,
  buildDoubaoTextCommit,
  filterDoubaoOnboardingTranscript,
  filterDoubaoOnboardingTranscriptPartial,
  DOUBAO_END_SMOOTH_WINDOW_MS,
  DOUBAO_CONFIGURABLE_VOICE_IDS,
  DEFAULT_DOUBAO_MODEL,
  DEFAULT_DOUBAO_VOICE,
  DOUBAO_INPUT_SAMPLE_RATE,
  DOUBAO_MODEL_NAME,
  DOUBAO_OUTPUT_ENCODING,
  DOUBAO_OUTPUT_SAMPLE_RATE,
  DOUBAO_PCM_FRAME_BYTES,
  DOUBAO_REALTIME_URL,
  DOUBAO_ONBOARDING_COMPLETION_SENTINEL,
  normalizeDoubaoAssistantTranscriptEvent,
  parseDoubaoServerEvent,
  readDoubaoTranscriptionText,
  resolveDoubaoAssistantTranscriptText,
} from './doubao.js';
import {
  buildInterviewContextPayload,
  buildInterviewInstructions,
  STORY_CONTEXT_MARKER,
} from './prompt.js';
import { createRealtimeInterviewProvider } from './provider.js';
import { ONBOARDING_COMPLETION_UTTERANCE } from '../interview/onboarding/prompt.js';

const context = {
  user: { user_id: 'user-1', name: '测试用户' },
  life_stage: { stage_id: 'stage-1', title: '工作阶段' },
  story: {
    story_id: 'story-1',
    title: '第一次负责项目',
    agent_memory: '【故事背景】第一次独立负责跨团队项目。\n【已覆盖主题】已经讲清楚团队协作背景和主要风险。',
    status: 'interviewing',
  },
};

const onboardingContext = {
  interview_type: 'onboarding' as const,
  profile: { name: '小林', birth_place: '南京' },
  previousOnboardingTranscripts: [{
    startedAt: '2026-09-10T00:00:00.000Z',
    messages: [{ role: 'user' as const, text: '我在南京长大。' }],
  }],
  taskContext: { mode: 'continue' as const },
};

test('Seeduplex 1.0 uses the documented full-duplex endpoint and API-key header', () => {
  assert.equal(DOUBAO_REALTIME_URL, 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue');
  assert.equal(DOUBAO_MODEL_NAME, 'Seeduplex 1.0');
  const headers = buildDoubaoRealtimeHeaders({ apiKey: ' test-only-api-key ' });
  assert.deepEqual(headers, {
    'X-Api-Key': 'test-only-api-key',
    'user-agent': 'rensheng-local-interview/0.1',
  });
  assert.throws(() => buildDoubaoRealtimeHeaders({ apiKey: '  ' }), /VOLCENGINE_API_KEY/);
});

test('Seeduplex session uses model 1.2.6.1, story interview instructions, and PCM audio formats', () => {
  const request = buildDoubaoSessionCreate(context);
  const session = request.session as Record<string, unknown>;
  const audio = session.audio as Record<string, unknown>;
  const input = audio.input as Record<string, unknown>;
  const output = audio.output as Record<string, unknown>;
  const extension = session.extension as Record<string, unknown>;
  const asr = extension.asr as Record<string, unknown>;
  const instructions = String(session.instructions);

  assert.equal(request.type, 'session.create');
  assert.match(String(request.event_id), /^[0-9a-f-]{36}$/);
  assert.equal(session.model, DEFAULT_DOUBAO_MODEL);
  assert.equal(DOUBAO_MODEL_NAME, 'Seeduplex 1.0');
  assert.match(instructions, /不编造/);
  assert.match(instructions, /优先顺着用户刚提到的/);
  assert.match(instructions, /同一语义方向默认只问一轮/);
  assert.match(instructions, /问过了/);
  assert.match(instructions, /首轮根据当前 Story \/ 人生阶段自然问一个具体问题/);
  assert.match(instructions, /用户明确要求结束时立即停止追问/);
  assert.match(instructions, /本次先聊到这里，再见/);
  assert.match(instructions, /8–10 个有效回答只作软参考/);
  assert.equal(instructions.match(/^\d+\. /gm)?.length, 5);
  assert.match(instructions, /【故事背景】第一次独立负责跨团队项目。/);
  assert.match(instructions, /"interview_mode": "continue"/);
  assert.doesNotMatch(instructions, /open_questions|story_state|confirmed_facts/);
  assert.ok(instructions.length <= 3_500);
  assert.deepEqual(input, { format: { type: 'pcm', rate: DOUBAO_INPUT_SAMPLE_RATE } });
  assert.deepEqual(output, {
    format: { type: 'pcm', rate: DOUBAO_OUTPUT_SAMPLE_RATE },
    voice: DEFAULT_DOUBAO_VOICE,
  });
  assert.deepEqual(asr, { extra: {
    enable_asr_twopass: true,
    end_smooth_window_ms: DOUBAO_END_SMOOTH_WINDOW_MS,
  } });
  assert.equal(DOUBAO_END_SMOOTH_WINDOW_MS, 1_500);
  assert.equal(DOUBAO_OUTPUT_ENCODING, 'pcm_f32le');
  assert.equal('tts' in extension, false);
});

test('Seeduplex exposes the requested voice as a configurable candidate without changing the default', () => {
  const candidateVoice = 'zh_female_meilinvyou_uranus_bigtts';
  assert.equal(DEFAULT_DOUBAO_VOICE, 'zh_female_vv_jupiter_bigtts');
  assert.deepEqual(DOUBAO_CONFIGURABLE_VOICE_IDS, [DEFAULT_DOUBAO_VOICE, candidateVoice]);

  const adapter = createRealtimeInterviewProvider('doubao', {
    doubaoApiKey: 'test-only-key',
    region: 'cn-beijing',
    model: DEFAULT_DOUBAO_MODEL,
    doubaoVoice: candidateVoice,
  });
  const setup = adapter.setupSession(context)[0]!;
  const session = setup.session as Record<string, unknown>;
  const audio = session.audio as Record<string, unknown>;
  const output = audio.output as Record<string, unknown>;
  assert.equal(output.voice, candidateVoice);

  const defaultSetup = buildDoubaoSessionCreate(context);
  const defaultSession = defaultSetup.session as Record<string, unknown>;
  const defaultAudio = defaultSession.audio as Record<string, unknown>;
  const defaultOutput = defaultAudio.output as Record<string, unknown>;
  assert.equal(defaultOutput.voice, DEFAULT_DOUBAO_VOICE);
});

test('Seeduplex continuation synthesizes a context-aware greeting text and retains it as the transcript fallback', () => {
  const adapter = createRealtimeInterviewProvider('doubao', {
    doubaoApiKey: 'test-only-key',
    region: 'cn-beijing',
    model: DEFAULT_DOUBAO_MODEL,
  });
  const greetingText = buildDoubaoOpeningGreetingText(context);
  const opening = adapter.initialResponsePlan(context);
  const openingMessage = opening.steps[0]!.message;
  const instructions = String((adapter.setupSession(context)[0]!.session as { instructions?: string }).instructions);

  assert.equal(openingMessage.type, 'speech_text_buffer.commit');
  assert.equal(openingMessage.text, greetingText);
  assert.match(instructions, /首轮根据当前 Story \/ 人生阶段自然问一个具体问题/);
  assert.match(instructions, /【故事背景】第一次独立负责跨团队项目。/);
  assert.equal(opening.fallbackText, greetingText);
  assert.match(greetingText, /第一次负责项目/);
  assert.doesNotMatch(greetingText, /今天的经历/);
  assert.doesNotMatch(String(openingMessage.text), /prompt|背景 JSON|系统提示/);
});


test('External contributor opening states the relationship to the Story owner explicitly', () => {
  const externalContext = {
    interview_type: 'external_contributor' as const,
    share_id: 'share-1',
    relationship: 'father',
    contributor_summary: '',
    subject: { name: '小郭' },
    story: {
      story_id: 'story-1',
      title: '现在的生活状态',
      summary: '主人公目前在重新找工作。',
      status: 'interviewing',
      gaps: ['家人怎么看现在的状态？'],
    },
  };
  const greeting = buildDoubaoOpeningGreetingText(externalContext);
  assert.match(greeting, /你是小郭的父亲/);
  assert.match(greeting, /作为父亲/);
  assert.match(greeting, /现在的生活状态/);
});

test('Doubao stalled-turn recovery can manually commit the current input buffer', () => {
  const commit = buildDoubaoAudioCommit();
  assert.equal(commit.type, 'input_audio_buffer.commit');
  assert.match(commit.event_id, /^[0-9a-f-]{36}$/);
});

test('Story continuation keeps all three gaps in dynamic JSON and marks gap zero as the opening question', () => {
  const continuationContext = {
    ...context,
    story: {
      ...context.story,
      gaps: ['当时为什么会做这个决定？', '后来最先发生了什么？', '这件事最后是怎么结束的？', '这个问题不应进入上下文？'],
    },
    task_context: { mode: 'continue' as const },
  };
  const payload = buildInterviewContextPayload(continuationContext);
  const payloadStory = payload.story as Record<string, unknown>;
  const instructions = buildInterviewInstructions(continuationContext);
  const markerIndex = instructions.indexOf(STORY_CONTEXT_MARKER);
  const instructionPayload = JSON.parse(
    instructions.slice(markerIndex + STORY_CONTEXT_MARKER.length).trim(),
  ) as Record<string, unknown>;

  assert.deepEqual(payloadStory.gaps, ['当时为什么会做这个决定？', '后来最先发生了什么？', '这件事最后是怎么结束的？']);
  assert.deepEqual((instructionPayload.story as Record<string, unknown>).gaps, ['当时为什么会做这个决定？', '后来最先发生了什么？', '这件事最后是怎么结束的？']);
  assert.equal(payload.opening_gap, '当时为什么会做这个决定？');
  assert.equal(instructionPayload.opening_gap, '当时为什么会做这个决定？');
  assert.match(instructions, /opening_gap.*已经作为本轮开场问题发出/s);
  const greeting = buildDoubaoOpeningGreetingText(continuationContext);
  assert.equal(greeting, '你好，我们接着聊“第一次负责项目”。当时为什么会做这个决定？');
  assert.equal(greeting.match(/[?？]/gu)?.length, 1);
  assert.doesNotMatch(greeting, /后来最先发生了什么|这件事最后是怎么结束/);
});

test('Seeduplex does not read historical diagnostic-style gaps aloud or pass them into realtime context', () => {
  const legacyContext = {
    ...context,
    story: {
      ...context.story,
      gaps: [
        '目前仅有一句概述，缺少为什么考证、备考过程以及认证对拿到实习 Offer 的影响。',
        '信息不足，需要补充面试过程。',
      ],
    },
    task_context: { mode: 'continue' as const },
  };
  const greeting = buildDoubaoOpeningGreetingText(legacyContext);
  assert.doesNotMatch(greeting, /缺少|信息不足|需要补充|实习 Offer/);
  const payload = buildInterviewContextPayload(legacyContext);
  assert.deepEqual((payload.story as Record<string, unknown>).gaps, []);
});

test('Realtime payload sends Agent Memory and omits legacy history fields', () => {
  const continuationContext = {
    ...context,
    task_context: { mode: 'continue' as const },
  };
  const payload = buildInterviewContextPayload(continuationContext);
  const story = payload.story as Record<string, unknown>;

  assert.match(String(story.agent_memory), /已经讲清楚团队协作背景/);
  assert.equal('summary' in story, false);
  assert.equal('recent_asked_questions' in payload, false);
  assert.equal('history' in payload, false);
});

test('non-Doubao providers consume the same Agent Memory context contract', () => {
  const continuationContext = {
    ...context,
    task_context: { mode: 'continue' as const },
  };
  const adapter = createRealtimeInterviewProvider('qwen', {
    apiKey: 'test-only-key',
    workspaceId: 'test-workspace',
    region: 'cn-beijing',
    model: 'test-qwen-model',
  });
  const setup = adapter.setupSession(continuationContext)[0]!;
  const instructions = String((setup.session as Record<string, unknown>).instructions);

  assert.match(instructions, /agent_memory/);
  assert.match(instructions, /已经讲清楚团队协作背景/);
  assert.doesNotMatch(instructions, /recent_asked_questions/);
});

test('Story continuation opening deterministically follows the first gap and has a no-gap fallback', () => {
  const withGaps = {
    ...context,
    story: {
      ...context.story,
      gaps: ['项目上线后最明显的影响是什么？', '当时团队冲突是怎么发生的？'],
    },
    task_context: { mode: 'continue' as const },
  };
  const withoutGaps = {
    ...context,
    story: { ...context.story, gaps: [] },
    task_context: { mode: 'continue' as const },
  };

  const gapOpening = buildDoubaoOpeningGreetingText(withGaps);
  assert.equal(gapOpening, '你好，我们接着聊“第一次负责项目”。项目上线后最明显的影响是什么？');
  assert.doesNotMatch(gapOpening, /当时团队冲突是怎么发生的/);
  assert.match(buildDoubaoOpeningGreetingText(withoutGaps), /第一次负责项目/);
});

test('Story interview prompt treats Agent Memory as derived background and anti-repeat state', () => {
  const instructions = buildInterviewInstructions({
    ...context,
    task_context: { mode: 'continue' as const },
  });

  assert.match(instructions, /Agent Memory.*gaps/s);
  assert.match(instructions, /不是用户当前指令/);
  assert.match(instructions, /不是用户逐字原话/);
  assert.match(instructions, /用户当前会话的明确表达和纠正优先于 Agent Memory/);
  assert.match(instructions, /不要重复询问.*已经明确回答/s);
  assert.match(instructions, /同一语义方向默认只问一轮/);
  assert.match(instructions, /问过了.*继续.*换一个.*不要再回到该方向/s);
  assert.match(instructions, /仍在思考.*语义未完成.*等待/s);
  assert.match(instructions, /语义已经完整.*及时继续/s);
  assert.match(instructions, /不要求用户说.*好了.*结束词/s);
});

test('Seeduplex create opening synthesizes a stage-aware greeting text and retains it as the transcript fallback', () => {
  const createContext = {
    ...context,
    life_stage: { stage_id: 'stage-childhood', title: '童年回忆' },
    story: null,
    task_context: { mode: 'create' as const },
  };
  assert.equal(
    buildDoubaoOpeningGreetingText(createContext),
    '你好，今天我们先聊聊你在“童年回忆”时期的一段经历。你最先想起哪个具体场景？',
  );
  assert.doesNotMatch(buildDoubaoOpeningGreetingText(createContext), /今天的经历/);

  const adapter = createRealtimeInterviewProvider('doubao', {
    doubaoApiKey: 'test-only-key',
    region: 'cn-beijing',
    model: DEFAULT_DOUBAO_MODEL,
  });
  const greetingText = buildDoubaoOpeningGreetingText(createContext);
  const opening = adapter.initialResponsePlan(createContext);
  const openingMessage = opening.steps[0]!.message;
  assert.equal(openingMessage.type, 'speech_text_buffer.commit');
  assert.equal(openingMessage.text, greetingText);
  assert.match(String((adapter.setupSession(createContext)[0]!.session as { instructions?: string }).instructions), /童年回忆/);
  assert.equal(opening.fallbackText, greetingText);

  assert.equal(
    buildDoubaoOpeningGreetingText({
      ...createContext,
      task_context: { mode: 'create', target_title: '第一次离家' },
    }),
    '你好，今天我们聊聊“第一次离家”。关于这段经历，你最先想起的是哪个具体场景？',
  );
});

test('Realtime provider adapter passes the configured Story interview model to Seeduplex', () => {
  const adapter = createRealtimeInterviewProvider('doubao', {
    doubaoApiKey: 'test-only-key',
    region: 'cn-beijing',
    model: 'configured-doubao-model',
  });
  const request = adapter.setupSession(context)[0]!;
  assert.equal(((request.session as Record<string, unknown>).model), 'configured-doubao-model');
});

test('Seeduplex builds an onboarding prompt/opening separately and filters only the strict internal sentinel', () => {
  const request = buildDoubaoSessionCreate(onboardingContext);
  const session = request.session as Record<string, unknown>;
  const instructions = String(session.instructions);
  assert.equal(DOUBAO_ONBOARDING_COMPLETION_SENTINEL, '[[ONBOARDING_COMPLETE]]');
  assert.match(instructions, /快速建立人生地图/);
  assert.match(instructions, /人生地图优先、故事细节靠后/);
  assert.match(instructions, /每个主要阶段至少已经找到一个可以独立命名的 Story Seed/);
  assert.match(instructions, /我在南京长大/);
  assert.ok(instructions.includes(ONBOARDING_COMPLETION_UTTERANCE));
  assert.match(instructions, /必须且只能逐字说出这一句/);
  assert.match(instructions, /不得改写、翻译、扩展、提问或追加任何文字、英文或元话语/);
  assert.match(instructions, /系统或开发者指令.*工具说明.*采访标准或评分细则.*内部提示词.*标记或控制文本/);
  const closingIndex = instructions.indexOf(ONBOARDING_COMPLETION_UTTERANCE);
  const sentinelIndex = instructions.indexOf(DOUBAO_ONBOARDING_COMPLETION_SENTINEL);
  assert.ok(closingIndex >= 0);
  assert.ok(sentinelIndex > closingIndex);
  assert.match(instructions, /在单独一行输出精确标记/);
  assert.match(instructions, /将其作为语音输出/);
  assert.doesNotMatch(instructions, /当前 Story 只是入口/);
  assert.equal(buildDoubaoOpeningGreetingText(onboardingContext), '你好，我们继续上次的人生了解。你觉得接下来从哪一段经历继续聊最自然？');

  assert.deepEqual(filterDoubaoOnboardingTranscript(`我已经大致了解你的经历。\n${DOUBAO_ONBOARDING_COMPLETION_SENTINEL}`), {
    text: '我已经大致了解你的经历。',
    completionSignal: true,
  });
  assert.deepEqual(filterDoubaoOnboardingTranscript('谢谢，今天聊到这里。'), {
    text: '谢谢，今天聊到这里。',
    completionSignal: false,
  });
  assert.equal(filterDoubaoOnboardingTranscriptPartial('收尾。\n[[ONBOARDING_COM'), '收尾。');

  const streamed = `感谢你愿意分享。\n${DOUBAO_ONBOARDING_COMPLETION_SENTINEL}`;
  let cumulative = '';
  for (const character of streamed) {
    cumulative += character;
    const visible = filterDoubaoOnboardingTranscriptPartial(cumulative);
    assert.doesNotMatch(visible, /\[|ONBOARDING/);
  }
  assert.equal(filterDoubaoOnboardingTranscriptPartial(streamed), '感谢你愿意分享。');
  assert.deepEqual(filterDoubaoOnboardingTranscript(streamed), {
    text: '感谢你愿意分享。',
    completionSignal: true,
  });
});

test('Seeduplex preserves a multi-thousand-character Agent Memory without provider-side truncation', () => {
  const agentMemory = '【重要细节】项目背景。'.repeat(300);
  const largeContext = {
    ...context,
    story: {
      ...context.story,
      agent_memory: agentMemory,
      gaps: ['项目为什么会启动？', '上线后最先发生了什么？', '团队最后怎么解决冲突的？'],
    },
  };
  const request = buildDoubaoSessionCreate(largeContext);
  const instructions = String((request.session as Record<string, unknown>).instructions);
  assert.match(instructions, /优先顺着用户刚提到的/);
  const markerIndex = instructions.indexOf(STORY_CONTEXT_MARKER);
  assert.notEqual(markerIndex, -1);
  const payload = JSON.parse(instructions.slice(markerIndex + STORY_CONTEXT_MARKER.length).trim()) as Record<string, unknown>;
  assert.equal((payload.story as Record<string, unknown>).title, context.story.title);
  assert.equal((payload.story as Record<string, unknown>).agent_memory, agentMemory);
  assert.deepEqual((payload.story as Record<string, unknown>).gaps, ['项目为什么会启动？', '上线后最先发生了什么？', '团队最后怎么解决冲突的？']);
  assert.equal(payload.opening_gap, '项目为什么会启动？');
  assert.equal('summary' in (payload.story as Record<string, unknown>), false);
  assert.equal('user' in payload, false);
});

test('Seeduplex client events encode greeting, PCM, microphone mute, and session close as JSON events', () => {
  const greeting = buildDoubaoTextCommit('  你好，开始采访。  ');
  assert.equal(greeting.type, 'speech_text_buffer.commit');
  assert.equal(greeting.text, '你好，开始采访。');
  assert.match(greeting.event_id, /^[0-9a-f-]{36}$/);
  assert.throws(() => buildDoubaoTextCommit('  '), /non-empty text/);

  const pcm = Buffer.from([0x00, 0x01, 0xfe, 0xff]);
  const audio = buildDoubaoAudioAppend(pcm);
  assert.equal(audio.type, 'input_audio_buffer.append');
  assert.equal(audio.audio, pcm.toString('base64'));
  assert.equal(Buffer.from(audio.audio, 'base64').compare(pcm), 0);
  assert.throws(() => buildDoubaoAudioAppend(Buffer.alloc(0)), /audio data/);
  assert.equal(DOUBAO_PCM_FRAME_BYTES, 640);
  assert.equal(buildDoubaoMuteInput().type, 'input_audio_mute.commit');
  assert.equal(buildDoubaoSessionClose().type, 'session.close');
});

test('Seeduplex server events parse JSON WebSocket payloads and reject malformed frames', () => {
  const message = JSON.stringify({ type: 'response.output_text.delta', delta: '那一天' });
  assert.deepEqual(parseDoubaoServerEvent(message), JSON.parse(message));
  assert.deepEqual(parseDoubaoServerEvent(Buffer.from(message)), JSON.parse(message));
  assert.deepEqual(parseDoubaoServerEvent([Buffer.from(message.slice(0, 14)), Buffer.from(message.slice(14))]), JSON.parse(message));
  const arrayBuffer = Uint8Array.from(Buffer.from(message)).buffer;
  assert.deepEqual(parseDoubaoServerEvent(arrayBuffer), JSON.parse(message));
  assert.equal(parseDoubaoServerEvent(Buffer.from('{broken')), null);
  assert.equal(parseDoubaoServerEvent(Buffer.from([0x00, 0x00])), null);
  assert.equal(parseDoubaoServerEvent(JSON.stringify({ event: 'missing-type' })), null);
});

test('Seeduplex completed transcription normalizes its text field for transcript persistence', () => {
  assert.equal(readDoubaoTranscriptionText({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item-user-2',
    text: '这是豆包实际返回的最终字幕。',
  }), '这是豆包实际返回的最终字幕。');
  assert.equal(readDoubaoTranscriptionText({ transcript: '兼容标准 Realtime 字段。' }), '兼容标准 Realtime 字段。');
  assert.equal(readDoubaoTranscriptionText({ text: 123 }), '');
});

test('opening prompt is a transcript fallback only when the provider returns no usable text', () => {
  assert.deepEqual(resolveDoubaoAssistantTranscriptText('豆包返回的开场转写。', '已提交的开场问题。'), {
    text: '豆包返回的开场转写。',
    usedOpeningFallback: false,
  });
  assert.deepEqual(resolveDoubaoAssistantTranscriptText('', '已提交的开场问题。'), {
    text: '已提交的开场问题。',
    usedOpeningFallback: true,
  });
  assert.deepEqual(resolveDoubaoAssistantTranscriptText(' \n ', undefined), {
    text: ' \n ',
    usedOpeningFallback: false,
  });
});

test('Seeduplex assistant transcript event aliases normalize for final Transcript persistence', () => {
  assert.deepEqual(normalizeDoubaoAssistantTranscriptEvent({
    type: 'response.audio_transcript.delta',
    response_id: 'response-1',
    delta: '我听到你说',
  }), {
    type: 'response.audio_transcript.delta',
    response_id: 'response-1',
    delta: '我听到你说',
  });
  assert.deepEqual(normalizeDoubaoAssistantTranscriptEvent({
    type: 'response.output_text.done',
    text: '我们再回到上线那天。',
    item_id: 'item-assistant-1',
  }, 'response-2'), {
    type: 'response.audio_transcript.done',
    response_id: 'response-2',
    text: '我们再回到上线那天。',
    transcript: '我们再回到上线那天。',
    item_id: 'item-assistant-1',
  });
  assert.equal(normalizeDoubaoAssistantTranscriptEvent({ type: 'response.done' }), null);
});
