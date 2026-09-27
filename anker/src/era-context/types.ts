export const ERA_CONTEXT_MIN_YEAR = 1970;
export const ERA_CONTEXT_MAX_YEAR = 2020;
export const ERA_CONTEXT_DEFAULT_TOP_K = 5;
export const ERA_CONTEXT_MAX_TOP_K = 5;

export const ERA_CONTEXT_CATEGORIES = Object.freeze([
  '社会',
  '时事',
  '音乐',
  '影视',
  '娱乐',
  '体育',
  '科技',
  '互联网',
  '消费',
  '教育',
  '工作就业',
  '日常生活方式',
]);

export type EraContextCategory = typeof ERA_CONTEXT_CATEGORIES[number];

export interface EraContextRecord {
  start_year: number;
  end_year: number;
  category: EraContextCategory;
  title: string;
  summary: string;
}

export interface EraContextSearchInput {
  query: string;
  start_year: number;
  end_year: number;
  top_k?: number;
  signal?: AbortSignal;
}

export interface EraContextMatch extends EraContextRecord {
  score: number;
}

export interface EraContextAdapter {
  search(input: EraContextSearchInput): Promise<EraContextMatch[]>;
}
