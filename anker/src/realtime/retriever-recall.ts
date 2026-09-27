import { performance } from 'node:perf_hooks';
import type { RetrieverAdapter, RetrieverEvidence } from '../retriever/types.js';
import type { RealtimeRecallRequest } from './slow-coordinator.js';

const REALTIME_RECALL_TOP_K = 5;
const QA_ENTRY = /\[segment_id=([^\]]+)\]\[message_id=([^\]]+)\]\[Q\+A\]\s*\r?\nQuestion \(context only\):([\s\S]*?)\r?\nAnswer \(user-provided fact\):([\s\S]*?)(?=(?:\r?\n\[segment_id=)|$)/gu;
const LEGACY_MESSAGE = /\[segment_id=([^\]]+)\]\[message_id=([^\]]+)\]\[(assistant|user)\]\s*([\s\S]*?)(?=(?:\r?\n)?\[segment_id=|$)/gu;

export interface RealtimeQAEvidence {
  id: string;
  question: string;
  answer: string;
  sourceMessageIds: string[];
  score: number;
}

export interface RealtimeRetrievalResult {
  candidateCount: number;
  evidence: RealtimeQAEvidence[];
  latencyMs: number;
}

export interface BoundedRealtimeQAEvidence {
  id: string;
  question: string;
  answer: string;
  sourceMessageIds: string[];
}

const MAX_EVIDENCE_ITEMS = 5;
const MAX_EVIDENCE_CHARS = 2_000;
const MAX_EVIDENCE_ITEM_CHARS = 450;

function clipAtSentence(value: string, maxChars: number): string {
  const characters = Array.from(value.trim());
  if (characters.length <= maxChars) return characters.join('');
  const stop = characters.slice(0, maxChars).reduce((latest, character, index) => (
    /[。！？!?；;\n]/u.test(character) ? index + 1 : latest
  ), 0);
  return characters.slice(0, stop >= Math.floor(maxChars * 0.6) ? stop : maxChars).join('');
}

/** Shared Q+A evidence budget for Coach Pass B and the existing read-only Agent path. */
export function boundRealtimeQAEvidence(evidence: RealtimeQAEvidence[]): BoundedRealtimeQAEvidence[] {
  let remaining = MAX_EVIDENCE_CHARS;
  const bounded: BoundedRealtimeQAEvidence[] = [];
  for (const item of evidence) {
    if (remaining <= 0 || bounded.length >= MAX_EVIDENCE_ITEMS) break;
    const question = clipAtSentence(item.question, Math.min(120, Math.floor(MAX_EVIDENCE_ITEM_CHARS / 3)));
    const answerBudget = Math.min(MAX_EVIDENCE_ITEM_CHARS - question.length, remaining - question.length);
    const answer = clipAtSentence(item.answer, answerBudget);
    if (!answer) continue;
    bounded.push({ id: item.id, question, answer, sourceMessageIds: item.sourceMessageIds });
    remaining -= question.length + answer.length;
  }
  return bounded;
}

function evidenceUnits(item: RetrieverEvidence): Array<Omit<RealtimeQAEvidence, 'id' | 'score'>> {
  const currentFormat = [...item.text.matchAll(QA_ENTRY)];
  if (currentFormat.length > 0) {
    return currentFormat.flatMap((match) => {
      const answer = match[4]?.trim() ?? '';
      const messageId = match[2]?.trim() ?? '';
      if (!answer || !messageId) return [];
      return [{
        question: match[3]?.trim() ?? '',
        answer,
        sourceMessageIds: [messageId],
      }];
    });
  }

  // Read already-indexed message-grain documents during the format migration.
  const messages = [...item.text.matchAll(LEGACY_MESSAGE)];
  const units: Array<Omit<RealtimeQAEvidence, 'id' | 'score'>> = [];
  let latestAssistant: string | undefined;
  for (const match of messages) {
    const messageId = match[2]?.trim() ?? '';
    const role = match[3];
    const text = match[4]?.trim() ?? '';
    if (role === 'assistant') {
      latestAssistant = text;
    } else if (role === 'user') {
      if (text && messageId) {
        units.push({
          question: latestAssistant ?? '',
          answer: text,
          sourceMessageIds: [messageId],
        });
      }
      latestAssistant = undefined;
    }
  }
  return units;
}

/**
 * Retrieves only Current Story subject evidence. Missing story scope fails closed
 * before the Retriever adapter can interpret it as an owner-wide query.
 */
export class RetrieverRealtimeRecall {
  constructor(
    private readonly retriever: RetrieverAdapter,
    private readonly topK = REALTIME_RECALL_TOP_K,
  ) {
    if (!Number.isInteger(topK) || topK <= 0) {
      throw new Error('Realtime Retriever topK must be a positive integer.');
    }
  }

  async retrieve(
    request: RealtimeRecallRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<RealtimeRetrievalResult> {
    const startedAt = performance.now();
    const storyId = request.storyId?.trim();
    if (!storyId) return { candidateCount: 0, evidence: [], latencyMs: 0 };

    const retrieved = await this.retriever.searchTranscript({
      ownerId: request.ownerId,
      storyId,
      sourceType: 'subject',
      query: request.query,
      topK: this.topK,
      signal: options.signal,
    });
    const evidence = retrieved
      .filter((item) => item.ownerId === request.ownerId
        && item.storyId === storyId
        && item.sourceType === 'subject'
        && item.sessionId.length > 0
        && item.text.trim().length > 0)
      .flatMap((item) => evidenceUnits(item).map((unit) => ({
        ...unit,
        score: item.score,
      })))
      .slice(0, this.topK)
      .map((item, index) => ({ ...item, id: `e${index + 1}` }));

    return {
      candidateCount: retrieved.length,
      evidence,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
    };
  }

}
