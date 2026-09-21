import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  StoryGenerationError,
  StoryGenerationService,
  buildStoryGenerationPrompt,
  storyGenerationJsonSchema,
  storyGenerationOutputSchema,
  type CreateNextStoryDocumentInput,
  type StoryGenerationContext,
  type StoryGenerationCreatedDocument,
  type StoryGenerationDataPort,
  type StoryGenerationDocumentRecord,
  type StoryGenerationModelPort,
  type StoryGenerationModelRequest,
  type StoryGenerationModelResponse,
  type StoryGenerationProfileRecord,
  type StoryGenerationStoryRecord,
  type StoryGenerationTranscriptMessage,
} from '../src/story/generation/index.js';

const ownerId = 'owner-db-17';
const storyId = 'story-db-23';
const story: StoryGenerationStoryRecord = {
  storyId,
  ownerId,
  stageId: 'stage-db-5',
  title: '第一次独立远行',
  summary: 'SUMMARY_SENTINEL：这次远行的故事骨架。',
  status: 'complete',
  updatedAt: '2026-09-03T00:00:00.000Z',
};

const transcript: StoryGenerationTranscriptMessage[] = [
  {
    sessionId: 'session-db-later',
    messageId: 'message-db-later',
    role: 'user',
    text: '后来我明确记得是和姐姐一起去的。',
    timestamp: '2026-09-02T10:00:00.000Z',
  },
  {
    sessionId: 'session-db-earlier',
    messageId: 'message-db-earlier',
    role: 'assistant',
    text: '你刚才说是一个人出发，对吗？',
    timestamp: '2026-09-01T10:00:00.000Z',
  },
  {
    sessionId: 'session-db-earlier',
    messageId: 'message-db-user',
    role: 'user',
    text: '那次远行大约在1988年。',
    timestamp: '2026-09-01T10:01:00.000Z',
  },
];

const profile: StoryGenerationProfileRecord = {
  ownerId,
  name: '林岚',
  profileSummary: '长期在杭州生活。',
};

const selectedDocument: StoryGenerationDocumentRecord = {
  documentId: 'document-db-v1',
  ownerId,
  scopeType: 'story',
  scopeId: storyId,
  title: '旧版本标题',
  content: 'SELECTED_DOCUMENT_SENTINEL：从夜车站台开始，依次讲述出发、旅途与重逢。',
  versionNumber: 1,
  status: 'draft',
};

function setup(options: {
  story?: StoryGenerationStoryRecord | null;
  document?: StoryGenerationDocumentRecord | null;
  output?: unknown;
  provider?: string;
  model?: string;
  modelError?: Error;
} = {}) {
  const calls = {
    model: [] as StoryGenerationModelRequest[],
    create: [] as CreateNextStoryDocumentInput[],
    transcriptOwnerIds: [] as string[],
    documentOwnerIds: [] as string[],
  };
  const data: StoryGenerationDataPort = {
    async findStoryForUser() { return options.story === undefined ? story : options.story; },
    async findProfileForUser() { return profile; },
    async findLifeStageForUser(_owner, stageId) {
      return {
        stageId,
        ownerId,
        title: '青年时期',
        startDate: '1985',
        endDate: '1995',
        summary: 'LIFESTAGE_SUMMARY_SENTINEL: 不应进入成稿 Prompt。',
      };
    },
    async listTranscriptsForStory(requestOwnerId) {
      calls.transcriptOwnerIds.push(requestOwnerId);
      return transcript;
    },
    async findDocumentForUser(requestOwnerId) {
      calls.documentOwnerIds.push(requestOwnerId);
      return options.document === undefined ? selectedDocument : options.document;
    },
    async createNextVersion(input) {
      calls.create.push(input);
      return {
        ...input,
        documentId: 'document-db-v2',
        versionNumber: 2,
      };
    },
  };
  const model: StoryGenerationModelPort = {
    async generate(request) {
      calls.model.push(request);
      if (options.modelError) throw options.modelError;
      return {
        output: options.output ?? { content: '  这是一篇有事实依据的成稿。  ' },
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.model ? { model: options.model } : {}),
      };
    },
  };
  return { service: new StoryGenerationService(data, model), calls };
}

