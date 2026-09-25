import { externalContributorRelationshipLabel } from '../../interview/external-contributor/relationship.js';
import type { RealtimeInterviewContext } from '../prompt.js';
import { CONTRIBUTOR_COACH_POLICY } from './prompts/contributor.js';
import { ONBOARDING_COACH_POLICY } from './prompts/onboarding.js';
import { REALTIME_COACH_CORE, REALTIME_COACH_GATE_CONTRACT, REALTIME_COACH_RESOLVE } from './prompts/core.js';
import { STORY_CREATE_COACH_POLICY } from './prompts/story-create.js';
import { STORY_CONTINUE_COACH_POLICY } from './prompts/story-continue.js';
import type {
  CoachAction,
  CoachEvidence,
  CoachGateInput,
  CoachGateResult,
  CoachReason,
  CoachResolveInput,
  CoachScenario,
  RealtimeCoachPort,
} from './types.js';

export interface RealtimeCoachConfig {
  provider: 'openai-compatible';
  baseUrl: string;
  model: string;
  apiKey?: string;
}

const SCENARIO_POLICIES: Record<CoachScenario, string> = {
  onboarding: ONBOARDING_COACH_POLICY,
  story_create: STORY_CREATE_COACH_POLICY,
  story_continue: STORY_CONTINUE_COACH_POLICY,
  contributor: CONTRIBUTOR_COACH_POLICY,
};
const ACTIONS: CoachAction[] = ['none', 'guide', 'correct'];
const REASONS: CoachReason[] = [
  'normal', 'repeated_question', 'direction_drift', 'history_reference',
  'possible_conflict', 'missing_key_detail', 'scenario_boundary',
];

