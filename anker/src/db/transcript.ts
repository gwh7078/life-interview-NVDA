import { z } from 'zod';

export const transcriptMessageSchema = z.object({
  message_id: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  timestamp: z.string().datetime({ offset: true }),
  provider: z.enum(['doubao', 'qwen', 'stepfun', 'stepaudio3_quality', 'stepaudio2_mini', 'modelbest', 'openclaw', 'test']),
  provider_message_id: z.string().optional(),
}).strict();

export const transcriptSchema = z.array(transcriptMessageSchema);
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>;

const closeoutModelMetadataSchema = z.object({
  provider: z.string().max(128).optional(),
  model: z.string().max(128).optional(),
  response_id: z.string().max(200).optional(),
  latency_ms: z.number().finite().nonnegative().optional(),
  usage: z.object({
    prompt_tokens: z.number().finite().nonnegative().optional(),
    completion_tokens: z.number().finite().nonnegative().optional(),
    total_tokens: z.number().finite().nonnegative().optional(),
  }).strip().optional(),
  repair_attempt_count: z.number().int().nonnegative().optional(),
}).strip();

const closeoutProcessingErrorSchema = z.object({
  code: z.string().max(128).optional(),
  message: z.string().max(1000).optional(),
  retryable: z.boolean().optional(),
  diagnostics: z.record(z.string(), z.unknown()).optional(),
}).strip();

/** Operational closeout metadata only; story summaries live in the stories table. */
export const closeoutResultSchema = z.object({
  target_story_title: z.string().trim().min(1).max(80).optional(),
  processing_attempt_id: z.string().optional(),
  processing_error: closeoutProcessingErrorSchema.optional(),
  current_story_source_message_ids: z.array(z.string()).max(12).optional(),
  new_stories: z.array(z.object({
    story_id: z.string().min(1),
    source_message_ids: z.array(z.string().min(1).max(64)).max(12),
  }).strip()).max(5).optional(),
  model_metadata: closeoutModelMetadataSchema.optional(),
}).strip();

export type CloseoutResult = z.infer<typeof closeoutResultSchema>;

export const jsonObjectSchema = z.record(z.string(), z.unknown());
export const jsonArraySchema = z.array(jsonObjectSchema);

export const documentSourceSchema = z
  .object({
    story_ids: z.array(z.string()).default([]),
    stage_ids: z.array(z.string()).default([]),
    session_ids: z.array(z.string()).default([]),
  })
  .passthrough();

export function parseTranscript(value: string | null | undefined): TranscriptMessage[] {
  if (!value) return [];
  return transcriptSchema.parse(JSON.parse(value));
}

export function serializeTranscript(value: unknown): string {
  return JSON.stringify(transcriptSchema.parse(value));
}

export function parseJsonColumn<T extends z.ZodTypeAny>(
  value: string | null | undefined,
  schema: T,
): z.infer<T> | null {
  if (value == null) return null;
  return schema.parse(JSON.parse(value));
}

export function serializeJsonColumn<T extends z.ZodTypeAny>(
  value: unknown,
  schema: T,
): string {
  return JSON.stringify(schema.parse(value));
}
