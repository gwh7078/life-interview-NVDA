import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { AgentToolTokenService } from '../agent/tools/token.js';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { StoryShareRepository } from '../src/repositories/story-share-repository.js';
import { EvidenceSearchGateway } from '../src/retriever/script-gateway.js';
import type { EraContextAdapter } from '../src/era-context/types.js';
import type { RetrieverAdapter, RetrieverEvidence, RetrieverSearchInput } from '../src/retriever/types.js';

const secret = 'evidence-search-gateway-test-secret-012345678901234567890';
const directories: string[] = [];

after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function token(
  service: AgentToolTokenService,
  input: {
    ownerId?: string;
    storyId?: string;
    shareId?: string;
    currentSessionId?: string;
    allowedSourceTypes: string[];
    task?: string;
    skill?: string;
  },
): string {
  return service.issue({
    runId: 'run-evidence-1',
    userId: input.ownerId ?? 'owner-1',
    tool: 'evidence_search',
    resourceType: 'agent_evidence_search',
    resourceId: 'run-evidence-1',
    evidenceSearch: {
      task: input.task ?? 'story.completion',
      skill: input.skill ?? 'story-completion',
      allowedSourceTypes: input.allowedSourceTypes,
      ...(input.storyId ? { storyId: input.storyId } : {}),
      ...(input.shareId ? { shareId: input.shareId } : {}),
      ...(input.currentSessionId ? { currentSessionId: input.currentSessionId } : {}),
    },
    ttlMs: 60_000,
  });
}

function transcriptEvidence(overrides: Partial<RetrieverEvidence> = {}): RetrieverEvidence {
  return {
    text: '后来核实正式高考日期是7月15日。',
    score: 0.91,
    ownerId: 'owner-1',
    storyId: 'story-1',
    sourceType: 'subject',
    sessionId: 'session-1',
    messageIds: ['message-1'],
    segmentIds: ['segment-1'],
    ...overrides,
  };
}

function retriever(
  searchTranscript: (input: RetrieverSearchInput) => Promise<RetrieverEvidence[]>,
): RetrieverAdapter {
  return {
    async indexSessionTranscript() { return { status: 'accepted' }; },
    searchTranscript,
    async deleteSessionTranscript(sessionId) { return { documentId: sessionId, status: 'deleted' }; },
    async getIndexStatus(sessionId) { return { documentId: sessionId, status: 'completed' }; },
  };
}

test('evidence search enforces owner, current Story, source lane, and provenance', async () => {
  let received: RetrieverSearchInput | undefined;
  const adapter = retriever(async (input) => {
    received = input;
    return [
      transcriptEvidence(),
      transcriptEvidence({ storyId: 'other-story', sessionId: 'other-session' }),
      transcriptEvidence({ ownerId: 'other-owner', sessionId: 'other-owner-session' }),
      transcriptEvidence({ sourceType: 'external_contributor', sessionId: 'contributor-session' }),
    ];
  });
  const tokens = new AgentToolTokenService(secret);
  const gateway = new EvidenceSearchGateway({ retriever: adapter, tokenService: tokens });

  const result = await gateway.search(token(tokens, {
    storyId: 'story-1',
    allowedSourceTypes: ['owner_transcript'],
  }), {
    query: '高考正式日期',
    source_types: ['owner_transcript'],
    top_k: 5,
  });

  assert.deepEqual(received && {
    ownerId: received.ownerId,
    storyId: received.storyId,
    sourceType: received.sourceType,
    topK: received.topK,
  }, { ownerId: 'owner-1', storyId: 'story-1', sourceType: 'subject', topK: 5 });
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]?.source_type, 'owner_transcript');
  assert.equal(result.evidence[0]?.source_ref, 'session-1');
  assert.deepEqual(result.evidence[0]?.message_refs, ['message-1']);
  assert.equal('ownerId' in (result.evidence[0] ?? {}), false);
  assert.equal(result.retrieval.status, 'ok');
});

