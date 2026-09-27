import { randomUUID } from 'node:crypto';
import {
  type AgentTaskRequestUnion,
} from '../../src/agent-tasks/index.js';

export const SYNTHETIC_FIXTURE_CASE_IDS = [
  'onboarding.closeout',
  'interview.closeout/story_create',
  'interview.closeout/story_continue',
  'interview.closeout/contributor',
  'story.completion',
  'story.generation',
] as const;

export type SyntheticFixtureCaseId = (typeof SYNTHETIC_FIXTURE_CASE_IDS)[number];

export const SYNTHETIC_REGRESSION_CASE_IDS = [
  ...SYNTHETIC_FIXTURE_CASE_IDS,
  'onboarding.closeout/complete_profile',
  'onboarding.closeout/missing_birth_year',
  'onboarding.closeout/ambiguous_birth_place',
  'onboarding.closeout/unknown_birth_year',
  'interview.closeout/story_create/explicit_date',
  'interview.closeout/story_create/ambiguous_date',
  'interview.closeout/story_create/multiple_events',
  'interview.closeout/story_continue/refine_fact',
  'interview.closeout/story_continue/deny_fact',
  'interview.closeout/story_continue/uncertainty',
  'interview.closeout/story_continue/new_gap',
  'interview.closeout/contributor/firsthand',
  'interview.closeout/contributor/hearsay',
  'interview.closeout/contributor/conflict',
  'story.completion/insufficient',
  'story.completion/complete',
  'story.generation/revision',
  'story.generation/unknown_place',
] as const;

export type SyntheticRegressionCaseId = (typeof SYNTHETIC_REGRESSION_CASE_IDS)[number];

export interface SyntheticAgentFixture {
  caseId: SyntheticRegressionCaseId;
  request: AgentTaskRequestUnion;
}

function transcript(messageId: string, role: 'user' | 'assistant', text: string) {
  return {
    message_id: messageId,
    role,
    text,
    timestamp: '2026-09-21T10:00:00.000Z',
  };
}

