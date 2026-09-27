import { MAX_STORY_GAP_QUESTION_LENGTH } from '../gaps.js';

export const storyCompletionJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['pending', 'interviewing', 'complete'],
    },
    gaps: {
      type: 'array',
      items: { type: 'string', maxLength: MAX_STORY_GAP_QUESTION_LENGTH },
      maxItems: 3,
    },
  },
  required: ['status', 'gaps'],
  additionalProperties: false,
};
