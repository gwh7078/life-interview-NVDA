import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  interviewContextHintTaskInputSchema,
  interviewContextHintTaskOutputSchema,
} from '../../src/agent-tasks/contracts/index.js';

function input() {
  return {
    query: '这是什么时候发生的？',
    story: { story_id: 'story-1', subject_id: 'subject-1' },
    evidence: [{ id: 'e1', question: '当时在哪儿？', answer: '在学校。' }],
  };
}

test('Realtime context hint input enforces the bounded strict contract', () => {
  assert.equal(interviewContextHintTaskInputSchema.safeParse({
    query: 'q'.repeat(500),
    story: { story_id: 'story-1', subject_id: 'subject-1' },
    evidence: ['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => ({
      id,
      question: 'q'.repeat(450),
      answer: 'a'.repeat(450),
    })),
  }).success, true);

  assert.equal(interviewContextHintTaskInputSchema.safeParse({ ...input(), query: 'x' }).success, false);
  assert.equal(interviewContextHintTaskInputSchema.safeParse({ ...input(), query: 'q'.repeat(501) }).success, false);
  assert.equal(interviewContextHintTaskInputSchema.safeParse({
    ...input(), story: { story_id: '', subject_id: 'subject-1' },
  }).success, false);
  assert.equal(interviewContextHintTaskInputSchema.safeParse({
    ...input(), recent_context: [{ role: 'user', text: 'recent conversation must stay out' }],
  }).success, false);
  assert.equal(interviewContextHintTaskInputSchema.safeParse({
    ...input(), evidence: [{ id: 'e1', question: '', answer: 'answer-only evidence' }],
  }).success, true);
  assert.equal(interviewContextHintTaskInputSchema.safeParse({
    ...input(), evidence: [{ id: 'e6', question: 'q', answer: 'a' }],
  }).success, false);
  assert.equal(interviewContextHintTaskInputSchema.safeParse({ ...input(), extra: true }).success, false);
});

test('Realtime context hint output allows only short bounded fields', () => {
  assert.equal(interviewContextHintTaskOutputSchema.safeParse({
    selected_evidence_ids: ['e1', 'e2', 'e3'],
    possible_conflicts: [],
    interview_hints: [],
  }).success, true);
  assert.equal(interviewContextHintTaskOutputSchema.safeParse({
    selected_evidence_ids: ['e1', 'e2', 'e3', 'e4'],
    possible_conflicts: [],
    interview_hints: [],
  }).success, false);
  assert.equal(interviewContextHintTaskOutputSchema.safeParse({
    selected_evidence_ids: [],
    possible_conflicts: ['x'.repeat(81)],
    interview_hints: [],
  }).success, false);
  assert.equal(interviewContextHintTaskOutputSchema.safeParse({
    selected_evidence_ids: ['e1'],
    possible_conflicts: ['x'.repeat(80)],
    interview_hints: ['y'.repeat(39)],
  }).success, false);
  assert.equal(interviewContextHintTaskOutputSchema.safeParse({
    selected_evidence_ids: [],
    possible_conflicts: [],
    interview_hints: [],
    rationale: 'extra output is not allowed',
  }).success, false);
});
