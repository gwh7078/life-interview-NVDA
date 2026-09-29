#!/usr/bin/env node

const query = process.argv.slice(2).join(' ').trim();
const baseUrl = process.env.LIFE_INTERVIEW_RETRIEVAL_BASE_URL?.trim();
const token = process.env.LIFE_INTERVIEW_RETRIEVAL_TOKEN?.trim();

if (query.length < 2 || query.length > 500) {
  console.error('memory-search requires a short query (2-500 characters).');
  process.exit(2);
}
if (!baseUrl || !token) {
  console.error('memory-search runtime authorization is unavailable.');
  process.exit(3);
}

console.error('LIFE_INTERVIEW_SCRIPT_CALL memory-search');

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 10_000);
const startedAt = Date.now();
try {
  const response = await fetch(`${baseUrl.replace(/\/+$/u, '')}/internal/agent-retrieval/memory-search`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query }),
    signal: controller.signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = body && typeof body === 'object' && typeof body.errorCode === 'string'
      ? body.errorCode
      : `HTTP_${response.status}`;
    console.error(`memory-search failed: ${code}`);
    process.exit(4);
  }
  const matches = body && typeof body === 'object' && Array.isArray(body.matches)
    ? body.matches.slice(0, 5)
    : [];
  console.error(`LIFE_INTERVIEW_SCRIPT_RESULT memory-search result_count=${matches.length} latency_ms=${Date.now() - startedAt}`);
  process.stdout.write(JSON.stringify({ matches }) + '\n');
} catch (error) {
  console.error(`memory-search failed: ${error instanceof Error ? error.name : 'unknown'}`);
  process.exit(5);
} finally {
  clearTimeout(timer);
}
