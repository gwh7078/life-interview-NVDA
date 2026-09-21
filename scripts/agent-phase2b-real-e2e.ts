import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentTaskPort, type AgentTaskRequestUnion } from '../src/agent-tasks/index.js';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

interface CaseResult {
  name: string;
  taskType: string;
  mode?: string;
  ok: boolean;
  latencyMs: number;
  runtime?: unknown;
  output?: unknown;
  error?: string;
}

function transcript(messageId: string, role: 'user' | 'assistant', text: string) {
  return {
    message_id: messageId,
    role,
    text,
    timestamp: '2026-09-21T10:00:00.000Z',
  };
}

function cases(ownerId: string): Array<{ name: string; request: AgentTaskRequestUnion }> {
  return [
    {
      name: 'onboarding.closeout',
      request: {
        runId: randomUUID(),
        taskType: 'onboarding.closeout',
        ownerId,
        resource: { type: 'interview_session', id: 'e2e-onboarding-session' },
        schemaVersion: 'v1',
        payload: {
          current_profile: {
            name: null,
            birth_year: null,
            gender: null,
            birth_place: null,
            current_location: null,
            current_status: null,
            profile_summary: null,
          },
          interviews: [{
            interview_number: 1,
            transcript: [
              {
                role: 'assistant',
                text: '请简单介绍一下你自己。',
                timestamp: '2026-09-21T10:00:00.000Z',
              },
              {
                role: 'user',
                source_ref: 'source_1',
                text: '我叫林岚，1990年出生，现在住在杭州。',
                timestamp: '2026-09-21T10:00:05.000Z',
              },
              {
                role: 'user',
                source_ref: 'source_2',
                text: '大学毕业后我第一次独自去北京工作，那段经历我一直记得。',
                timestamp: '2026-09-21T10:00:10.000Z',
              },
            ],
          }],
        },
      },
    },
    {
      name: 'interview.closeout/story_create',
      request: {
        runId: randomUUID(),
        taskType: 'interview.closeout',
        mode: 'story_create',
        ownerId,
        resource: { type: 'interview_session', id: 'e2e-story-create-session' },
        schemaVersion: 'v1',
        payload: {
          mode: 'story_create',
          target_stage: {
            stage_id: 's1',
            title: '初入职场',
            start_date: '2012',
            end_date: '2015',
          },
          target_story_title: '第一次独自去北京工作',
          other_stories: [],
          transcript: [
            transcript('m1', 'assistant', '第一次到北京时你最先记住的是什么？'),
            transcript('m2', 'user', '我记得是冬天，出了北京站以后特别冷，我拖着一个大箱子去找公司安排的宿舍。'),
            transcript('m3', 'user', '具体是哪一天我记不清了，只记得大概是2012年底。'),
          ],
        },
      },
    },
    {
      name: 'interview.closeout/story_continue',
      request: {
        runId: randomUUID(),
        taskType: 'interview.closeout',
        mode: 'story_continue',
        ownerId,
        resource: {
          type: 'story',
          id: 'e2e-story-continue',
          version: '2026-09-21T09:00:00.000Z',
        },
        schemaVersion: 'v1',
        payload: {
          mode: 'story_continue',
          current_story: {
            title: '第一次独自去北京工作',
            summary: '2012年前后第一次独自去北京工作。',
            agent_memory: '用户大约在2012年前后第一次独自去北京工作。具体月份尚不确定。',
            status: 'interviewing',
          },
          current_stage: {
            stage_id: 's1',
            title: '初入职场',
            start_date: '2012',
            end_date: '2015',
          },
          life_stages: [{
            stage_id: 's1',
            title: '初入职场',
            start_date: '2012',
            end_date: '2015',
          }],
          other_stories: [],
          transcript: [
            transcript('m1', 'assistant', '你刚才说大约是2012年，对吗？'),
            transcript('m2', 'user', '我后来想起来了，不是2012年，是2013年春节以后去的。'),
            transcript('m3', 'user', '公司宿舍在朝阳区，但具体小区名字我记不清了。'),
          ],
        },
      },
    },
    {
      name: 'interview.closeout/contributor',
      request: {
        runId: randomUUID(),
        taskType: 'interview.closeout',
        mode: 'contributor',
        ownerId,
        resource: {
          type: 'story_share',
          id: 'e2e-share-1',
          version: '2026-09-21T09:30:00.000Z',
        },
        schemaVersion: 'v1',
        payload: {
          mode: 'contributor',
          relationship: '女儿',
          previous_contributor_summary: null,
          transcript: [
            transcript('m1', 'assistant', '你记得他第一次去北京工作时是什么样吗？'),
            transcript('m2', 'user', '我只听家里人说过，他那时候一个人拖着很大的箱子去北京。'),
            transcript('m3', 'user', '具体是哪一年我不能确定，所以不要写成确定年份。'),
          ],
        },
      },
    },
    {
      name: 'story.completion',
      request: {
        runId: randomUUID(),
        taskType: 'story.completion',
        ownerId,
        resource: {
          type: 'story',
          id: 'e2e-completion-story',
          version: '2026-09-21T09:40:00.000Z',
        },
        schemaVersion: 'v1',
        payload: {
          title: '第一次独自去北京工作',
          agent_memory: [
            '用户在2013年春节以后第一次独自去北京工作。',
            '到北京站后天气很冷，拖着大箱子去公司安排的宿舍。',
            '宿舍在朝阳区，但小区名称记不清。',
          ].join('\n'),
          stage_title: '初入职场',
          current_status: 'interviewing',
          previous_gaps: ['当时为什么决定去北京？'],
          blocked_directions: ['宿舍具体小区名称：用户明确表示记不清'],
          session_count: 2,
        },
      },
    },
    {
      name: 'story.generation',
      request: {
        runId: randomUUID(),
        taskType: 'story.generation',
        ownerId,
        resource: {
          type: 'story',
          id: 'e2e-generation-story',
          version: '2026-09-21T09:50:00.000Z',
        },
        schemaVersion: 'v1',
        payload: {
          mode: 'initial',
          style: 'documentary',
          user_instruction: '保持第一人称，不补写没有依据的细节。',
          profile: { name: '林岚', profile_summary: '长期在杭州生活。' },
          life_stage: {
            title: '初入职场',
            start_date: '2012',
            end_date: '2015',
          },
          story: {
            title: '第一次独自去北京工作',
            summary: '2013年春节以后第一次独自去北京工作。',
          },
          selected_document: null,
          transcript: [
            { role: 'assistant', text: '第一次到北京时你最先记住的是什么？' },
            { role: 'user', text: '我记得出了北京站特别冷，我拖着一个大箱子去找公司安排的宿舍。' },
            { role: 'user', text: '后来我确认是2013年春节以后去的。宿舍在朝阳区，但具体小区名字记不清。' },
          ],
        },
      },
    },
  ];
}

