import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertInterviewBenchmarkCompatible,
  constrainCoachGate,
  parseInterviewBenchmarkVariant,
  resolveInterviewBenchmarkProfile,
} from './benchmark-profile.js';
import { createRealtimeInterviewProvider } from './provider.js';
import { buildStepAudio2MiniInstructions, type RealtimeInterviewContext } from './prompt.js';
import { resolveRealtimeProviderConfig } from './runtime-config.js';
import type { CoachGateResult } from './coach/types.js';

const gate: CoachGateResult = {
  action: 'guide',
  retrieve_memory: true,
  memory_query: '核对过去的工作经历',
  retrieve_era: true,
  era_query: '1998 年就业环境',
  era_start_year: 1996,
  era_end_year: 2000,
  reason: 'history_reference',
  avoid: '不要把时代背景当作用户事实。',
  direction: '核实这段工作经历并继续追问。',
};

test('Interview Benchmark is absent by default and rejects unknown values', () => {
  assert.equal(parseInterviewBenchmarkVariant(undefined), undefined);
  assert.equal(parseInterviewBenchmarkVariant(''), undefined);
  assert.equal(resolveInterviewBenchmarkProfile(undefined), undefined);
  assert.throws(() => parseInterviewBenchmarkVariant('D'), /INTERVIEW_BENCHMARK_VARIANT.*A.*B.*C/u);
  assert.throws(() => parseInterviewBenchmarkVariant('a'), /INTERVIEW_BENCHMARK_VARIANT/u);
});

test('Interview Benchmark variants map to the requested capabilities', () => {
  assert.deepEqual(resolveInterviewBenchmarkProfile('A'), {
    variant: 'A', coachEnabled: false, memoryRetrievalEnabled: false, eraRetrievalEnabled: false,
  });
  assert.deepEqual(resolveInterviewBenchmarkProfile('B'), {
    variant: 'B', coachEnabled: true, memoryRetrievalEnabled: false, eraRetrievalEnabled: false,
  });
  assert.deepEqual(resolveInterviewBenchmarkProfile('C'), {
    variant: 'C', coachEnabled: true, memoryRetrievalEnabled: true, eraRetrievalEnabled: true,
  });
});

test('Interview Benchmark B clamps Gate retrieval requests while preserving Coach guidance', () => {
  const profile = resolveInterviewBenchmarkProfile('B');
  const effectiveGate = constrainCoachGate(gate, profile);

  assert.equal(effectiveGate.retrieve_memory, false);
  assert.equal(effectiveGate.memory_query, null);
  assert.equal(effectiveGate.retrieve_era, false);
  assert.equal(effectiveGate.era_query, null);
  assert.equal(effectiveGate.era_start_year, null);
  assert.equal(effectiveGate.era_end_year, null);
  assert.equal(effectiveGate.direction, gate.direction);
  assert.equal(effectiveGate.avoid, gate.avoid);
  assert.equal(gate.retrieve_memory, true, 'clamping must not mutate the model Gate result');
});

test('Interview Benchmark C preserves Gate decisions and unset profile leaves them untouched', () => {
  const profile = resolveInterviewBenchmarkProfile('C');
  assert.deepEqual(constrainCoachGate(gate, profile), gate);
  assert.equal(constrainCoachGate(gate, undefined), gate);
});

test('Interview Benchmark validates the fixed Mini runtime without using credentials to select a variant', () => {
  const miniRuntime = {
    provider: 'stepaudio2_mini',
    model: 'step-audio-2-mini',
    memoryTriggerMode: 'supervisor_auto',
    retrieverEnabled: true,
  };
  assert.doesNotThrow(() => assertInterviewBenchmarkCompatible(undefined, {
    provider: 'stepaudio3_quality', model: 'other-model', memoryTriggerMode: 'voice_tool',
    coachConfigured: false, retrieverEnabled: false,
  }));
  assert.doesNotThrow(() => assertInterviewBenchmarkCompatible('A', { ...miniRuntime, coachConfigured: false }));
  for (const variant of ['B', 'C'] as const) {
    assert.doesNotThrow(() => assertInterviewBenchmarkCompatible(variant, { ...miniRuntime, coachConfigured: true }));
    assert.throws(
      () => assertInterviewBenchmarkCompatible(variant, { ...miniRuntime, coachConfigured: false }),
      /REALTIME_COACH_API_KEY or BAILIAN_API_KEY/u,
    );
  }
  assert.throws(
    () => assertInterviewBenchmarkCompatible('A', { ...miniRuntime, provider: 'stepaudio3_quality', coachConfigured: false }),
    /STORY_INTERVIEW_PROVIDER=stepaudio2_mini/u,
  );
  assert.throws(
    () => assertInterviewBenchmarkCompatible('A', { ...miniRuntime, model: 'stepaudio-3-realtime-preview', coachConfigured: false }),
    /STEPFUN_REALTIME_MODEL=step-audio-2-mini/u,
  );
  assert.throws(
    () => assertInterviewBenchmarkCompatible('C', { ...miniRuntime, memoryTriggerMode: 'voice_tool', coachConfigured: true }),
    /REALTIME_MEMORY_TRIGGER=supervisor_auto/u,
  );
  assert.throws(
    () => assertInterviewBenchmarkCompatible('C', { ...miniRuntime, retrieverEnabled: false, coachConfigured: true }),
    /NEMO_RETRIEVER_ENABLED=true/u,
  );
});

test('Interview Benchmark A/B/C keep the Mini provider, model, initial prompt and audio spec identical', () => {
  const context: RealtimeInterviewContext = {
    interview_type: 'story',
    voiceProfile: 'stepaudio2_mini',
    memoryTriggerMode: 'supervisor_auto',
    user: { name: '测试用户' },
    life_stage: { title: '进入职场', start_year: 2004, end_year: 2018 },
    story: { story_id: 'story-test', title: '第一次独立负责跨团队项目', summary: '同一份故事背景。' },
    task_context: { mode: 'continue' },
  };
  const runs = (['A', 'B', 'C'] as const).map((variant) => {
    const profile = resolveInterviewBenchmarkProfile(variant)!;
    const provider = createRealtimeInterviewProvider('stepaudio2_mini', {
      stepfunApiKey: 'test-only-key', region: 'cn-beijing', model: 'step-audio-2-mini',
    });
    return {
      profile,
      providerId: provider.id,
      model: resolveRealtimeProviderConfig('stepaudio2_mini', {
        region: 'cn-beijing', model: 'unused', stepfunModel: 'step-audio-2-mini',
      }).model,
      audio: provider.audio,
      initialSession: provider.setupSession(context),
      initialTurnPrompt: buildStepAudio2MiniInstructions(context, {
        memoryTriggerMode: 'supervisor_auto', omitOpeningGap: true,
      }),
    };
  });

  for (const [index, run] of runs.entries()) {
    assert.equal(run.profile.variant, ['A', 'B', 'C'][index]);
    assert.equal(run.providerId, runs[0]!.providerId);
    assert.equal(run.model, 'step-audio-2-mini');
    assert.deepEqual(run.audio, runs[0]!.audio);
    assert.deepEqual(run.initialSession, runs[0]!.initialSession);
    assert.equal(run.initialTurnPrompt, runs[0]!.initialTurnPrompt);
  }
});
