import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  interviewContextHintTaskInputSchema,
  interviewContextHintTaskOutputSchema,
} from '../../src/agent-tasks/contracts/index.js';

function input() {
  return {
    query: '这是什么时候发生的？',
    story_summary: '简短故事背景',
    recent_context: [{ role: 'assistant', text: '最近一轮对话' }],
    evidence: [{ id: 'e1', question: '当时在哪儿？', answer: '在学校。' }],
  };
}

test('Realtime context hint input enforces the bounded strict contract', () => {
  assert.equal(interviewContextHintTaskInputSchema.safeParse({
    query: 'q'.repeat(500),
    story_summary: 's'.repeat(1000),
    recent_context: [
      { role: 'user', text: 'a'.repeat(250) },
      { role: 'assistant', text: 'b'.repeat(250) },
      { role: 'user', text: 'c'.repeat(250) },
      { role: 'assistant', text: 'd'.repeat(250) },
    ],
    evidence: ['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => ({
      id,
      question: 'q'.repeat(450),
      answer: 'a'.repeat(450),
    })),
  }).success, true);

  assert.equal(interviewContextHintTaskInputSchema.safeParse({ ...input(), query: 'x' }).success, false);
  assert.equal(interviewContextHintTaskInputSchema.safeParse({ ...input(), query: 'q'.repeat(501) }).success, false);
  assert.equal(interviewContextHintTaskInputSchema.safeParse({
    ...input(), story_summary: 's'.repeat(1001),
  }).success, false);
  assert.equal(interviewContextHintTaskInputSchema.safeParse({
    ...input(), recent_context: [
      { role: 'user', text: 'a'.repeat(501) },
      { role: 'assistant', text: 'b'.repeat(500) },
    ],
  }).success, false);
  assert.equal(interviewContextHintTaskInputSchema.safeParse({
    ...input(), recent_context: ['user', 'assistant', 'user', 'assistant', 'user']
      .map((role) => ({ role, text: 'context' })),
  }).success, false);
  assert.equal(interviewContextHintTaskInputSchema.safeParse({
    ...input(), recent_context: [{ role: 'system', text: 'not allowed' }],
  }).success, false);
  assert.equal(interviewContextHintTaskInputSchema.safeParse({
    ...input(), recent_context: [{ role: 'user', text: 'context', extra: true }],
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