function row(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function clip(value: string, maxChars: number): string {
  const chars = Array.from(value.trim());
  return chars.length <= maxChars ? chars.join('') : chars.slice(0, maxChars).join('');
}

function definedText(source: Record<string, unknown>, keys: readonly string[], maxChars: number): Record<string, string> {
  return Object.fromEntries(keys.flatMap((key) => {
    const value = source[key];
    return typeof value === 'string' && value.trim() ? [[key, clip(value, maxChars)]] : [];
  }));
}

function scenarioFor(context: RealtimeInterviewContext): CoachScenario {
  if (context.interview_type === 'onboarding') return 'onboarding';
  if (context.interview_type === 'external_contributor') return 'contributor';
  return context.task_context?.mode === 'create' || !context.story ? 'story_create' : 'story_continue';
}

function onboardingHistory(context: Extract<RealtimeInterviewContext, { interview_type: 'onboarding' }>): Array<{ role: string; text: string }> {
  const recent = context.previousOnboardingTranscripts.flatMap((transcript) => transcript.messages).slice(-4);
  let remaining = 800;
  const output: Array<{ role: string; text: string }> = [];
  for (const message of recent.reverse()) {
    if (remaining <= 0) break;
    const text = clip(message.text, remaining);
    if (!text) continue;
    output.push({ role: message.role, text });
    remaining -= Array.from(text).length;
  }
  return output.reverse();
}

function scenarioState(context: RealtimeInterviewContext): Record<string, unknown> {
  if (context.interview_type === 'onboarding') {
    return {
      mode: context.taskContext.mode,
      profile: definedText(context.profile, ['name', 'birth_place', 'birth_date', 'current_city', 'current_status', 'occupation'], 100),
      onboarding_history: onboardingHistory(context),
    };
  }
  if (context.interview_type === 'external_contributor') {
    return {
      relationship: externalContributorRelationshipLabel(context.relationship),
      subject_name: context.subject.name ? clip(context.subject.name, 80) : '',
      story_summary: clip(context.story.summary, 500),
      contributor_summary: clip(context.contributor_summary, 400),
    };
  }
  const scenario = scenarioFor(context);
  const story = context.story;
  return {
    ...(context.task_context?.target_title ? { target_title: clip(context.task_context.target_title, 120) } : {}),
    life_stage: definedText(context.life_stage, ['title', 'start_date', 'end_date'], 100),
    ...(scenario === 'story_continue' && story ? {
      current_story: {
        title: clip(String(story.title ?? ''), 120),
        status: clip(String(story.status ?? ''), 50),
        agent_memory: clip(String(story.agent_memory ?? ''), 1_000),
        gaps: Array.isArray(story.gaps)
          ? story.gaps.filter((gap): gap is string => typeof gap === 'string').slice(0, 2).map((gap) => clip(gap, 120))
          : [],
      },
    } : {}),
  };
}

/** Constructs the bounded Pass A view; it never receives the full current Session Transcript. */
export function buildRealtimeCoachGateInput(
  context: RealtimeInterviewContext,
  input: {
    lastAssistantQuestion?: string | null;
    currentUserAnswer: string;
    recentContext: CoachGateInput['boundedRecentContext'];
  },
): CoachGateInput {
  let remaining = 1_600;
  const boundedRecentContext: CoachGateInput['boundedRecentContext'] = [];
  for (const message of input.recentContext.slice(-6).reverse()) {
    if (remaining <= 0) break;
    const text = clip(message.text, Math.min(500, remaining));
    if (!text) continue;
    boundedRecentContext.push({ role: message.role, text });
    remaining -= Array.from(text).length;
  }
  boundedRecentContext.reverse();
  return {
    scenario: scenarioFor(context),
    lastAssistantQuestion: input.lastAssistantQuestion?.trim()
      ? clip(input.lastAssistantQuestion, 300)
      : null,
    currentUserAnswer: clip(input.currentUserAnswer, 600),
    boundedRecentContext,
    scenarioState: scenarioState(context),
  };
}

function parseModelObject(content: unknown): Record<string, unknown> {
  if (typeof content !== 'string') throw Object.assign(new Error('Coach output is not JSON text.'), { code: 'REALTIME_COACH_OUTPUT_INVALID' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim());
  } catch {
    const unfenced = content.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
    try { parsed = JSON.parse(unfenced); }
    catch { throw Object.assign(new Error('Coach output is not valid JSON.'), { code: 'REALTIME_COACH_OUTPUT_INVALID' }); }
  }
  const object = row(parsed);
  if (!object) throw Object.assign(new Error('Coach output must be a JSON object.'), { code: 'REALTIME_COACH_OUTPUT_INVALID' });
  return object;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.length === Object.keys(value).length && keys.every((key) => Object.hasOwn(value, key));
}

function nullableText(value: unknown, maxChars: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return clip(value, maxChars);
}

function parseGate(value: unknown, scenario: CoachScenario): CoachGateResult {
  const object = row(value);
  const keys = ['action', 'retrieve', 'query', 'reason', 'avoid', 'direction'];
  if (!object) throw Object.assign(new Error('Coach Gate output is not an object.'), { code: 'REALTIME_COACH_OUTPUT_INVALID' });
  if (!exactKeys(object, keys)) throw Object.assign(new Error('Coach Gate output has the wrong keys.'), { code: 'REALTIME_COACH_OUTPUT_INVALID' });
  if (!ACTIONS.includes(object.action as CoachAction)
    || typeof object.retrieve !== 'boolean'
    || !REASONS.includes(object.reason as CoachReason)) {
    throw Object.assign(new Error('Coach Gate output has an invalid action, retrieve, or reason field.'), { code: 'REALTIME_COACH_OUTPUT_INVALID' });
  }
  const query = nullableText(object.query, 200);
  const avoid = nullableText(object.avoid, 120);
  const direction = nullableText(object.direction, 120);
  if (query === undefined || avoid === undefined || direction === undefined) {
    throw Object.assign(new Error('Coach Gate text fields violate their limits.'), { code: 'REALTIME_COACH_OUTPUT_INVALID' });
  }
  if (direction && !/[\u3400-\u9fff]/u.test(direction)) {
    throw Object.assign(new Error('Coach Gate direction violates its Chinese-language contract.'), { code: 'REALTIME_COACH_OUTPUT_INVALID' });
  }
  const action = object.action as CoachAction;
  const reason = object.reason as CoachReason;
  if (action === 'none') {
    if (object.retrieve || query !== null || avoid !== null || direction !== null || reason !== 'normal') {
      throw Object.assign(new Error('A non-intervening Coach Gate must return the normal empty result.'), { code: 'REALTIME_COACH_OUTPUT_INVALID' });
    }
  } else {
    const violations = [
      ...(!direction ? ['direction_missing'] : []),
      ...(reason === 'normal' ? ['intervention_reason_is_normal'] : []),
      ...(object.retrieve && scenario === 'story_continue' && !query ? ['retrieval_query_missing'] : []),
    ];
    if (violations.length) {
      throw Object.assign(new Error(`Coach Gate requested an invalid intervention (${violations.join(',')}).`), { code: 'REALTIME_COACH_OUTPUT_INVALID' });
    }
  }
  const retrieve = action !== 'none' && scenario === 'story_continue' && object.retrieve;
  return { action, retrieve, query: retrieve ? query : null, reason, avoid, direction };
}

function stringList(value: unknown, maxItems: number, maxChars: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems
    || value.some((item) => typeof item !== 'string' || !item.trim())) return undefined;
  return value.map((item) => clip(item as string, maxChars));
}

