import { z } from 'zod';

export const storyGenerationStyleSchema = z.enum([
  'documentary',
  'warm',
  'restrained',
  'literary',
]);

export const storyGenerationInputSchema = z.object({
  ownerId: z.string().trim().min(1).max(200),
  storyId: z.string().trim().min(1).max(200),
  style: storyGenerationStyleSchema,
  userInstruction: z.string().max(4_000).optional().default(''),
  baseDocumentId: z.string().trim().min(1).max(200).nullable().optional().default(null),
}).strict();

/** Keep model output intentionally minimal; the document title is server-owned. */
export const storyGenerationOutputSchema = z.object({
  content: z.string().min(1).regex(/\S/),
}).strict();

export const storyGenerationJsonSchema = z.toJSONSchema(storyGenerationOutputSchema);

export const storyGenerationSourceSchema = z.object({
  storyId: z.string().min(1).max(200),
  generationMode: z.enum(['initial', 'revision']),
  baseDocumentId: z.string().min(1).max(200).nullable(),
  provider: z.string().trim().min(1).max(128).optional(),
  model: z.string().trim().min(1).max(128).optional(),
  promptVersion: z.literal('story-generation-v1'),
  style: storyGenerationStyleSchema,
  userInstruction: z.string().max(4_000),
  generationParameters: z.object({}).strict(),
  sessionIds: z.array(z.string().min(1).max(200)).max(2_000),
}).strict();

export type ParsedStoryGenerationInput = z.infer<typeof storyGenerationInputSchema>;
export type StoryGenerationOutput = z.infer<typeof storyGenerationOutputSchema>;
