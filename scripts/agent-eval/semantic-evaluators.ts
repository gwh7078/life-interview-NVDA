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
  if (request.taskType === 'interview.context_hint') return [];
  return request.payload.transcript
    .filter((message) => message.role === 'user')
    .map((message) => message.message_id);
}

function yearsIn(value: string): string[] {
  return value.match(/(?:19|20)\d{2}/gu) ?? [];
}

function storyText(story: Record<string, unknown>): string {
  return [story.summary, story.agent_memory].map(text).join('\n');
}

function hasConcreteDate(value: string): boolean {
  return /(?:19|20)\d{2}[年/-]\d{1,2}[月/-]\d{1,2}(?:日)?/u.test(value);
}

function unsupportedPlaceNames(value: string): string[] {
  const generic = new Set(['具体小区', '某个小区', '一个小区', '宿舍小区']);
  return (value.match(/[\u4e00-\u9fa5]{2,12}(?:小区|花园|公寓)/gu) ?? [])
    .filter((candidate) => !generic.has(candidate));
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
    const content = storyText(story);
    const checks = [
      check('story_create.title', story.title === request.payload.target_story_title,
        'keeps the requested story title'),
      check('story_create.source_refs', sourceIds.some((id) => validSources.includes(String(id))),
        'uses a current user message as evidence'),
      check('story_create.beijing_fact', /北京/u.test(content),
        'retains the explicitly mentioned Beijing fact'),
    ];
    if (caseId.endsWith('/explicit_date')) {
      checks.push(check('story_create.explicit_date', /2013年2月15日|2013年02月15日|2013-02-15/u.test(content),
        'retains the confirmed synthetic date'));
    } else if (caseId.endsWith('/ambiguous_date')) {
      checks.push(
        check('story_create.ambiguous_date', /(大概|左右|年底|年初|记不清|不确定)/u.test(content),
          'keeps the synthetic date qualified'),
        check('story_create.no_concrete_ambiguous_date', !hasConcreteDate(content),
          'does not turn an ambiguous date into a precise date'),
      );
    } else if (caseId.endsWith('/multiple_events')) {
      checks.push(
        check('story_create.department_change', /换了?部门|换部门|调到.*部门/u.test(content),
          'retains the additional department change'),
        check('story_create.first_pay', /工资|领到.*钱/u.test(content),
          'retains the additional first-pay event'),
      );
    }
    return checks;
  }

  if (request.taskType === 'interview.closeout' && request.mode === 'story_continue') {
    const story = record(result.current_story);
    const memory = text(story.agent_memory);
    const changes = Array.isArray(story.memory_changes) ? story.memory_changes.map(record) : [];
    const correction = changes.find((item) => item.type === 'correct');
    const expectedYear = caseId.endsWith('/deny_fact') ? '2014' : '2013';
    const checks = [
      check('story_continue.correction_recorded', Boolean(correction),
        'records a correction change rather than silently overwriting history'),
      check('story_continue.correction_value',
        /2012|2013/u.test(text(correction?.previous_text)) && new RegExp(expectedYear, 'u').test(text(correction?.new_text)),
        `changes the synthetic year from 2012 to ${expectedYear}`),
      check('story_continue.uncertainty_preserved',
        /朝阳区/u.test(memory) && /(记不清|不确定)/u.test(memory),
        'keeps the unknown residential detail uncertain'),
    ];
    if (caseId.endsWith('/deny_fact')) {
      checks.push(check('story_continue.denied_year_replaced',
        /2014/u.test(memory) && !/(?:2012|2013)(?:年|年前后|年以后)/u.test(memory),
        'uses 2014 as the current year and removes superseded certainty'));
    } else if (caseId.endsWith('/refine_fact')) {
      checks.push(check('story_continue.refined_detail', /地铁|靠近地铁/u.test(memory),
        'retains the newly refined transit detail'));
    } else if (caseId.endsWith('/new_gap')) {
      checks.push(check('story_continue.unknown_contributor_name',
        /同事/u.test(memory) && /(名字|姓名).*(想不起来|记不清|不确定)/u.test(memory),
        'records the new person fact without inventing a name'));
    }
    return checks;
  }

  if (request.taskType === 'interview.closeout' && request.mode === 'contributor') {
    const summary = text(result.summary);
    const firsthand = caseId.endsWith('/firsthand');
    const conflict = caseId.endsWith('/conflict');
    const checks = [
      check('contributor.source_distance', firsthand
        ? /(亲眼|亲自|见过)/u.test(summary)
        : /(听说|听家里人|家里人|只听)/u.test(summary),
      firsthand
        ? 'preserves that the contributor witnessed the detail'
        : 'preserves that the contributor heard the detail from others'),
      check('contributor.uncertain_year', conflict
        ? /(冲突|不能确定|不确定|无法确定|说不清)/u.test(summary)
        : yearsIn(summary).length === 0,
      conflict
        ? 'preserves the conflict between the contributor and owner memories'
        : 'does not turn an uncertain year into a concrete year'),
    ];
    return checks;
  }

  if (request.taskType === 'story.completion') {
    const gaps = Array.isArray(result.gaps) ? result.gaps.map(text) : [];
    const status = text(result.status);
    const checks = [
      check('story_completion.status', /^(pending|interviewing|complete)$/u.test(status),
        'returns a valid completion status'),
      check('story_completion.gaps', Array.isArray(result.gaps) && gaps.every((gap) => gap.endsWith('？') || gap.endsWith('?')),
        'returns direct interview questions as gaps'),
      check('story_completion.blocked_direction', !gaps.some((gap) => /小区|门牌/u.test(gap)),
        'does not re-ask a blocked residential detail'),
    ];
    if (caseId === 'story.completion') {
      checks.push(
        check('story_completion.unresolved_gap', gaps.some((gap) => /决定|为什么/u.test(gap)),
          'keeps the unanswered reason for going to Beijing as a gap'),
        check('story_completion.not_complete', status !== 'complete',
          'does not mark the story complete while an important gap remains'),
      );
    } else if (caseId.endsWith('/insufficient')) {
      checks.push(
        check('story_completion.insufficient', status !== 'complete' && gaps.length > 0,
          'asks for more information when the memory is insufficient'),
      );
    } else if (caseId.endsWith('/complete')) {
      checks.push(
        check('story_completion.complete_status', status === 'complete',
          'keeps an already complete story complete'),
        check('story_completion.complete_no_gaps', gaps.length === 0,
          'does not add gaps to an already complete story'),
      );
    }
    return checks;
  }

  if (request.taskType === 'story.generation') {
    const content = text(result.content);
    const allowedYears = new Set(yearsIn(JSON.stringify(request.payload)));
    const unsupportedYears = yearsIn(content).filter((year) => !allowedYears.has(year));
    const checks = [
      check('generation.first_person', /我/u.test(content),
        'keeps the synthetic generation in first person'),
      check('generation.source_facts', /2013/u.test(content) && /北京/u.test(content),
        'retains the explicitly supported year and place'),
      check('generation.no_new_years', unsupportedYears.length === 0,
        'does not introduce an unsupported concrete year'),
    ];
    if (caseId.endsWith('/unknown_place')) {
      checks.push(check('generation.no_new_place', unsupportedPlaceNames(content).length === 0,
        'does not invent a concrete neighborhood or residential place'));
    }
    return checks;
  }

  return [];
}
