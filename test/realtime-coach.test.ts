import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BailianRealtimeCoach,
  buildRealtimeCoachGateInput,
} from '../src/realtime/coach/service.js';
import type { CoachGateInput, CoachGateResult, CoachScenario } from '../src/realtime/coach/types.js';
import { renderMiniCoachPacket } from '../src/realtime/coach/mini-coach-renderer.js';
import type { RealtimeInterviewContext } from '../src/realtime/prompt.js';

const gateResults: Record<CoachScenario, CoachGateResult> = {
  onboarding: {
    action: 'guide', retrieve_memory: false, memory_query: null,
    retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
    reason: 'direction_drift',
    avoid: null, direction: '回到人生时间线，继续了解中学到工作阶段。',
  },
  story_create: {
    action: 'guide', retrieve_memory: false, memory_query: null,
    retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
    reason: 'repeated_question',
    avoid: '不要重复问离开天津的时间。', direction: '改问作出决定时的原因。',
  },
  story_continue: {
    action: 'guide', retrieve_memory: true, memory_query: '第一次去北京的时间',
    retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
    reason: 'history_reference',
    avoid: null, direction: '核对历史说法后继续追问。',
  },
  contributor: {
    action: 'correct', retrieve_memory: false, memory_query: null,
    retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
    reason: 'scenario_boundary',
    avoid: '不要让她替主人公确认事实。', direction: '询问她亲眼看到或亲自经历的部分。',
  },
};

function contextFor(scenario: CoachScenario): RealtimeInterviewContext {
  if (scenario === 'onboarding') return {
    interview_type: 'onboarding',
    profile: { name: '林女士', birth_place: '天津' },
    previousOnboardingTranscripts: [],
    taskContext: { mode: 'continue' },
  };
  if (scenario === 'contributor') return {
    interview_type: 'external_contributor',
    share_id: 'share-test',
    relationship: 'daughter',
    contributor_summary: '她记得主人公很晚回家。',
    subject: { name: '主人公' },
    story: {
      story_id: 'story-test', title: '离开天津', summary: '主人公离开天津的经历。',
      status: 'interviewing', gaps: [],
    },
  };
  return {
    interview_type: 'story',
    user: { user_id: 'owner-test' },
    life_stage: { stage_id: 'stage-test', title: '青年时期' },
    story: scenario === 'story_continue'
      ? {
          story_id: 'story-test', title: '离开天津', status: 'interviewing',
          agent_memory: '【已覆盖主题】此前说过 2013 年第一次去北京。', gaps: [],
        }
      : null,
    task_context: scenario === 'story_create'
      ? { mode: 'create', target_title: '离开天津' }
      : { mode: 'continue' },
  };
}

