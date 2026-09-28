import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BailianRealtimeCoach, buildRealtimeCoachGateInput } from '../../src/realtime/coach/service.js';
import { StoryInterviewContextBuilder } from '../../src/interview/context/story-interview-context.js';
import type { CoachGateInput } from '../../src/realtime/coach/types.js';
import type { RealtimeInterviewContext } from '../../src/realtime/prompt.js';
import type { NextQuestionCase } from './cases.js';

interface NextQuestionFixtureManifest {
  database_path: string;
  owner_id: string;
  stage_id: string;
  story_id: string;
  session_ids: string[];
  retriever_collection: string;
  story_context: {
    story_title: string;
    story_status: string;
    life_stage_title: string;
    life_stage_start_date: string;
    life_stage_end_date: string;
    story_summary: string;
    agent_memory: string;
  };
}

const fixtureContext = JSON.parse(readFileSync(new URL('./fixture-context.json', import.meta.url), 'utf8')) as {
  story_title: string;
  story_status: string;
  life_stage_title: string;
  life_stage_start_date: string;
  life_stage_end_date: string;
  story_summary: string;
  agent_memory: string;
};

export const STORY_SUMMARY = fixtureContext.story_summary;
export const AGENT_MEMORY = fixtureContext.agent_memory;

export function loadNextQuestionFixture(): NextQuestionFixtureManifest {
  const manifestPath = process.env.NEXT_QUESTION_BENCHMARK_FIXTURE_MANIFEST?.trim()
    || fileURLToPath(new URL('../../data/next-question-benchmark/fixture.json', import.meta.url));
  const fixture = JSON.parse(readFileSync(manifestPath, 'utf8')) as NextQuestionFixtureManifest;
  const databasePath = path.resolve(path.dirname(manifestPath), fixture.database_path);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (!uuid.test(fixture.owner_id) || !uuid.test(fixture.story_id) || !uuid.test(fixture.stage_id)
    || !fixture.database_path || !fixture.retriever_collection || fixture.session_ids.length !== 6) {
    throw new Error('NEXT_QUESTION_FIXTURE_MANIFEST_INVALID');
  }
  if (fixture.story_context.story_summary !== STORY_SUMMARY || fixture.story_context.agent_memory !== AGENT_MEMORY) {
    throw new Error('NEXT_QUESTION_FIXTURE_CONTEXT_MISMATCH');
  }
  return { ...fixture, database_path: databasePath };
}

function coachSettings(envVars: NodeJS.ProcessEnv) {
  const apiKey = envVars.REALTIME_COACH_API_KEY?.trim() || envVars.BAILIAN_API_KEY?.trim();
  if (!apiKey) throw new Error('B/C require REALTIME_COACH_API_KEY or BAILIAN_API_KEY.');
  const provider = envVars.REALTIME_COACH_PROVIDER?.trim() || 'openai-compatible';
  if (provider !== 'openai-compatible') throw new Error('REALTIME_COACH_PROVIDER must be openai-compatible.');
  const requestDialect = envVars.REALTIME_COACH_REQUEST_DIALECT?.trim() || 'dashscope';
  if (requestDialect !== 'dashscope' && requestDialect !== 'vllm') {
    throw new Error('REALTIME_COACH_REQUEST_DIALECT must be dashscope or vllm.');
  }
  return {
    provider,
    apiKey,
    baseUrl: envVars.REALTIME_COACH_BASE_URL?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: envVars.REALTIME_COACH_MODEL?.trim() || 'qwen3-8b',
    requestDialect,
  } as const;
}

export function createRealtimeCoach(envVars: NodeJS.ProcessEnv): BailianRealtimeCoach {
  return new BailianRealtimeCoach(coachSettings(envVars));
}

export function realtimeCoachDiagnostics(
  envVars: NodeJS.ProcessEnv,
  gateTimeoutMs: number,
  totalTimeoutMs: number,
): Record<string, string | number> {
  const settings = coachSettings(envVars);
  let baseUrlHost = 'invalid-url';
  try { baseUrlHost = new URL(settings.baseUrl).hostname || baseUrlHost; } catch { /* sanitized diagnostic only */ }
  return {
    coach_model: settings.model,
    request_dialect: settings.requestDialect,
    base_url_host: baseUrlHost,
    gate_timeout_ms: gateTimeoutMs,
    total_timeout_ms: totalTimeoutMs,
  };
}

export function coachErrorDetails(error: unknown, envVars: NodeJS.ProcessEnv): { code: string; message: string } {
  const candidate = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
  const code = typeof candidate.code === 'string' && /^[A-Z0-9_]{1,96}$/u.test(candidate.code)
    ? candidate.code
    : error instanceof Error && /^[A-Z][A-Za-z0-9]{0,95}$/u.test(error.name) ? error.name : 'UNKNOWN_ERROR';
  const apiKey = envVars.REALTIME_COACH_API_KEY?.trim() || envVars.BAILIAN_API_KEY?.trim() || '';
  const rawMessage = typeof candidate.message === 'string' ? candidate.message : String(error);
  const message = rawMessage
    .split(apiKey).join(apiKey ? '[redacted]' : '')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .slice(0, 500);
  return { code, message };
}

export function makeNextQuestionContext(ownerId: string, storyId: string, databasePath: string): RealtimeInterviewContext {
  const prepared = new StoryInterviewContextBuilder(databasePath).build(ownerId, { mode: 'continue', storyId });
  if (!prepared.story
    || prepared.life_stage.title !== fixtureContext.life_stage_title
    || prepared.life_stage.start_date !== fixtureContext.life_stage_start_date
    || prepared.life_stage.end_date !== fixtureContext.life_stage_end_date
    || prepared.life_stage.summary !== STORY_SUMMARY
    || prepared.story.title !== fixtureContext.story_title
    || prepared.story.status !== fixtureContext.story_status
    || prepared.story.summary !== STORY_SUMMARY
    || prepared.story.agent_memory !== AGENT_MEMORY) {
    throw new Error('NEXT_QUESTION_FIXTURE_CONTEXT_MISMATCH');
  }
  return {
    ...prepared,
    voiceProfile: 'stepaudio2_mini',
    memoryTriggerMode: 'supervisor_auto',
  };
}

export function buildCaseGateInput(
  context: RealtimeInterviewContext,
  item: NextQuestionCase,
): CoachGateInput {
  return buildRealtimeCoachGateInput(context, {
    lastAssistantQuestion: item.previousQuestion,
    currentUserAnswer: item.userAnswer,
    recentContext: [{ role: 'assistant', text: item.previousQuestion }],
  });
}
