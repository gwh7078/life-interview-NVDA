import { StoryCompletionValidationError } from './errors.js';
import { MAX_STORY_GAPS, isStoryGapQuestion } from '../gaps.js';
import type { StoryCompletionOutput, StoryCompletionStatus } from './types.js';

const VALID_STATUSES = new Set<StoryCompletionStatus>(['pending', 'interviewing', 'complete']);
const ALLOWED_KEYS = new Set(['status', 'gaps']);

function invalid(message: string, path?: string): never {
  throw new StoryCompletionValidationError(message, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Enforces the model contract in addition to the provider's structured-output schema. */
export class StoryCompletionValidator {
  validate(candidate: unknown): StoryCompletionOutput {
    if (!isRecord(candidate)) invalid('输出必须是 JSON 对象。');

    const keys = Reflect.ownKeys(candidate);
    if (keys.some((key) => typeof key !== 'string' || !ALLOWED_KEYS.has(key))) {
      invalid('输出包含 Schema 未定义的字段。');
    }
    if (!Object.hasOwn(candidate, 'status')) invalid('缺少 status。', 'status');
    if (!Object.hasOwn(candidate, 'gaps')) invalid('缺少 gaps。', 'gaps');

    const status = candidate.status;
    if (typeof status !== 'string' || !VALID_STATUSES.has(status as StoryCompletionStatus)) {
      invalid('status 必须是 pending、interviewing 或 complete。', 'status');
    }

    const gaps = candidate.gaps;
    if (!Array.isArray(gaps)) invalid('gaps 必须是数组。', 'gaps');
    if (gaps.length > MAX_STORY_GAPS) invalid('gaps 最多只能有 3 条。', 'gaps');

    const normalizedGaps = gaps.map((gap, index) => {
      if (typeof gap !== 'string') invalid('每条 gap 必须是字符串。', `gaps[${index}]`);
      const normalized = gap.trim();
      if (!normalized) invalid('每条 gap 去除首尾空白后不能为空。', `gaps[${index}]`);
      if (!isStoryGapQuestion(normalized)) {
        invalid('每条 gap 必须是单一、可直接问用户的问题，以问号结尾且最多 80 个字符；不能是“缺少/信息不足/需要补充”类诊断说明。', `gaps[${index}]`);
      }
      return normalized;
    });

    return { status: status as StoryCompletionStatus, gaps: normalizedGaps };
  }
}