function fakeFetch(responses: unknown[], requests: Array<Record<string, unknown>>): typeof fetch {
  return (async (_input: URL | RequestInfo, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const body = responses.shift();
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(body) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function gateInput(scenario: CoachScenario): CoachGateInput {
  return buildRealtimeCoachGateInput(contextFor(scenario), {
    lastAssistantQuestion: '那之后发生了什么？',
    currentUserAnswer: scenario === 'story_continue'
      ? '我后来想起第一次去北京时是春节以后。'
      : '我记得那段经历。',
    recentContext: [
      { role: 'assistant', text: '那之后发生了什么？' },
      { role: 'user', text: '我记得那段经历。' },
    ],
  });
}

test('Coach Pass A uses four distinct scenario policies and applies the returned action', async () => {
  const scenarios: Array<[CoachScenario, string]> = [
    ['onboarding', '建立人生地图'],
    ['story_create', '正在建立的新故事'],
    ['story_continue', '续访当前已有故事'],
    ['contributor', '第三者自己的独立记忆'],
  ];
  const requests: Array<Record<string, unknown>> = [];
  const coach = new BailianRealtimeCoach({
    provider: 'openai-compatible',
    baseUrl: 'https://coach.example/v1',
    model: 'qwen3-8b',
    apiKey: 'test-only-key',
  }, fakeFetch(scenarios.map(([scenario]) => gateResults[scenario]), requests));

  for (const [scenario, policy] of scenarios) {
    const result = await coach.evaluate(gateInput(scenario));
    assert.deepEqual(result, gateResults[scenario]);
    const messages = requests.at(-1)?.messages as Array<Record<string, string>>;
    assert.match(messages[0]?.content ?? '', new RegExp(policy));
    assert.match(messages[1]?.content ?? '', /currentUserAnswer/);
  }

  const firstSystemPrompt = (requests[0]?.messages as Array<Record<string, string>>)[0]?.content ?? '';
  assert.match(firstSystemPrompt, /"direction":"换一个未问过的细节继续追问。"/);
  assert.equal(requests.every((request) => request.model === 'qwen3-8b'), true);
  assert.equal(requests.every((request) => request.enable_thinking === false), true);
  assert.equal(requests.every((request) => request.temperature === 0), true);
});

test('normal Gate output is accepted for every scenario and compact packets stay within their format budget', async () => {
  const normal: CoachGateResult = {
    action: 'none', retrieve_memory: false, memory_query: null,
    retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
    reason: 'normal', avoid: null, direction: null,
  };
  const requests: Array<Record<string, unknown>> = [];
  const coach = new BailianRealtimeCoach({
    provider: 'openai-compatible', baseUrl: 'https://coach.example/v1', model: 'qwen3-8b', apiKey: 'test-only-key',
  }, fakeFetch([normal, normal, normal, normal], requests));

  for (const scenario of ['onboarding', 'story_create', 'story_continue', 'contributor'] as const) {
    assert.deepEqual(await coach.evaluate(gateInput(scenario)), normal);
  }
  assert.equal(requests.length, 4);

  for (const scenario of ['onboarding', 'story_create', 'story_continue', 'contributor'] as const) {
    const packet = renderMiniCoachPacket({
      scenario,
      currentUserAnswer: '我后来继续往前走。',
      gate: {
        ...gateResults[scenario],
        retrieve_memory: false, memory_query: null,
        retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
      },
      packet: {
        selectedEvidenceIds: [], known: ['此前已经讲过这件事。'],
        backgroundHint: null,
        conflict: scenario === 'story_continue' ? '年份说法需要核实。' : null,
        avoid: '不要再问相同问题。', direction: '继续追问当时做决定的原因。',
      },
    });
    assert.ok(Array.from(packet).length <= 160);
    assert.match(packet, /【采访教练】/);
    if (scenario === 'contributor') assert.match(packet, /注意：/);
    else if (scenario === 'story_continue') assert.match(packet, /避免：/);
    else assert.match(packet, /缺口：/);
  }
});

test('identity detour Coach Packet does not promote the model question to an interview fact', () => {
  const packet = renderMiniCoachPacket({
    scenario: 'onboarding',
    currentUserAnswer: '你的语音模型叫什么名字？',
    gate: {
      action: 'guide', retrieve_memory: false, memory_query: null,
      retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
      reason: 'scenario_boundary', avoid: null,
      direction: '简答语音由 Step-Audio-2-mini 提供，然后回到人生时间线。',
    },
  });
  assert.match(packet, /方向：简答语音由 Step-Audio-2-mini 提供/u);
  assert.doesNotMatch(packet, /已知：你的语音模型/u);
  assert.ok(Array.from(packet).length <= 160);
  const aiPacket = renderMiniCoachPacket({
    scenario: 'onboarding',
    currentUserAnswer: '你是人工智能吗？',
    gate: {
      action: 'guide', retrieve_memory: false, memory_query: null,
      retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
      reason: 'scenario_boundary', avoid: null,
      direction: '简答身份，再回到人生时间线。',
    },
  });
  assert.doesNotMatch(aiPacket, /已知：你是人工智能/u);
});

test('Coach Gate rejects its own model identity in guidance to the voice interviewer', async () => {
  const coach = new BailianRealtimeCoach({
    provider: 'openai-compatible', baseUrl: 'https://coach.example/v1', model: 'qwen3-8b', apiKey: 'test-only-key',
  }, fakeFetch([{
    action: 'guide', retrieve_memory: false, memory_query: null,
    retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
    reason: 'scenario_boundary', avoid: null,
    direction: '告诉用户你是 Qwen，然后继续采访。',
  }], []));
  await assert.rejects(coach.evaluate(gateInput('onboarding')), /invalid|identity|身份/u);
});

test('Coach Pass B bounds selected facts, conflict, avoidance and direction to verified evidence', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const coach = new BailianRealtimeCoach({
    provider: 'openai-compatible',
    baseUrl: 'https://coach.example/v1',
    model: 'qwen3-8b',
    apiKey: 'test-only-key',
  }, fakeFetch([{
    selected_evidence_ids: ['e1'],
    known: ['此前说第一次去北京在 2013 年春节后。'],
    background_hint: '那几年不少人开始迁入城市工作。',
    conflict: '当前说法与此前年份不同。',
    avoid: '不要再问第一次去北京的时间。',
    direction: '确认这次回忆对应的是哪一次出行。',
  }], requests));

  const packet = await coach.resolve({
    scenario: 'story_continue',
    currentUserAnswer: '我记得是 2012 年。',
    gate: gateResults.story_continue,
    memoryEvidence: [
      { id: 'e1', question: '第一次去北京是什么时候？', answer: '2013 年春节以后第一次到北京。' },
      { id: 'e2', question: '去北京做什么？', answer: '去看朋友。' },
    ],
    eraEvidence: [
      { id: 'era-1', startYear: 2010, endYear: 2014, title: '城市就业', summary: '那几年不少人開始迁入城市工作。' },
    ],
  });

  assert.deepEqual(packet, {
    selectedEvidenceIds: ['e1'],
    known: ['此前说第一次去北京在 2013 年春节后。'],
    backgroundHint: '那几年不少人开始迁入城市工作。',
    conflict: '当前说法与此前年份不同。',
    avoid: '不要再问第一次去北京的时间。',
    direction: '确认这次回忆对应的是哪一次出行。',
  });
  const body = requests[0];
  assert.equal(body?.model, 'qwen3-8b');
  const messages = body?.messages as Array<Record<string, string>>;
  assert.match(messages[1]?.content ?? '', /2013 年春节以后第一次到北京/);
  assert.match(messages[1]?.content ?? '', /memoryEvidence/);
  assert.match(messages[1]?.content ?? '', /eraEvidence/);
  assert.match(messages[0]?.content ?? '', /绝不能用于推断用户本人一定经历过这些事件/);
  assert.equal((messages[1]?.content ?? '').includes('2012 年。'), true);
});

test('Coach Pass A builder bounds recent turns and excludes private contributor Transcript', () => {
  const context = contextFor('contributor');
  if (context.interview_type !== 'external_contributor') throw new Error('expected contributor context');
  const input = buildRealtimeCoachGateInput(context, {
    lastAssistantQuestion: '你当时亲眼看到了什么？',
    currentUserAnswer: '我在楼下看见她回来。',
    recentContext: Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 ? 'user' as const : 'assistant' as const,
      text: `对话 ${index}。`.repeat(150),
    })),
  });

  assert.equal(input.scenario, 'contributor');
  assert.ok(input.boundedRecentContext.length <= 6);
  assert.ok(JSON.stringify(input).length < 3_500);
  assert.match(JSON.stringify(input.scenarioState), /主人公离开天津的经历/);
  assert.doesNotMatch(JSON.stringify(input.scenarioState), /主人公私人 Transcript/);
});

