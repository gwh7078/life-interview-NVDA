import { LifeStageRepository, ProfileRepository, StoryRepository } from '../../repositories/domain-repositories.js';
import type { StoryInterviewContext } from '../../realtime/prompt.js';
import { parseStoryGaps } from '../../story/gaps.js';

export type StoryInterviewTarget =
  | { mode: 'continue'; storyId: string }
  | { mode: 'create'; stageId: string; title?: string };

const STORY_AGENT_MEMORY_HARD_LIMIT = 8_000;

export class InterviewContextError extends Error {
  constructor(message: string, readonly code: string, readonly httpStatus = 404) {
    super(message);
    this.name = 'InterviewContextError';
  }
}


/** Structured data only. This builder never produces prompts or sends data to a model. */
export class StoryInterviewContextBuilder {
  private readonly profiles: ProfileRepository;
  private readonly stages: LifeStageRepository;
  private readonly stories: StoryRepository;

  constructor(private readonly databasePath?: string) {
    this.profiles = new ProfileRepository(databasePath);
    this.stages = new LifeStageRepository(databasePath);
    this.stories = new StoryRepository(databasePath);
  }

  build(userId: string, target: StoryInterviewTarget): StoryInterviewContext {
    const profile = this.profiles.findById(userId);
    if (!profile) throw new InterviewContextError('找不到当前人生档案。', 'PROFILE_NOT_FOUND');

    const story = target.mode === 'continue'
      ? this.stories.findByIdForUser(userId, target.storyId)
      : null;
    if (target.mode === 'continue' && !story) {
      throw new InterviewContextError('找不到当前人生档案中的故事。', 'STORY_NOT_FOUND');
    }
    if (story && (story.agentMemory || story.summary).length > STORY_AGENT_MEMORY_HARD_LIMIT) {
      throw new InterviewContextError('Story Agent Memory 超出允许的上下文上限。', 'STORY_AGENT_MEMORY_TOO_LONG', 409);
    }
    const stageId = story?.stageId ?? (target.mode === 'create' ? target.stageId : '');
    const stage = this.stages.findByIdForUser(userId, stageId);
    if (!stage) throw new InterviewContextError('找不到当前人生档案中的人生阶段。', 'LIFE_STAGE_NOT_FOUND');


    return {
      interview_type: 'story',
      user: {
        user_id: profile.userId,
        name: profile.name,
        nickname: profile.nickname,
        birth_date: profile.birthDate,
        birth_date_precision: profile.birthDatePrecision,
        birth_place: profile.birthPlace,
        current_location: profile.currentLocation,
        profile_summary: profile.profileSummary,
      },
      life_stage: {
        stage_id: stage.stageId,
        title: stage.title,
        start_date: stage.startDate,
        end_date: stage.endDate,
        date_precision: stage.datePrecision,
        summary: stage.summary,
      },
      story: story ? {
        story_id: story.storyId,
        title: story.title,
        summary: story.summary,
        agent_memory: story.agentMemory || story.summary,
        status: story.status,
        gaps: parseStoryGaps(story.gapsJson),
      } : null,
      task_context: {
        mode: target.mode,
        ...(target.mode === 'create' && target.title ? { target_title: target.title } : {}),
      },
    };
  }
}
