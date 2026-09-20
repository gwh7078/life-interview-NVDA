import { StoryGenerationError } from './errors.js';
import type {
  StoryGenerationContext,
  StoryGenerationDataPort,
  StoryGenerationDocumentRecord,
  StoryGenerationInput,
  StoryGenerationStoryRecord,
} from './types.js';

export interface BuildStoryGenerationContextInput extends StoryGenerationInput {
  story: StoryGenerationStoryRecord;
  baseDocument: StoryGenerationDocumentRecord | null;
}

function orderedTranscript(messages: Awaited<ReturnType<StoryGenerationDataPort['listTranscriptsForStory']>>) {
  return messages
    .map((message, originalIndex) => ({ message, originalIndex, timestamp: Date.parse(message.timestamp) }))
    .sort((left, right) => {
      if (Number.isFinite(left.timestamp) && Number.isFinite(right.timestamp)
        && left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
      return left.originalIndex - right.originalIndex;
    })
    .map(({ message }) => message);
}

/** Loads only owner-scoped generation context; Prompt construction stays pure. */
export class StoryGenerationContextBuilder {
  constructor(private readonly data: StoryGenerationDataPort) {}

  async build(input: BuildStoryGenerationContextInput): Promise<StoryGenerationContext> {
    const { ownerId, story } = input;
    const [profile, lifeStage, rawTranscript] = await Promise.all([
      this.data.findProfileForUser(ownerId),
      this.data.findLifeStageForUser(ownerId, story.stageId),
      this.data.listTranscriptsForStory(ownerId, story.storyId),
    ]);

    if (!profile || profile.ownerId !== ownerId) {
      throw new StoryGenerationError('找不到当前人生档案。', 'PROFILE_NOT_FOUND', 409);
    }
    if (!lifeStage || lifeStage.ownerId !== ownerId || lifeStage.stageId !== story.stageId) {
      throw new StoryGenerationError('找不到对应的人生阶段。', 'LIFE_STAGE_NOT_FOUND', 409);
    }

    const transcript = orderedTranscript(rawTranscript);
    const profileContext = {
      ...(profile.name?.trim() ? { name: profile.name.trim() } : {}),
      ...(profile.profileSummary?.trim() ? { profileSummary: profile.profileSummary.trim() } : {}),
    };
    const lifeStageContext = {
      title: lifeStage.title,
      startDate: lifeStage.startDate,
      endDate: lifeStage.endDate,
    };
    const transcriptSessionIds = [...new Set(transcript.map(({ sessionId }) => sessionId))];

    if (input.baseDocument) {
      return {
        mode: 'revision',
        style: input.style,
        userInstruction: input.userInstruction ?? '',
        profile: profileContext,
        lifeStage: lifeStageContext,
        transcript,
        transcriptSessionIds,
        // Intentionally omit summary from Mode B context.
        story: { title: story.title },
        selectedDocument: {
          title: input.baseDocument.title,
          content: input.baseDocument.content,
        },
      };
    }

    return {
      mode: 'initial',
      style: input.style,
      userInstruction: input.userInstruction ?? '',
      profile: profileContext,
      lifeStage: lifeStageContext,
      transcript,
      transcriptSessionIds,
      story: { title: story.title, summary: story.summary },
      selectedDocument: null,
    };
  }
}
