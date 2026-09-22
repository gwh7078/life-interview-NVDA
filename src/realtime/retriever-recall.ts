import type { RetrieverAdapter } from '../retriever/types.js';
import type {
  RealtimeContextHint,
  RealtimeRecallPort,
  RealtimeRecallRequest,
} from './slow-coordinator.js';

const REALTIME_RECALL_TOP_K = 5;

/**
 * Adapts scoped Retriever evidence to the small hint accepted by Realtime.
 * Authorization is checked again here because Retriever filters are only an
 * optimization boundary.
 */
export class RetrieverRealtimeRecall implements RealtimeRecallPort {
  constructor(
    private readonly retriever: RetrieverAdapter,
    private readonly topK = REALTIME_RECALL_TOP_K,
  ) {
    if (!Number.isInteger(topK) || topK <= 0) {
      throw new Error('Realtime Retriever topK must be a positive integer.');
    }
  }

  async recall(
    request: RealtimeRecallRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<RealtimeContextHint> {
    const evidence = await this.retriever.searchTranscript({
      ownerId: request.ownerId,
      ...(request.storyId ? { storyId: request.storyId } : {}),
      sourceType: 'subject',
      query: request.query,
      topK: this.topK,
      signal: options.signal,
    });
    const facts = evidence
      .filter((item) => (
        item.ownerId === request.ownerId
        && (!request.storyId || item.storyId === request.storyId)
        && item.sourceType === 'subject'
        && item.sessionId.length > 0
        && item.text.trim().length > 0
        && item.messageIds.length > 0
      ))
      .slice(0, this.topK)
      .map((item) => ({
        claim: item.text.trim(),
        sourceMessageIds: item.messageIds,
      }));

    return {
      basedOnTurnId: request.turnId,
      facts,
      possibleConflicts: [],
      interviewHints: [],
    };
  }
}
