#!/usr/bin/env node
import { performance } from 'node:perf_hooks';

const [query, sourceList, startYear, endYear] = process.argv.slice(2);
const baseUrl = process.env.LIFE_INTERVIEW_RETRIEVAL_BASE_URL?.trim();
const token = process.env.LIFE_INTERVIEW_RETRIEVAL_TOKEN?.trim();
const sourceTypes = (sourceList ?? '').split(',').map((value) => value.trim()).filter(Boolean);
const validSources = new Set([
  'owner_transcript', 'contributor_transcript', 'profile', 'life_stage',
  'story_memory', 'story_summary', 'related_story', 'era',
]);

if (typeof query !== 'string' || query.trim().length < 2 || query.trim().length > 500
  || sourceTypes.length === 0 || sourceTypes.some((value) => !validSources.has(value))) {
  console.error('evidence-search requires a short query and one or more supported source types.');
  process.exit(2);
}
if (!baseUrl || !token) {
  console.error('evidence-search runtime authorization is unavailable.');
  process.exit(2);
}

const body = { query: query.trim(), source_types: [...new Set(sourceTypes)], top_k: 5 };
if (body.source_types.includes('era')) {
  const start = Number(startYear);
  const end = Number(endYear);
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    console.error('evidence-search requires start_year and end_year for Era evidence.');
    process.exit(2);
  }
  body.year_range = { start, end };
}

console.error('LIFE_INTERVIEW_SCRIPT_CALL evidence-search');
const startedAt = performance.now();
try {
  const response = await fetch(`${baseUrl.replace(/\/+$/u, '')}/internal/agent-retrieval/evidence-search`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || !Array.isArray(payload.evidence)) {
    const code = typeof payload?.errorCode === 'string' ? payload.errorCode : 'EVIDENCE_SEARCH_FAILED';
    console.error(`evidence-search failed: ${code}`);
    process.exit(1);
  }
  console.error(`LIFE_INTERVIEW_SCRIPT_RESULT evidence-search result_count=${payload.evidence.length} latency_ms=${Math.round(performance.now() - startedAt)}`);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
} catch (error) {
  console.error(`evidence-search failed: ${error instanceof Error ? error.name : 'unknown'}`);
  process.exit(1);
}
