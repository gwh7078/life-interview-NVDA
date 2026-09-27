import { z } from 'zod';
import { onboardingCloseoutOutputSchema } from '../../onboarding/schema.js';

const sourceRefSchema = z.string().trim().min(1).max(64);

const onboardingUserMessageSchema = z.object({
  role: z.literal('user'),
  source_ref: sourceRefSchema,
  text: z.string(),
  timestamp: z.string().min(1).max(100),
}).strict();

const onboardingAssistantMessageSchema = z.object({
  role: z.literal('assistant'),
  text: z.string(),
  timestamp: z.string().min(1).max(100),
}).strict();

const onboardingTaskTranscriptMessageSchema = z.discriminatedUnion('role', [
  onboardingUserMessageSchema,
  onboardingAssistantMessageSchema,
]);

export const onboardingCloseoutTaskInputSchema = z.object({
  current_profile: z.object({
    name: z.string().nullable(),
    birth_year: z.number().int().min(1).max(9999).nullable(),
    gender: z.string().nullable(),
    birth_place: z.string().nullable(),
    current_location: z.string().nullable(),
    current_status: z.string().nullable(),
    profile_summary: z.string().nullable(),
  }).strict(),
  interviews: z.array(z.object({
    interview_number: z.number().int().positive(),
    transcript: z.array(onboardingTaskTranscriptMessageSchema),
  }).strict()).min(1),
}).strict();

export const onboardingCloseoutTaskOutputSchema = onboardingCloseoutOutputSchema;

export type OnboardingCloseoutTaskInput = z.infer<typeof onboardingCloseoutTaskInputSchema>;
export type OnboardingCloseoutTaskOutput = z.infer<typeof onboardingCloseoutTaskOutputSchema>;
