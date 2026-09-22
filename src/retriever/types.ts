export interface RetrieverIndexInput {
  userId: string;
  sessionId: string;
  storyId: string | null;
  stageId: string | null;
  sessionType: string;
  sourceType: string;
  endedAt: string | null;
  transcriptText: string;
  contentHash: string;
}

export interface RetrieverSearchInput {
  ownerId: string;
  storyId?: string;
  sessionId?: string;
  sourceType?: 'subject' | 'external_contributor';
  query: string;
  topK: number;
  signal?: AbortSignal;
}

export interface RetrieverEvidence {
  text: string;
  score: number;
  ownerId: string | null;
  storyId: string | null;
  sourceType: 'subject' | 'external_contributor' | null;
  sessionId: string;
  messageIds: string[];
  segmentIds: string[];
}

export interface RetrieverIndexResult {
  jobId?: string;
  documentId?: string;
  status: string;
}

export interface RetrieverIndexStatus {
  jobId?: string;
  documentId?: string;
  status: string;
}

export interface RetrieverDocumentReference {
  jobId?: string;
  documentId?: string;
}

export interface RetrieverRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  reference?: RetrieverDocumentReference;
}

export interface RetrieverAdapter {
  indexSessionTranscript(
    input: RetrieverIndexInput,
    options?: RetrieverRequestOptions,
  ): Promise<RetrieverIndexResult>;
  searchTranscript(input: RetrieverSearchInput): Promise<RetrieverEvidence[]>;
  deleteSessionTranscript(
    sessionId: string,
    options?: RetrieverRequestOptions,
  ): Promise<RetrieverIndexStatus>;
  getIndexStatus(
    sessionId: string,
    options?: RetrieverRequestOptions,
  ): Promise<RetrieverIndexStatus>;
}
