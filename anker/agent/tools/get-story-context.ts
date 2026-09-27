import { LifeStageRepository, StoryRepository } from '../../src/repositories/domain-repositories.js';
import { parseStoryGaps } from '../../src/story/gaps.js';

export interface StoryContextToolOutput {
  story: {
    id: string;
    title: string;
    life_stage: {
      id: string;
      title: string;
      start_year: number | null;
      end_year: number | 'now' | null;
    };
    summary: string;
    agent_memory: string;
    completion_status: string;
    gaps: string[];
  };
}

function parseYear(value: string | null): number | null {
  if (!value) return null;
  const match = /^(-?\d+)/u.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isSafeInteger(year) ? year : null;
}

export class StoryContextTool {
  private readonly stories: StoryRepository;
  private readonly stages: LifeStageRepository;

  constructor(databasePath?: string) {
    this.stories = new StoryRepository(databasePath);
    this.stages = new LifeStageRepository(databasePath);
  }

  getForOwner(userId: string, storyId: string): StoryContextToolOutput | null {
    const story = this.stories.findByIdForUser(userId, storyId);
    if (!story) return null;
    const stage = this.stages.findByIdForUser(userId, story.stageId);
    if (!stage) return null;
    return {
      story: {
        id: story.storyId,
        title: story.title,
        life_stage: {
          id: stage.stageId,
          title: stage.title,
          start_year: parseYear(stage.startDate),
          end_year: stage.endDate === 'now' ? 'now' : parseYear(stage.endDate),
        },
        summary: story.summary,
        agent_memory: story.agentMemory || story.summary,
        completion_status: story.status,
        gaps: parseStoryGaps(story.gapsJson),
      },
    };
  }
}