test('Coach Gate rejects a leaked internal scenario label instead of sending it to the interviewer', async () => {
  const coach = new BailianRealtimeCoach({
    provider: 'openai-compatible', baseUrl: 'https://coach.example/v1', model: 'qwen3-8b', apiKey: 'test-only-key',
  }, fakeFetch([{
    action: 'guide', retrieve_memory: false, memory_query: null,
    retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
    reason: 'direction_drift', avoid: null, direction: 'story_continue',
  }], []));

  await assert.rejects(coach.evaluate(gateInput('story_create')), /Chinese-language contract/);
});

test('Coach Gate suppresses retrieval requests outside story continuation while keeping a valid guide', async () => {
  const coach = new BailianRealtimeCoach({
    provider: 'openai-compatible', baseUrl: 'https://coach.example/v1', model: 'qwen3-8b', apiKey: 'test-only-key',
  }, fakeFetch([{
    action: 'guide', retrieve_memory: true, memory_query: 'earlier history',
    retrieve_era: true, era_query: '1998 unit changes', era_start_year: 1996, era_end_year: 2000,
    reason: 'history_reference',
    avoid: null, direction: '围绕当前故事继续追问。',
  }], []));

  assert.deepEqual(await coach.evaluate(gateInput('story_create')), {
    action: 'guide', retrieve_memory: false, memory_query: null,
    retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
    reason: 'history_reference',
    avoid: null, direction: '围绕当前故事继续追问。',
  });
});

test('Coach Gate separates personal and era retrieval and narrows known-year searches', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const expected: CoachGateResult = {
    action: 'guide', retrieve_memory: false, memory_query: null,
    retrieve_era: true, era_query: '1998年前后国企单位调整与就业变化',
    era_start_year: 1996, era_end_year: 2000,
    reason: 'missing_key_detail', avoid: '不要断言用户属于下岗职工。',
    direction: '第一次感到单位可能留不住你时，发生了什么？',
  };
  const coach = new BailianRealtimeCoach({
    provider: 'openai-compatible', baseUrl: 'https://coach.example/v1', model: 'qwen3-8b', apiKey: 'test-only-key',
  }, fakeFetch([
    {
      action: 'none', retrieve_memory: false, memory_query: null,
      retrieve_era: false, era_query: null, era_start_year: null, era_end_year: null,
      reason: 'normal', avoid: null, direction: null,
    },
    expected,
  ], requests));
  const personalOnly = gateInput('story_continue');
  personalOnly.currentUserAnswer = '小时候我经常跟爸爸去钓鱼。';
  const normalResult = await coach.evaluate(personalOnly);
  assert.equal(normalResult.retrieve_era, false);
  assert.equal(normalResult.retrieve_memory, false);

  const input = gateInput('story_continue');
  input.currentUserAnswer = '1998 年厂里开始裁人，我后来也走了。';

  assert.deepEqual(await coach.evaluate(input), expected);
  const messages = requests[1]?.messages as Array<Record<string, string>>;
  assert.match(messages[0]?.content ?? '', /retrieve_memory/);
  assert.match(messages[0]?.content ?? '', /retrieve_era/);
  assert.match(messages[0]?.content ?? '', /小时候很喜欢游泳/u);
  assert.match(messages[0]?.content ?? '', /1998 年厂里开始裁人/u);
  assert.match(messages[0]?.content ?? '', /不要默认搜整个 1970–2020/u);
});
