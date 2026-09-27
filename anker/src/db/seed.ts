import { writeDiagnosticLog } from '../diagnostics/logger.js';
import { eq } from 'drizzle-orm';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createDatabase, type DatabaseHandle } from './client.js';
import {
  accounts,
  interviewSessions,
  lifeStages,
  memoirDocuments,
  stories,
  users,
} from './schema.js';
import {
  serializeJsonColumn,
  closeoutResultSchema,
  documentSourceSchema,
  jsonObjectSchema,
} from './transcript.js';
import { nowUtcIso } from './time.js';

export const seedIds = {
  account: '00000000-0000-4000-8000-000000000000',
  user: '00000000-0000-4000-8000-000000000001',
  childhood: '00000000-0000-4000-8000-000000000101',
  work: '00000000-0000-4000-8000-000000000102',
  family: '00000000-0000-4000-8000-000000000103',
  childhoodSchool: '00000000-0000-4000-8000-000000000201',
  childhoodMove: '00000000-0000-4000-8000-000000000202',
  firstJob: '00000000-0000-4000-8000-000000000203',
  firstProject: '00000000-0000-4000-8000-000000000204',
  wedding: '00000000-0000-4000-8000-000000000205',
  familyTrip: '00000000-0000-4000-8000-000000000206',
  onboardingSession: '00000000-0000-4000-8000-000000000301',
  storySession: '00000000-0000-4000-8000-000000000302',
  document: '00000000-0000-4000-8000-000000000501',
} as const;

