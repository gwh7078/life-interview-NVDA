import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSyntheticFixtureRegistry,
  createSyntheticRegressionRegistry,
  SYNTHETIC_REGRESSION_CASE_IDS,
} from '../../scripts/agent-eval/fixture-registry.js';
import { evaluateSyntheticSemantics } from '../../scripts/agent-eval/semantic-evaluators.js';

const fixtures = createSyntheticFixtureRegistry('nat-semantic-test-owner', () => 'run');

test('story_continue evaluator requires correction and uncertainty preservation', () => {
  const fixture = fixtures.get('interview.closeout/story_continue');
  assert.ok(fixture);
  const checks = evaluateSyntheticSemantics(fixture.request, {
    current_story: {
      agent_memory: '2013年春节以后去北京，宿舍在朝阳区，具体小区记不清。',
      memory_changes: [{
        type: 'correct',
        previous_text: '2012年前后去北京',
        new_text: '2013年春节以后去北京',
      }],
    },
  });
  assert.equal(checks.every((item) => item.passed), true);

  const failed = evaluateSyntheticSemantics(fixture.request, {
    current_story: { agent_memory: '2013年春节以后去北京。', memory_changes: [] },
  });
  assert.equal(failed.every((item) => item.passed), false);
});

test('contributor and generation evaluators reject unsupported certainty', () => {
  const contributor = fixtures.get('interview.closeout/contributor');
  assert.ok(contributor);
  const contributorChecks = evaluateSyntheticSemantics(contributor.request, {
    summary: '我听家里人说过这件事，但具体是哪一年不能确定。',
  });
  assert.equal(contributorChecks.every((item) => item.passed), true);

  const generation = fixtures.get('story.generation');
  assert.ok(generation);
  const generationChecks = evaluateSyntheticSemantics(generation.request, {
    content: '我在2013年春节以后第一次独自去北京工作。',
  });
  assert.equal(generationChecks.every((item) => item.passed), true);
  const hallucinated = evaluateSyntheticSemantics(generation.request, {
    content: '我在2024年第一次独自去北京工作。',
  });
  assert.equal(hallucinated.find((item) => item.name === 'generation.no_new_years')?.passed, false);
});

test('every synthetic regression case has a case-specific semantic evaluator', () => {
  const regression = createSyntheticRegressionRegistry('nat-semantic-coverage-owner', () => 'run');
  for (const caseId of SYNTHETIC_REGRESSION_CASE_IDS) {
    const fixture = regression.get(caseId);
    assert.ok(fixture, `missing fixture for ${caseId}`);
    assert.ok(
      evaluateSyntheticSemantics(fixture.request, {}, caseId).length > 0,
      `missing semantic checks for ${caseId}`,
    );
  }
});

test('completion evaluator distinguishes unresolved, insufficient, and complete stories', () => {
  const regression = createSyntheticRegressionRegistry('nat-completion-test-owner', () => 'run');
  const base = regression.get('story.completion');
  const insufficient = regression.get('story.completion/insufficient');
  const complete = regression.get('story.completion/complete');
  assert.ok(base && insufficient && complete);

  assert.equal(
    evaluateSyntheticSemantics(base.request, {
      status: 'interviewing',
      gaps: ['你当时为什么决定去北京？'],
    }, base.caseId).every((item) => item.passed),
    true,
  );
  assert.equal(
    evaluateSyntheticSemantics(insufficient.request, {
      status: 'interviewing',
      gaps: ['你还记得那段经历的具体经过吗？'],
    }, insufficient.caseId).every((item) => item.passed),
    true,
  );
  assert.equal(
    evaluateSyntheticSemantics(complete.request, {
      status: 'complete',
      gaps: [],
    }, complete.caseId).every((item) => item.passed),
    true,
  );
});
