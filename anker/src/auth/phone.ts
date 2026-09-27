export class PhoneNormalizationError extends Error {
  constructor() {
    super('请输入有效的手机号，并包含国家码或中国大陆 11 位手机号。');
    this.name = 'PhoneNormalizationError';
  }
}

/** Store one canonical E.164-like representation; bare Chinese mobile numbers default to +86. */
export function normalizePhone(value: string): string {
  let normalized = value.trim().replace(/[\s().-]/g, '');
  if (!normalized) throw new PhoneNormalizationError();
  if (normalized.startsWith('00')) normalized = `+${normalized.slice(2)}`;
  if (/^1[3-9]\d{9}$/.test(normalized)) normalized = `+86${normalized}`;
  else if (/^86(1[3-9]\d{9})$/.test(normalized)) normalized = `+${normalized}`;
  else if (!normalized.startsWith('+')) throw new PhoneNormalizationError();

  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new PhoneNormalizationError();
  return normalized;
}

/** Demo login accepts any Mainland 11-digit number without carrier-prefix checks. */
export function normalizeDemoPhone(value: string): string {
  let compact = value.trim().replace(/[\s().-]/g, '');
  if (compact.startsWith('00')) compact = `+${compact.slice(2)}`;

  if (/^1\d{10}$/.test(compact)) return `+86${compact}`;
  const withChinaCode = /^(?:\+86|86)(1\d{10})$/.exec(compact);
  if (withChinaCode) return `+86${withChinaCode[1]}`;
  throw new PhoneNormalizationError();
}
