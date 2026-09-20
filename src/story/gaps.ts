export const MAX_STORY_GAPS = 3;
export const MAX_STORY_GAP_QUESTION_LENGTH = 80;

const DIAGNOSTIC_GAP_TEXT = /(?:缺少|信息不足|资料不足|需要补充|目前(?:仅有|只有)|当前(?:仅有|只有))/u;

/** New Completion output must be one direct interview question, not a diagnostic note. */
export function isStoryGapQuestion(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const gap = value.trim();
  if (!gap || gap.length > MAX_STORY_GAP_QUESTION_LENGTH || DIAGNOSTIC_GAP_TEXT.test(gap)) return false;
  const questionMarks = gap.match(/[?？]/gu) ?? [];
  return questionMarks.length === 1 && /[?？]$/u.test(gap);
}

/** Parse persisted Story gaps without exposing malformed raw JSON to API clients.
 * Historical diagnostic-style gaps remain readable until the next Completion refresh.
 */
export function parseStoryGaps(raw: string | null | undefined): string[] {
  if (raw == null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_STORY_GAPS
      || parsed.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
      console.error('[story-gaps] Invalid persisted gaps_json; returning an empty list.');
      return [];
    }
    return parsed.map((item: string) => item.trim());
  } catch {
    console.error('[story-gaps] Malformed persisted gaps_json; returning an empty list.');
    return [];
  }
}
