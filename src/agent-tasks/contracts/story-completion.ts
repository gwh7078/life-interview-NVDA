import { z } from 'zod';
import {
  MAX_STORY_GAPS,
  MAX_STORY_GAP_QUESTION_LENGTH,
  isStoryGapQuestion,
} from '../../story/gaps.js';

const gapQuestionSchema = z.string()
  .trim()
  .min(1)
  .max(MAX_STORY_GAP_QUESTION_LENGTH)
  .refine(isStoryGapQuestion, 'gap must be one direct interview question ending with a question mark');

export const storyCompletionTaskInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  agent_memory: z.string().trim().min(1).max(8000),
  stage_title: z.string().trim().min(1).max(160),
  current_status: z.enum(['pending', 'interviewing', 'complete']),
  previous_gaps: z.array(gapQuestionSchema).max(MAX_STORY_GAPS),
  blocked_directions: z.array(z.string().trim().min(1).max(180)).max(8),
  session_count: z.number().int().nonnegative().optional(),
}).strict();

export const storyCompletionTaskOutputSchema = z.object({
  status: z.enum(['pending', 'interviewing', 'complete']),
  gaps: z.array(gapQuestionSchema).max(MAX_STORY_GAPS),
}).strict();

export type StoryCompletionTaskInput = z.infer<typeof storyCompletionTaskInputSchema>;
export type StoryCompletionTaskOutput = z.infer<typeof storyCompletionTaskOutputSchema>;
