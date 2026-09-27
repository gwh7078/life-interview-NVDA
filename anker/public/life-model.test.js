import assert from 'node:assert/strict';
import test from 'node:test';

import { formatLifeStageYears, sortLifeStages } from './life-model.js';

test('sortLifeStages orders dated history, undated history, then current stages', () => {
  const stages = [
    { stage_id: 'current-unknown', start_year: null, end_year: 'now', sort_order: 3 },
    { stage_id: 'unknown', start_year: null, end_year: null, sort_order: 0 },
    { stage_id: 'late', start_year: 2010, end_year: 2015, sort_order: 0 },
    { stage_id: 'current-late', start_year: 2020, end_year: 'now', sort_order: 0 },
    { stage_id: 'early', start_year: 1998, end_year: 2004, sort_order: 4 },
    { stage_id: 'current-early', start_year: 2018, end_year: 'now', sort_order: 5 },
  ];

  assert.deepEqual(sortLifeStages(stages).map(({ stage_id }) => stage_id), [
    'early', 'late', 'unknown', 'current-early', 'current-late', 'current-unknown',
  ]);
  assert.deepEqual(stages.map(({ stage_id }) => stage_id), [
    'current-unknown', 'unknown', 'late', 'current-late', 'early', 'current-early',
  ]);
});

test('sortLifeStages uses sort_order, then created_at, as stable tie breakers', () => {
  const stages = [
    { stage_id: 'created-late', start_year: 2000, end_year: 2001, sort_order: 2, created_at: '2020-03-01' },
    { stage_id: 'order-first', start_year: 2000, end_year: 2001, sort_order: 1, created_at: '2020-04-01' },
    { stage_id: 'created-first', start_year: 2000, end_year: 2001, sort_order: 2, created_at: '2020-01-01' },
  ];

  assert.deepEqual(sortLifeStages(stages).map(({ stage_id }) => stage_id), [
    'order-first', 'created-first', 'created-late',
  ]);
});

test('formatLifeStageYears preserves unknown and 至今 as different values', () => {
  assert.equal(formatLifeStageYears({ start_year: 2010, end_year: 2015 }), '2010–2015');
  assert.equal(formatLifeStageYears({ start_year: 2010, end_year: 'now' }), '2010–至今');
  assert.equal(formatLifeStageYears({ start_year: 2010, end_year: null }), '2010–');
  assert.equal(formatLifeStageYears({ start_year: null, end_year: 2015 }), '–2015');
  assert.equal(formatLifeStageYears({ start_year: null, end_year: null }), '年份未填写');
});