async function expectGenerationError(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) =>
    error instanceof StoryGenerationError && error.code === code);
}

function userPrompt(request: StoryGenerationModelRequest): Record<string, unknown> {
  return JSON.parse(request.prompt.user) as Record<string, unknown>;
}

test('Mode A uses title and summary as its outline and sends every ordered Transcript without internal IDs', async () => {
  const { service, calls } = setup({ provider: 'fake-provider', model: 'fake-model' });
  const document = await service.generate({
    ownerId,
    storyId,
    style: 'documentary',
    userInstruction: '保持第一人称，保留不确定的年份。',
  });

  assert.equal(calls.model.length, 1);
  const prompt = calls.model[0]!.prompt;
  const promptData = userPrompt(calls.model[0]!);
  assert.deepEqual(promptData.story, { title: story.title, summary: story.summary });
  assert.equal(promptData.style, 'documentary');
  assert.equal(promptData.user_instruction, '保持第一人称，保留不确定的年份。');
  assert.deepEqual((promptData.transcript as Array<{ role: string; text: string }>).map(({ role }) => role), [
    'assistant', 'user', 'user',
  ]);
  assert.match(prompt.system, /assistant/);
  assert.match(prompt.system, /Transcript/);
  assert.match(prompt.system, /Summary/);
  assert.match(prompt.system, /最新/);
  assert.equal(`${prompt.system}\n${prompt.user}`.includes('LIFESTAGE_SUMMARY_SENTINEL'), false);
  for (const internalId of [ownerId, storyId, 'stage-db-5', 'session-db-later', 'message-db-user']) {
    assert.equal(`${prompt.system}\n${prompt.user}`.includes(internalId), false);
  }
  assert.deepEqual(calls.transcriptOwnerIds, [ownerId]);
  assert.equal(document.title, story.title);
  assert.equal(document.scopeType, 'story');
  assert.equal(document.scopeId, storyId);
  assert.equal(document.status, 'draft');
  assert.equal(document.content, '这是一篇有事实依据的成稿。');
  assert.equal(calls.create.length, 1);
  const source = JSON.parse(calls.create[0]!.sourceJson) as Record<string, unknown>;
  assert.equal(source.generationMode, 'initial');
  assert.equal(source.baseDocumentId, null);
  assert.deepEqual(source.sessionIds, ['session-db-earlier', 'session-db-later']);
  assert.equal(source.provider, 'fake-provider');
  assert.equal(source.model, 'fake-model');
  assert.equal(JSON.stringify(source).includes(document.content), false);
  assert.deepEqual(Object.keys(source).sort(), [
    'baseDocumentId', 'generationMode', 'generationParameters', 'model', 'promptVersion',
    'provider', 'sessionIds', 'storyId', 'style', 'userInstruction',
  ]);
});

test('Mode B uses the selected document as its only writing skeleton and omits Story summary', () => {
  const context: StoryGenerationContext = {
    mode: 'revision',
    style: 'warm',
    userInstruction: '增加旅途中的感受，但不要补充新事实。',
    profile: { name: '林岚' },
    lifeStage: { title: '青年时期', startDate: '1985', endDate: '1995' },
    transcript,
    transcriptSessionIds: ['session-db-earlier', 'session-db-later'],
    story: { title: story.title },
    selectedDocument: { title: selectedDocument.title, content: selectedDocument.content },
  };
  const prompt = buildStoryGenerationPrompt(context);
  const promptData = JSON.parse(prompt.user) as Record<string, unknown>;

  assert.equal('story' in promptData, false);
  assert.equal(JSON.stringify(promptData).includes('SUMMARY_SENTINEL'), false);
  assert.equal(JSON.stringify(promptData).includes('story-db-23'), false);
  assert.deepEqual(promptData.selected_document, {
    title: selectedDocument.title,
    content: selectedDocument.content,
  });
  assert.equal((promptData.transcript as unknown[]).length, transcript.length);
  assert.match(prompt.system, /selected_document/);
  assert.match(prompt.system, /Story Summary/);
});