async function main(): Promise<void> {
  if (!process.env.NEMOCLAW_SANDBOX?.trim()) {
    throw new Error('NEMOCLAW_SANDBOX is required for the real Agent E2E gate.');
  }

  const directory = mkdtempSync(path.join(tmpdir(), 'life-interview-phase2b-e2e-'));
  const databasePath = path.join(directory, 'memoir.db');
  const database = createDatabase(databasePath);
  try {
    runMigrations(database);
  } finally {
    database.close();
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AI_TASK_RUNTIME: 'agent',
    DATABASE_PATH: databasePath,
  };
  const tasks = createAgentTaskPort(env, { databasePath });
  if (!tasks) throw new Error('Agent runtime did not resolve to AgentTaskPort.');

  const ownerId = 'phase2b-e2e-owner';
  const results: CaseResult[] = [];
  try {
    for (const item of cases(ownerId)) {
      const started = Date.now();
      try {
        const result = await tasks.run(item.request);
        results.push({
          name: item.name,
          taskType: item.request.taskType,
          ...(item.request.mode ? { mode: item.request.mode } : {}),
          ok: true,
          latencyMs: Date.now() - started,
          runtime: result.runtime,
          output: result.output,
        });
        process.stdout.write(`PASS ${item.name}\n`);
      } catch (error) {
        results.push({
          name: item.name,
          taskType: item.request.taskType,
          ...(item.request.mode ? { mode: item.request.mode } : {}),
          ok: false,
          latencyMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        });
        process.stderr.write(`FAIL ${item.name}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }

    const report = {
      generatedAt: new Date().toISOString(),
      sandbox: process.env.NEMOCLAW_SANDBOX,
      provider: process.env.AGENT_PROVIDER ?? null,
      models: {
        default: process.env.AGENT_MODEL_DEFAULT ?? null,
        reasoning: process.env.AGENT_MODEL_REASONING ?? null,
        reasoningFast: process.env.AGENT_MODEL_REASONING_FAST ?? null,
        writing: process.env.AGENT_MODEL_WRITING ?? null,
      },
      passed: results.filter((item) => item.ok).length,
      total: results.length,
      results,
    };
    process.stdout.write(`LIFE_INTERVIEW_PHASE2B_E2E_REPORT ${JSON.stringify(report)}\n`);
    if (report.passed !== report.total) process.exitCode = 1;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
