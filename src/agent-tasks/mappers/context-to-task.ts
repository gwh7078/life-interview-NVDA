import { yearFromStoredDate } from '../../onboarding/years.js';
import type { OnboardingCloseoutContext } from '../../onboarding/types.js';
import type { StoryCloseoutContext } from '../../interview/closeout/context-builder.js';
import type { TranscriptMessage } from '../../db/transcript.js';
import type { StoryCompletionContext } from '../../story/completion/types.js';
import type { StoryGenerationContext } from '../../story/generation/types.js';
import type {
  AgentTaskReferenceMap,
  ContributorCloseoutTaskRequest,
  MappedAgentTask,
  OnboardingCloseoutTaskRequest,
  StoryCompletionTaskRequest,
  StoryCreateCloseoutTaskRequest,
  StoryContinueCloseoutTaskRequest,
  StoryGenerationTaskRequest,
} from '../contracts/index.js';

function compactIds(values: string[], prefix: string): {
  aliasToOriginal: Record<string, string>;
  originalToAlias: Map<string, string>;
} {
  const aliasToOriginal: Record<string, string> = {};
  const originalToAlias = new Map<string, string>();
  for (const [index, value] of [...new Set(values)].entries()) {
    const alias = `${prefix}${index + 1}`;
    aliasToOriginal[alias] = value;
    originalToAlias.set(value, alias);
  }
  return { aliasToOriginal, originalToAlias };
}

function mapTranscript(
  transcript: TranscriptMessage[],
  aliases: Map<string, string>,
) {
  return transcript.map((message) => ({
    message_id: aliases.get(message.message_id) ?? message.message_id,
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
  }));
}

export function mapOnboardingCloseoutContextToTask(
  context: OnboardingCloseoutContext,
  runId: string,
): MappedAgentTask<OnboardingCloseoutTaskRequest> {
  const onboardingSources: NonNullable<AgentTaskReferenceMap['onboardingSources']> = {};
  let nextSource = 1;

  const interviews = context.transcripts.map((session, index) => ({
    interview_number: index + 1,
    transcript: session.messages.map((message) => {
      if (message.role === 'assistant') {
        return {
          role: 'assistant' as const,
          text: message.text,
          timestamp: message.timestamp,
        };
      }
      const sourceRef = `source_${nextSource++}`;
      onboardingSources[sourceRef] = {
        session_id: session.sessionId,
        message_id: message.message_id,
      };
      return {
        role: 'user' as const,
        source_ref: sourceRef,
        text: message.text,
        timestamp: message.timestamp,
      };
    }),
  }));

  return {
    request: {
      runId,
      taskType: 'onboarding.closeout',
      ownerId: context.userId,
      resource: { type: 'interview_session', id: context.sessionId },
      schemaVersion: 'v1',
      payload: {
        current_profile: {
          name: context.profile.name,
          birth_year: yearFromStoredDate(context.profile.birthDate),
          gender: context.profile.gender,
          birth_place: context.profile.birthPlace,
          current_location: context.profile.currentLocation,
          current_status: context.profile.currentStatus,
          profile_summary: context.profile.profileSummary,
        },
        interviews,
      },
    },
    references: { onboardingSources },
  };
}

export function mapStoryCloseoutContextToTask(
  context: StoryCloseoutContext,
  runId: string,
): MappedAgentTask<StoryCreateCloseoutTaskRequest | StoryContinueCloseoutTaskRequest> {
  const messages = compactIds(context.transcript.map((message) => message.message_id), 'm');
  const stages = compactIds([
    ...context.lifeStages.map((stage) => stage.stage_id),
    context.currentStageId,
    ...context.otherStories.map((story) => story.stage_id),
  ], 's');

  const stage = context.lifeStages.find((item) => item.stage_id === context.currentStageId);
  if (!stage) throw new Error('AGENT_TASK_CURRENT_STAGE_NOT_FOUND');

  const stagePayload = {
    stage_id: stages.originalToAlias.get(stage.stage_id) ?? stage.stage_id,
    title: stage.title,
    start_date: stage.start_date,
    end_date: stage.end_date,
  };
  const otherStories = context.otherStories.map((story) => ({
    title: story.title,
    summary: story.summary,
    stage_id: stages.originalToAlias.get(story.stage_id) ?? story.stage_id,
  }));
  const transcript = mapTranscript(context.transcript, messages.originalToAlias);

  const references: AgentTaskReferenceMap = {
    messageIds: messages.aliasToOriginal,
    stageIds: stages.aliasToOriginal,
  };

  if (context.mode === 'create') {
    return {
      request: {
        runId,
        taskType: 'interview.closeout',
        mode: 'story_create',
        ownerId: context.userId,
        resource: { type: 'interview_session', id: context.sessionId },
        schemaVersion: 'v1',
        payload: {
          mode: 'story_create',
          target_stage: stagePayload,
          ...(context.targetStoryTitle ? { target_story_title: context.targetStoryTitle } : {}),
          other_stories: otherStories,
          transcript,
        },
      },
      references,
    };
  }

  if (!context.currentStory) throw new Error('AGENT_TASK_CURRENT_STORY_NOT_FOUND');

  return {
    request: {
      runId,
      taskType: 'interview.closeout',
      mode: 'story_continue',
      ownerId: context.userId,
      resource: {
        type: 'story',
        id: context.currentStory.story_id,
        version: context.currentStory.updated_at,
      },
      schemaVersion: 'v1',
      payload: {
        mode: 'story_continue',
        current_story: {
          title: context.currentStory.title,
          summary: context.currentStory.summary,
          agent_memory: context.currentStory.agent_memory,
          status: context.currentStory.status as 'pending' | 'interviewing' | 'complete',
        },
        current_stage: stagePayload,
        life_stages: context.lifeStages.map((item) => ({
          stage_id: stages.originalToAlias.get(item.stage_id) ?? item.stage_id,
          title: item.title,
          start_date: item.start_date,
          end_date: item.end_date,
        })),
        other_stories: otherStories,
        transcript,
      },
    },
    references,
  };
}

