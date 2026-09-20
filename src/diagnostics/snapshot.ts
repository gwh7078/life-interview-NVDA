import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveDiagnosticsPath } from './paths.js';

function safeSegment(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'unknown';
}

function timestampForFile(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function diagnosticsContentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DIAGNOSTICS_CAPTURE_CONTENT?.trim() === '1';
}

export function writeDiagnosticSnapshot(
  scope: string,
  id: string,
  payload: Record<string, unknown>,
): string | undefined {
  try {
    const directory = resolveDiagnosticsPath('snapshots', safeSegment(scope));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filePath = path.join(directory, `${timestampForFile()}-${safeSegment(id)}.json`);
    writeFileSync(filePath, `${JSON.stringify({
      captured_at: new Date().toISOString(),
      scope: safeSegment(scope),
      id,
      ...payload,
    }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return filePath;
  } catch {
    // Diagnostics must never break application behavior.
    return undefined;
  }
}
