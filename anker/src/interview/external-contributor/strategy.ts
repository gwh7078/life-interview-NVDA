import type { RealtimeInterviewProvider, RealtimeInterviewSession } from '../session.js';
import { createExternalContributorInterviewSession } from '../session.js';
import type { ExternalContributorInterviewContext } from '../../realtime/prompt.js';
import { ProfileRepository, StoryRepository } from '../../repositories/domain-repositories.js';
import { StoryShareRepository } from '../../repositories/story-share-repository.js';
import { UserControlledCompletionPolicy, type InterviewStrategy } from '../story/strategy.js';

export interface ExternalContributorInterviewStart {
  interview_type: 'external_contributor';
  shareId: string;
}

export class ExternalContributorInterviewStrategy implements InterviewStrategy<
  ExternalContributorInterviewStart,
  ExternalContributorInterviewContext,
  RealtimeInterviewSession
> {
  readonly type = 'external_contributor' as const;
  readonly completionPolicy = new UserControlledCompletionPolicy();

  constructor(private readonly databasePath?: string) {}

  buildContext(userId: string, input: ExternalContributorInterviewStart): ExternalContributorInterviewContext {
    const shares = new StoryShareRepository(this.databasePath);
    const share = shares.findByShareIdForUser(userId, input.shareId);
    if (!share || share.status !== 'active' || Date.parse(share.expiresAt) <= Date.now()) {
      throw new Error('分享链接已失效。');
    }
    const story = new StoryRepository(this.databasePath).getDetailForUser(userId, share.storyId);
    if (!story) throw new Error('分享的故事不存在。');
    const profile = new ProfileRepository(this.databasePath).findById(userId);
    return {
      interview_type: 'external_contributor',
      share_id: share.shareId,
      relationship: share.relationship,
      contributor_summary: share.contributorSummary,
      subject: { name: profile?.name ?? null },
      story: {
        story_id: story.storyId,
        title: story.title,
        summary: story.summary,
        status: story.status,
        gaps: story.gaps,
      },
    };
  }

  openSession(
    databasePath: string | undefined,
    userId: string,
    context: ExternalContributorInterviewContext,
    provider: RealtimeInterviewProvider,
  ): RealtimeInterviewSession {
    return createExternalContributorInterviewSession(databasePath, userId, context, provider);
  }
}