test('evidence search rejects source expansion and caller-supplied scope', async () => {
  let calls = 0;
  const tokens = new AgentToolTokenService(secret);
  const gateway = new EvidenceSearchGateway({
    retriever: retriever(async () => { calls += 1; return []; }),
    tokenService: tokens,
  });
  const signed = token(tokens, {
    storyId: 'story-1',
    allowedSourceTypes: ['owner_transcript'],
  });

  await assert.rejects(
    gateway.search(signed, { query: '高考日期', source_types: ['contributor_transcript'] }),
    (error: unknown) => error instanceof Error && 'statusCode' in error && error.statusCode === 403,
  );
  await assert.rejects(
    gateway.search(signed, {
      query: '高考日期',
      source_types: ['owner_transcript'],
      owner_id: 'other-owner',
    }),
    (error: unknown) => error instanceof Error && 'statusCode' in error && error.statusCode === 400,
  );
  await assert.rejects(
    gateway.search(signed, {
      query: '高考日期',
      source_types: ['owner_transcript'],
      story_id: 'other-story',
    }),
    (error: unknown) => error instanceof Error && 'statusCode' in error && error.statusCode === 400,
  );
  await assert.rejects(
    gateway.search(signed, { query: '高考日期', source_types: ['owner_transcript'], top_k: 6 }),
    (error: unknown) => error instanceof Error && 'statusCode' in error && error.statusCode === 400,
  );
  await assert.rejects(
    gateway.search(signed, { query: 'x'.repeat(501), source_types: ['owner_transcript'] }),
    (error: unknown) => error instanceof Error && 'statusCode' in error && error.statusCode === 400,
  );
  assert.equal(calls, 0);
});

test('evidence search rejects invalid, expired, and unsigned-scope tokens before querying', async () => {
  let now = Date.now();
  let calls = 0;
  const tokens = new AgentToolTokenService(secret, () => now);
  const gateway = new EvidenceSearchGateway({
    retriever: retriever(async () => { calls += 1; return []; }),
    tokenService: tokens,
  });
  const expired = token(tokens, { storyId: 'story-1', allowedSourceTypes: ['owner_transcript'] });
  now += 61_000;
  for (const value of ['invalid-token', expired, tokens.issue({
    runId: 'run-evidence-1',
    userId: 'owner-1',
    tool: 'evidence_search',
    resourceType: 'agent_evidence_search',
    resourceId: 'run-evidence-1',
  })]) {
    await assert.rejects(
      gateway.search(value, { query: '高考日期', source_types: ['owner_transcript'] }),
      (error: unknown) => error instanceof Error && 'statusCode' in error && error.statusCode === 401,
    );
  }
  assert.equal(calls, 0);
});

test('oversized non-record transcript evidence is dropped rather than sliced mid-answer', async () => {
  const tokens = new AgentToolTokenService(secret);
  const gateway = new EvidenceSearchGateway({
    retriever: retriever(async (input) => Array.from({ length: 8 }, (_, index) => transcriptEvidence({
      text: `# Life Interview Transcript\nuser_id: secret-owner\nsession_id: secret-session\nstory_id: secret-story\nsource_type: subject\n\n历史回答 ${index}。${'补充内容'.repeat(500)}`,
      ownerId: input.ownerId,
      storyId: input.storyId ?? null,
      sourceType: input.sourceType ?? null,
      sessionId: `session-${index}`,
      messageIds: [`message-${index}`],
      segmentIds: [`segment-${index}`],
    }))),
    tokenService: tokens,
  });
  const result = await gateway.search(token(tokens, {
    storyId: 'story-1',
    allowedSourceTypes: ['owner_transcript'],
  }), {
    query: '历史回答',
    source_types: ['owner_transcript'],
  });

  assert.equal(result.evidence.length, 0);
});

