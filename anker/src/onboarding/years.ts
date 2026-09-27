/** Numeric year projected from current and legacy text columns without inferring approximate dates. */
export function yearFromStoredDate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const yearOnly = /^(\d{4})$/.exec(value);
  if (yearOnly) {
    const year = Number(yearOnly[1]);
    return year >= 1 && year <= 9999 ? year : null;
  }

  const exactDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!exactDate) return null;
  const year = Number(exactDate[1]);
  const month = Number(exactDate[2]);
  const day = Number(exactDate[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? year
    : null;
}

export function yearToStoredDate(value: number): string {
  return String(value).padStart(4, '0');
}

export function endYearFromStoredDate(value: unknown): number | 'now' | null {
  if (value === 'now') return 'now';
  return yearFromStoredDate(value);
}
