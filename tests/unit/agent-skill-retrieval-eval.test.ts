import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve('agent/evals/skills/retrieval-upgrade-2026-09-29');
const cases = readFileSync(path.join(root, 'cases.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line) as {
    case_id: string;
    skill: string;
    case_type: string;
    current_input?: string;
    allowed_source_types: string[];
    fixture_id: string | null;
    expected_search_calls?: number;
    expected_agent_script_calls?: number;
    expected_backend_prefetch_calls?: number;
  });
const fixtures = readFileSync(path.join(root, 'evidence-fixtures.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line) as { fixture_id: string; text: string });

test('retrieval upgrade case pack covers all five Skills with paired case categories', () => {
  const skills = [
    'interview-observer',
    'onboarding-closeout',
    'interview-closeout',
    'story-completion',
    'story-generation',
  ];
  assert.equal(cases.length, 19);
  assert.equal(new Set(cases.map((item) => item.case_id)).size, cases.length);
  assert.deepEqual(Object.fromEntries(['ordinary', 'retrieval_required', 'hard_negative'].map((type) => [
    type,
    cases.filter((item) => item.case_type === type).length,
  ])), { ordinary: 5, retrieval_required: 9, hard_negative: 5 });
  for (const item of cases) {
    assert.ok(item.allowed_source_types.every((source) => [
      'owner_transcript', 'contributor_transcript', 'profile', 'life_stage',
      'story_memory', 'story_summary', 'related_story', 'era',
    ].includes(source)));
    if (item.case_type === 'ordinary') assert.equal(item.expected_agent_script_calls ?? 0, 0);
    if (item.case_type === 'retrieval_required') {
      assert.ok(item.fixture_id);
      if (item.skill === 'interview-observer') {
        assert.equal(item.expected_backend_prefetch_calls, 1);
        assert.equal(item.expected_agent_script_calls, 0);
      } else {
        assert.equal(item.expected_agent_script_calls, 1);
      }
    }
  }
  for (const skill of skills) {
    assert.ok(cases.some((item) => item.skill === skill && item.case_type === 'ordinary'));
    assert.ok(cases.some((item) => item.skill === skill && item.case_type === 'retrieval_required'));
    assert.ok(cases.some((item) => item.skill === skill && item.case_type === 'hard_negative'));
  }
});

test('retrieval answers stay in the out-of-band fixture catalog, not the Agent task input', () => {
  const fixtureIds = new Set(fixtures.map((fixture) => fixture.fixture_id));
  for (const item of cases) {
    if (item.case_type === 'retrieval_required') assert.ok(item.fixture_id && fixtureIds.has(item.fixture_id));
    if (item.case_type === 'ordinary' || item.case_type === 'hard_negative') {
      assert.equal(item.fixture_id, null);
    }
    assert.ok(item.current_input);
    for (const fixture of fixtures) {
      assert.equal(item.current_input.includes(fixture.text), false);
    }
  }
  for (const item of cases.filter((entry) => entry.case_type === 'hard_negative')) {
    assert.equal(item.expected_agent_script_calls, 0);
    assert.equal(item.expected_search_calls, 0);
  }
});
