import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MODEL = 'step-5-preview';
const ENDPOINT = 'https://api.stepfun.com/v1/chat/completions';
const SCORE_LIMITS = {
  information_gain: 30,
  context_use: 25,
  story_value: 20,
  depth: 15,
  non_leading: 10,
} as const;

interface JudgeInput {
  case_id: string;
  candidate_id: string;
  previous_question: string;
  user_answer: string;
  known_context: Record<string, unknown>;
  historical_known_facts: string[];
  next_question: string;
}

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name}.`);
  return value;
}

function parseJsonl<T>(pathname: string): T[] {
  if (!existsSync(pathname)) return [];
  return readFileSync(pathname, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as T);
}

function validScore(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function validResult(value: unknown): value is {
  information_gain: number;
  context_use: number;
  story_value: number;
  depth: number;
  non_leading: number;
  total_score: number;
  repeated_question: boolean;
  fact_misuse: boolean;
  leading_question: boolean;
  missed_high_value_clue: boolean;
  brief_reason: string;
} {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  const dimensions = Object.entries(SCORE_LIMITS);
  if (!dimensions.every(([key, maximum]) => validScore(result[key], maximum))) return false;
  const total = dimensions.reduce((sum, [key]) => sum + Number(result[key]), 0);
  return result.total_score === total
    && ['repeated_question', 'fact_misuse', 'leading_question', 'missed_high_value_clue']
      .every((key) => typeof result[key] === 'boolean')
    && typeof result.brief_reason === 'string'
    && result.brief_reason.trim().length > 0
    && result.brief_reason.length <= 500;
}

function systemPrompt(): string {
  return [
    '你是人生采访下一问质量评审员。对当前这一条候选问题做独立、绝对评分，不与其他问题比较。',
    '只评“在给定上下文下，这是不是一个高质量的下一问”。不评价总结、写书、声音、ASR、TTS、延迟或系统实现。',
    '历史已知事实用于判断是否重复询问；时代背景是一般背景，不能当作受访者的个人经历、观点或事实。',
    '评分必须是整数：information_gain 0-30；context_use 0-25；story_value 0-20；depth 0-15；non_leading 0-10。',
    'total_score 必须等于五项之和。高分要求：能获得新信息、利用上下文且不重复、抓住高价值线索、追问具体场景/人物/因果/情绪/判断/转折/意义，并且不诱导或虚构。',
    '标签必须是布尔值：repeated_question 表示重问已知事实；fact_misuse 表示把推测/时代背景当个人事实；leading_question 表示问题诱导或预设答案；missed_high_value_clue 表示忽略当前最值得追问的线索。',
    '输出且只输出 JSON object，不要 Markdown。结构：',
    '{"information_gain":0,"context_use":0,"story_value":0,"depth":0,"non_leading":0,"total_score":0,"repeated_question":false,"fact_misuse":false,"leading_question":false,"missed_high_value_clue":false,"brief_reason":"简短理由"}',
  ].join('\n');
}

async function score(candidate: JudgeInput, apiKey: string): Promise<Record<string, unknown>> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: JSON.stringify({
          case_id: candidate.case_id,
          previous_question: candidate.previous_question,
          user_answer: candidate.user_answer,
          known_context: candidate.known_context,
          historical_known_facts: candidate.historical_known_facts,
          candidate_next_question: candidate.next_question,
        }) },
      ],
      temperature: 0,
      max_tokens: 500,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json().catch(() => ({})) as {
    model?: unknown;
    id?: unknown;
    choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }>;
    error?: { code?: unknown };
  };
  const model = typeof body.model === 'string' ? body.model : null;
  const responseId = typeof body.id === 'string' ? body.id : null;
  const finishReason = body.choices?.[0]?.finish_reason;
  const content = body.choices?.[0]?.message?.content;
  if (!response.ok) {
    return {
      status: 'failed', candidate_id: candidate.candidate_id, case_id: candidate.case_id,
      judge_model: MODEL, http_status: response.status,
      error_code: typeof body.error?.code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/u.test(body.error.code) ? body.error.code : 'JUDGE_HTTP_ERROR',
    };
  }
  if (model !== MODEL || finishReason !== 'stop' || typeof content !== 'string') {
    return {
      status: 'failed', candidate_id: candidate.candidate_id, case_id: candidate.case_id,
      judge_model: MODEL, response_model: model, response_id: responseId,
      error_code: 'JUDGE_RESPONSE_INCOMPLETE',
    };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch {
    return {
      status: 'failed', candidate_id: candidate.candidate_id, case_id: candidate.case_id,
      judge_model: MODEL, response_id: responseId, error_code: 'JUDGE_RESPONSE_INVALID_JSON',
    };
  }
  if (!validResult(parsed)) {
    return {
      status: 'failed', candidate_id: candidate.candidate_id, case_id: candidate.case_id,
      judge_model: MODEL, response_id: responseId, error_code: 'JUDGE_RESPONSE_SCHEMA_INVALID',
    };
  }
  return {
    status: 'scored',
    candidate_id: candidate.candidate_id,
    case_id: candidate.case_id,
    judge_model: MODEL,
    temperature: 0,
    response_id: responseId,
    finish_reason: finishReason,
    ...parsed,
  };
}

async function main(): Promise<void> {
  const directory = path.resolve(requiredArgument('--result-dir'));
  const inputPath = path.join(directory, 'judge.jsonl');
  const outputPath = path.join(directory, 'judge-results.jsonl');
  const apiKey = process.env.STEPFUN_API_KEY?.trim();
  if (!apiKey) throw new Error('STEPFUN_API_KEY is not configured for the Step 5 Preview Judge.');
  const candidates = parseJsonl<JudgeInput>(inputPath);
  if (candidates.length === 0) throw new Error('judge.jsonl has no candidates.');
  const existingRows = parseJsonl<{ candidate_id?: string }>(outputPath);
  const completed = new Set(existingRows.map((row) => row.candidate_id).filter((id): id is string => Boolean(id)));
  if (!existsSync(outputPath)) writeFileSync(outputPath, '', { mode: 0o600 });
  let judged = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    if (completed.has(candidate.candidate_id)) continue;
    let result: Record<string, unknown>;
    try {
      result = await score(candidate, apiKey);
    } catch (error) {
      result = {
        status: 'failed', candidate_id: candidate.candidate_id, case_id: candidate.case_id,
        judge_model: MODEL,
        error_code: error instanceof Error && error.name === 'TimeoutError' ? 'JUDGE_TIMEOUT' : 'JUDGE_REQUEST_FAILED',
      };
    }
    appendFileSync(outputPath, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600 });
    completed.add(candidate.candidate_id);
    judged += 1;
    process.stdout.write(`${result.status === 'scored' ? 'SCORED' : 'JUDGE_FAILED'} ${index + 1}/${candidates.length} ${candidate.case_id} ${candidate.candidate_id}\n`);
  }
  process.stdout.write(`Judge recorded ${completed.size}/${candidates.length} candidates at ${outputPath}; new calls=${judged}.\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`Judge stopped: ${error instanceof Error ? error.message : 'UNKNOWN_ERROR'}\n`);
  process.exitCode = 1;
});
