import type {
  AgentTaskRequestUnion,
  StoryContinueCloseoutTaskRequest,
  StoryCreateCloseoutTaskRequest,
} from '../../src/agent-tasks/index.js';
import { contributorCloseoutTaskOutputSchema } from '../../src/agent-tasks/contracts/interview-closeout.js';
import { OnboardingCloseoutValidator } from '../../src/onboarding/validator.js';
import { StoryCloseoutValidator } from '../../src/interview/closeout/validator.js';
import type { StoryCloseoutContext } from '../../src/interview/closeout/context-builder.js';
import type { CompactPromptReferences } from '../../src/interview/closeout/prompt-builder.js';
import { StoryCompletionValidator } from '../../src/story/completion/validator.js';
import { storyGenerationOutputSchema } from '../../src/story/generation/schema.js';

export type SyntheticBackendValidator = (output: unknown) => void;

function closeoutReferences(
  transcript: Array<{ message_id: string; role: 'user' | 'assistant'; text: string }>,
  stageIds: string[],
): CompactPromptReferences {
  const messageIds = new Map(transcript.map((message) => [message.message_id, message.message_id] as const));
  const stages = new Map(stageIds.map((stageId) => [stageId, stageId] as const));
  return {
    messages: transcript.map(({ message_id, role, text }) => ({ message_id, role, text })),
    sourceMessageIds: messageIds,
    stageIds: stages,
    stageIdAliases: new Map(stages),
  };
}

function transcriptFor(
  messages: Array<{ message_id: string; role: 'user' | 'assistant'; text: string; timestamp: string }>,
): StoryCloseoutContext['transcript'] {
  return messages.map((message) => ({
    ...message,
    provider: 'test' as const,
  }));
}

function storyCloseoutValidator(
  request: StoryCreateCloseoutTaskRequest | StoryContinueCloseoutTaskRequest,
): SyntheticBackendValidator {
  if (request.mode === 'story_create') {
    const payload = request.payload;
    const transcript = transcriptFor(payload.transcript);
    const stageIds = [payload.target_stage.stage_id, ...payload.other_stories.map((story) => story.stage_id)];
    const references = closeoutReferences(payload.transcript, stageIds);
    const context: StoryCloseoutContext = {
      sessionId: request.resource.id,
      userId: request.ownerId,
      mode: 'create',
      currentStageId: payload.target_stage.stage_id,
      ...(payload.target_story_title ? { targetStoryTitle: payload.target_story_title } : {}),
      currentStory: null,
      lifeStages: [payload.target_stage],
      otherStories: payload.other_stories.map((story, index) => ({
        story_id: `synthetic-other-${index + 1}`,
        ...story,
      })),
      transcript,
    };
    const validator = new StoryCloseoutValidator();
    return (output) => { validator.validate(output, context, references); };
  }

  const payload = request.payload;
  const transcript = transcriptFor(payload.transcript);
  const stageIds = [
    ...payload.life_stages.map((stage) => stage.stage_id),
    payload.current_stage.stage_id,
    ...payload.other_stories.map((story) => story.stage_id),
  ];
  const references = closeoutReferences(payload.transcript, stageIds);
  const context: StoryCloseoutContext = {
    sessionId: request.resource.id,
    userId: request.ownerId,
    mode: 'continue',
    currentStageId: payload.current_stage.stage_id,
    currentStory: {
      story_id: request.resource.id,
      ...payload.current_story,
      stage_id: payload.current_stage.stage_id,
      updated_at: request.resource.version ?? '2026-09-21T09:00:00.000Z',
    },
    lifeStages: payload.life_stages,
    otherStories: payload.other_stories.map((story, index) => ({
      story_id: `synthetic-other-${index + 1}`,
      ...story,
    })),
    transcript,
  };
  const validator = new StoryCloseoutValidator();
  return (output) => { validator.validate(output, context, references); };
}

function onboardingValidator(
  request: Extract<AgentTaskRequestUnion, { taskType: 'onboarding.closeout' }>,
): SyntheticBackendValidator {
  const sourceReferences = new Map<string, { session_id: string; message_id: string }>();
  for (const interview of request.payload.interviews) {
    for (const [index, message] of interview.transcript.entries()) {
      if (message.role !== 'user') continue;
      sourceReferences.set(message.source_ref, {
        session_id: request.resource.id,
        message_id: `synthetic-onboarding-message-${index + 1}`,
      });
    }
  }
  const validator = new OnboardingCloseoutValidator();
  return (output) => {
    validator.validate(output, { sourceReferences });
  };
}

export function createSyntheticBackendValidator(
  request: AgentTaskRequestUnion,
): SyntheticBackendValidator | undefined {
  if (request.taskType === 'onboarding.closeout') return onboardingValidator(request);

  if (request.taskType === 'interview.closeout') {
    if (request.mode === 'story_create' || request.mode === 'story_continue') {
      return storyCloseoutValidator(request);
    }
    return (output) => {
      contributorCloseoutTaskOutputSchema.parse(output);
    };
  }

  if (request.taskType === 'story.completion') {
    const validator = new StoryCompletionValidator();
    return (output) => { validator.validate(output); };
  }

  if (request.taskType === 'story.generation') {
    return (output) => { storyGenerationOutputSchema.parse(output); };
  }

  return undefined;
}
