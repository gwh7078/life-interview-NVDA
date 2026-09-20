import { OnboardingWorkflowError } from './errors.js';
import { restoreOnboardingSourceReferences, sourceReferenceAliasExists } from './prompt-builder.js';
import { onboardingCloseoutOutputSchema } from './schema.js';
import type {
  OnboardingProfileCandidates,
  OnboardingPromptReferences,
  ValidatedOnboardingCloseoutOutput,
} from './types.js';

function schemaFailure(error: { issues: Array<{ path: PropertyKey[]; code: string }> }): OnboardingWorkflowError {
  return new OnboardingWorkflowError('模型输出未通过首次建档结果结构校验。', 'ONBOARDING_OUTPUT_INVALID', 422, {
    issues: error.issues.slice(0, 20).map((issue) => ({
      path: issue.path.map((part) => typeof part === 'number' ? `[${part}]` : String(part)).join('.').slice(0, 160),
      code: issue.code,
    })),
    issueCount: error.issues.length,
  });
}

function validateAliases(aliases: string[], references: OnboardingPromptReferences): void {
  if (new Set(aliases).size !== aliases.length || aliases.some((alias) => !sourceReferenceAliasExists(alias, references))) {
    throw new OnboardingWorkflowError('整理结果引用了无效或重复的访谈来源。', 'INVALID_SOURCE_REFS', 422);
  }
}

function requireSources(aliases: string[], field: string): void {
  if (aliases.length === 0) {
    throw new OnboardingWorkflowError(`整理结果的 ${field} 缺少用户来源。`, 'SOURCE_REFS_REQUIRED', 422, { field });
  }
}

/** Schema, required-field, and prompt-alias checks; persistence revalidates resolved refs in SQLite. */
export class OnboardingCloseoutValidator {
  validate(candidate: unknown, references: OnboardingPromptReferences): ValidatedOnboardingCloseoutOutput {
    const parsed = onboardingCloseoutOutputSchema.safeParse(candidate);
    if (!parsed.success) throw schemaFailure(parsed.error);
    const profile = parsed.data.profile;
    for (const [field, value] of Object.entries(profile)) {
      validateAliases(value.source_refs, references);
      if (value.value !== null && value.source_refs.length === 0) {
        requireSources(value.source_refs, `profile.${field}`);
      }
    }
    requireSources(profile.name.source_refs, 'profile.name');

    const restoredProfile = Object.fromEntries(
      Object.entries(profile).map(([field, value]) => [field, {
        value: value.value,
        source_refs: restoreOnboardingSourceReferences(value.source_refs, references),
      }]),
    ) as unknown as OnboardingProfileCandidates;
    const lifeStages = parsed.data.life_stages.map((stage, stageIndex) => {
      validateAliases(stage.source_refs, references);
      requireSources(stage.source_refs, `life_stages[${stageIndex}].source_refs`);
      return {
        ...stage,
        source_refs: restoreOnboardingSourceReferences(stage.source_refs, references),
        stories: stage.stories.map((story, storyIndex) => {
          validateAliases(story.source_refs, references);
          requireSources(story.source_refs, `life_stages[${stageIndex}].stories[${storyIndex}].source_refs`);
          return {
            ...story,
            source_refs: restoreOnboardingSourceReferences(story.source_refs, references),
          };
        }),
      };
    });
    return { profile: restoredProfile, life_stages: lifeStages };
  }
}
