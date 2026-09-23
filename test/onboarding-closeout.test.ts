import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { accounts, interviewSessions, lifeStages, stories, users } from '../src/db/schema.js';
import { serializeTranscript } from '../src/db/transcript.js';
import { endRealtimeInterviewSession } from '../src/interview/session.js';
import { TranscriptRepository } from '../src/repositories/domain-repositories.js';
import { OnboardingRepository } from '../src/repositories/onboarding-repository.js';
import {
  beginOnboardingCloseout,
  failOnboardingCloseout,
  getOnboardingResult,
  type OnboardingCloseoutConfig,
} from '../src/onboarding/index.js';
import type { TextModelProvider } from '../src/providers/text-model-provider.js';
import type { CloseoutModelConfig, CloseoutModelResult } from '../src/interview/llm-provider.js';
import type {
  OnboardingCloseoutProcessor,
  ProcessOnboardingCloseoutResult,
} from '../src/onboarding/processor.js';
import type {
  OnboardingSourceReference,
  ValidatedOnboardingCloseoutOutput,
} from '../src/onboarding/types.js';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'rensheng-onboarding-closeout-'));
after(() => rmSync(tempRoot, { recursive: true, force: true }));

interface Fixture {
  databasePath: string;
  userId: string;
}

interface EndedSession {
  sessionId: string;
  messageId: string;
}

function makeFixture(userId: string): Fixture {
  const directory = mkdtempSync(path.join(tempRoot, 'case-'));
  const databasePath = path.join(directory, 'memoir.db');
  const connection = createDatabase(databasePath);
  try {
    runMigrations(connection);
    const now = '2026-09-14T00:00:00.000Z';
    connection.db.insert(accounts).values({
      accountId: `account-${userId}`,
      phone: null,
      phoneVerified: false,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }).run();
    connection.db.insert(users).values({ userId, accountId: `account-${userId}`, createdAt: now, updatedAt: now }).run();
  } finally {
    connection.close();
  }
  return { databasePath, userId };
}

function createEndedSession(
  fixture: Fixture,
  text: string,
  startedAt: string,
  options: { completionEligible?: boolean; transcriptComplete?: boolean } = {},
): EndedSession {
  const session = new OnboardingRepository(fixture.databasePath).createInterviewSessionForUser(fixture.userId, 'stepfun');
  const userMessage = new TranscriptRepository(fixture.databasePath).appendForSession(fixture.userId, session.sessionId, {
    role: 'user', text, provider: 'stepfun',
  });
  new TranscriptRepository(fixture.databasePath).appendForSession(fixture.userId, session.sessionId, {
    role: 'assistant', text: '谢谢你分享。', provider: 'stepfun',
  });
  const endedAt = new Date(Date.parse(startedAt) + 60_000).toISOString();
  const connection = createDatabase(fixture.databasePath);
  try {
    connection.db.update(interviewSessions).set({
      startedAt,
      createdAt: startedAt,
    }).where(eq(interviewSessions.sessionId, session.sessionId)).run();
  } finally {
    connection.close();
  }
  endRealtimeInterviewSession(fixture.databasePath, fixture.userId, session.sessionId, endedAt, {
    onboardingCompletionEligible: options.completionEligible ?? true,
    onboardingTranscriptComplete: options.transcriptComplete ?? true,
  });
  return { sessionId: session.sessionId, messageId: userMessage.message_id };
}

interface PromptMessage {
  role: 'user' | 'assistant';
  source_ref?: string;
  text: string;
}

interface PromptData {
  current_profile: Record<string, unknown>;
  interviews: Array<{ interview_number: number; transcript: PromptMessage[] }>;
}

function promptData(prompt: { system: string; user: string }): PromptData {
  return JSON.parse(prompt.user) as PromptData;
}

function aliasFor(prompt: { system: string; user: string }, fragment: string): string {
  const message = promptData(prompt).interviews.flatMap((interview) => interview.transcript)
    .find((candidate) => candidate.role === 'user' && candidate.text.includes(fragment));
  assert.ok(message?.source_ref, `expected an opaque source alias for ${fragment}`);
  return message.source_ref;
}