export interface ContributorCloseoutTaskContext {
  userId: string;
  sessionId: string;
  relationship: string;
  previousContributorSummary: string | null;
  transcript: TranscriptMessage[];
  shareId?: string;
  resourceVersion?: string;
}

export function mapContributorCloseoutContextToTask(
  context: ContributorCloseoutTaskContext,
  runId: string,
): MappedAgentTask<ContributorCloseoutTaskRequest> {
  const messages = compactIds(context.transcript.map((message) => message.message_id), 'm');
  return {
    request: {
      runId,
      taskType: 'interview.closeout',
      mode: 'contributor',
      ownerId: context.userId,
      resource: {
        type: context.shareId ? 'story_share' : 'interview_session',
        id: context.shareId ?? context.sessionId,
        ...(context.resourceVersion ? { version: context.resourceVersion } : {}),
      },
      schemaVersion: 'v1',
      payload: {
        mode: 'contributor',
        relationship: context.relationship,
        previous_contributor_summary: context.previousContributorSummary,
        transcript: mapTranscript(context.transcript, messages.originalToAlias),
      },
    },
    references: { messageIds: messages.aliasToOriginal },
  };
}

export function mapStoryCompletionContextToTask(
  context: StoryCompletionContext,
  input: { runId: string; ownerId: string; storyId: string },
): MappedAgentTask<StoryCompletionTaskRequest> {
  return {
    request: {
      runId: input.runId,
      taskType: 'story.completion',
      ownerId: input.ownerId,
      resource: {
        type: 'story',
        id: input.storyId,
        ...(context.sourceUpdatedAt ? { version: context.sourceUpdatedAt } : {}),
      },
      schemaVersion: 'v1',
      payload: {
        title: context.title,
        agent_memory: context.agentMemory,
        stage_title: context.stageTitle,
        current_status: context.currentStatus,
        previous_gaps: context.previousGaps ?? [],
        blocked_directions: context.blockedDirections ?? [],
        ...(context.sessionCount !== undefined ? { session_count: context.sessionCount } : {}),
      },
    },
    references: {},
  };
}

export function mapStoryGenerationContextToTask(
  context: StoryGenerationContext,
  input: { runId: string; ownerId: string; storyId: string; resourceVersion?: string },
): MappedAgentTask<StoryGenerationTaskRequest> {
  const common = {
    style: context.style,
    user_instruction: context.userInstruction,
    profile: {
      ...(context.profile.name ? { name: context.profile.name } : {}),
      ...(context.profile.profileSummary ? { profile_summary: context.profile.profileSummary } : {}),
    },
    life_stage: {
      title: context.lifeStage.title,
      start_date: context.lifeStage.startDate,
      end_date: context.lifeStage.endDate,
    },
    transcript: context.transcript.map((message) => ({
      role: message.role,
      text: message.text,
    })),
  };

  return {
    request: {
      runId: input.runId,
      taskType: 'story.generation',
      ownerId: input.ownerId,
      resource: {
        type: 'story',
        id: input.storyId,
        ...(input.resourceVersion ? { version: input.resourceVersion } : {}),
      },
      schemaVersion: 'v1',
      payload: context.mode === 'initial'
        ? {
            mode: 'initial',
            ...common,
            story: context.story,
            selected_document: null,
          }
        : {
            mode: 'revision',
            ...common,
            story: context.story,
            selected_document: context.selectedDocument,
          },
    },
    references: {},
  };
}
