import {
  ERA_CONTEXT_CATEGORIES,
  ERA_CONTEXT_DEFAULT_TOP_K,
  ERA_CONTEXT_MAX_TOP_K,
  ERA_CONTEXT_MAX_YEAR,
  ERA_CONTEXT_MIN_YEAR,
  type EraContextRecord,
  type EraContextSearchInput,
} from './types.js';

export class EraContextValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EraContextValidationError';
  }
}

const categorySet = new Set<string>(ERA_CONTEXT_CATEGORIES);

function integer(value: unknown, name: string): number {
  if (!Number.isInteger(value)) throw new EraContextValidationError(`${name} must be an integer.`);
  return value as number;
}

function year(value: unknown, name: string): number {
  const parsed = integer(value, name);
  if (parsed < ERA_CONTEXT_MIN_YEAR || parsed > ERA_CONTEXT_MAX_YEAR) {
    throw new EraContextValidationError(
      `${name} must be between ${ERA_CONTEXT_MIN_YEAR} and ${ERA_CONTEXT_MAX_YEAR}.`,
    );
  }
  return parsed;
}

function text(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string') throw new EraContextValidationError(`${name} must be a string.`);
  const result = value.trim();
  if (!result || result.length > maxLength) {
    throw new EraContextValidationError(`${name} must contain 1-${maxLength} characters.`);
  }
  return result;
}

export function validateEraContextRecord(value: unknown): EraContextRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EraContextValidationError('Era context record must be an object.');
  }
  const record = value as Record<string, unknown>;
  const startYear = year(record.start_year, 'start_year');
  const endYear = year(record.end_year, 'end_year');
  if (startYear > endYear) {
    throw new EraContextValidationError('start_year must not be after end_year.');
  }
  const category = text(record.category, 'category', 20);
  if (!categorySet.has(category)) {
    throw new EraContextValidationError(`Unsupported era context category: ${category}.`);
  }
  return {
    start_year: startYear,
    end_year: endYear,
    category: category as EraContextRecord['category'],
    title: text(record.title, 'title', 120),
    summary: text(record.summary, 'summary', 500),
  };
}

export function validateEraContextDataset(values: unknown[]): EraContextRecord[] {
  const records = values.map(validateEraContextRecord);
  const seen = new Set<string>();
  for (const record of records) {
    const key = JSON.stringify(record);
    if (seen.has(key)) throw new EraContextValidationError(`Duplicate era context record: ${record.title}.`);
    seen.add(key);
  }
  return records;
}

export function validateEraContextSearchInput(value: unknown): Required<Omit<EraContextSearchInput, 'signal'>>
  & Pick<EraContextSearchInput, 'signal'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EraContextValidationError('Era context search input must be an object.');
  }
  const input = value as Record<string, unknown>;
  const query = text(input.query, 'query', 500);
  const startYear = year(input.start_year, 'start_year');
  const endYear = year(input.end_year, 'end_year');
  if (startYear > endYear) {
    throw new EraContextValidationError('start_year must not be after end_year.');
  }
  const topK = input.top_k === undefined ? ERA_CONTEXT_DEFAULT_TOP_K : integer(input.top_k, 'top_k');
  if (topK < 1 || topK > ERA_CONTEXT_MAX_TOP_K) {
    throw new EraContextValidationError(`top_k must be between 1 and ${ERA_CONTEXT_MAX_TOP_K}.`);
  }
  return {
    query,
    start_year: startYear,
    end_year: endYear,
    top_k: topK,
    ...(input.signal instanceof AbortSignal ? { signal: input.signal } : {}),
  };
}

export function overlapsEraYears(record: Pick<EraContextRecord, 'start_year' | 'end_year'>, startYear: number, endYear: number): boolean {
  return record.start_year <= endYear && record.end_year >= startYear;
}
