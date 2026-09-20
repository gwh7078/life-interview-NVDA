import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  assertPathInsideDiagnostics,
  resolveDiagnosticsPath,
  resolveDiagnosticsRoot,
} from '../src/diagnostics/paths.js';
import { writeDiagnosticLog } from '../src/diagnostics/logger.js';

const previousDiagnosticsDir = process.env.DIAGNOSTICS_DIR;
const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'life-interview-diagnostics-'));

after(() => {
  if (previousDiagnosticsDir === undefined) delete process.env.DIAGNOSTICS_DIR;
  else process.env.DIAGNOSTICS_DIR = previousDiagnosticsDir;
  rmSync(temporaryRoot, { recursive: true, force: true });
});

test('diagnostics root centralizes logs and rejects artifact paths outside the root', () => {
  process.env.DIAGNOSTICS_DIR = temporaryRoot;

  assert.equal(resolveDiagnosticsRoot(), temporaryRoot);
  assert.equal(resolveDiagnosticsPath('traces', 'realtime'), path.join(temporaryRoot, 'traces', 'realtime'));
  assert.equal(
    assertPathInsideDiagnostics(path.join(temporaryRoot, 'captures', 'request.json')),
    path.join(temporaryRoot, 'captures', 'request.json'),
  );
  assert.throws(
    () => assertPathInsideDiagnostics(path.resolve(temporaryRoot, '..', 'outside.json')),
    /must stay inside/,
  );

  writeDiagnosticLog('server', 'info', 'test diagnostic event', { status: 'ok', count: 1 });
  const logPath = path.join(temporaryRoot, 'logs', 'server.jsonl');
  assert.equal(existsSync(logPath), true);
  const line = readFileSync(logPath, 'utf8').trim();
  const entry = JSON.parse(line) as Record<string, unknown>;
  assert.equal(entry.scope, 'server');
  assert.equal(entry.level, 'info');
  assert.equal(entry.status, 'ok');
  assert.equal(entry.count, 1);
});
