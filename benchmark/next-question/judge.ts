import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MODEL = 'step-5-preview';
const ENDPOINT = 'https://api.stepfun.com/step_plan/v1/chat/completions';
const MAX_ATTEMPTS = 3;
const CONCURRENCY = 2;
const SCORE_LIMITS = {
  information_gain: 30,
  context_use: 25,
  story_value: 20,
  depth: 15,
  non_leading: 10,
} as const;
const RESULT_KEYS = [
  'information_gain', 'context_use', 'story_value', 'depth', 'non_leading',
  'repeated_question', 'fact_misuse', 'leading_question', 'missed_high_value_clue', 'brief_reason',
] as const;
const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    information_gain: { type: 'integer', minimum: 0, maximum: 30 },
    context_use: { type: 'integer', minimum: 0, maximum: 25 },
    story_value: { type: 'integer', minimum: 0, maximum: 20 },
    depth: { type: 'integer', minimum: 0, maximum: 15 },
    non_leading: { type: 'integer', minimum: 0, maximum: 10 },
    repeated_question: { type: 'boolean' },
    fact_misuse: { type: 'boolean' },
    leading_question: { type: 'boolean' },
    missed_high_value_clue: { type: 'boolean' },
    brief_reason: { type: 'string' },
  },
  required: RESULT_KEYS,
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