test('transcript evidence keeps only complete Q+A records within the text budget', async () => {
  const first = '[segment_id=segment-1][message_id=message-1][Q+A]\nQuestion (context only):第一个问题？\nAnswer (user-provided fact):'
    + '甲'.repeat(700);
  const second = '[segment_id=segment-2][message_id=message-2][Q+A]\nQuestion (context only):第二个问题？\nAnswer (user-provided fact):'
    + '乙'.repeat(700);
  const tokens = new AgentToolTokenService(secret);
  const gateway = new EvidenceSearchGateway({
    retriever: retriever(async () => [transcriptEvidence({
      text: `# Life Interview Transcript\nuser_id: secret-owner\nsession_id: secret-session\nstory_id: secret-story\n\n${first}\n${second}`,
      messageIds: ['message-1', 'message-2'],
      segmentIds: ['segment-1', 'segment-2'],
    })]),
    tokenService: tokens,
  });
  const result = await gateway.search(token(tokens, {
    storyId: 'story-1',
    allowedSourceTypes: ['owner_transcript'],
  }), {
    query: '第一个问题',
    source_types: ['owner_transcript'],
  });

  assert.equal(result.evidence.length, 1);
  const [item] = result.evidence;
  assert.ok(item?.text.includes(first));
  assert.equal(item?.text.includes('message-2'), false);
  assert.ok(Array.from(item?.text ?? '').length <= 1_200);
  assert.ok(!/secret-owner|secret-session|secret-story/u.test(item?.text ?? ''));
  assert.deepEqual(item?.message_refs, ['message-1']);
  assert.deepEqual(item?.segment_refs, ['segment-1']);
});

test('contributor search is limited to the same share sessions and never returns owner transcripts', async () => {
  const directory = mkdtempSync(path.resolve('data/test-tmp/evidence-contributor-'));
  directories.push(directory);
  const databasePath = path.join(directory, 'memoir.db');
  const connection = createDatabase(databasePath);
  runMigrations(connection);
  seedDatabase(connection);
  connection.close();
  const shares = new StoryShareRepository(databasePath);
  const share = shares.createForStory(seedIds.user, seedIds.firstJob, 'daughter')!.link;
  const otherShare = shares.createForStory(seedIds.user, seedIds.firstJob, 'friend')!.link;
  const sessionIds = ['contributor-history-1', 'contributor-history-2', 'other-contributor-history'];
  const sessionConnection = createDatabase(databasePath);
  for (const [sessionId, sourceShareId] of [
    [sessionIds[0]!, share.shareId],
    [sessionIds[1]!, share.shareId],
    [sessionIds[2]!, otherShare.shareId],
  ]) {
    sessionConnection.sqlite.prepare(`
      INSERT INTO interview_sessions (
        session_id, provider, user_id, story_id, session_type, source_type, source_share_id,
        status, closeout_status, transcript_json, started_at, ended_at, created_at, updated_at
      ) VALUES (?, 'openclaw', ?, ?, 'story', 'external_contributor', ?,
        'completed', 'completed', '[]', '2026-09-10T01:00:00.000Z',
        '2026-09-10T01:20:00.000Z', '2026-09-10T01:20:00.000Z', '2026-09-10T01:20:00.000Z')
    `).run(sessionId, seedIds.user, seedIds.firstJob, sourceShareId);
  }
  sessionConnection.close();

  const received: string[] = [];
  const tokens = new AgentToolTokenService(secret);
  const gateway = new EvidenceSearchGateway({
    databasePath,
    retriever: retriever(async (input) => {
      received.push(input.sessionId ?? 'unscoped');
      return [transcriptEvidence({
        text: 'user_id: private-owner\nsession_id: private-session\nstory_id: private-story\nContributor：那晚我记得很紧张。',
        sourceType: input.sourceType,
        ownerId: input.ownerId,
        storyId: input.storyId,
        sessionId: input.sessionId ?? '',
      })];
    }),
    tokenService: tokens,
  });
  const result = await gateway.search(token(tokens, {
    ownerId: seedIds.user,
    storyId: seedIds.firstJob,
    shareId: share.shareId,
    currentSessionId: 'current-contributor-session',
    allowedSourceTypes: ['contributor_transcript'],
    task: 'interview.closeout:contributor',
    skill: 'interview-closeout',
  }), {
    query: '那晚的感受',
    source_types: ['contributor_transcript'],
  });

  assert.deepEqual(received.sort(), sessionIds.slice(0, 2).sort());
  assert.equal(result.evidence.length, 2);
  assert.equal(result.evidence[0]?.source_type, 'contributor_transcript');
  assert.match(result.evidence[0]?.text ?? '', /Contributor/u);
  assert.equal(result.evidence.some((item) => /user_id:|session_id:|story_id:/u.test(item.text)), false);
  const generation = await gateway.search(token(tokens, {
    ownerId: seedIds.user,
    storyId: seedIds.firstJob,
    allowedSourceTypes: ['contributor_transcript'],
    task: 'story.generation',
    skill: 'story-generation',
  }), {
    query: '那晚的感受',
    source_types: ['contributor_transcript'],
  });
  assert.equal(generation.evidence.length, 3);
  assert.ok(generation.evidence.every((item) => item.source_type === 'contributor_transcript'));
});