function modelCandidate(
  prompt: { system: string; user: string },
  options: { stageCount?: number; profileText?: string; stageText?: string } = {},
): Record<string, unknown> {
  const profileSource = aliasFor(prompt, options.profileText ?? '我叫林岚');
  const stageSource = aliasFor(prompt, options.stageText ?? '小时候');
  return {
    profile: {
      name: { value: '林岚', source_refs: [profileSource] },
      birth_year: { value: 1987, source_refs: [profileSource] },
      gender: { value: '女性', source_refs: [profileSource] },
      birth_place: { value: '南京', source_refs: [stageSource] },
      current_location: { value: '杭州', source_refs: [profileSource] },
      current_status: { value: '退休后参与志愿服务', source_refs: [profileSource] },
      profile_summary: { value: '1987年出生，现居杭州，参与志愿服务。', source_refs: [profileSource] },
    },
    life_stages: Array.from({ length: options.stageCount ?? 2 }, (_, index) => ({
      title: `人生阶段 ${index + 1}`,
      start_year: index === 1 ? 100 : 1990,
      end_year: index === 0 ? 'now' : null,
      source_refs: [stageSource],
      stories: [{
        title: `值得继续采访的故事 ${index + 1}`,
        summary: '一个由本人讲述、可在未来继续展开的经历。',
        source_refs: [stageSource],
        status: 'pending',
      }],
    })),
  };
}

function providerFor(
  output: (prompt: { system: string; user: string }) => unknown,
  onPrompt?: (prompt: { system: string; user: string }) => void,
): TextModelProvider {
  return {
    async complete(prompt: { system: string; user: string }, _config: CloseoutModelConfig): Promise<CloseoutModelResult> {
      onPrompt?.(prompt);
      return {
        output: output(prompt),
        model: 'onboarding-test-model',
        responseId: 'onboarding-test-response',
        usage: { prompt_tokens: 120, completion_tokens: 90, total_tokens: 210 },
        latencyMs: 4,
      };
    },
  };
}

const config: OnboardingCloseoutConfig = {
  provider: 'volcengine-agent-plan',
  apiKey: 'test-only-not-a-real-key',
  model: 'onboarding-test-model',
};

async function waitForTerminal(fixture: Fixture, sessionId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = getOnboardingResult(fixture.databasePath, fixture.userId, sessionId);
    if (result.session?.closeout_status === 'failed') return result;
    if (result.session?.closeout_status === 'completed' && !result.story_completion_pending) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Onboarding closeout did not reach a terminal state.');
}

function resolvedOutput(reference: OnboardingSourceReference): ValidatedOnboardingCloseoutOutput {
  return {
    profile: {
      name: { value: '林岚', source_refs: [reference] },
      birth_year: { value: null, source_refs: [] },
      gender: { value: null, source_refs: [] },
      birth_place: { value: null, source_refs: [] },
      current_location: { value: null, source_refs: [] },
      current_status: { value: null, source_refs: [] },
      profile_summary: { value: null, source_refs: [] },
    },
    life_stages: [],
  };
}

function processorWithMutation(
  mutate: (contextSessionId: string) => void,
  source: (contextSessionId: string) => OnboardingSourceReference,
): OnboardingCloseoutProcessor {
  return {
    async process(input): Promise<ProcessOnboardingCloseoutResult> {
      mutate(input.context.sessionId);
      const result: CloseoutModelResult = { output: {}, model: 'test', latencyMs: 1 };
      return { output: resolvedOutput(source(input.context.sessionId)), modelResult: result };
    },
  };
}

test('Closeout cannot retry a model-complete session whose final Transcript did not drain', () => {
  const fixture = makeFixture('incomplete-drain');
  const current = createEndedSession(fixture, '我叫林岚。', '2026-09-14T01:00:00.000Z', {
    completionEligible: true,
    transcriptComplete: false,
  });
  failOnboardingCloseout(
    fixture.databasePath,
    current.sessionId,
    'TRANSCRIPT_DRAIN_INCOMPLETE',
    'The final transcript did not drain.',
    fixture.userId,
  );
  const failedResult = getOnboardingResult(fixture.databasePath, fixture.userId, current.sessionId);
  assert.equal(failedResult.processing_error?.retryable, false);
  assert.throws(
    () => beginOnboardingCloseout(fixture.databasePath, current.sessionId, config, fixture.userId),
    (error: unknown) => error instanceof Error && 'code' in error
      && error.code === 'ONBOARDING_TRANSCRIPT_INCOMPLETE',
  );
  assert.equal(getOnboardingResult(fixture.databasePath, fixture.userId, current.sessionId).session?.closeout_status, 'failed');
});

