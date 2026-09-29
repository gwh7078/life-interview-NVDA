#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const casesPath = new URL('./cases.jsonl', import.meta.url);
const fixturesPath = new URL('./evidence-fixtures.jsonl', import.meta.url);
const allowedSkills = new Set([
  'interview-observer',
  'onboarding-closeout',
  'interview-closeout',
  'story-completion',
  'story-generation',
]);
const allowedCaseTypes = new Set(['ordinary', 'retrieval_required', 'hard_negative']);

function readJsonl(path, label) {
  const source = readFileSync(path, 'utf8');
  return source.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${label}:${index + 1} is not valid JSON.`);
    }
  });
}

function readFixtures() {
  const fixtures = new Map();
  for (const [index, value] of readJsonl(fixturesPath, 'evidence-fixtures.jsonl').entries()) {
    if (!value || typeof value.fixture_id !== 'string' || !value.fixture_id
      || typeof value.source_type !== 'string' || typeof value.scope !== 'string'
      || !value.provenance || typeof value.provenance !== 'object' || Array.isArray(value.provenance)) {
      throw new Error(`evidence-fixtures.jsonl:${index + 1} is missing provisioning metadata.`);
    }
    if (fixtures.has(value.fixture_id)) throw new Error(`Duplicate fixture_id: ${value.fixture_id}`);
    fixtures.set(value.fixture_id, {
      source_type: value.source_type,
      scope: value.scope,
      provenance: value.provenance,
    });
  }
  return fixtures;
}

function readCases(fixtures) {
  const rows = readJsonl(casesPath, 'cases.jsonl');
  const seen = new Set();
  return rows.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.case_id !== 'string' || !value.case_id
      || !allowedSkills.has(value.skill)
      || !allowedCaseTypes.has(value.case_type)
      || typeof value.current_input !== 'string' || !value.current_input
      || !Array.isArray(value.allowed_source_types)
      || !Array.isArray(value.success_criteria)
      || value.success_criteria.some((item) => typeof item !== 'string')) {
      throw new Error(`cases.jsonl:${index + 1} is missing required case fields.`);
    }
    if (seen.has(value.case_id)) throw new Error(`Duplicate case_id: ${value.case_id}`);
    seen.add(value.case_id);
    const fixture = value.fixture_id ? fixtures.get(value.fixture_id) : undefined;
    if (value.fixture_id && !fixture) throw new Error(`Unknown fixture_id in ${value.case_id}: ${value.fixture_id}`);

    return {
      evaluator_input_format: 'nvidia-skillevaluator-tier3-case-manifest/v1',
      case_id: value.case_id,
      target_skill: value.skill,
      case_type: value.case_type,
      task_input: value.current_input,
      allowed_source_types: value.allowed_source_types,
      paired_conditions: [
        { name: 'with_skill', skill_file: `agent/skills/${value.skill}/SKILL.md` },
        { name: 'without_skill', skill_file: null },
      ],
      fixture_provision: fixture
        ? {
          fixture_id: value.fixture_id,
          catalog: 'evidence-fixtures.jsonl',
          ...fixture,
          before_run: true,
          destination: 'scoped Retriever',
          fixture_text_in_prompt: false,
        }
        : null,
      success_criteria: value.success_criteria,
      ...(Number.isInteger(value.expected_agent_script_calls)
        ? { expected_agent_script_calls: value.expected_agent_script_calls }
        : {}),
      ...(Number.isInteger(value.expected_backend_prefetch_calls)
        ? { expected_backend_prefetch_calls: value.expected_backend_prefetch_calls }
        : {}),
      ...(Number.isInteger(value.expected_search_calls)
        ? { expected_search_calls: value.expected_search_calls }
        : {}),
    };
  });
}

if (process.argv.length > 2) {
  throw new Error('Usage: node prepare-evals.mjs');
}

try {
  const fixtures = readFixtures();
  for (const item of readCases(fixtures)) process.stdout.write(`${JSON.stringify(item)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Eval case preparation failed.'}\n`);
  process.exitCode = 1;
}
