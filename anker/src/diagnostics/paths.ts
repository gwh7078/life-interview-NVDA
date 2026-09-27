import path from 'node:path';

export const DEFAULT_DIAGNOSTICS_ROOT = path.resolve('runtime/diagnostics');

export function resolveDiagnosticsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DIAGNOSTICS_DIR?.trim();
  return configured ? path.resolve(configured) : DEFAULT_DIAGNOSTICS_ROOT;
}

export function resolveDiagnosticsPath(...segments: string[]): string {
  return path.join(resolveDiagnosticsRoot(), ...segments);
}

export function assertPathInsideDiagnostics(targetPath: string): string {
  const root = resolveDiagnosticsRoot();
  const resolved = path.resolve(targetPath);
  const relative = path.relative(root, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return resolved;
  throw new Error(`Diagnostic artifact path must stay inside ${root}: ${resolved}`);
}