test('structured profile, Life Stage, Story Memory, Summary, and related Story search stays owner scoped', async () => {
  const directory = mkdtempSync(path.resolve('data/test-tmp/evidence-search-'));
  directories.push(directory);
  const databasePath = path.join(directory, 'memoir.db');
  const connection = createDatabase(databasePath);
  runMigrations(connection);
  seedDatabase(connection);
  connection.close();

  const tokens = new AgentToolTokenService(secret);
  const gateway = new EvidenceSearchGateway({
    retriever: retriever(async () => []),
    tokenService: tokens,
    databasePath,
  });
  const storyScopedToken = token(tokens, {
    ownerId: seedIds.user,
    storyId: seedIds.firstProject,
    allowedSourceTypes: ['story_memory', 'story_summary', 'related_story'],
  });
  const memory = await gateway.search(storyScopedToken, {
    query: '跨团队项目',
    source_types: ['story_memory', 'story_summary'],
  });
  assert.deepEqual(new Set(memory.evidence.map((item) => item.source_type)), new Set(['story_memory', 'story_summary']));
  assert.ok(memory.evidence.every((item) => item.story_ref === seedIds.firstProject));

  const ownerScopedToken = token(tokens, {
    ownerId: seedIds.user,
    allowedSourceTypes: ['profile', 'life_stage', 'related_story'],
  });
  const stages = await gateway.search(ownerScopedToken, {
    query: '童年求学杭州',
    source_types: ['profile', 'life_stage'],
  });
  assert.ok(stages.evidence.some((item) => item.source_type === 'profile'));
  assert.ok(stages.evidence.some((item) => item.source_type === 'life_stage'));
  assert.ok(stages.evidence.every((item) => !('ownerId' in item) && !('email' in item)));

  const related = await gateway.search(storyScopedToken, {
    query: '第一次独立负责跨团队项目',
    source_types: ['related_story'],
  });
  assert.ok(related.evidence.every((item) => item.story_ref !== seedIds.firstProject));
});

test('related Story search excludes the current Story and returns only owner records', async () => {
  const directory = mkdtempSync(path.resolve('data/test-tmp/evidence-related-story-'));
  directories.push(directory);
  const databasePath = path.join(directory, 'memoir.db');
  const connection = createDatabase(databasePath);
  runMigrations(connection);
  seedDatabase(connection);
  connection.close();
  const tokens = new AgentToolTokenService(secret);
  const gateway = new EvidenceSearchGateway({
    retriever: retriever(async () => []),
    tokenService: tokens,
    databasePath,
  });

  const result = await gateway.search(token(tokens, {
    ownerId: seedIds.user,
    storyId: seedIds.firstJob,
    allowedSourceTypes: ['related_story'],
  }), {
    query: '第一次参加学校演出',
    source_types: ['related_story'],
  });
  assert.ok(result.evidence.some((item) => item.story_ref === seedIds.childhoodSchool));
  assert.ok(result.evidence.every((item) => item.story_ref !== seedIds.firstJob));
});

