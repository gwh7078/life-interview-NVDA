import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createDatabase } from '../../src/db/client.js';
import { stories } from '../../src/db/schema.js';
import { and, eq } from 'drizzle-orm';
import { RetrieverIndexService } from '../../src/retriever/indexer.js';
import { createRetrieverClientFromEnv } from '../../src/retriever/client.js';

interface FixtureManifest {
  database_path: string;
  owner_id: string;
  stage_id: string;
  story_id: string;
  session_ids: string[];
  retriever_collection: string;
  story_context: {
    story_title: string;
    story_summary: string;
    agent_memory: string;
  };
}

const root = process.cwd();
const fixtureDirectory = path.resolve(root, 'data/next-question-benchmark');
const manifestPath = path.resolve(
  process.env.NEXT_QUESTION_BENCHMARK_FIXTURE_MANIFEST?.trim() || path.join(fixtureDirectory, 'fixture.json'),
);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as FixtureManifest;
const databasePath = path.resolve(path.dirname(manifestPath), manifest.database_path);
const collection = manifest.retriever_collection;

function privateWrite(file: string, value: string): void {
  writeFileSync(file, value, { encoding: 'utf8', mode: 0o600 });
}

function checkFixture(): void {
  const connection = createDatabase(databasePath);
  try {
    const story = connection.db.select().from(stories).where(and(
      eq(stories.userId, manifest.owner_id),
      eq(stories.storyId, manifest.story_id),
    )).get();
    if (!story || story.stageId !== manifest.stage_id) throw new Error('BENCHMARK_STORY_SCOPE_INVALID');
    if (story.title !== manifest.story_context.story_title
      || story.summary !== manifest.story_context.story_summary
      || story.agentMemory !== manifest.story_context.agent_memory) {
      throw new Error('BENCHMARK_STORY_CONTEXT_MISMATCH');
    }
  } finally {
    connection.close();
  }
}

async function main(): Promise<void> {
  if (process.env.NEMO_RETRIEVER_ENABLED?.trim() !== 'true') throw new Error('NEMO_RETRIEVER_ENABLED_REQUIRED');
  checkFixture();
  const clientEnv = { ...process.env, NEMO_RETRIEVER_COLLECTION: collection };
  const retriever = createRetrieverClientFromEnv(clientEnv);
  await retriever.health();

  const indexer = new RetrieverIndexService(databasePath, retriever);
  const indexResults: Array<Record<string, unknown>> = [];
  for (const sessionId of manifest.session_ids) {
    let outcome = await indexer.indexSessionTranscript(manifest.owner_id, sessionId);
    if (outcome.status === 'indexing') {
      outcome = await indexer.waitForIndex(manifest.owner_id, sessionId, { timeoutMs: 180_000, pollIntervalMs: 1_000 })
        ?? { status: 'failed', errorCode: 'INDEX_STATUS_MISSING' };
    }
    indexResults.push({ session_id: sessionId, ...outcome });
    if (outcome.status !== 'indexed') throw new Error(`RETRIEVER_INDEX_NOT_COMPLETE:${sessionId}:${outcome.status}`);
  }

  const queries = [
    { id: 'exam-date', query: '1983年正式高考日期', required: ['7月15日'] },
    { id: 'river-crossing', query: '过沭河时发生了什么', required: ['水深得没过腰', '相互搀扶', '行李举过头顶'] },
  ] as const;
  const queryResults: Array<Record<string, unknown>> = [];
  for (const item of queries) {
    const evidence = await retriever.searchTranscript({
      ownerId: manifest.owner_id,
      storyId: manifest.story_id,
      query: item.query,
      topK: 12,
    });
    const text = evidence.map((entry) => entry.text).join('\n');
    const found = item.required.filter((phrase) => text.includes(phrase));
    queryResults.push({
      id: item.id,
      query: item.query,
      evidence_count: evidence.length,
      required_phrases: [...item.required],
      found_phrases: found,
      matched: evidence.filter((entry) => item.required.some((phrase) => entry.text.includes(phrase))),
      pass: evidence.length > 0 && found.length === item.required.length,
    });
  }

  const passed = queryResults.every((result) => result.pass === true);
  const runId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`;
  const outputDir = path.resolve(root, 'benchmark/next-question/results', `retriever-probe-${runId}`);
  mkdirSync(outputDir, { recursive: false, mode: 0o700 });
  privateWrite(path.join(outputDir, 'run.json'), JSON.stringify({
    benchmark: 'controlled-next-question-retriever-probe',
    run_id: runId,
    generated_at: new Date().toISOString(),
    repeat_command: 'bash scripts/codex-node.sh npm run benchmark:next-question:retriever-probe',
    database_path: path.relative(root, databasePath),
    source_database: 'benchmark/interview-quality/interview-quality-benchmark.db.gz',
    owner_id: manifest.owner_id,
    story_id: manifest.story_id,
    collection,
  }, null, 2));
  privateWrite(path.join(outputDir, 'retriever-results.json'), JSON.stringify({
    status: passed ? 'PASS' : 'FAIL',
    indexed_session_count: indexResults.length,
    index: indexResults,
    queries: queryResults,
  }, null, 2));

  for (const result of queryResults) {
    const matches = (result.matched as Array<{ text: string; sessionId: string }>).map((item) => ({
      session_id: item.sessionId,
      excerpt: item.text.slice(-360),
    }));
    process.stdout.write(`${JSON.stringify({
      query: result.query,
      evidence_count: result.evidence_count,
      found_phrases: result.found_phrases,
      pass: result.pass,
      evidence: matches,
    })}\n`);
  }
  process.stdout.write(`RETRIEVER_PROBE ${passed ? '2/2 PASS' : 'FAIL'}; ${outputDir}\n`);
  if (!passed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'RETRIEVER_PROBE_FAILED';
  process.stderr.write(`${message.slice(0, 240)}\n`);
  process.exitCode = 1;
});
