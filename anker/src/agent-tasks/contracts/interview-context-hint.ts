import { z } from 'zod';

export const interviewEvidenceIdSchema = z.enum(['e1', 'e2', 'e3', 'e4', 'e5']);

const interviewEvidenceSchema = z.object({
  id: interviewEvidenceIdSchema,
  question: z.string().trim().max(450),
  answer: z.string().trim().min(1).max(450),
}).strict();

export const interviewContextHintTaskInputSchema = z.object({
  query: z.string().trim().min(2).max(500),
  story: z.object({
    story_id: z.string().trim().min(1).max(128),
    subject_id: z.string().trim().min(1).max(128),
  }).strict(),
  evidence: z.array(interviewEvidenceSchema).max(5)
    .superRefine((entries, context) => {
      const ids = entries.map(({ id }) => id);
      if (new Set(ids).size !== ids.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'evidence IDs must be unique.',
        });
      }
    }),
}).strict();

const shortTextSchema = z.string().trim().min(1).max(80);

export const interviewContextHintTaskOutputSchema = z.object({
  selected_evidence_ids: z.array(interviewEvidenceIdSchema).max(3)
    .superRefine((ids, context) => {
      if (new Set(ids).size !== ids.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'selected_evidence_ids must be unique.',
        });
      }
    }),
  possible_conflicts: z.array(shortTextSchema).max(2),
  interview_hints: z.array(shortTextSchema).max(2),
}).strict().superRefine((output, context) => {
  const totalTextCharacters = output.selected_evidence_ids.reduce((total, id) => total + id.length, 0)
    + output.possible_conflicts.reduce((total, conflict) => total + conflict.length, 0)
    + output.interview_hints.reduce((total, hint) => total + hint.length, 0);
  if (totalTextCharacters > 120) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Output text across evidence IDs, conflicts and hints must not exceed 120 characters.',
    });
  }
});

export type InterviewContextHintTaskInput = z.infer<typeof interviewContextHintTaskInputSchema>;
export type InterviewContextHintTaskOutput = z.infer<typeof interviewContextHintTaskOutputSchema>;
