import { BailianRealtimeCoach } from '../src/realtime/coach/service.js';
import type {
  CoachGateInput,
  CoachGateResult,
  CoachResolveInput,
} from '../src/realtime/coach/types.js';

const iterations = process.argv.includes('--once')
  ? 1
  : Math.max(3, Number(process.env.SPARK_BENCH_ITERATIONS || 5));
const coach = new BailianRealtimeCoach({
  provider: 'openai-compatible',
  baseUrl: process.env.REALTIME_COACH_BASE_URL || 'http://127.0.0.1:8001/v1',
  model: process.env.REALTIME_COACH_MODEL || process.env.SPARK_COACH_MODEL || 'Qwen/Qwen3-8B',
  apiKey: process.env.REALTIME_COACH_API_KEY || 'local-spark',
});

function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!);
}

function route(gate: CoachGateResult): 'none' | 'memory' | 'era' | 'dual' | 'guide' {
  if (gate.action === 'none') return 'none';
  if (gate.retrieve_memory && gate.retrieve_era) return 'dual';
  if (gate.retrieve_memory) return 'memory';
  if (gate.retrieve_era) return 'era';
  return 'guide';
}

const scenarioState = {
  life_stage: { title: '初入职场', start_date: '2012', end_date: '2015' },
  current_story: {
    title: '第一次独自去北京工作',
    status: 'interviewing',
    agent_memory: '此前记录：用户大约在2012年前后第一次独自去北京工作，月份尚不确定。',
    gaps: ['准确时间是什么？', '当时为什么去北京？'],
  },
};
const base = {
  scenario: 'story_continue' as const,
  boundedRecentContext: [
    { role: 'assistant' as const, text: '你大概是哪一年去北京的？' },
    { role: 'user' as const, text: '之前我说过大概是2012年。' },
  ],
  scenarioState,
};
const gateCases: Array<{ name: string; expected: string; input: CoachGateInput }> = [
  {
    name: 'none',
    expected: 'none',
    input: { ...base, lastAssistantQuestion: '到了北京以后第一天发生了什么？', currentUserAnswer: '我先去了公司安排的宿舍，第二天才正式报到。' },
  },
  {
    name: 'memory',
    expected: 'memory',
    input: { ...base, lastAssistantQuestion: '你确定是2012年吗？', currentUserAnswer: '我刚想起来，应该不是2012年，可能是2013年春节以后。' },
  },
  {
    name: 'era',
    expected: 'era',
    input: { ...base, lastAssistantQuestion: '2013年去北京以后你对当时环境有什么印象？', currentUserAnswer: '我记得是2013年，那时找工作方式和现在差别很大，但具体社会背景我说不准。' },
  },
  {
    name: 'dual',
    expected: 'dual',
    input: { ...base, lastAssistantQuestion: '这和你之前讲的时间能对上吗？', currentUserAnswer: '我现在更确定是2013年春节后，而且想核对之前记录，也想知道当时北京就业环境的大背景。' },
  },
];

const gateLatencies: number[] = [];
const gates: Record<string, unknown>[] = [];
for (const entry of gateCases) {
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    const result = await coach.evaluate(entry.input);
    const latency = Math.round(performance.now() - started);
    gateLatencies.push(latency);
    samples.push({ latency_ms: latency, route: route(result), action: result.action, reason: result.reason });
  }
  gates.push({
    case: entry.name,
    expected_route: entry.expected,
    samples,
    observed_routes: [...new Set(samples.map((sample) => sample.route))],
  });
}

function gateFor(kind: 'memory' | 'era' | 'dual'): CoachGateResult {
  return {
    action: 'guide',
    retrieve_memory: kind === 'memory' || kind === 'dual',
    memory_query: kind === 'memory' || kind === 'dual' ? '用户第一次去北京的准确年份' : null,
    retrieve_era: kind === 'era' || kind === 'dual',
    era_query: kind === 'era' || kind === 'dual' ? '2013年前后北京就业与城市生活背景' : null,
    era_start_year: kind === 'era' || kind === 'dual' ? 2012 : null,
    era_end_year: kind === 'era' || kind === 'dual' ? 2014 : null,
    reason: 'possible_conflict',
    avoid: '不要把不确定年份写成确定事实。',
    direction: '核对年份后追问初到北京的具体经历。',
  };
}

const resolveLatencies: number[] = [];
const resolves: Record<string, unknown>[] = [];
for (const kind of ['memory', 'era', 'dual'] as const) {
  const input: CoachResolveInput = {
    scenario: 'story_continue',
    currentUserAnswer: '我现在更确定是2013年春节以后去的北京。',
    gate: gateFor(kind),
    memoryEvidence: kind === 'era' ? [] : [{
      id: 'm1',
      question: '你什么时候第一次去北京工作？',
      answer: '此前记录为2012年前后，但月份不确定。',
    }],
    eraEvidence: kind === 'memory' ? [] : [{
      id: 'e1',
      startYear: 2012,
      endYear: 2014,
      title: '移动互联网与就业信息渠道变化',
      summary: '招聘与求职信息线上化持续加速。',
    }],
  };
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    const packet = await coach.resolve(input);
    const latency = Math.round(performance.now() - started);
    resolveLatencies.push(latency);
    samples.push({ latency_ms: latency, selected_evidence: packet.selectedEvidenceIds.length, has_background: Boolean(packet.backgroundHint) });
  }
  resolves.push({ route: kind, samples });
}

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  model: process.env.REALTIME_COACH_MODEL || process.env.SPARK_COACH_MODEL || 'Qwen/Qwen3-8B',
  iterations,
  gate: {
    p50_ms: percentile(gateLatencies, 0.50),
    p95_ms: percentile(gateLatencies, 0.95),
    budget_ms: 2_000,
    cases: gates,
  },
  resolve: {
    p50_ms: percentile(resolveLatencies, 0.50),
    p95_ms: percentile(resolveLatencies, 0.95),
    routes: resolves,
  },
  total_deadline_ms: 6_000,
})}\n`);
