import { z } from 'zod';

const promptSourceRefsSchema = z.array(z.string().trim().min(1).max(64));
const sourceReferenceSchema = z.object({
  session_id: z.string().min(1).max(200),
  message_id: z.string().min(1).max(200),
}).strict();
const persistedSourceRefsSchema = z.array(sourceReferenceSchema);

function profileCandidate<T extends z.ZodType>(value: T) {
  return z.object({ value, source_refs: promptSourceRefsSchema }).strict();
}

const profileCandidatesSchema = z.object({
  name: profileCandidate(z.string().trim().min(1).max(120)),
  birth_year: profileCandidate(z.number().int().min(1).max(9999).nullable()),
  gender: profileCandidate(z.string().trim().min(1).max(100).nullable()),
  birth_place: profileCandidate(z.string().trim().min(1).max(240).nullable()),
  current_location: profileCandidate(z.string().trim().min(1).max(240).nullable()),
  current_status: profileCandidate(z.string().trim().min(1).max(400).nullable()),
  profile_summary: profileCandidate(z.string().trim().min(1).max(800).nullable()
    .describe('3–6 个简洁的人生概况 Facts；不要复述 Life Stage 时间线。')),
}).strict();

const storyCandidateSchema = z.object({
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(4000),
  source_refs: promptSourceRefsSchema,
  status: z.literal('pending'),
}).strict();

const lifeStageCandidateSchema = z.object({
  title: z.string().trim().min(1).max(160),
  start_year: z.number().int().min(1).max(9999).nullable(),
  end_year: z.union([z.number().int().min(1).max(9999), z.literal('now')]).nullable(),
  source_refs: promptSourceRefsSchema,
  stories: z.array(storyCandidateSchema).min(1),
}).strict();

/** Structured model output. Stage/story counts intentionally have no V1 target-range limits. */
export const onboardingCloseoutOutputSchema = z.object({
  profile: profileCandidatesSchema,
  life_stages: z.array(lifeStageCandidateSchema),
}).strict();

export const onboardingCloseoutJsonSchema = z.toJSONSchema(onboardingCloseoutOutputSchema);

const profileSourceRefsSchema = z.object({
  name: persistedSourceRefsSchema.optional(),
  birth_year: persistedSourceRefsSchema.optional(),
  // Read old closeout records without requiring the retired date-precision fields in new output.
  birth_date: persistedSourceRefsSchema.optional(),
  birth_date_precision: persistedSourceRefsSchema.optional(),
  gender: persistedSourceRefsSchema.optional(),
  birth_place: persistedSourceRefsSchema.optional(),
  current_location: persistedSourceRefsSchema.optional(),
  current_status: persistedSourceRefsSchema.optional(),
  profile_summary: persistedSourceRefsSchema.optional(),
}).strip();

const modelMetadataSchema = z.object({
  provider: z.string().max(128).optional(),
  model: z.string().max(128).optional(),
  response_id: z.string().max(200).optional(),
  latency_ms: z.number().finite().nonnegative().optional(),
  usage: z.object({
    prompt_tokens: z.number().finite().nonnegative().optional(),
    completion_tokens: z.number().finite().nonnegative().optional(),
    total_tokens: z.number().finite().nonnegative().optional(),
  }).strip().optional(),
}).strip();

/** Operational state and resolved provenance for one onboarding closeout. */
export const onboardingCloseoutResultSchema = z.object({
  completion_eligible: z.boolean().optional(),
  transcript_complete: z.boolean().optional(),
  processing_attempt_id: z.string().min(1).optional(),
  processing_error: z.object({
    code: z.string().max(128).optional(),
    message: z.string().max(1000).optional(),
    retryable: z.boolean().optional(),
  }).strip().optional(),
  profile_source_refs: profileSourceRefsSchema.optional(),
  life_stages: z.array(z.object({
    stage_id: z.string().min(1),
    source_refs: persistedSourceRefsSchema,
    stories: z.array(z.object({
      story_id: z.string().min(1),
      source_refs: persistedSourceRefsSchema,
    }).strip()),
  }).strip()).optional(),
  model_metadata: modelMetadataSchema.optional(),
}).strip();

export type OnboardingCloseoutResultState = z.infer<typeof onboardingCloseoutResultSchema>;
