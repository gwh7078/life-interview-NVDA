import { z } from 'zod';
import {
  storyCloseoutOutputSchema,
  storyCreationCloseoutOutputSchema,
} from '../../interview/closeout-schema.js';
import {
  taskLifeStageSchema,
  taskOtherStorySchema,
  taskTranscriptMessageSchema,
} from './common.js';

export const storyCreateCloseoutTaskInputSchema = z.object({
  mode: z.literal('story_create'),
  target_stage: taskLifeStageSchema,
  target_story_title: z.string().trim().min(1).max(80).optional(),
  other_stories: z.array(taskOtherStorySchema),
  transcript: z.array(taskTranscriptMessageSchema).min(1),
}).strict();

export const storyContinueCloseoutTaskInputSchema = z.object({
  mode: z.literal('story_continue'),
  current_story: z.object({
    title: z.string().trim().min(1).max(160),
    summary: z.string().max(800),
    agent_memory: z.string().min(1).max(8000),
    status: z.enum(['pending', 'interviewing', 'complete']),
  }).strict(),
  current_stage: taskLifeStageSchema,
  life_stages: z.array(taskLifeStageSchema).min(1),
  other_stories: z.array(taskOtherStorySchema),
  transcript: z.array(taskTranscriptMessageSchema).min(1),
}).strict();

export const contributorCloseoutTaskInputSchema = z.object({
  mode: z.literal('contributor'),
  relationship: z.string().trim().min(1).max(120),
  previous_contributor_summary: z.string().max(400).nullable(),
  transcript: z.array(taskTranscriptMessageSchema).min(1),
}).strict();

export const interviewCloseoutTaskInputSchema = z.discriminatedUnion('mode', [
  storyCreateCloseoutTaskInputSchema,
  storyContinueCloseoutTaskInputSchema,
  contributorCloseoutTaskInputSchema,
]);

export const interviewCloseoutInputSchemas = {
  story_create: storyCreateCloseoutTaskInputSchema,
  story_continue: storyContinueCloseoutTaskInputSchema,
  contributor: contributorCloseoutTaskInputSchema,
} as const;

export const contributorCloseoutTaskOutputSchema = z.object({
  summary: z.string().trim().min(1).max(400),
}).strict();

export const interviewCloseoutOutputSchemas = {
  story_create: storyCreationCloseoutOutputSchema,
  story_continue: storyCloseoutOutputSchema,
  contributor: contributorCloseoutTaskOutputSchema,
} as const;

export type StoryCreateCloseoutTaskInput = z.infer<typeof storyCreateCloseoutTaskInputSchema>;
export type StoryContinueCloseoutTaskInput = z.infer<typeof storyContinueCloseoutTaskInputSchema>;
export type ContributorCloseoutTaskInput = z.infer<typeof contributorCloseoutTaskInputSchema>;
export type InterviewCloseoutTaskInput = z.infer<typeof interviewCloseoutTaskInputSchema>;

export type StoryCreateCloseoutTaskOutput = z.infer<typeof storyCreationCloseoutOutputSchema>;
export type StoryContinueCloseoutTaskOutput = z.infer<typeof storyCloseoutOutputSchema>;
export type ContributorCloseoutTaskOutput = z.infer<typeof contributorCloseoutTaskOutputSchema>;
