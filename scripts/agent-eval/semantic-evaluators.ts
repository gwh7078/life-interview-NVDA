import type { AgentTaskRequestUnion } from '../../src/agent-tasks/index.js';

export interface SemanticCheck {
  name: string;
  passed: boolean;
  detail: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '', undefined, 0);
}

function check(name: string, passed: boolean, detail: string): SemanticCheck {
  return { name, passed, detail };
}

function userMessageIds(request: AgentTaskRequestUnion): string[] {
  if (request.taskType === 'onboarding.closeout') return [];
  if (request.taskType === 'story.completion') return [];
  if (request.taskType === 'story.generation') return [];
  return request.payload.transcript
    .filter((message) => message.role === 'user')
    .map((message) => message.message_id);
}

function yearsIn(value: string): string[] {
  return value.match(/(?:19|20)\d{2}/gu) ?? [];
}

export function evaluateSyntheticSemantics(
  request: AgentTaskRequestUnion,
  output: unknown,
  caseId = '',
): SemanticCheck[] {
  const result = record(output);

  if (request.taskType === 'onboarding.closeout') {
    const profile = record(result.profile);
    const name = record(profile.name).value;
    const birthYear = record(profile.birth_year).value;
    const location = record(profile.current_location).value;
    const unknownBirthYear =
      caseId.endsWith('/missing_birth_year') ||
      caseId.endsWith('/unknown_birth_year');
    const expectedBirthYear = unknownBirthYear ? null : 1990;
    const checks = [
      check('onboarding.name', name === '林岚',
        'extracts the synthetic profile name from the transcript'),
      check('onboarding.current_location', location === '杭州',
        'preserves the synthetic current location'),
    ];
    if (caseId.endsWith('/ambiguous_birth_place')) {
      checks.push(check('onboarding.ambiguous_birth_place',
        record(profile.birth_place).value === null || /宁波|附近/u.test(text(record(profile.birth_place).value)),
        'keeps an ambiguous birth place qualified'));
    } else if (caseId.endsWith('/missing_birth_year') || caseId.endsWith('/unknown_birth_year')) {
      checks.push(check('onboarding.unknown_birth_year', birthYear === null,
        'does not invent a birth year the user does not know'));
    } else {
      checks.push(check('onboarding.birth_year', birthYear === expectedBirthYear,
        'preserves the synthetic birth year'));
    }
    return checks;
  }

  if (request.taskType === 'interview.closeout' && request.mode === 'story_create') {
    const story = record(result.story);
    const sourceIds = Array.isArray(story.source_message_ids) ? story.source_message_ids : [];
    const validSources = userMessageIds(request);
    return [
      check('story_create.title', story.title === request.payload.target_story_title,
        'keeps the requested story title'),
      check('story_create.source_refs', sourceIds.some((id) => validSources.includes(String(id))),
        'uses a current user message as evidence'),
      check('story_create.beijing_fact', /北京/u.test(`${text(story.summary)} ${text(story.agent_memory)}`),
        'retains the explicitly mentioned Beijing fact'),
    ];
  }

  if (request.taskType === 'interview.closeout' && request.mode === 'story_continue') {
    const story = record(result.current_story);
    const memory = text(story.agent_memory);
    const changes = Array.isArray(story.memory_changes) ? story.memory_changes.map(record) : [];
    const correction = changes.find((item) => item.type === 'correct');
    const expectedYear = caseId.endsWith('/deny_fact') ? '2014' : '2013';
    return [
      check('story_continue.correction_recorded', Boolean(correction),
        'records a correction change rather than silently overwriting history'),
      check('story_continue.correction_value',
        /2012/u.test(text(correction?.previous_text)) && new RegExp(expectedYear, 'u').test(text(correction?.new_text)),
        `changes the synthetic year from 2012 to ${expectedYear}`),
      check('story_continue.uncertainty_preserved',
        /朝阳区/u.test(memory) && /(记不清|不确定)/u.test(memory),
        'keeps the unknown residential detail uncertain'),
    ];
  }

  if (request.taskType === 'interview.closeout' && request.mode === 'contributor') {
    const summary = text(result.summary);
    const firsthand = caseId.endsWith('/firsthand');
    return [
      check('contributor.source_distance', firsthand
        ? /(亲眼|亲自|见过)/u.test(summary)
        : /(听说|听家里人|家里人|只听)/u.test(summary),
      firsthand
        ? 'preserves that the contributor witnessed the detail'
        : 'preserves that the contributor heard the detail from others'),
      check('contributor.uncertain_year', yearsIn(summary).length === 0,
        'does not turn an uncertain year into a concrete year'),
    ];
  }

  if (request.taskType === 'story.generation') {
    const content = text(result.content);
    const allowedYears = new Set(yearsIn(JSON.stringify(request.payload)));
    const unsupportedYears = yearsIn(content).filter((year) => !allowedYears.has(year));
    return [
      check('generation.first_person', /我/u.test(content),
        'keeps the synthetic generation in first person'),
      check('generation.source_facts', /2013/u.test(content) && /北京/u.test(content),
        'retains the explicitly supported year and place'),
      check('generation.no_new_years', unsupportedYears.length === 0,
        'does not introduce an unsupported concrete year'),
    ];
  }

  return [];
}
