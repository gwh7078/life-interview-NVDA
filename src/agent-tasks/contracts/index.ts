export * from './common.js';
export * from './onboarding-closeout.js';
export * from './interview-closeout.js';
export * from './story-completion.js';
export * from './story-generation.js';

import type { AgentTaskRequest, AgentTaskResult } from './common.js';
import type {
  ContributorCloseoutTaskInput,
  ContributorCloseoutTaskOutput,
  StoryContinueCloseoutTaskInput,
  StoryContinueCloseoutTaskOutput,
  StoryCreateCloseoutTaskInput,
  StoryCreateCloseoutTaskOutput,
} from './interview-closeout.js';
import type {
  OnboardingCloseoutTaskInput,
  OnboardingCloseoutTaskOutput,
} from './onboarding-closeout.js';
import type {
  StoryCompletionTaskInput,
  StoryCompletionTaskOutput,
} from './story-completion.js';
import type {
  StoryGenerationTaskInput,
  StoryGenerationTaskOutput,
} from './story-generation.js';

export type OnboardingCloseoutTaskRequest = AgentTaskRequest<OnboardingCloseoutTaskInput> & {
  taskType: 'onboarding.closeout';
  mode?: undefined;
};

export type StoryCreateCloseoutTaskRequest = AgentTaskRequest<StoryCreateCloseoutTaskInput> & {
  taskType: 'interview.closeout';
  mode: 'story_create';
};

export type StoryContinueCloseoutTaskRequest = AgentTaskRequest<StoryContinueCloseoutTaskInput> & {
  taskType: 'interview.closeout';
  mode: 'story_continue';
};

export type ContributorCloseoutTaskRequest = AgentTaskRequest<ContributorCloseoutTaskInput> & {
  taskType: 'interview.closeout';
  mode: 'contributor';
};

export type StoryCompletionTaskRequest = AgentTaskRequest<StoryCompletionTaskInput> & {
  taskType: 'story.completion';
  mode?: undefined;
};

export type StoryGenerationTaskRequest = AgentTaskRequest<StoryGenerationTaskInput> & {
  taskType: 'story.generation';
  mode?: undefined;
};

export type AgentTaskRequestUnion =
  | OnboardingCloseoutTaskRequest
  | StoryCreateCloseoutTaskRequest
  | StoryContinueCloseoutTaskRequest
  | ContributorCloseoutTaskRequest
  | StoryCompletionTaskRequest
  | StoryGenerationTaskRequest;

export type OnboardingCloseoutTaskResult = AgentTaskResult<OnboardingCloseoutTaskOutput> & {
  taskType: 'onboarding.closeout';
  mode?: undefined;
};

export type StoryCreateCloseoutTaskResult = AgentTaskResult<StoryCreateCloseoutTaskOutput> & {
  taskType: 'interview.closeout';
  mode: 'story_create';
};

export type StoryContinueCloseoutTaskResult = AgentTaskResult<StoryContinueCloseoutTaskOutput> & {
  taskType: 'interview.closeout';
  mode: 'story_continue';
};

export type ContributorCloseoutTaskResult = AgentTaskResult<ContributorCloseoutTaskOutput> & {
  taskType: 'interview.closeout';
  mode: 'contributor';
};

export type StoryCompletionTaskResult = AgentTaskResult<StoryCompletionTaskOutput> & {
  taskType: 'story.completion';
  mode?: undefined;
};

export type StoryGenerationTaskResult = AgentTaskResult<StoryGenerationTaskOutput> & {
  taskType: 'story.generation';
  mode?: undefined;
};

export type AgentTaskResultUnion =
  | OnboardingCloseoutTaskResult
  | StoryCreateCloseoutTaskResult
  | StoryContinueCloseoutTaskResult
  | ContributorCloseoutTaskResult
  | StoryCompletionTaskResult
  | StoryGenerationTaskResult;
