#!/usr/bin/env node

const input = await readInput();
const baseUrl = process.env.LIFE_INTERVIEW_RETRIEVAL_BASE_URL?.trim();
const token = process.env.LIFE_INTERVIEW_RETRIEVAL_TOKEN?.trim();

if (!input || typeof input !== 'object' || Array.isArray(input)) fail('era-context-search requires a JSON object.', 2);
if (typeof input.query !== 'string' || input.query.trim().length < 2 || input.query.trim().length > 500) {
  fail('era-context-search query must contain between 2 and 500 characters.', 2);
}
if (!Number.isInteger(input.start_year) || !Number.isInteger(input.end_year)
  || input.start_year < 1970 || input.end_year > 2020 || input.start_year > input.end_year) {
  fail('era-context-search requires a valid 1970-2020 year range.', 2);
}
if (input.top_k !== undefined && (!Number.isInteger(input.top_k) || input.top_k < 1 || input.top_k > 5)) {
  fail('era-context-search top_k must be between 1 and 5.', 2);
}
if (!baseUrl || !token) fail('era-context-search runtime authorization is unavailable.', 3);

console.error('LIFE_INTERVIEW_SCRIPT_CALL era-context-search');
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 10_000);
const startedAt = Date.now();
try {
  const response = await fetch(`${baseUrl.replace(/\/+$/u, '')}/internal/agent-retrieval/era-context-search`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query: input.query.trim(),
      start_year: input.start_year,
      end_year: input.end_year,
      ...(input.top_k === undefined ? {} : { top_k: input.top_k }),
    }),
    signal: controller.signal,
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 503) {
    console.error(`LIFE_INTERVIEW_SCRIPT_RESULT era-context-search status=unavailable latency_ms=${Date.now() - startedAt}`);
    process.stdout.write(JSON.stringify({ matches: [] }) + '\n');
    process.exit(0);
  }
  if (!response.ok) {
    const code = body && typeof body === 'object' && typeof body.errorCode === 'string'
      ? body.errorCode
      : `HTTP_${response.status}`;
    fail(`era-context-search failed: ${code}`, 4);
  }
  const matches = body && typeof body === 'object' && Array.isArray(body.matches)
    ? body.matches.slice(0, 5)
    : [];
  console.error(`LIFE_INTERVIEW_SCRIPT_RESULT era-context-search result_count=${matches.length} latency_ms=${Date.now() - startedAt}`);
  process.stdout.write(JSON.stringify({ matches }) + '\n');
} catch (error) {
  console.error(`era-context-search failed: ${error instanceof Error ? error.name : 'unknown'}`);
  process.stdout.write(JSON.stringify({ matches: [] }) + '\n');
  process.exit(0);
} finally {
  clearTimeout(timer);
}

async function readInput() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 8_192) fail('era-context-search input is too large.', 2);
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function fail(message, code) {
  console.error(message);
  process.exit(code);
}
