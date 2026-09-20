import type { storyGenerationJsonSchema } from './schema.js';

export type StoryGenerationStyle = 'documentary' | 'warm' | 'restrained' | 'literary';
export type StoryGenerationMode = 'initial' | 'revision';

/** Minimal owner-scoped Story projection required by Generation. */
export interface StoryGenerationStoryRecord {
  storyId: string;
  ownerId: string;
  stageId: string;
  title: string;
  summary: string;
  status: string;
}

export interface StoryGenerationProfileRecord {
  ownerId: string;
  name: string | null;
  profileSummary: string | null;
}

export interface StoryGenerationLifeStageRecord {
  stageId: string;
  ownerId: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
  summary: string | null;
}

/** IDs stay in server-side context for source metadata and are stripped before prompting. */
export interface StoryGenerationTranscriptMessage {
  sessionId: string;
  messageId: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

export interface StoryGenerationDocumentRecord {
  documentId: string;
  ownerId: string;
  scopeType: string;
  scopeId: string | null;
  title: string;
  content: string;
  versionNumber: number;
  status: string;
}

export interface CreateNextStoryDocumentInput {
  ownerId: string;
  scopeType: 'story';
  scopeId: string;
  title: string;
  content: string;
  status: 'draft';
  sourceJson: string;
}

export interface StoryGenerationCreatedDocument extends StoryGenerationDocumentRecord {
  scopeType: 'story';
  scopeId: string;
  status: 'draft';
  sourceJson: string;
}

/**
 * Adapters must implement every read as owner-scoped. createNextVersion must
 * calculate MAX(version_number) + 1 and insert in one database transaction.
 */
export interface StoryGenerationDataPort {
  findStoryForUser(ownerId: string, storyId: string): Promise<StoryGenerationStoryRecord | null>;
  findProfileForUser(ownerId: string): Promise<StoryGenerationProfileRecord | null>;
  findLifeStageForUser(ownerId: string, stageId: string): Promise<StoryGenerationLifeStageRecord | null>;
  /** Return every current Transcript message from every Session owned by this Story. */
  listTranscriptsForStory(ownerId: string, storyId: string): Promise<StoryGenerationTranscriptMessage[]>;
  findDocumentForUser(ownerId: string, documentId: string): Promise<StoryGenerationDocumentRecord | null>;
  createNextVersion(input: CreateNextStoryDocumentInput): Promise<StoryGenerationCreatedDocument>;
}

export interface StoryGenerationInput {
  ownerId: string;
  storyId: string;
  style: StoryGenerationStyle;
  userInstruction?: string;
  /** null/omitted generates the initial document; an ID revises that version. */
  baseDocumentId?: string | null;
}

export interface StoryGenerationPrompt {
  system: string;
  user: string;
}

export interface StoryGenerationStructuredOutput {
  name: 'story_generation';
  jsonSchema: typeof storyGenerationJsonSchema;
}

export interface StoryGenerationModelRequest {
  prompt: StoryGenerationPrompt;
  structuredOutput: StoryGenerationStructuredOutput;
}

/** Only these non-secret routing labels are copied to source_json. */
export interface StoryGenerationModelResponse {
  output: unknown;
  provider?: string;
  model?: string;
}

export interface StoryGenerationModelPort {
  generate(input: StoryGenerationModelRequest): Promise<StoryGenerationModelResponse>;
}

export interface StoryGenerationPromptProfile {
  name?: string;
  profileSummary?: string;
}

export interface StoryGenerationPromptLifeStage {
  title: string;
  startDate: string | null;
  endDate: string | null;
}

export interface StoryGenerationPromptTranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
}

interface StoryGenerationContextBase {
  mode: StoryGenerationMode;
  style: StoryGenerationStyle;
  userInstruction: string;
  profile: StoryGenerationPromptProfile;
  lifeStage: StoryGenerationPromptLifeStage;
  transcript: StoryGenerationTranscriptMessage[];
  /** Used only for server-side source metadata; never serialized into a prompt. */
  transcriptSessionIds: string[];
}

export interface InitialStoryGenerationContext extends StoryGenerationContextBase {
  mode: 'initial';
  story: Pick<StoryGenerationStoryRecord, 'title' | 'summary'>;
  selectedDocument: null;
}

export interface RevisionStoryGenerationContext extends StoryGenerationContextBase {
  mode: 'revision';
  /** Deliberately has no summary so it cannot become a second writing skeleton. */
  story: Pick<StoryGenerationStoryRecord, 'title'>;
  selectedDocument: Pick<StoryGenerationDocumentRecord, 'title' | 'content'>;
}

export type StoryGenerationContext = InitialStoryGenerationContext | RevisionStoryGenerationContext;

export interface StoryGenerationSourceMetadata {
  storyId: string;
  generationMode: StoryGenerationMode;
  baseDocumentId: string | null;
  provider?: string;
  model?: string;
  promptVersion: 'story-generation-v1';
  style: StoryGenerationStyle;
  userInstruction: string;
  generationParameters: Record<string, never>;
  sessionIds: string[];
}