test('revision service uses an owner-scoped historical Document and records only its ID in source metadata', async () => {
  const { service, calls } = setup();
  const document = await service.generate({
    ownerId,
    storyId,
    style: 'restrained',
    userInstruction: '删去重复内容。',
    baseDocumentId: selectedDocument.documentId,
  });

  assert.deepEqual(calls.documentOwnerIds, [ownerId]);
  assert.equal(calls.model.length, 1);
  const modelCall = calls.model[0]!;
  const promptText = `${modelCall.prompt.system}\n${modelCall.prompt.user}`;
  const promptData = userPrompt(modelCall);
  assert.equal(promptText.includes('SUMMARY_SENTINEL'), false);
  assert.equal(promptText.includes(selectedDocument.documentId), false);
  assert.equal(promptText.includes('SELECTED_DOCUMENT_SENTINEL'), true);
  assert.equal((promptData.transcript as unknown[]).length, transcript.length);
  const source = JSON.parse(calls.create[0]!.sourceJson) as Record<string, unknown>;
  assert.equal(source.generationMode, 'revision');
  assert.equal(source.baseDocumentId, selectedDocument.documentId);
  assert.equal(source.storyId, storyId);
  assert.equal(document.title, story.title);
  assert.equal(document.versionNumber, 2);
});

test('server rejects a non-complete Story before context, model, or document writes', async () => {
  const { service, calls } = setup({ story: { ...story, status: 'interviewing' } });
  await expectGenerationError(service.generate({ ownerId, storyId, style: 'documentary' }), 'STORY_NOT_COMPLETE');
  assert.equal(calls.model.length, 0);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.transcriptOwnerIds.length, 0);
});

test('server rejects a Story projection returned for a different owner', async () => {
  const { service, calls } = setup({ story: { ...story, ownerId: 'other-owner' } });
  await expectGenerationError(service.generate({ ownerId, storyId, style: 'documentary' }), 'STORY_NOT_FOUND');
  assert.equal(calls.model.length, 0);
  assert.equal(calls.create.length, 0);
});

test('server rejects a selected document from another owner or Story without generating or writing', async () => {
  const invalidDocuments: Array<{ record: StoryGenerationDocumentRecord; requestedId: string }> = [
    { record: { ...selectedDocument, ownerId: 'other-owner' }, requestedId: selectedDocument.documentId },
    { record: { ...selectedDocument, scopeType: 'profile' }, requestedId: selectedDocument.documentId },
    { record: { ...selectedDocument, scopeId: 'other-story' }, requestedId: selectedDocument.documentId },
    { record: { ...selectedDocument, documentId: 'different-document' }, requestedId: selectedDocument.documentId },
  ];

  for (const { record, requestedId } of invalidDocuments) {
    const { service, calls } = setup({ document: record });
    await expectGenerationError(
      service.generate({ ownerId, storyId, style: 'warm', baseDocumentId: requestedId }),
      'BASE_DOCUMENT_NOT_FOUND',
    );
    assert.equal(calls.model.length, 0);
    assert.equal(calls.create.length, 0);
  }
});

test('generation model failures and invalid structured output do not retry or write a document', async () => {
  const failed = setup({ modelError: new Error('provider offline') });
  await assert.rejects(failed.service.generate({ ownerId, storyId, style: 'documentary' }), /provider offline/);
  assert.equal(failed.calls.model.length, 1);
  assert.equal(failed.calls.create.length, 0);

  const invalid = setup({ output: { content: '正文', reasoning: 'private reasoning' } });
  await expectGenerationError(
    invalid.service.generate({ ownerId, storyId, style: 'documentary' }),
    'GENERATION_OUTPUT_INVALID',
  );
  assert.equal(invalid.calls.model.length, 1);
  assert.equal(invalid.calls.create.length, 0);
});

test('structured output contains only a non-empty content field', () => {
  assert.equal(storyGenerationOutputSchema.safeParse({ content: '正文' }).success, true);
  assert.equal(storyGenerationOutputSchema.safeParse({ content: '' }).success, false);
  assert.equal(storyGenerationOutputSchema.safeParse({ content: '  ' }).success, false);
  assert.equal(storyGenerationOutputSchema.safeParse({ content: '正文', title: '模型标题' }).success, false);
  assert.equal(storyGenerationJsonSchema.additionalProperties, false);
  assert.deepEqual(storyGenerationJsonSchema.required, ['content']);
});
