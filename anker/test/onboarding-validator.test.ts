import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OnboardingWorkflowError } from '../src/onboarding/errors.js';
import type { OnboardingPromptReferences } from '../src/onboarding/types.js';
import { OnboardingCloseoutValidator } from '../src/onboarding/validator.js';

const references: OnboardingPromptReferences = {
  sourceReferences: new Map([['source_1', { session_id: 'session-1', message_id: 'message-1' }]]),
};

function stage(options: {
  title?: string;
  startYear?: number | null;
  endYear?: number | 'now' | null;
  sourceRefs?: string[];
  stories?: unknown[];
} = {}) {
  return {
    title: options.title ?? '童年',
    start_year: options.startYear === undefined ? 1980 : options.startYear,
    end_year: options.endYear === undefined ? null : options.endYear,
    source_refs: options.sourceRefs ?? ['source_1'],
    stories: options.stories ?? [{
      title: '河边玩耍', summary: '小时候常和表姐去河边玩。', source_refs: ['source_1'], status: 'pending',
    }],
  };
}

function candidate(options: {
  birthYear?: number | null;
  lifeStages?: unknown[];
} = {}) {
  const birthYear = options.birthYear === undefined ? null : options.birthYear;
  return {
    profile: {
      name: { value: '林岚', source_refs: ['source_1'] },
      birth_year: { value: birthYear, source_refs: birthYear === null ? [] : ['source_1'] },
      gender: { value: null, source_refs: [] },
      birth_place: { value: null, source_refs: [] },
      current_location: { value: null, source_refs: [] },
      current_status: { value: null, source_refs: [] },
      profile_summary: { value: null, source_refs: [] },
    },
    life_stages: options.lifeStages ?? [stage()],
  };
}

function assertInvalid(input: unknown, code: string): void {
  assert.throws(
    () => new OnboardingCloseoutValidator().validate(input, references),
    (error: unknown) => error instanceof OnboardingWorkflowError && error.code === code,
  );
}

test('Onboarding validator accepts sparse year fields, ongoing stages, and overlapping life stages', () => {
  const validator = new OnboardingCloseoutValidator();
  const result = validator.validate(candidate({
    birthYear: 1987,
    lifeStages: [
      stage({ title: '童年', startYear: 1980, endYear: 'now' }),
      stage({ title: '求学与工作', startYear: 1995, endYear: 'now' }),
      stage({ title: '时间未知', startYear: null, endYear: null }),
    ],
  }), references);

  assert.equal(result.profile.birth_year.value, 1987);
  assert.deepEqual(result.life_stages.map(({ start_year, end_year }) => [start_year, end_year]), [
    [1980, 'now'],
    [1995, 'now'],
    [null, null],
  ]);
  assert.equal('summary' in result.life_stages[0]!, false);
  assert.equal('date_precision' in result.life_stages[0]!, false);
});

test('Onboarding validator rejects invalid year shapes, missing sources, and empty Stories', () => {
  assertInvalid(candidate({ birthYear: 1987.5 }), 'ONBOARDING_OUTPUT_INVALID');
  assertInvalid(candidate({ birthYear: 0 }), 'ONBOARDING_OUTPUT_INVALID');
  assertInvalid(candidate({ lifeStages: [stage({ startYear: '1980' as unknown as number })] }), 'ONBOARDING_OUTPUT_INVALID');
  assertInvalid(candidate({ lifeStages: [stage({ endYear: 'present' as unknown as 'now' })] }), 'ONBOARDING_OUTPUT_INVALID');
  assertInvalid(candidate({ lifeStages: [stage({ stories: [] })] }), 'ONBOARDING_OUTPUT_INVALID');
  assertInvalid(candidate({ lifeStages: [stage({
    stories: [{ title: '空内容', summary: ' ', source_refs: ['source_1'], status: 'pending' }],
  })] }), 'ONBOARDING_OUTPUT_INVALID');
  const missingBirthYearSource = candidate({ birthYear: 1987 });
  missingBirthYearSource.profile.birth_year.source_refs = [];
  assertInvalid(missingBirthYearSource, 'SOURCE_REFS_REQUIRED');
});