function parsePacket(value: unknown, input: CoachResolveInput): import('./types.js').CoachPacket {
  const object = row(value);
  const keys = ['selected_evidence_ids', 'known', 'conflict', 'avoid', 'direction'];
  if (!object || !exactKeys(object, keys)) {
    throw Object.assign(new Error('Coach Resolve output violates its schema.'), { code: 'REALTIME_COACH_OUTPUT_INVALID' });
  }
  const selectedEvidenceIds = stringList(object.selected_evidence_ids, 2, 20);
  const known = stringList(object.known, 2, 120);
  const conflict = nullableText(object.conflict, 120);
  const avoid = nullableText(object.avoid, 120);
  const direction = nullableText(object.direction, 120);
  const evidenceIds = new Set(input.evidence.map((item) => item.id));
  if (!selectedEvidenceIds || !known || conflict === undefined || avoid === undefined || direction === undefined
    || new Set(selectedEvidenceIds).size !== selectedEvidenceIds.length
    || selectedEvidenceIds.some((id) => !evidenceIds.has(id))) {
    throw Object.assign(new Error('Coach Resolve selected unsupported or oversized evidence.'), { code: 'REALTIME_COACH_OUTPUT_INVALID' });
  }
  return { selectedEvidenceIds, known, conflict, avoid, direction };
}

export class BailianRealtimeCoach implements RealtimeCoachPort {
  constructor(
    private readonly config: RealtimeCoachConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  evaluate(input: CoachGateInput, options: { signal?: AbortSignal } = {}): Promise<CoachGateResult> {
    return this.complete({
      system: `${REALTIME_COACH_CORE}\n\n${REALTIME_COACH_GATE_CONTRACT}\n\n${SCENARIO_POLICIES[input.scenario]}`,
      user: JSON.stringify(input),
      maxTokens: 220,
      signal: options.signal,
    }).then((output) => parseGate(output, input.scenario));
  }

  resolve(input: CoachResolveInput, options: { signal?: AbortSignal } = {}): Promise<import('./types.js').CoachPacket> {
    return this.complete({
      system: `${REALTIME_COACH_CORE}\n\n${SCENARIO_POLICIES[input.scenario]}\n\n${REALTIME_COACH_RESOLVE}`,
      user: JSON.stringify(input),
      maxTokens: 320,
      signal: options.signal,
    }).then((output) => parsePacket(output, input));
  }

  private async complete(input: {
    system: string;
    user: string;
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>> {
    if (!this.config.apiKey) throw Object.assign(new Error('Realtime Coach is not configured.'), { code: 'REALTIME_COACH_NOT_CONFIGURED' });
    const baseUrl = this.config.baseUrl.trim().replace(/\/+$/u, '');
    const response = await this.fetcher(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
      },
      signal: input.signal,
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
        response_format: { type: 'json_object' },
        enable_thinking: false,
        temperature: 0,
        max_tokens: input.maxTokens,
        stream: false,
      }),
    });
    if (!response.ok) {
      throw Object.assign(new Error(`Realtime Coach HTTP ${response.status}.`), {
        code: `REALTIME_COACH_HTTP_${response.status}`,
      });
    }
    let responseBody: unknown;
    try { responseBody = await response.json(); }
    catch { throw Object.assign(new Error('Realtime Coach response is invalid.'), { code: 'REALTIME_COACH_OUTPUT_INVALID' }); }
    const choices = row(responseBody)?.choices;
    const message = Array.isArray(choices) ? row(row(choices[0])?.message) : undefined;
    return parseModelObject(message?.content);
  }
}