test('Onboarding closeout resolves opaque aliases, aggregates prior transcripts, persists the life map atomically and is idempotent', async () => {
  const fixture = makeFixture('closeout-success-user');
  const profileConnection = createDatabase(fixture.databasePath);
  try {
    profileConnection.db.update(users).set({ currentStatus: 'Existing unverified status' })
      .where(eq(users.userId, fixture.userId)).run();
  } finally {
    profileConnection.close();
  }
  const previous = createEndedSession(fixture, '小时候我在南京长大，常和表姐去河边玩。', '2026-09-13T00:00:00.000Z');
  const current = createEndedSession(fixture, '我叫林岚，1987年出生，现在住在杭州并参与志愿服务。', '2026-09-14T00:00:00.000Z');
  const contextData = new OnboardingRepository(fixture.databasePath).getInterviewContextData(fixture.userId);
  assert.equal(contextData.onboardingStatus, 'in_progress');
  assert.equal(contextData.transcripts.length, 2);

  let seenPrompt: { system: string; user: string } | undefined;
  const completedStoryIds: string[] = [];
  const dependencies = {
    textModelProvider: providerFor((prompt) => modelCandidate(prompt, { stageCount: 9 }), (prompt) => { seenPrompt = prompt; }),
    afterApply: async (userId: string, storyId: string) => {
      assert.equal(userId, fixture.userId);
      completedStoryIds.push(storyId);
    },
  };
  const started = beginOnboardingCloseout(fixture.databasePath, current.sessionId, config, fixture.userId, dependencies);
  assert.deepEqual(started.status, 'processing');
  const result = await waitForTerminal(fixture, current.sessionId);

  assert.equal(result.onboarding_status, 'completed');
  assert.deepEqual(result.session, {
    session_id: current.sessionId,
    status: 'completed',
    closeout_status: 'completed',
  });
  assert.equal(result.profile?.name.value, '林岚');
  assert.equal(result.profile?.gender.value, '女性');
  assert.equal(result.profile?.birth_year.value, 1987);
  assert.equal(result.profile?.profile_summary.value, '1987年出生，现居杭州，参与志愿服务。');
  assert.equal(result.profile?.name.source_refs[0]?.session_id, current.sessionId);
  assert.equal(result.profile?.name.source_refs[0]?.message_id, current.messageId);
  assert.equal(result.life_stages.length, 9, '4–8 stages is a target, not a validator or DB limit');
  assert.equal(result.life_stages[0]?.start_year, 1990);
  assert.equal(result.life_stages[0]?.end_year, 'now');
  assert.equal(result.life_stages[1]?.start_year, 100);
  assert.equal(result.life_stages[1]?.end_year, null);
  assert.equal('summary' in result.life_stages[0]!, false);
  assert.equal('date_precision' in result.life_stages[0]!, false);
  assert.equal(result.stories.length, 9);
  assert.deepEqual(
    new Set(completedStoryIds),
    new Set(result.stories.map((story) => story.story_id)),
    'every Story created by Onboarding is sent through the post-apply Completion hook',
  );
  assert.ok(result.stories.every((story) => story.status === 'pending'));
  assert.ok(result.stories.every((story) => result.life_stages.some((stage) => stage.stage_id === story.stage_id)));
  assert.ok(result.life_stages.every((stage) => stage.source_refs[0]?.session_id === previous.sessionId));
  assert.ok(result.stories.every((story) => story.source_refs[0]?.session_id === previous.sessionId));
  assert.equal(result.evidence.length, 2);
  assert.ok(result.evidence.some((entry) => entry.session_id === previous.sessionId));
  assert.ok(result.evidence.some((entry) => entry.session_id === current.sessionId));
  assert.ok(seenPrompt);
  const promptProfile = promptData(seenPrompt).current_profile;
  assert.equal(promptProfile.current_status, 'Existing unverified status');
  assert.equal(promptProfile.birth_year, null);
  assert.equal('birth_date' in promptProfile, false);
  assert.equal('birth_date_precision' in promptProfile, false);
  assert.match(seenPrompt.system, /start_year.*end_year/);
  assert.ok(seenPrompt.system.includes('超级阶段'));
  assert.ok(seenPrompt.system.includes('超级 Story'));
  assert.ok(seenPrompt.system.includes('同一 Life Stage 可以有多个 Story'));
  assert.ok(seenPrompt.system.includes('人生概况 Facts'));
  assert.ok(seenPrompt.system.includes('不是人生时间线摘要'));
  assert.ok(seenPrompt.system.includes('后来、之后、随后'));
  assert.ok(seenPrompt.system.includes('未核实上下文'));
  assert.ok(seenPrompt.system.includes('绝不根据姓名、声音、关系称谓或其他线索推断'));
  assert.equal(promptData(seenPrompt).interviews.length, 2);
  assert.equal(seenPrompt.user.includes(current.sessionId), false);
  assert.equal(seenPrompt.user.includes(current.messageId), false);

  const connection = createDatabase(fixture.databasePath);
  try {
    const persistedStages = connection.db.select().from(lifeStages).where(eq(lifeStages.userId, fixture.userId)).all();
    assert.equal(persistedStages.length, 9);
    assert.equal(persistedStages[0]?.startDate, '1990');
    assert.equal(persistedStages[0]?.endDate, 'now');
    assert.equal(persistedStages[1]?.startDate, '0100');
    assert.equal(persistedStages[0]?.datePrecision, null);
    assert.equal(persistedStages[0]?.summary, null);
    assert.equal(connection.db.select().from(stories).where(eq(stories.userId, fixture.userId)).all().length, 9);
  } finally {
    connection.close();
  }
  assert.equal(beginOnboardingCloseout(fixture.databasePath, current.sessionId, config, fixture.userId).status, 'completed');
  const repeated = getOnboardingResult(fixture.databasePath, fixture.userId, current.sessionId);
  assert.equal(repeated.life_stages.length, 9);
  assert.equal(repeated.stories.length, 9);
  assert.throws(
    () => getOnboardingResult(fixture.databasePath, 'some-other-user', current.sessionId),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SESSION_NOT_FOUND',
  );
});

