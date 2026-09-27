import { z } from 'zod';
import {
  storyGenerationOutputSchema,
  storyGenerationStyleSchema,
} from '../../story/generation/schema.js';

const generationProfileSchema = z.object({
  name: z.string().trim().min(1).optional(),
  profile_summary: z.string().trim().min(1).optional(),
}).strict();

const generationLifeStageSchema = z.object({
  title: z.string().trim().min(1).max(160),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
}).strict();

const generationTranscriptMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
}).strict();

const generationBaseSchema = {
  style: storyGenerationStyleSchema,
  user_instruction: z.string().max(4000),
  profile: generationProfileSchema,
  life_stage: generationLifeStageSchema,
  transcript: z.array(generationTranscriptMessageSchema),
};

const initialGenerationSchema = z.object({
  mode: z.literal('initial'),
  ...generationBaseSchema,
  story: z.object({
    title: z.string().trim().min(1).max(160),
    summary: z.string().max(800),
  }).strict(),
  selected_document: z.null(),
}).strict();

const revisionGenerationSchema = z.object({
  mode: z.literal('revision'),
  ...generationBaseSchema,
  story: z.object({
    title: z.string().trim().min(1).max(160),
  }).strict(),
  selected_document: z.object({
    title: z.string().trim().min(1).max(240),
    content: z.string().min(1),
  }).strict(),
}).strict();

export const storyGenerationTaskInputSchema = z.discriminatedUnion('mode', [
  initialGenerationSchema,
  revisionGenerationSchema,
]);

export const storyGenerationTaskOutputSchema = storyGenerationOutputSchema;

export type StoryGenerationTaskInput = z.infer<typeof storyGenerationTaskInputSchema>;
export type StoryGenerationTaskOutput = z.infer<typeof storyGenerationTaskOutputSchema>;
