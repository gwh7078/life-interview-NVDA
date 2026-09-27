import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveDiagnosticsPath } from './paths.js';

type DiagnosticField = string | number | boolean | null | undefined;

function safeScope(scope: string): string {
  const normalized = scope.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'app';
}

export function writeDiagnosticLog(
  scope: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  fields: Record<string, DiagnosticField> = {},
): void {
  try {
    const directory = resolveDiagnosticsPath('logs');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const safeFields: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      safeFields[key] = typeof value === 'string' ? value.slice(0, 500) : value;
    }
    const payload = {
      at: new Date().toISOString(),
      level,
      scope: safeScope(scope),
      message: message.slice(0, 500),
      ...safeFields,
    };
    appendFileSync(path.join(directory, `${safeScope(scope)}.jsonl`), `${JSON.stringify(payload)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // Diagnostics must never break the application path.
  }
}
