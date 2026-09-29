import { AgentToolTokenError, type AgentToolTokenService } from '../../agent/tools/token.js';
import { EvidenceSearchError, EvidenceSearchService } from './evidence-search.js';
import type { RetrieverAdapter, RetrieverEvidence } from './types.js';

export { EvidenceSearchError, EvidenceSearchGateway } from './evidence-search.js';

export class RetrieverScriptError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'INVALID_RETRIEVAL_REQUEST'
      | 'RETRIEVAL_TOKEN_INVALID'
      | 'RETRIEVER_UNAVAILABLE',
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'RetrieverScriptError';
  }
}

export interface MemorySearchResult {
  matches: Array<Omit<RetrieverEvidence, 'ownerId' | 'sourceType'>>;
}

function readQuery(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RetrieverScriptError('A JSON object is required.', 'INVALID_RETRIEVAL_REQUEST', 400);
  }
  const query = (body as { query?: unknown }).query;
  if (typeof query !== 'string' || query.trim().length < 2 || query.trim().length > 500) {
    throw new RetrieverScriptError('query must contain between 2 and 500 characters.', 'INVALID_RETRIEVAL_REQUEST', 400);
  }
  return query.trim();
}

export class RetrieverScriptGateway {
  private readonly evidenceSearch: EvidenceSearchService;

  constructor(
    private readonly adapter: RetrieverAdapter,
    private readonly tokenService: AgentToolTokenService,
  ) {
    this.evidenceSearch = new EvidenceSearchService({ retriever: adapter });
  }

  async memorySearch(token: string, body: unknown, signal?: AbortSignal): Promise<MemorySearchResult> {
    const payload = (() => {
      try {
        return this.tokenService.verify(token, { tool: 'memory_search', resourceType: 'story' });
      } catch (error) {
        if (error instanceof AgentToolTokenError) {
          throw new RetrieverScriptError(error.message, 'RETRIEVAL_TOKEN_INVALID', 401);
        }
        throw error;
      }
    })();
    const query = readQuery(body);
    try {
      const result = await this.evidenceSearch.searchScoped({
        ownerId: payload.userId,
        storyId: payload.resourceId,
        task: 'interview.closeout:story_continue',
        skill: 'interview-closeout',
        allowedSourceTypes: ['owner_transcript'],
      }, { query, source_types: ['owner_transcript'], top_k: 5 }, signal);
      return {
        matches: result.evidence.map((item) => ({
          text: item.text,
          score: item.score,
          storyId: item.story_ref ?? payload.resourceId,
          sessionId: item.source_ref,
          messageIds: item.message_refs ?? [],
          segmentIds: item.segment_refs ?? [],
        })),
      };
    } catch (error) {
      if (error instanceof RetrieverScriptError) throw error;
      if (error instanceof EvidenceSearchError) {
        throw new RetrieverScriptError(error.message, 'INVALID_RETRIEVAL_REQUEST', error.statusCode);
      }
      throw new RetrieverScriptError(
        error instanceof Error ? error.message : 'Retriever search failed.',
        'RETRIEVER_UNAVAILABLE',
        503,
      );
    }
  }
}
