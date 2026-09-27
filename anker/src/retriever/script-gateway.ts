import { AgentToolTokenError, type AgentToolTokenService } from '../../agent/tools/token.js';
import type { RetrieverAdapter, RetrieverEvidence } from './types.js';

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
  constructor(
    private readonly adapter: RetrieverAdapter,
    private readonly tokenService: AgentToolTokenService,
  ) {}

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
      const matches = await this.adapter.searchTranscript({
        ownerId: payload.userId,
        storyId: payload.resourceId,
        sourceType: 'subject',
        query,
        topK: 5,
        signal,
      });
      // The Retriever filter is an optimization boundary, not an authorization
      // boundary. Fail closed if a result cannot prove it belongs to this Story.
      return {
        matches: matches.filter((match) => (
          match.ownerId === payload.userId
          && match.storyId === payload.resourceId
          && match.sourceType === 'subject'
          && match.sessionId.length > 0
        )).slice(0, 5).map((match) => {
          const { ownerId: _ownerId, sourceType: _sourceType, ...evidence } = match;
          return evidence;
        }),
      };
    } catch (error) {
      if (error instanceof RetrieverScriptError) throw error;
      throw new RetrieverScriptError(
        error instanceof Error ? error.message : 'Retriever search failed.',
        'RETRIEVER_UNAVAILABLE',
        503,
      );
    }
  }
}
