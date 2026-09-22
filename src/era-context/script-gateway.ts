import { AgentToolTokenError, type AgentToolTokenService } from '../../agent/tools/token.js';
import type { EraContextAdapter, EraContextMatch } from './types.js';
import { EraContextClientError } from './client.js';
import { validateEraContextSearchInput } from './validation.js';

export class EraContextScriptError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_ERA_CONTEXT_REQUEST' | 'ERA_CONTEXT_TOKEN_INVALID' | 'ERA_CONTEXT_UNAVAILABLE',
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'EraContextScriptError';
  }
}

export class EraContextScriptGateway {
  constructor(
    private readonly adapter: EraContextAdapter,
    private readonly tokenService: AgentToolTokenService,
  ) {}

  async search(token: string, body: unknown, signal?: AbortSignal): Promise<{ matches: EraContextMatch[] }> {
    try {
      this.tokenService.verify(token, {
        tool: 'era_context_search',
        resourceType: 'era_context',
        resourceId: 'global',
      });
    } catch (error) {
      if (error instanceof AgentToolTokenError) {
        throw new EraContextScriptError(error.message, 'ERA_CONTEXT_TOKEN_INVALID', 401);
      }
      throw error;
    }

    let input;
    try {
      input = validateEraContextSearchInput(body);
    } catch (error) {
      throw new EraContextScriptError(
        error instanceof Error ? error.message : 'Invalid era context request.',
        'INVALID_ERA_CONTEXT_REQUEST',
        400,
      );
    }
    try {
      return { matches: await this.adapter.search({ ...input, signal }) };
    } catch (error) {
      if (error instanceof EraContextScriptError) throw error;
      throw new EraContextScriptError(
        error instanceof EraContextClientError ? error.message : 'Era context retrieval failed.',
        'ERA_CONTEXT_UNAVAILABLE',
        503,
      );
    }
  }
}
