import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endYearFromStoredDate, yearFromStoredDate, yearToStoredDate } from '../src/onboarding/years.js';

test('legacy stored dates project to a year without turning approximate text into false precision', () => {
  assert.equal(yearFromStoredDate('1987'), 1987);
  assert.equal(yearFromStoredDate('0100'), 100);
  assert.equal(yearFromStoredDate('1987-06-05'), 1987);
  assert.equal(yearFromStoredDate('1987-02-30'), null);
  assert.equal(yearFromStoredDate('around 1987'), null);
  assert.equal(yearFromStoredDate(null), null);
  assert.equal(yearFromStoredDate(1987), null);
});

test('stored end year preserves the distinct ongoing and unknown states', () => {
  assert.equal(endYearFromStoredDate('now'), 'now');
  assert.equal(endYearFromStoredDate('2001'), 2001);
  assert.equal(endYearFromStoredDate(null), null);
  assert.equal(endYearFromStoredDate('0100'), 100);
});

test('years below 1000 are persisted as four digits for stable legacy-column round trips', () => {
  assert.equal(yearToStoredDate(1), '0001');
  assert.equal(yearToStoredDate(100), '0100');
  assert.equal(yearToStoredDate(1987), '1987');
});