test('Onboarding remains processing while post-apply Story Completion is still running', async () => {
  const fixture = makeFixture('onboarding-completion-pending-user');
  const current = createEndedSession(
    fixture,
    '我叫林岚，小时候在南京长大，后来搬到杭州生活，也有几件以后想继续讲的故事。',
    '2026-09-14T03:00:00.000Z',
  );
  let releaseCompletion!: () => void;
  let markCompletionStarted!: () => void;
  const completionStarted = new Promise<void>((resolve) => { markCompletionStarted = resolve; });
  const completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve; });
  let completionCalls = 0;
  const dependencies = {
    textModelProvider: providerFor((prompt) => modelCandidate(prompt, { stageCount: 2 })),
    afterApply: async () => {
      completionCalls += 1;
      markCompletionStarted();
      await completionGate;
    },
  };

  const started = beginOnboardingCloseout(
    fixture.databasePath,
    current.sessionId,
    config,
    fixture.userId,
    dependencies,
  );
  assert.equal(started.status, 'processing');
  await completionStarted;

  const pending = getOnboardingResult(fixture.databasePath, fixture.userId, current.sessionId);
  assert.equal(pending.onboarding_status, 'completed', 'the atomic Onboarding write is already committed');
  assert.equal(pending.session?.closeout_status, 'completed');
  assert.equal(pending.story_completion_pending, true,
    'the public result must remain processing until derived Story Completion finishes');
  assert.equal(pending.stories.length, 2);

  releaseCompletion();
  const completed = await waitForTerminal(fixture, current.sessionId);
  assert.equal(completed.story_completion_pending, false);
  assert.equal(completed.session?.closeout_status, 'completed');
  assert.equal(completionCalls, 2, 'each Story created by Onboarding gets a Completion pass');
});

test('atomic write failure leaves the Profile/life map untouched, is retryable, and a retry completes once', async () => {
  const fixture = makeFixture('closeout-retry-user');
  const current = createEndedSession(fixture, '小时候我常在南京和表姐玩。我叫林岚。', '2026-09-14T00:00:00.000Z');
  const connection = createDatabase(fixture.databasePath);
  try {
    connection.sqlite.exec(`CREATE TRIGGER fail_onboarding_story_insert BEFORE INSERT ON stories
      BEGIN SELECT RAISE(ABORT, 'intentional onboarding test failure'); END`);
  } finally {
    connection.close();
  }
  const dependencies = { textModelProvider: providerFor((prompt) => modelCandidate(prompt, { stageCount: 1 })) };
  beginOnboardingCloseout(fixture.databasePath, current.sessionId, config, fixture.userId, dependencies);
  const failed = await waitForTerminal(fixture, current.sessionId);
  assert.equal(failed.session?.closeout_status, 'failed');
  assert.equal(failed.onboarding_status, 'in_progress');
  assert.equal(failed.processing_error?.retryable, true);
  assert.equal(failed.profile?.name.value, null);
  assert.equal(failed.life_stages.length, 0);
  assert.equal(failed.stories.length, 0);

  const retryConnection = createDatabase(fixture.databasePath);
  try { retryConnection.sqlite.exec('DROP TRIGGER fail_onboarding_story_insert'); }
  finally { retryConnection.close(); }

  beginOnboardingCloseout(fixture.databasePath, current.sessionId, config, fixture.userId, dependencies);
  const completed = await waitForTerminal(fixture, current.sessionId);
  assert.equal(completed.session?.closeout_status, 'completed', JSON.stringify(completed.processing_error));
  assert.equal(completed.profile?.name.value, '林岚');
  assert.equal(completed.life_stages.length, 1);
  assert.equal(completed.stories.length, 1);
  assert.equal(completed.onboarding_status, 'completed');
});