export function seedDatabase(connection: DatabaseHandle): void {
  const timestamp = nowUtcIso();
  const closeoutResult = {
    current_story_source_message_ids: [],
    new_stories: [],
  };

  connection.db.transaction((tx) => {
    tx.insert(accounts)
      .values({
        accountId: seedIds.account,
        phone: null,
        phoneVerified: false,
        status: 'legacy',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoNothing()
      .run();

    tx.insert(users)
      .values({
        userId: seedIds.user,
        accountId: seedIds.account,
        name: '周明',
        nickname: '明哥',
        email: 'seed@example.invalid',
        birthDate: '1985',
        birthDatePrecision: 'year',
        birthPlace: '浙江杭州',
        currentLocation: '浙江杭州',
        occupationSummary: '产品与项目管理',
        familySummary: '与伴侣和女儿生活在杭州',
        profileSummary: '正在整理工作、家庭与迁徙经历。',
        extraProfileJson: serializeJsonColumn(
          { preferredInterviewTime: 'weekend_morning' },
          jsonObjectSchema,
        ),
        onboardingStatus: 'completed',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoNothing()
      .run();

    tx.insert(lifeStages)
      .values([
        {
          stageId: seedIds.childhood,
          userId: seedIds.user,
          title: '童年与求学',
          startDate: '1985',
          endDate: '2003',
          datePrecision: 'year',
          summary: '在杭州长大并完成基础教育。',
          sortOrder: 1,
          status: 'active',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          stageId: seedIds.work,
          userId: seedIds.user,
          title: '进入职场',
          startDate: '2004',
          endDate: '2018',
          datePrecision: 'year',
          summary: '从第一份工作开始，逐渐承担项目责任。',
          sortOrder: 2,
          status: 'active',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          stageId: seedIds.family,
          userId: seedIds.user,
          title: '家庭生活',
          startDate: '2015',
          datePrecision: 'year',
          summary: '建立家庭并记录共同生活的片段。',
          sortOrder: 3,
          status: 'active',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ])
      .onConflictDoNothing()
      .run();

    tx.insert(stories)
      .values([
        {
          storyId: seedIds.childhoodSchool,
          userId: seedIds.user,
          stageId: seedIds.childhood,
          title: '第一次参加学校演出',
          summary: '第一次站上学校舞台，克服了上台前的紧张。',
          agentMemory: '第一次站上学校舞台，克服了上台前的紧张。',
          status: 'pending',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          storyId: seedIds.childhoodMove,
          userId: seedIds.user,
          stageId: seedIds.childhood,
          title: '搬家后的新邻居',
          summary: '搬家后认识了一位重要朋友，并逐渐建立友谊。',
          agentMemory: '搬家后认识了一位重要朋友，并逐渐建立友谊。',
          status: 'pending',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          storyId: seedIds.firstJob,
          userId: seedIds.user,
          stageId: seedIds.work,
          title: '第一份工作',
          summary: '从校园进入职场，经历了适应新工作环境的过程。',
          agentMemory: '从校园进入职场，经历了适应新工作环境的过程。',
          status: 'interviewing',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          storyId: seedIds.firstProject,
          userId: seedIds.user,
          stageId: seedIds.work,
          title: '第一次独立负责跨团队项目',
          summary: '第一次独立负责跨团队项目，在不确定中学会拆解问题和带团队。项目于 2013 年正式上线；过程中先拆解问题、再分工协作，帮助团队减少反复争论。',
          agentMemory: '第一次独立负责跨团队项目，在不确定中学会拆解问题和带团队。项目于 2013 年正式上线；过程中先拆解问题、再分工协作，帮助团队减少反复争论。',
          status: 'complete',
          createdSourceSessionId: seedIds.storySession,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          storyId: seedIds.wedding,
          userId: seedIds.user,
          stageId: seedIds.family,
          title: '一起做出的重要决定',
          summary: '和伴侣共同做出的一个重要决定。',
          agentMemory: '和伴侣共同做出的一个重要决定。',
          status: 'pending',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          storyId: seedIds.familyTrip,
          userId: seedIds.user,
          stageId: seedIds.family,
          title: '一次全家旅行',
          summary: '一次让全家记忆深刻的旅行。',
          agentMemory: '一次让全家记忆深刻的旅行。',
          status: 'pending',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ])
      .onConflictDoNothing()
      .run();

    tx.insert(interviewSessions)
      .values([
        {
          sessionId: seedIds.onboardingSession,
          provider: 'openclaw',
          userId: seedIds.user,
          sessionType: 'onboarding',
          status: 'completed',
          closeoutStatus: 'completed',
          startedAt: '2026-09-10T01:00:00.000Z',
          endedAt: '2026-09-10T01:20:00.000Z',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          sessionId: seedIds.storySession,
          provider: 'openclaw',
          userId: seedIds.user,
          storyId: seedIds.firstProject,
          sessionType: 'story',
          status: 'completed',
          closeoutStatus: 'completed',
          closeoutResultJson: serializeJsonColumn(closeoutResult, closeoutResultSchema),
          startedAt: '2026-09-10T02:00:00.000Z',
          endedAt: '2026-09-10T02:45:00.000Z',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ])
      .onConflictDoNothing()
      .run();

    tx.insert(memoirDocuments)
      .values({
        documentId: seedIds.document,
        userId: seedIds.user,
        scopeType: 'full_memoir',
        title: '周明的人生档案（草稿）',
        content: '这是一份由已确认资料生成的测试文稿。',
        versionNumber: 1,
        status: 'draft',
        sourceJson: serializeJsonColumn(
          { story_ids: [seedIds.firstProject], session_ids: [seedIds.storySession] },
          documentSourceSchema,
        ),
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoNothing()
      .run();
  });

  const user = connection.db.select().from(users).where(eq(users.userId, seedIds.user)).get();
  if (!user) {
    throw new Error('Seed verification failed: user was not inserted.');
  }
}

export function main(): void {
  const connection = createDatabase();

  try {
    seedDatabase(connection);
    console.log(`Seed complete: ${connection.databasePath}`);
    writeDiagnosticLog('database', 'info', 'Database seed completed.', { databasePath: connection.databasePath });
  } finally {
    connection.close();
  }
}

const invokedScript = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;

if (invokedScript === import.meta.url) {
  main();
}