function optionalPositiveIntegerArgument(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${name}.`);
  return value;
}

function parseJsonl<T>(pathname: string): T[] {
  if (!existsSync(pathname)) return [];
  return readFileSync(pathname, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as T);
}

function validScore(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function clipCharacters(value: string, maxChars: number): string {
  return Array.from(value.trim()).slice(0, maxChars).join('');
}

function validateResult(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'response must be an object';
  const result = value as Record<string, unknown>;
  const dimensions = Object.entries(SCORE_LIMITS);
  const keys = Object.keys(result);
  const missing = RESULT_KEYS.filter((key) => !Object.hasOwn(result, key));
  const extra = keys.filter((key) => !RESULT_KEYS.includes(key as (typeof RESULT_KEYS)[number]));
  if (missing.length || extra.length) return `keys mismatch; missing=${missing.join(',')}; additional=${extra.join(',')}`;
  const invalidScore = dimensions.find(([key, maximum]) => !validScore(result[key], maximum));
  if (invalidScore) return `${invalidScore[0]} must be an integer in 0..${invalidScore[1]}`;
  const invalidBoolean = ['repeated_question', 'fact_misuse', 'leading_question', 'missed_high_value_clue']
    .find((key) => typeof result[key] !== 'boolean');
  if (invalidBoolean) return `${invalidBoolean} must be boolean`;
  if (typeof result.brief_reason !== 'string' || !result.brief_reason.trim()) return 'brief_reason must be a non-empty string';
  return null;
}

function systemPrompt(): string {
  return [
    '你是人生采访下一问质量评审员。对当前这一条候选问题做独立、绝对评分，不与其他问题比较。',
    '只评“在给定上下文下，这是不是一个高质量的下一问”。不评价总结、写书、声音、ASR、TTS、延迟或系统实现。',
    '历史已知事实用于判断是否重复询问；时代背景是一般背景，不能当作受访者的个人经历、观点或事实。',
    '评分必须是整数：information_gain 0-30；context_use 0-25；story_value 0-20；depth 0-15；non_leading 0-10。',
    '高分要求：能获得新信息、利用上下文且不重复、抓住高价值线索、追问具体场景/人物/因果/情绪/判断/转折/意义，并且不诱导或虚构。',
    '标签必须是布尔值：repeated_question 表示重问已知事实；fact_misuse 表示把推测/时代背景当个人事实；leading_question 表示问题诱导或预设答案；missed_high_value_clue 表示忽略当前最值得追问的线索。',
    '只返回字段 information_gain、context_use、story_value、depth、non_leading、repeated_question、fact_misuse、leading_question、missed_high_value_clue、brief_reason。不要输出 total_score，系统会本地求和。brief_reason 用简短中文说明且非空；保存时超过160字符会截短。不要展示推理过程或输出 Markdown。',
  ].join('\n');
}

async function score(candidate: JudgeInput, apiKey: string, maxTokens: number): Promise<Record<string, unknown>> {
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
      max_tokens: maxTokens,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'next_question_judge', strict: true, schema: JUDGE_SCHEMA },
      },
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
      finish_reason: typeof finishReason === 'string' ? finishReason : null,
      max_output_tokens: maxTokens,
      error_code: typeof body.error?.code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/u.test(body.error.code) ? body.error.code : 'JUDGE_HTTP_ERROR',
    };
  }
  if (model !== MODEL || finishReason !== 'stop' || typeof content !== 'string') {
    return {
      status: 'failed', candidate_id: candidate.candidate_id, case_id: candidate.case_id,
      judge_model: MODEL, response_model: model, response_id: responseId,
      finish_reason: typeof finishReason === 'string' ? finishReason : null,
      max_output_tokens: maxTokens,
      error_code: finishReason === 'length' ? 'JUDGE_OUTPUT_TOKEN_LIMIT' : 'JUDGE_RESPONSE_INCOMPLETE',
    };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch {
    return {
      status: 'failed', candidate_id: candidate.candidate_id, case_id: candidate.case_id,
      judge_model: MODEL, response_id: responseId, finish_reason: finishReason,
      max_output_tokens: maxTokens, error_code: 'JUDGE_RESPONSE_INVALID_JSON', schema_validation_error: 'response body is not valid JSON',
    };
  }
  const schemaValidationError = validateResult(parsed);
  if (schemaValidationError) {
    return {
      status: 'failed', candidate_id: candidate.candidate_id, case_id: candidate.case_id,
      judge_model: MODEL, response_id: responseId, finish_reason: finishReason,
      max_output_tokens: maxTokens, error_code: 'JUDGE_RESPONSE_SCHEMA_INVALID', schema_validation_error: schemaValidationError,
    };
  }
  return {
    status: 'scored',
    candidate_id: candidate.candidate_id,
    case_id: candidate.case_id,
    judge_model: MODEL,
    temperature: 0,
    max_output_tokens: maxTokens,
    response_id: responseId,
    finish_reason: finishReason,
    ...parsed,
    total_score: Object.keys(SCORE_LIMITS).reduce((sum, key) => sum + Number(parsed[key]), 0),
    brief_reason: clipCharacters(parsed.brief_reason as string, 160),
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
  const existingRows = parseJsonl<{
    candidate_id?: string;
    status?: string;
    error_code?: string;
    http_status?: number;
    max_output_tokens?: number;
    retry_reason?: string;
  }>(outputPath);
  const attemptHistory = new Map<string, Array<{
    status?: string;
    error_code?: string;
    http_status?: number;
    max_output_tokens?: number;
    retry_reason?: string;
  }>>();
  for (const row of existingRows) {
    if (!row.candidate_id) continue;
    attemptHistory.set(row.candidate_id, [...(attemptHistory.get(row.candidate_id) ?? []), row]);
  }
  const retryable = (row: { error_code?: string; http_status?: number }) =>
    ['JUDGE_OUTPUT_TOKEN_LIMIT', 'JUDGE_RESPONSE_INCOMPLETE', 'JUDGE_RESPONSE_SCHEMA_INVALID', 'JUDGE_RESPONSE_INVALID_JSON', 'JUDGE_TIMEOUT', 'JUDGE_REQUEST_FAILED', 'JUDGE_RUN_INTERRUPTED'].includes(String(row.error_code))
    || (row.error_code === 'JUDGE_HTTP_ERROR' && Number(row.http_status) >= 500);
  const scored = new Set([...attemptHistory].filter(([, rows]) => rows.at(-1)?.status === 'scored').map(([id]) => id));
  if (!existsSync(outputPath)) writeFileSync(outputPath, '', { mode: 0o600 });
  let newCalls = 0;
  let nextIndex = 0;
  const retrySchemaInvalidOnce = process.argv.includes('--retry-schema-invalid-once');
  const retryLatestFailuresOnce = process.argv.includes('--retry-latest-failures-once');
  if (retrySchemaInvalidOnce && retryLatestFailuresOnce) throw new Error('Choose only one explicit retry mode.');
  const oneShotRetryReason = retrySchemaInvalidOnce
    ? 'USER_REQUESTED_SCHEMA_RETRY'
    : retryLatestFailuresOnce ? 'USER_REQUESTED_FAILURE_RETRY_ROUND_2' : undefined;
  const explicitRetryTargets = oneShotRetryReason ? candidates.filter((candidate) => {
    const history = attemptHistory.get(candidate.candidate_id) ?? [];
    const previous = history.at(-1);
    return previous?.status === 'failed'
      && (!retrySchemaInvalidOnce || previous.error_code === 'JUDGE_RESPONSE_SCHEMA_INVALID')
      && !history.some((row) => row.retry_reason === oneShotRetryReason);
  }) : [];
  const expectedRetryCount = optionalPositiveIntegerArgument('--expect-retry-count');
  if (expectedRetryCount !== undefined && explicitRetryTargets.length !== expectedRetryCount) {
    throw new Error(`Expected ${expectedRetryCount} explicit retry targets, found ${explicitRetryTargets.length}.`);
  }
  const explicitRetryIds = new Set(explicitRetryTargets.map((candidate) => candidate.candidate_id));
  const processCandidate = async (index: number): Promise<void> => {
    const candidate = candidates[index]!;
    const history = attemptHistory.get(candidate.candidate_id) ?? [];
    const previous = history.at(-1);
    if (oneShotRetryReason) {
      if (!explicitRetryIds.has(candidate.candidate_id) || !previous) return;
      const maxTokens = previous.max_output_tokens ?? 2_048;
      let result: Record<string, unknown>;
      try {
        result = await score(candidate, apiKey, maxTokens);
      } catch (error) {
        result = {
          status: 'failed', candidate_id: candidate.candidate_id, case_id: candidate.case_id,
          judge_model: MODEL, max_output_tokens: maxTokens,
          error_code: error instanceof Error && error.name === 'TimeoutError' ? 'JUDGE_TIMEOUT' : 'JUDGE_REQUEST_FAILED',
        };
      }
      result.judge_attempt = history.length + 1;
      result.attempt_count = history.length + 1;
      result.retry_reason = oneShotRetryReason;
      result.response_id ??= null;
      result.error_code ??= null;
      result.finish_reason ??= null;
      result.schema_validation_error ??= null;
      appendFileSync(outputPath, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600 });
      history.push({
        status: String(result.status),
        error_code: typeof result.error_code === 'string' ? result.error_code : undefined,
        http_status: typeof result.http_status === 'number' ? result.http_status : undefined,
        max_output_tokens: maxTokens,
        retry_reason: oneShotRetryReason,
      });
      attemptHistory.set(candidate.candidate_id, history);
      newCalls += 1;
      process.stdout.write(`${result.status === 'scored' ? 'SCORED' : 'JUDGE_FAILED'} ${index + 1}/${candidates.length} retry=${oneShotRetryReason} attempt=${history.length} ${candidate.case_id}\n`);
      return;
    }
    if (scored.has(candidate.candidate_id)) return;
    if (previous && (previous.status === 'scored' || !retryable(previous))) return;
    for (let attempt = history.length + 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const maxTokens = 2_048 * (2 ** (attempt - 1));
      let result: Record<string, unknown>;
      try {
        result = await score(candidate, apiKey, maxTokens);
      } catch (error) {
        result = {
          status: 'failed', candidate_id: candidate.candidate_id, case_id: candidate.case_id,
          judge_model: MODEL, max_output_tokens: maxTokens,
          error_code: error instanceof Error && error.name === 'TimeoutError' ? 'JUDGE_TIMEOUT' : 'JUDGE_REQUEST_FAILED',
        };
      }
      result.judge_attempt = attempt;
      result.attempt_count = attempt;
      result.retry_reason = attempt > 1 ? String(history.at(-1)?.error_code ?? 'RETRY') : null;
      result.response_id ??= null;
      result.error_code ??= null;
      result.finish_reason ??= null;
      result.schema_validation_error ??= null;
      appendFileSync(outputPath, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600 });
      history.push({
        status: String(result.status),
        error_code: typeof result.error_code === 'string' ? result.error_code : undefined,
        http_status: typeof result.http_status === 'number' ? result.http_status : undefined,
      });
      attemptHistory.set(candidate.candidate_id, history);
      newCalls += 1;
      process.stdout.write(`${result.status === 'scored' ? 'SCORED' : 'JUDGE_FAILED'} ${index + 1}/${candidates.length} attempt=${attempt} ${candidate.case_id}\n`);
      if (result.status === 'scored') {
        scored.add(candidate.candidate_id);
        break;
      }
      if (!retryable(result) || attempt === MAX_ATTEMPTS) break;
      process.stdout.write(`JUDGE_RETRY ${candidate.case_id} after ${String(result.error_code)}\n`);
    }
  };
  process.stdout.write(`Judge concurrency=${CONCURRENCY}${oneShotRetryReason ? `; explicit retry=${oneShotRetryReason}; targets=${explicitRetryTargets.length}` : ''}.\n`);
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= candidates.length) return;
      await processCandidate(index);
    }
  }));
  const latest = new Map<string, { status?: string }>();
  for (const row of parseJsonl<{ candidate_id?: string; status?: string }>(outputPath)) {
    if (row.candidate_id) latest.set(row.candidate_id, row);
  }
  const scoredCount = [...latest.values()].filter((row) => row.status === 'scored').length;
  process.stdout.write(`Judge recorded ${scoredCount}/${candidates.length} scored candidates at ${outputPath}; new calls=${newCalls}.\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`Judge stopped: ${error instanceof Error ? error.message : 'UNKNOWN_ERROR'}\n`);
  process.exitCode = 1;
});
