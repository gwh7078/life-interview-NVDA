import {
  InterviewSessionRepository,
  LifeStageRepository,
  ProfileRepository,
  StoryRepository,
  TranscriptRepository,
} from '../../repositories/domain-repositories.js';
import { closeoutResultSchema, type TranscriptMessage } from '../../db/transcript.js';
import { CloseoutWorkflowError } from './errors.js';

export interface CloseoutStoryContext {
  story_id: string;
  title: string;
  summary: string;
  agent_memory: string;
  status: string;
  stage_id: string;
  updated_at: string;
}

export interface StoryCloseoutContext {
  sessionId: string;
  userId: string;
  mode: 'continue' | 'create';
  currentStageId: string;
  targetStoryTitle?: string;
  currentStory: CloseoutStoryContext | null;
  lifeStages: Array<{ stage_id: string; title: string; start_date: string | null; end_date: string | null }>;
  otherStories: Array<{ story_id: string; title: string; summary: string; stage_id: string }>;
  transcript: TranscriptMessage[];
}

/** Loads trusted, ownership-scoped domain data; it does not build prompts or call a model. */
export class StoryCloseoutContextBuilder {
  private readonly sessions: InterviewSessionRepository;
  private readonly profiles: ProfileRepository;
  private readonly stages: LifeStageRepository;
  private readonly stories: StoryRepository;
  private readonly transcripts: TranscriptRepository;

  constructor(private readonly databasePath?: string) {
    this.sessions = new InterviewSessionRepository(databasePath);
    this.profiles = new ProfileRepository(databasePath);
    this.stages = new LifeStageRepository(databasePath);
    this.stories = new StoryRepository(databasePath);
    this.transcripts = new TranscriptRepository(databasePath);
  }

  build(sessionId: string, ownerUserId: string): StoryCloseoutContext {
    const session = this.sessions.findByIdForUser(ownerUserId, sessionId);
    if (!session) throw new CloseoutWorkflowError('找不到这次访谈。', 'SESSION_NOT_FOUND', 404);
    if (session.sessionType !== 'story') {
      throw new CloseoutWorkflowError('当前只支持整理 Story 访谈。', 'INVALID_SESSION_TYPE');
    }
    if (session.sourceType !== 'subject') {
      throw new CloseoutWorkflowError('外部贡献者访谈不能进入主人公 Story 整理链路。', 'INVALID_SESSION_SOURCE', 409);
    }
    if (!session.endedAt || session.status === 'active') {
      throw new CloseoutWorkflowError('访谈还没有结束。', 'SESSION_NOT_ENDED', 409);
    }
    if (!this.profiles.findById(session.userId)) {
      throw new CloseoutWorkflowError('找不到当前人生档案。', 'PROFILE_NOT_FOUND', 409);
    }

    const transcript = this.transcripts.getForSession(session.userId, sessionId);
    if (!transcript) throw new CloseoutWorkflowError('找不到这次访谈。', 'SESSION_NOT_FOUND', 404);
    if (transcript.length === 0 || !transcript.some((message) => message.role === 'user' && message.text.trim())) {
      throw new CloseoutWorkflowError('这次访谈没有可整理的用户发言。', 'TRANSCRIPT_EMPTY', 422);
    }

    const lifeStages = this.stages.listForUser(session.userId).map((stage) => ({
      stage_id: stage.stageId,
      title: stage.title,
      start_date: stage.startDate,
      end_date: stage.endDate,
    }));
    const allStories = this.stories.listAllForUser(session.userId);
    let rawCloseoutResult: unknown = {};
    try { rawCloseoutResult = session.closeoutResultJson ? JSON.parse(session.closeoutResultJson) : {}; }
    catch { rawCloseoutResult = {}; }
    const result = closeoutResultSchema.safeParse(rawCloseoutResult);
    const targetStoryTitle = result.success ? result.data.target_story_title : undefined;

    if (session.storyId) {
      if (session.stageId !== null) {
        throw new CloseoutWorkflowError('已有 Story 的 Session 不应重复保存人生阶段。', 'DATA_RELATION_INVALID', 409);
      }
      const story = this.stories.findByIdForUser(session.userId, session.storyId);
      if (!story) throw new CloseoutWorkflowError('找不到这次访谈对应的故事。', 'STORY_NOT_FOUND', 409);
      const stage = this.stages.findByIdForUser(session.userId, story.stageId);
      if (!stage) throw new CloseoutWorkflowError('找不到对应的人生阶段。', 'LIFE_STAGE_NOT_FOUND', 409);
      return {
        sessionId,
        userId: session.userId,
        mode: 'continue',
        currentStageId: stage.stageId,
        currentStory: {
          story_id: story.storyId,
          title: story.title,
          summary: story.summary,
          agent_memory: story.agentMemory || story.summary,
          status: story.status,
          stage_id: stage.stageId,
          updated_at: story.updatedAt,
        },
        lifeStages,
        otherStories: allStories.filter((item) => item.storyId !== story.storyId).map((item) => ({
          story_id: item.storyId,
          title: item.title,
          summary: item.summary,
          stage_id: item.stageId,
        })),
        transcript,
      };
    }

    if (!session.stageId) {
      throw new CloseoutWorkflowError('新建 Story 的访谈缺少目标人生阶段。', 'LIFE_STAGE_NOT_FOUND', 409);
    }
    const stage = this.stages.findByIdForUser(session.userId, session.stageId);
    if (!stage) throw new CloseoutWorkflowError('找不到当前人生档案中的人生阶段。', 'LIFE_STAGE_NOT_FOUND', 409);
    return {
      sessionId,
      userId: session.userId,
      mode: 'create',
      currentStageId: stage.stageId,
      ...(targetStoryTitle ? { targetStoryTitle } : {}),
      currentStory: null,
      lifeStages,
      otherStories: allStories.map((item) => ({
        story_id: item.storyId,
        title: item.title,
        summary: item.summary,
        stage_id: item.stageId,
      })),
      transcript,
    };
  }
}
