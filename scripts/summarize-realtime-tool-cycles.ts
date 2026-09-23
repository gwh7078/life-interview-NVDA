import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type TraceRow = Record<string, unknown>;

interface Percentiles {
  samples: number;
  p50: number | null;
  p95: number | null;
}

export interface RealtimeToolCycleSummary {
  terminalCycles: number;
  outcomeCounts: Record<string, number>;
  latencyMs: {
    completedCycle: Percentiles;
    slowRecall: Percentiles;
    responseBStart: Percentiles;
    responseBFirstAudio: Percentiles;
    responseBTotal: Percentiles;
  };
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? null;
}

function stats(values: number[]): Percentiles {
  return {
    samples: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  };
}

function metric(rows: TraceRow[], field: string, predicate: (row: TraceRow) => boolean = () => true): number[] {
  return rows.flatMap((row) => {
    const value = row[field];
    return predicate(row) && typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? [value]
      : [];
  });
}

export function summarizeRealtimeToolCycles(rows: TraceRow[]): RealtimeToolCycleSummary {
  const terminalRows = rows.filter((row) => row.event === 'realtime.tool_cycle_terminal');
  const outcomeCounts: Record<string, number> = {};
  for (const row of terminalRows) {
    const outcome = typeof row.outcome === 'string' ? row.outcome : 'unknown';
    outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;
  }
  return {
    terminalCycles: terminalRows.length,
    outcomeCounts,
    latencyMs: {
      completedCycle: stats(metric(terminalRows, 'toolCycleLatencyMs', (row) => row.outcome === 'completed')),
      slowRecall: stats(metric(terminalRows, 'slowRecallLatencyMs')),
      responseBStart: stats(metric(terminalRows, 'responseBLatencyMs')),
      responseBFirstAudio: stats(metric(terminalRows, 'responseBFirstAudioMs')),
      responseBTotal: stats(metric(terminalRows, 'responseBTotalMs')),
    },
  };
}

export async function readRealtimeToolTraceRows(inputPath: string): Promise<{ files: number; rows: TraceRow[] }> {
  const inputStat = await stat(inputPath);
  const files = inputStat.isDirectory()
    ? (await readdir(inputPath, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^[0-9a-f-]{36}\.jsonl$/i.test(entry.name))
      .map((entry) => path.join(inputPath, entry.name))
    : [inputPath];
  const rows: TraceRow[] = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    for (const [index, line] of content.split('\n').entries()) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          rows.push(value as TraceRow);
        }
      } catch {
        throw new Error(`Invalid JSON in ${file}:${index + 1}`);
      }
    }
  }
  return { files: files.length, rows };
}

async function main(): Promise<void> {
  const diagnosticsRoot = path.resolve(process.env.DIAGNOSTICS_DIR ?? 'runtime/diagnostics');
  const inputPath = path.resolve(process.argv[2] ?? path.join(diagnosticsRoot, 'traces/realtime'));
  const { files, rows } = await readRealtimeToolTraceRows(inputPath);
  process.stdout.write(`${JSON.stringify({
    traceFiles: files,
    ...summarizeRealtimeToolCycles(rows),
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Unable to summarize realtime tool cycles.'}\n`);
    process.exitCode = 1;
  });
}