test('a null Profile summary candidate preserves the previously saved profile_summary', async () => {
  const fixture = makeFixture('closeout-summary-preserve-user');
  const current = createEndedSession(fixture, '我叫林岚。', '2026-09-14T02:00:00.000Z');
  const connection = createDatabase(fixture.databasePath);
  try {
    connection.db.update(users).set({ profileSummary: '既有的人生概述' })
      .where(eq(users.userId, fixture.userId)).run();
  } finally {
    connection.close();
  }

  const processor = processorWithMutation(
    () => {},
    (sessionId) => ({ session_id: sessionId, message_id: current.messageId }),
  );
  beginOnboardingCloseout(fixture.databasePath, current.sessionId, config, fixture.userId, { processor });
  const result = await waitForTerminal(fixture, current.sessionId);
  assert.equal(result.session?.closeout_status, 'completed');
  assert.equal(result.profile?.profile_summary.value, '既有的人生概述');
});

test('apply transaction rechecks owner, onboarding session type, and persisted user role for every provenance ref', async (t) => {
  await t.test('rejects evidence owned by another user', async () => {
    const fixture = makeFixture('source-owner-target');
    const target = createEndedSession(fixture, '我叫林岚。', '2026-09-14T00:00:00.000Z');
    const otherFixture = makeFixture('source-owner-other');
    const foreign = createEndedSession(otherFixture, '我叫其他用户。', '2026-09-14T00:00:00.000Z');
    const processor = processorWithMutation(
      () => {},
      () => ({ session_id: foreign.sessionId, message_id: foreign.messageId }),
    );
    beginOnboardingCloseout(fixture.databasePath, target.sessionId, config, fixture.userId, { processor });
    const result = await waitForTerminal(fixture, target.sessionId);
    assert.equal(result.session?.closeout_status, 'failed');
    assert.equal(result.profile?.name.value, null);
    assert.equal(result.onboarding_status, 'in_progress');
  });

  await t.test('rejects evidence whose source session changed away from onboarding', async () => {
    const fixture = makeFixture('source-type-target');
    const previous = createEndedSession(fixture, '小时候在南京长大。', '2026-09-13T00:00:00.000Z');
    const target = createEndedSession(fixture, '我叫林岚。', '2026-09-14T00:00:00.000Z');
    const processor = processorWithMutation((contextSessionId) => {
      const connection = createDatabase(fixture.databasePath);
      try {
        connection.db.update(interviewSessions).set({ sessionType: 'story' })
          .where(eq(interviewSessions.sessionId, previous.sessionId)).run();
      } finally { connection.close(); }
      assert.equal(contextSessionId, target.sessionId);
    }, () => ({ session_id: previous.sessionId, message_id: previous.messageId }));
    beginOnboardingCloseout(fixture.databasePath, target.sessionId, config, fixture.userId, { processor });
    const result = await waitForTerminal(fixture, target.sessionId);
    assert.equal(result.session?.closeout_status, 'failed');
    assert.equal(result.profile?.name.value, null);
    assert.equal(result.life_stages.length, 0);
  });

  await t.test('rejects a source message no longer persisted as a user message', async () => {
    const fixture = makeFixture('source-role-target');
    const target = createEndedSession(fixture, '我叫林岚。', '2026-09-14T00:00:00.000Z');
    const processor = processorWithMutation((contextSessionId) => {
      const connection = createDatabase(fixture.databasePath);
      try {
        connection.db.update(interviewSessions).set({
          transcriptJson: serializeTranscript([{
            message_id: target.messageId,
            role: 'assistant',
            text: '我叫林岚。',
            timestamp: '2026-09-14T00:00:00.000Z',
            provider: 'stepfun',
          }]),
        }).where(eq(interviewSessions.sessionId, contextSessionId)).run();
      } finally { connection.close(); }
    }, (contextSessionId) => ({ session_id: contextSessionId, message_id: target.messageId }));
    beginOnboardingCloseout(fixture.databasePath, target.sessionId, config, fixture.userId, { processor });
    const result = await waitForTerminal(fixture, target.sessionId);
    assert.equal(result.session?.closeout_status, 'failed');
    assert.equal(result.profile?.name.value, null);
  });
});
