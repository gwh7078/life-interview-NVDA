import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase, seedIds } from '../src/db/seed.js';
import { interviewSessions } from '../src/db/schema.js';
import { createInterviewRuntimeCore } from '../src/interview/core.js';
import {
  endRealtimeInterviewSession,
} from '../src/interview/session.js';
import { runExternalContributorCloseout } from '../src/interview/external-contributor/closeout.js';
import { beginInterviewCloseout, CloseoutWorkflowError } from '../src/interview/closeout-workflow.js';
import {
  StoryRepository,
  TranscriptRepository,
} from '../src/repositories/domain-repositories.js';
import {
  StoryShareRepository,
  STORY_SHARE_TTL_MS,
} from '../src/repositories/story-share-repository.js';
import { buildInterviewInstructions } from '../src/realtime/prompt.js';
import type { TextModelProvider } from '../src/providers/text-model-provider.js';

const temporaryDirectories: string[] = [];
const root = path.resolve('data/test-tmp');
mkdirSync(root, { recursive: true });

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(path.join(root, 'story-share-test-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'memoir.db');
  const connection = createDatabase(databasePath);
  try {
    runMigrations(connection);
    seedDatabase(connection);
    connection.sqlite.prepare('UPDATE stories SET gaps_json = ? WHERE story_id = ?')
      .run(JSON.stringify(['家人当时怎么看这个决定？']), seedIds.firstProject);
  } finally {
    connection.close();
  }
  return databasePath;
}

test('share token is a seven-day scoped contributor identity and never exposes the plaintext token in storage', () => {
  const databasePath = setup();
  const shares = new StoryShareRepository(databasePath);
  const created = shares.createForStory(seedIds.user, seedIds.firstProject, 'daughter');
  assert.ok(created);
  assert.equal(created.link.relationship, 'daughter');

  const resolved = shares.resolvePublicToken(created.token, new Date(created.link.createdAt));
  assert.ok(resolved);
  assert.equal(resolved.storyId, seedIds.firstProject);
  assert.equal(resolved.userId, seedIds.user);
  assert.equal(resolved.storyTitle, '第一次独立负责跨团队项目');
  assert.deepEqual(JSON.parse(resolved.storyGapsJson), ['家人当时怎么看这个决定？']);
  assert.equal(resolved.relationship, 'daughter');

  const stored = createDatabase(databasePath);
  try {
    const row = stored.sqlite.prepare(
      'SELECT token_hash AS tokenHash FROM story_share_links WHERE share_id = ?',
    ).get(created.link.shareId) as { tokenHash: string };
    assert.notEqual(row.tokenHash, created.token);
    assert.equal(row.tokenHash.length, 64);
  } finally {
    stored.close();
  }

  const afterExpiry = new Date(Date.parse(created.link.createdAt) + STORY_SHARE_TTL_MS + 1);
  assert.equal(shares.resolvePublicToken(created.token, afterExpiry), null);
});

test('same share_id keeps contributor memory across sessions while owner evidence remains isolated', async () => {
  const databasePath = setup();
  const shares = new StoryShareRepository(databasePath);
  const created = shares.createForStory(seedIds.user, seedIds.firstProject, 'daughter');
  assert.ok(created);

  const core = createInterviewRuntimeCore(databasePath);
  const firstContext = core.prepare(seedIds.user, {
    interview_type: 'external_contributor',
    shareId: created.link.shareId,
  });
  assert.equal(firstContext.interview_type, 'external_contributor');
  if (firstContext.interview_type !== 'external_contributor') throw new Error('wrong context');
  assert.equal(firstContext.relationship, 'daughter');
  assert.equal(firstContext.contributor_summary, '');
  assert.equal(firstContext.story.title, '第一次独立负责跨团队项目');

  const instructions = buildInterviewInstructions(firstContext);
  assert.match(instructions, /不是客观真相/);
  assert.match(instructions, /不得透露主人公的私密访谈内容/);
  assert.match(instructions, /家人当时怎么看这个决定/);
  assert.equal(instructions.includes(seedIds.user), false);
  assert.equal(instructions.includes(created.link.shareId), false);

  const session = core.start(seedIds.user, firstContext, 'stepfun');
  const transcripts = new TranscriptRepository(databasePath);
  transcripts.appendForSession(seedIds.user, session.sessionId, {
    role: 'user',
    text: '我记得那时候他每天很晚回家，家里其实很担心。',
    provider: 'stepfun',
    providerMessageId: 'external-user-1',
  });
  endRealtimeInterviewSession(databasePath, seedIds.user, session.sessionId);

  const fakeModel: TextModelProvider = {
    async complete() {
      return {
        output: { summary: '她记得那段时间主人公每天很晚回家，家里对此很担心。' },
        model: 'fake-model',
        latencyMs: 1,
      };
    },
  };
  await runExternalContributorCloseout({
    databasePath,
    userId: seedIds.user,
    sessionId: session.sessionId,
    config: { apiKey: 'test-key' },
    textModelProvider: fakeModel,
  });

  const savedShare = shares.findByShareIdForUser(seedIds.user, created.link.shareId);
  assert.equal(savedShare?.interviewCount, 1);
  assert.match(savedShare?.contributorSummary ?? '', /很晚回家/);

  const secondContext = core.prepare(seedIds.user, {
    interview_type: 'external_contributor',
    shareId: created.link.shareId,
  });
  assert.equal(secondContext.interview_type, 'external_contributor');
  if (secondContext.interview_type !== 'external_contributor') throw new Error('wrong context');
  assert.match(secondContext.contributor_summary, /很晚回家/);

  const secondSession = core.start(seedIds.user, secondContext, 'stepfun');
  transcripts.appendForSession(seedIds.user, secondSession.sessionId, {
    role: 'user',
    text: '后来项目上线那天，他回来得很早，我们全家一起吃了饭。',
    provider: 'stepfun',
    providerMessageId: 'external-user-2',
  });
  endRealtimeInterviewSession(databasePath, seedIds.user, secondSession.sessionId);

  const mergingModel: TextModelProvider = {
    async complete(prompt) {
      const payload = JSON.parse(prompt.user) as {
        previous_contributor_summary?: string | null;
        current_transcript?: string;
      };
      assert.match(payload.previous_contributor_summary ?? '', /很晚回家/);
      assert.match(payload.current_transcript ?? '', /全家一起吃了饭/);
      return {
        output: {
          summary: '她记得项目期间主人公经常很晚回家，家里很担心；项目上线当天他回来得很早，全家一起吃了饭。',
        },
        model: 'fake-model',
        latencyMs: 1,
      };
    },
  };
  await runExternalContributorCloseout({
    databasePath,
    userId: seedIds.user,
    sessionId: secondSession.sessionId,
    config: { apiKey: 'test-key' },
    textModelProvider: mergingModel,
  });
  const mergedShare = shares.findByShareIdForUser(seedIds.user, created.link.shareId);
  assert.equal(mergedShare?.interviewCount, 2);
  assert.match(mergedShare?.contributorSummary ?? '', /很晚回家/);
  assert.match(mergedShare?.contributorSummary ?? '', /一起吃了饭/);

  const sessionRow = createDatabase(databasePath);
  try {
    const saved = sessionRow.db.select().from(interviewSessions)
      .where(eq(interviewSessions.sessionId, session.sessionId)).get();
    assert.equal(saved?.sourceType, 'external_contributor');
    assert.equal(saved?.sourceShareId, created.link.shareId);
    assert.equal(saved?.storyId, seedIds.firstProject);
    assert.equal(saved?.userId, seedIds.user);
  } finally {
    sessionRow.close();
  }

  const stories = new StoryRepository(databasePath);
  const ownerHistory = stories.getTranscriptsByStoryId(seedIds.user, seedIds.firstProject);
  assert.equal(ownerHistory.some((item) => item.sessionId === session.sessionId), false);
  assert.equal(
    stories.getCompletionDataForUser(seedIds.user, seedIds.firstProject)?.interviewSessionCount,
    1,
    'external contributor sessions must not change owner Completion session count',
  );
});

test('revoked share token cannot resolve and a share from another owner cannot be opened by owner-scoped lookup', () => {
  const databasePath = setup();
  const shares = new StoryShareRepository(databasePath);
  const created = shares.createForStory(seedIds.user, seedIds.firstProject, 'friend');
  assert.ok(created);
  assert.equal(shares.findByShareIdForUser('other-user', created.link.shareId), null);
  assert.equal(shares.revokeForUser('other-user', created.link.shareId), false);
  assert.equal(shares.revokeForUser(seedIds.user, created.link.shareId), true);
  assert.equal(shares.resolvePublicToken(created.token), null);
});

test('public share always projects the latest Story fields while relationship remains fixed', () => {
  const databasePath = setup();
  const shares = new StoryShareRepository(databasePath);
  const created = shares.createForStory(seedIds.user, seedIds.firstProject, 'daughter');
  assert.ok(created);

  const database = createDatabase(databasePath);
  try {
    database.sqlite.prepare(`
      UPDATE stories
      SET title = ?, summary = ?, status = 'interviewing', gaps_json = ?, updated_at = ?
      WHERE story_id = ? AND user_id = ?
    `).run(
      '项目上线前最后一周',
      '主人公后来补充了上线前最后一周的细节。',
      JSON.stringify(['上线前家里最担心什么？', '项目上线当天发生了什么？']),
      '2026-09-18T15:00:00.000Z',
      seedIds.firstProject,
      seedIds.user,
    );
  } finally {
    database.close();
  }

  const resolved = shares.resolvePublicToken(created.token);
  assert.ok(resolved);
  assert.equal(resolved.storyTitle, '项目上线前最后一周');
  assert.equal(resolved.storySummary, '主人公后来补充了上线前最后一周的细节。');
  assert.equal(resolved.storyStatus, 'interviewing');
  assert.deepEqual(JSON.parse(resolved.storyGapsJson), [
    '上线前家里最担心什么？',
    '项目上线当天发生了什么？',
  ]);
  assert.equal(resolved.relationship, 'daughter');
});

test('different share ids keep contributor memory and relationship isolated', async () => {
  const databasePath = setup();
  const shares = new StoryShareRepository(databasePath);
  const daughter = shares.createForStory(seedIds.user, seedIds.firstProject, 'daughter');
  const friend = shares.createForStory(seedIds.user, seedIds.firstProject, 'friend');
  assert.ok(daughter);
  assert.ok(friend);
  assert.notEqual(daughter.link.shareId, friend.link.shareId);

  const core = createInterviewRuntimeCore(databasePath);
  const daughterContext = core.prepare(seedIds.user, {
    interview_type: 'external_contributor',
    shareId: daughter.link.shareId,
  });
  const daughterSession = core.start(seedIds.user, daughterContext, 'stepfun');
  new TranscriptRepository(databasePath).appendForSession(seedIds.user, daughterSession.sessionId, {
    role: 'user',
    text: '我记得他那段时间常常很晚回家。',
    provider: 'stepfun',
    providerMessageId: 'daughter-isolation',
  });
  endRealtimeInterviewSession(databasePath, seedIds.user, daughterSession.sessionId);
  await runExternalContributorCloseout({
    databasePath,
    userId: seedIds.user,
    sessionId: daughterSession.sessionId,
    config: { apiKey: 'test-key' },
    textModelProvider: {
      async complete() {
        return {
          output: { summary: '女儿记得主人公那段时间常常很晚回家。' },
          model: 'fake-model',
          latencyMs: 1,
        };
      },
    },
  });

  const daughterSaved = shares.findByShareIdForUser(seedIds.user, daughter.link.shareId);
  const friendSaved = shares.findByShareIdForUser(seedIds.user, friend.link.shareId);
  assert.equal(daughterSaved?.relationship, 'daughter');
  assert.equal(friendSaved?.relationship, 'friend');
  assert.equal(daughterSaved?.interviewCount, 1);
  assert.equal(friendSaved?.interviewCount, 0);
  assert.match(daughterSaved?.contributorSummary ?? '', /很晚回家/);
  assert.equal(friendSaved?.contributorSummary, '');

  const friendContext = core.prepare(seedIds.user, {
    interview_type: 'external_contributor',
    shareId: friend.link.shareId,
  });
  assert.equal(friendContext.interview_type, 'external_contributor');
  if (friendContext.interview_type !== 'external_contributor') throw new Error('wrong context');
  assert.equal(friendContext.relationship, 'friend');
  assert.equal(friendContext.contributor_summary, '');
});

test('contributor closeout retries transient failures and rejects summaries over 400 characters', async () => {
  const databasePath = setup();
  const shares = new StoryShareRepository(databasePath);
  const created = shares.createForStory(seedIds.user, seedIds.firstProject, 'friend');
  assert.ok(created);
  const core = createInterviewRuntimeCore(databasePath);
  const transcripts = new TranscriptRepository(databasePath);

  const context = core.prepare(seedIds.user, {
    interview_type: 'external_contributor',
    shareId: created.link.shareId,
  });
  const session = core.start(seedIds.user, context, 'stepfun');
  transcripts.appendForSession(seedIds.user, session.sessionId, {
    role: 'user',
    text: '这是一次需要自动重试的补充。',
    provider: 'stepfun',
    providerMessageId: 'retry-success',
  });
  endRealtimeInterviewSession(databasePath, seedIds.user, session.sessionId);

  let calls = 0;
  await runExternalContributorCloseout({
    databasePath,
    userId: seedIds.user,
    sessionId: session.sessionId,
    config: { apiKey: 'test-key' },
    textModelProvider: {
      async complete() {
        calls += 1;
        if (calls < 3) throw new Error('temporary model failure');
        return {
          output: { summary: '记'.repeat(400) },
          model: 'fake-model',
          latencyMs: 1,
        };
      },
    },
  });
  assert.equal(calls, 3);
  assert.equal(shares.findByShareIdForUser(seedIds.user, created.link.shareId)?.contributorSummary.length, 400);

  const secondContext = core.prepare(seedIds.user, {
    interview_type: 'external_contributor',
    shareId: created.link.shareId,
  });
  const secondSession = core.start(seedIds.user, secondContext, 'stepfun');
  transcripts.appendForSession(seedIds.user, secondSession.sessionId, {
    role: 'user',
    text: '这次模型始终返回过长摘要。',
    provider: 'stepfun',
    providerMessageId: 'retry-too-long',
  });
  endRealtimeInterviewSession(databasePath, seedIds.user, secondSession.sessionId);

  let invalidCalls = 0;
  await assert.rejects(runExternalContributorCloseout({
    databasePath,
    userId: seedIds.user,
    sessionId: secondSession.sessionId,
    config: { apiKey: 'test-key' },
    textModelProvider: {
      async complete() {
        invalidCalls += 1;
        return {
          output: { summary: '长'.repeat(401) },
          model: 'fake-model',
          latencyMs: 1,
        };
      },
    },
  }), /EXTERNAL_CONTRIBUTOR_CLOSEOUT_INVALID/);
  assert.equal(invalidCalls, 3);
  const saved = shares.findByShareIdForUser(seedIds.user, created.link.shareId);
  assert.equal(saved?.interviewCount, 1);
  assert.equal(saved?.contributorSummary.length, 400);
});

test('concurrent closeouts merge against the latest contributor summary instead of overwriting it', async () => {
  const databasePath = setup();
  const shares = new StoryShareRepository(databasePath);
  const created = shares.createForStory(seedIds.user, seedIds.firstProject, 'friend');
  assert.ok(created);
  const core = createInterviewRuntimeCore(databasePath);
  const transcripts = new TranscriptRepository(databasePath);

  const makeSession = (label: string) => {
    const context = core.prepare(seedIds.user, {
      interview_type: 'external_contributor' as const,
      shareId: created.link.shareId,
    });
    const session = core.start(seedIds.user, context, 'stepfun');
    transcripts.appendForSession(seedIds.user, session.sessionId, {
      role: 'user',
      text: `补充内容${label}`,
      provider: 'stepfun',
      providerMessageId: `concurrent-${label}`,
    });
    endRealtimeInterviewSession(databasePath, seedIds.user, session.sessionId);
    return session;
  };
  const first = makeSession('A');
  const second = makeSession('B');

  let firstRoundCalls = 0;
  let releaseFirstRound!: () => void;
  const firstRoundReady = new Promise<void>((resolve) => { releaseFirstRound = resolve; });
  const model: TextModelProvider = {
    async complete(prompt) {
      const payload = JSON.parse(prompt.user) as {
        previous_contributor_summary?: string | null;
        current_transcript: string;
      };
      if (!payload.previous_contributor_summary) {
        firstRoundCalls += 1;
        if (firstRoundCalls === 2) releaseFirstRound();
        await firstRoundReady;
      }
      const label = payload.current_transcript.includes('补充内容A') ? 'A' : 'B';
      return {
        output: {
          summary: [payload.previous_contributor_summary, label].filter(Boolean).join('；'),
        },
        model: 'fake-model',
        latencyMs: 1,
      };
    },
  };

  await Promise.all([
    runExternalContributorCloseout({
      databasePath,
      userId: seedIds.user,
      sessionId: first.sessionId,
      config: { apiKey: 'test-key' },
      textModelProvider: model,
    }),
    runExternalContributorCloseout({
      databasePath,
      userId: seedIds.user,
      sessionId: second.sessionId,
      config: { apiKey: 'test-key' },
      textModelProvider: model,
    }),
  ]);

  const saved = shares.findByShareIdForUser(seedIds.user, created.link.shareId);
  assert.equal(saved?.interviewCount, 2);
  assert.match(saved?.contributorSummary ?? '', /A/);
  assert.match(saved?.contributorSummary ?? '', /B/);
});

test('external contributor sessions are rejected by the normal Story Closeout pipeline', () => {
  const databasePath = setup();
  const shares = new StoryShareRepository(databasePath);
  const created = shares.createForStory(seedIds.user, seedIds.firstProject, 'friend');
  assert.ok(created);
  const core = createInterviewRuntimeCore(databasePath);
  const context = core.prepare(seedIds.user, {
    interview_type: 'external_contributor',
    shareId: created.link.shareId,
  });
  const session = core.start(seedIds.user, context, 'stepfun');
  new TranscriptRepository(databasePath).appendForSession(seedIds.user, session.sessionId, {
    role: 'user',
    text: '这条外部证词绝不能进入主人公 Story Closeout。',
    provider: 'stepfun',
    providerMessageId: 'external-closeout-guard',
  });
  endRealtimeInterviewSession(databasePath, seedIds.user, session.sessionId);

  assert.throws(
    () => beginInterviewCloseout(
      databasePath,
      session.sessionId,
      { apiKey: 'test-key' },
      seedIds.user,
    ),
    (error: unknown) => error instanceof CloseoutWorkflowError
      && error.code === 'INVALID_SESSION_SOURCE',
  );
});

test('empty contributor interview completes without calling the model or advancing contributor memory', async () => {
  const databasePath = setup();
  const shares = new StoryShareRepository(databasePath);
  const created = shares.createForStory(seedIds.user, seedIds.firstProject, 'friend');
  assert.ok(created);

  const core = createInterviewRuntimeCore(databasePath);
  const context = core.prepare(seedIds.user, {
    interview_type: 'external_contributor',
    shareId: created.link.shareId,
  });
  const session = core.start(seedIds.user, context, 'stepfun');
  endRealtimeInterviewSession(databasePath, seedIds.user, session.sessionId);

  let modelCalls = 0;
  const shouldNotRun: TextModelProvider = {
    async complete() {
      modelCalls += 1;
      throw new Error('model must not run for empty contributor interviews');
    },
  };
  await runExternalContributorCloseout({
    databasePath,
    userId: seedIds.user,
    sessionId: session.sessionId,
    config: { apiKey: 'test-key' },
    textModelProvider: shouldNotRun,
  });

  const saved = shares.findByShareIdForUser(seedIds.user, created.link.shareId);
  assert.equal(modelCalls, 0);
  assert.equal(saved?.interviewCount, 0);
  assert.equal(saved?.contributorSummary, '');
  assert.equal(saved?.lastInterviewAt, null);

  const database = createDatabase(databasePath);
  try {
    const row = database.sqlite.prepare(`
      SELECT closeout_status AS closeoutStatus, closeout_result_json AS closeoutResultJson
      FROM interview_sessions WHERE session_id = ?
    `).get(session.sessionId) as { closeoutStatus: string; closeoutResultJson: string | null };
    assert.equal(row.closeoutStatus, 'completed');
    assert.equal(JSON.parse(row.closeoutResultJson ?? '{}').no_new_user_content, true);
  } finally {
    database.close();
  }
});

test('deleting a Story invalidates its share link but preserves historical contributor Session and Transcript', () => {
  const databasePath = setup();
  const shares = new StoryShareRepository(databasePath);
  const created = shares.createForStory(seedIds.user, seedIds.firstProject, 'daughter');
  assert.ok(created);

  const core = createInterviewRuntimeCore(databasePath);
  const context = core.prepare(seedIds.user, {
    interview_type: 'external_contributor',
    shareId: created.link.shareId,
  });
  const session = core.start(seedIds.user, context, 'stepfun');
  const transcripts = new TranscriptRepository(databasePath);
  transcripts.appendForSession(seedIds.user, session.sessionId, {
    role: 'user',
    text: '这是删除 Story 之后仍然必须保留的历史口述。',
    provider: 'stepfun',
    providerMessageId: 'external-delete-history',
  });
  endRealtimeInterviewSession(databasePath, seedIds.user, session.sessionId);

  const stories = new StoryRepository(databasePath);
  assert.equal(stories.deleteForUser(seedIds.user, seedIds.firstProject), true);
  assert.equal(shares.resolvePublicToken(created.token), null);

  const database = createDatabase(databasePath);
  try {
    const row = database.sqlite.prepare(`
      SELECT story_id AS storyId, source_share_id AS sourceShareId, transcript_json AS transcriptJson
      FROM interview_sessions
      WHERE session_id = ?
    `).get(session.sessionId) as {
      storyId: string | null;
      sourceShareId: string | null;
      transcriptJson: string;
    };
    assert.equal(row.storyId, null);
    assert.equal(row.sourceShareId, null);
    assert.match(row.transcriptJson, /删除 Story 之后仍然必须保留的历史口述/);
    const remainingShares = database.sqlite.prepare(
      'SELECT count(*) AS count FROM story_share_links WHERE story_id = ?',
    ).get(seedIds.firstProject) as { count: number };
    assert.equal(remainingShares.count, 0);
  } finally {
    database.close();
  }
});