export function createSyntheticFixtureRegistry(
  ownerId: string,
  runIdFactory: () => string = randomUUID,
): ReadonlyMap<SyntheticFixtureCaseId, SyntheticAgentFixture> {
  const fixtures: SyntheticAgentFixture[] = [
    {
      caseId: 'onboarding.closeout',
      request: {
        runId: runIdFactory(),
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
      caseId: 'interview.closeout/story_create',
      request: {
        runId: runIdFactory(),
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
      caseId: 'interview.closeout/story_continue',
      request: {
        runId: runIdFactory(),
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
      caseId: 'interview.closeout/contributor',
      request: {
        runId: runIdFactory(),
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
      caseId: 'story.completion',
      request: {
        runId: runIdFactory(),
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
      caseId: 'story.generation',
      request: {
        runId: runIdFactory(),
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

  const registry = new Map<SyntheticFixtureCaseId, SyntheticAgentFixture>(
    fixtures.map((fixture) => [fixture.caseId as SyntheticFixtureCaseId, fixture] as const),
  );
  if (registry.size !== SYNTHETIC_FIXTURE_CASE_IDS.length) {
    throw new Error('Synthetic Agent fixture registry must contain six unique cases.');
  }
  return registry;
}

export function listSyntheticFixtures(ownerId: string): SyntheticAgentFixture[] {
  return [...createSyntheticFixtureRegistry(ownerId).values()];
}

function addRegressionVariant(
  registry: Map<SyntheticRegressionCaseId, SyntheticAgentFixture>,
  caseId: SyntheticRegressionCaseId,
  baseCaseId: SyntheticFixtureCaseId,
  runIdFactory: () => string,
  mutate: (payload: Record<string, unknown>) => void,
): void {
  const base = registry.get(baseCaseId);
  if (!base) throw new Error(`Missing base fixture for ${caseId}: ${baseCaseId}`);
  const request = structuredClone(base.request) as AgentTaskRequestUnion;
  request.runId = runIdFactory();
  request.resource = {
    ...request.resource,
    id: `${request.resource.id}-${caseId.replaceAll('/', '-')}`,
  };
  mutate(request.payload as unknown as Record<string, unknown>);
  registry.set(caseId, { caseId, request });
}

export function createSyntheticRegressionRegistry(
  ownerId: string,
  runIdFactory: () => string = randomUUID,
): ReadonlyMap<SyntheticRegressionCaseId, SyntheticAgentFixture> {
  const registry = new Map(
    [...createSyntheticFixtureRegistry(ownerId, runIdFactory).entries()]
      .map(([caseId, fixture]) => [caseId, fixture] as const),
  ) as Map<SyntheticRegressionCaseId, SyntheticAgentFixture>;

  addRegressionVariant(registry, 'onboarding.closeout/complete_profile', 'onboarding.closeout', runIdFactory, (payload) => {
    payload.current_profile = {
      name: '林岚',
      birth_year: 1990,
      gender: '女',
      birth_place: '宁波',
      current_location: '杭州',
      current_status: '产品经理',
      profile_summary: '长期在杭州生活。',
    };
  });
  addRegressionVariant(registry, 'onboarding.closeout/missing_birth_year', 'onboarding.closeout', runIdFactory, (payload) => {
    const interviews = payload.interviews as Array<{ transcript: Array<{ role: string; text: string }> }>;
    interviews[0].transcript[1].text = '我叫林岚，现在住在杭州，出生年份记不清了。';
  });
  addRegressionVariant(registry, 'onboarding.closeout/ambiguous_birth_place', 'onboarding.closeout', runIdFactory, (payload) => {
    const interviews = payload.interviews as Array<{ transcript: Array<{ role: string; text: string }> }>;
    interviews[0].transcript[1].text = '我叫林岚，1990年出生，应该是宁波，但也可能是附近的县城。';
  });
  addRegressionVariant(registry, 'onboarding.closeout/unknown_birth_year', 'onboarding.closeout', runIdFactory, (payload) => {
    const interviews = payload.interviews as Array<{ transcript: Array<{ role: string; text: string }> }>;
    interviews[0].transcript[1].text = '我叫林岚，出生年份我确实不知道，现在住在杭州。';
  });

  addRegressionVariant(registry, 'interview.closeout/story_create/explicit_date', 'interview.closeout/story_create', runIdFactory, (payload) => {
    const transcript = payload.transcript as Array<{
      role: 'user' | 'assistant';
      message_id: string;
      text: string;
      timestamp: string;
    }>;
    transcript[2].text = '后来我确认是2013年2月15日到的北京。';
  });
  addRegressionVariant(registry, 'interview.closeout/story_create/ambiguous_date', 'interview.closeout/story_create', runIdFactory, (payload) => {
    const transcript = payload.transcript as Array<{
      role: 'user' | 'assistant';
      message_id: string;
      text: string;
      timestamp: string;
    }>;
    transcript[2].text = '具体哪一天记不清了，大概是2012年底到2013年初。';
  });
  addRegressionVariant(registry, 'interview.closeout/story_create/multiple_events', 'interview.closeout/story_create', runIdFactory, (payload) => {
    const transcript = payload.transcript as Array<{
      role: 'user' | 'assistant';
      message_id: string;
      text: string;
      timestamp: string;
    }>;
    transcript.push({
      role: 'user',
      message_id: 'm4',
      text: '后来我又换了部门，第一次领到工资也发生在那段时间。',
      timestamp: '2026-09-21T10:01:00.000Z',
    });
  });

  addRegressionVariant(registry, 'interview.closeout/story_continue/refine_fact', 'interview.closeout/story_continue', runIdFactory, (payload) => {
    const transcript = payload.transcript as Array<{ role: 'user' | 'assistant'; text: string }>;
    transcript[2].text = '公司宿舍在朝阳区，应该靠近地铁，但具体小区名字还是记不清。';
  });
  addRegressionVariant(registry, 'interview.closeout/story_continue/deny_fact', 'interview.closeout/story_continue', runIdFactory, (payload) => {
    const transcript = payload.transcript as Array<{ role: 'user' | 'assistant'; text: string }>;
    transcript[1].text = '我后来想起来了，不是2012年，也不是2013年，是2014年春节以后去的。';
  });
  addRegressionVariant(registry, 'interview.closeout/story_continue/uncertainty', 'interview.closeout/story_continue', runIdFactory, (payload) => {
    const transcript = payload.transcript as Array<{ role: 'user' | 'assistant'; text: string }>;
    transcript[2].text = '公司宿舍大概在朝阳区，具体小区名字和门牌号都记不清了。';
  });
  addRegressionVariant(registry, 'interview.closeout/story_continue/new_gap', 'interview.closeout/story_continue', runIdFactory, (payload) => {
    const transcript = payload.transcript as Array<{
      role: 'user' | 'assistant';
      message_id: string;
      text: string;
      timestamp: string;
    }>;
    transcript.push({
      role: 'user',
      message_id: 'm4',
      text: '我还想起那天是和同事一起去的，但同事的名字想不起来。',
      timestamp: '2026-09-21T10:01:00.000Z',
    });
  });

  addRegressionVariant(registry, 'interview.closeout/contributor/firsthand', 'interview.closeout/contributor', runIdFactory, (payload) => {
    payload.relationship = '同事';
    const transcript = payload.transcript as Array<{ text: string }>;
    transcript[1].text = '我亲眼见过他拖着大箱子到北京站。';
  });
  addRegressionVariant(registry, 'interview.closeout/contributor/hearsay', 'interview.closeout/contributor', runIdFactory, (payload) => {
    const transcript = payload.transcript as Array<{ text: string }>;
    transcript[1].text = '我听家里人说，他那时候一个人拖着很大的箱子去北京。';
  });
  addRegressionVariant(registry, 'interview.closeout/contributor/conflict', 'interview.closeout/contributor', runIdFactory, (payload) => {
    const transcript = payload.transcript as Array<{ text: string }>;
    transcript[1].text = '我听说他是2014年去的北京，但他自己记得是2013年，所以我不能确定。';
  });

  addRegressionVariant(registry, 'story.completion/insufficient', 'story.completion', runIdFactory, (payload) => {
    payload.agent_memory = '只知道用户曾经去过北京工作。';
    payload.previous_gaps = [];
    payload.blocked_directions = [];
    payload.session_count = 1;
  });
  addRegressionVariant(registry, 'story.completion/complete', 'story.completion', runIdFactory, (payload) => {
    payload.current_status = 'complete';
    payload.previous_gaps = [];
    payload.blocked_directions = [];
    payload.session_count = 4;
  });

  addRegressionVariant(registry, 'story.generation/revision', 'story.generation', runIdFactory, (payload) => {
    payload.mode = 'revision';
    payload.story = { title: '第一次独自去北京工作' };
    payload.selected_document = {
      title: '第一次独自去北京工作',
      content: '2013年春节以后，我第一次独自去北京工作。',
    };
  });
  addRegressionVariant(registry, 'story.generation/unknown_place', 'story.generation', runIdFactory, (payload) => {
    const transcript = payload.transcript as Array<{ role: string; text: string }>;
    transcript[2].text = '后来我确认是2013年春节以后去的。宿舍大概在朝阳区，具体小区名字记不清。';
  });

  if (registry.size !== SYNTHETIC_REGRESSION_CASE_IDS.length) {
    throw new Error('Synthetic regression fixture registry must contain 24 unique cases.');
  }
  return registry;
}