test('Era evidence uses only the public Era adapter and carries no personal Story provenance', async () => {
  let eraCalls = 0;
  let transcriptCalls = 0;
  const era: EraContextAdapter = {
    async search(input) {
      eraCalls += 1;
      assert.equal(input.query, '1983年山东高考安排');
      return [{
        start_year: 1983,
        end_year: 1983,
        category: '教育',
        title: '山东高考日期背景',
        summary: '该年度正式考试日期为7月15日。',
        score: 0.88,
      }];
    },
  };
  const tokens = new AgentToolTokenService(secret);
  const gateway = new EvidenceSearchGateway({
    retriever: retriever(async () => { transcriptCalls += 1; return []; }),
    eraContext: era,
    tokenService: tokens,
  });
  const result = await gateway.search(token(tokens, {
    storyId: 'story-1',
    allowedSourceTypes: ['era'],
    task: 'story.generation',
    skill: 'story-generation',
  }), {
    query: '1983年山东高考安排',
    source_types: ['era'],
    top_k: 5,
    year_range: { start: 1983, end: 1983 },
  });

  assert.equal(eraCalls, 1);
  assert.equal(transcriptCalls, 0);
  assert.equal(result.evidence[0]?.source_type, 'era');
  assert.equal(result.evidence[0]?.time_hint, '1983');
  assert.equal('story_ref' in (result.evidence[0] ?? {}), false);
});

test('retrieval failures degrade to current context and emit content-free trace metadata', async () => {
  const traces: Array<Record<string, unknown>> = [];
  const tokens = new AgentToolTokenService(secret);
  const gateway = new EvidenceSearchGateway({
    retriever: retriever(async () => { throw new Error('private query failure detail'); }),
    tokenService: tokens,
    onTrace(trace) { traces.push(trace); },
  });
  const result = await gateway.search(token(tokens, {
    storyId: 'story-1',
    allowedSourceTypes: ['owner_transcript'],
  }), {
    query: '医院是谁送去的',
    source_types: ['owner_transcript'],
  });

  assert.deepEqual(result.evidence, []);
  assert.equal(result.retrieval.status, 'unavailable');
  assert.equal(result.retrieval.result_count, 0);
  assert.equal(result.retrieval.query_chars, '医院是谁送去的'.length);
  assert.equal(traces.length, 1);
  assert.equal(JSON.stringify(traces[0]).includes('医院是谁送去的'), false);
  assert.equal(JSON.stringify(traces[0]).includes('private query failure detail'), false);
  assert.equal(traces[0]?.timeout, false);
});

test('bounded search timeout returns no unverified evidence and records only safe trace fields', async () => {
  const tokens = new AgentToolTokenService(secret);
  const gateway = new EvidenceSearchGateway({
    timeoutMs: 10,
    retriever: retriever((input) => new Promise<RetrieverEvidence[]>((_resolve, reject) => {
      if (input.signal?.aborted) reject(new Error('aborted'));
      else input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })),
    tokenService: tokens,
  });
  const result = await gateway.search(token(tokens, {
    storyId: 'story-1',
    allowedSourceTypes: ['owner_transcript'],
  }), {
    query: '秘密问题的具体答案',
    source_types: ['owner_transcript'],
  });
  assert.deepEqual(result.evidence, []);
  assert.equal(result.retrieval.status, 'unavailable');
  assert.equal(result.retrieval.timeout, true);
});
