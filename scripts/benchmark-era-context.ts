import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createEraContextClientFromEnv } from '../src/era-context/client.js';
import type { EraContextMatch } from '../src/era-context/types.js';

interface Fixture {
  query: string;
  start_year: number;
  end_year: number;
  expected_titles: string[];
}

const root = path.resolve(import.meta.dirname, '..');
const fixturesPath = process.argv[2] ?? path.join(root, 'data/era-context/benchmark-fixtures.jsonl');
const reportRoot = path.join(root, 'docs/07-reports/era-context');
const jsonPath = path.join(reportRoot, 'ERA_CONTEXT_BENCHMARK.json');
const markdownPath = path.join(reportRoot, 'ERA_CONTEXT_BENCHMARK.md');
const fixtures = (await readFile(fixturesPath, 'utf8')).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Fixture);
const client = createEraContextClientFromEnv(process.env);
const rows: Array<Record<string, unknown>> = [];

for (const fixture of fixtures) {
  const startedAt = performance.now();
  try {
    const matches = await client.search({ ...fixture, top_k: 5 });
    const latencyMs = performance.now() - startedAt;
    const wrongYear = matches.filter((match) => match.start_year > fixture.end_year || match.end_year < fixture.start_year).length;
    const relevant = matches.some((match) => fixture.expected_titles.some((expected) => match.title.includes(expected)));
    rows.push({
      ...fixture,
      status: 'completed',
      latency_ms: Number(latencyMs.toFixed(2)),
      result_count: matches.length,
      relevant,
      wrong_year_count: wrongYear,
      matches: matches.map((match) => ({ title: match.title, category: match.category, score: match.score })),
    });
  } catch (error) {
    rows.push({
      ...fixture,
      status: 'failed',
      latency_ms: Number((performance.now() - startedAt).toFixed(2)),
      error_code: error instanceof Error && 'code' in error ? String(error.code) : 'unknown',
    });
  }
}

const completed = rows.filter((row) => row.status === 'completed');
const latencies = completed.map((row) => Number(row.latency_ms)).sort((a, b) => a - b);
const percentile = (values: number[], p: number) => values.length === 0 ? null : values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
const result = {
  generated_at: new Date().toISOString(),
  fixtures: fixtures.length,
  completed: completed.length,
  failed: rows.length - completed.length,
  retrieval_success_rate: fixtures.length === 0 ? 0 : completed.length / fixtures.length,
  era_retrieval_relevance: completed.length === 0 ? 0 : completed.filter((row) => row.relevant === true).length / completed.length,
  wrong_year_rate: completed.length === 0 ? 0 : completed.reduce((sum, row) => sum + Number(row.wrong_year_count ?? 0), 0) / completed.reduce((sum, row) => sum + Number(row.result_count ?? 0), 0),
  latency_p50_ms: percentile(latencies, 0.5),
  latency_p95_ms: percentile(latencies, 0.95),
  rows,
};

await mkdir(reportRoot, { recursive: true });
await writeFile(jsonPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
const markdown = [
  '# Era Context Benchmark',
  '',
  `Generated: ${result.generated_at}`,
  '',
  '| Metric | Value |',
  '| --- | ---: |',
  `| Fixtures | ${result.fixtures} |`,
  `| Completed | ${result.completed} |`,
  `| Failed | ${result.failed} |`,
  `| Retrieval success rate | ${(result.retrieval_success_rate * 100).toFixed(1)}% |`,
  `| Era retrieval relevance | ${(result.era_retrieval_relevance * 100).toFixed(1)}% |`,
  `| Wrong year rate | ${(result.wrong_year_rate * 100).toFixed(1)}% |`,
  `| Latency P50 | ${result.latency_p50_ms ?? 'n/a'} ms |`,
  `| Latency P95 | ${result.latency_p95_ms ?? 'n/a'} ms |`,
  '',
  '## Per fixture',
  '',
  '| Query | Years | Status | Results | Relevant | Latency |',
  '| --- | --- | --- | ---: | --- | ---: |',
  ...rows.map((row) => `| ${row.query} | ${row.start_year}-${row.end_year} | ${row.status} | ${row.result_count ?? '-'} | ${row.relevant ?? '-'} | ${row.latency_ms ?? '-'} ms |`),
  '',
].join('\n');
await writeFile(markdownPath, markdown, 'utf8');
console.log(JSON.stringify({ json: path.relative(root, jsonPath), markdown: path.relative(root, markdownPath), ...result, rows: undefined }));
if (result.failed > 0) process.exitCode = 1;
