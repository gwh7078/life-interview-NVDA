import { performance } from 'node:perf_hooks';
import { AgentToolTokenError, type AgentToolTokenService } from '../../agent/tools/token.js';
import { createDatabase } from '../db/client.js';
import { EraContextClientError } from '../era-context/client.js';
import type { EraContextAdapter } from '../era-context/types.js';
import type { RetrieverAdapter, RetrieverEvidence } from './types.js';

export const evidenceSearchSourceTypes = [
  'owner_transcript',
  'contributor_transcript',
  'profile',
  'life_stage',
  'story_memory',
  'story_summary',
  'related_story',
  'era',
] as const;

export type EvidenceSearchSourceType = typeof evidenceSearchSourceTypes[number];

export interface EvidenceSearchTokenScope {
  task: string;
  skill: string;
  allowedSourceTypes: EvidenceSearchSourceType[];
  storyId?: string;
  stageId?: string;
  shareId?: string;
  currentSessionId?: string;
}

export interface EvidenceSearchRequest {
  query: string;
  source_types: EvidenceSearchSourceType[];
  top_k: number;
  year_range?: { start: number; end: number };
}

export interface EvidenceSearchEvidence {
  source_type: EvidenceSearchSourceType;
  text: string;
  score: number;
  source_ref: string;
  story_ref?: string;
  message_refs?: string[];
  segment_refs?: string[];
  time_hint?: string;
}

export interface EvidenceSearchResponse {
  evidence: EvidenceSearchEvidence[];
  retrieval: {
    status: 'ok' | 'unavailable';
    result_count: number;
    query_chars: number;
    latency_ms: number;
    timeout: boolean;
  };
}

export class EvidenceSearchError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'INVALID_EVIDENCE_SEARCH_REQUEST'
      | 'EVIDENCE_SEARCH_TOKEN_INVALID'
      | 'EVIDENCE_SEARCH_FORBIDDEN',
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'EvidenceSearchError';
  }
}

interface EvidenceSearchDependencies {
  retriever: RetrieverAdapter;
  eraContext?: EraContextAdapter;
  databasePath?: string;
  timeoutMs?: number;
  onTrace?: (trace: {
    runId?: string;
    task: string;
    skill: string;
    sourceTypes: EvidenceSearchSourceType[];
    resultCount: number;
    latencyMs: number;
    status: 'ok' | 'unavailable';
    timeout: boolean;
  }) => void;
}

interface SearchScope extends EvidenceSearchTokenScope {
  ownerId: string;
  runId?: string;
}

const MAX_TOP_K = 5;
const MAX_TEXT_CHARS = 1_200;
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_CONTRIBUTOR_SESSIONS = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSourceType(value: unknown): value is EvidenceSearchSourceType {
  return typeof value === 'string' && (evidenceSearchSourceTypes as readonly string[]).includes(value);
}

function invalidRequest(message: string): EvidenceSearchError {
  return new EvidenceSearchError(message, 'INVALID_EVIDENCE_SEARCH_REQUEST', 400);
}

function readRequest(body: unknown): EvidenceSearchRequest {
  if (!isRecord(body)) throw invalidRequest('A JSON object is required.');
  const allowedKeys = new Set(['query', 'source_types', 'top_k', 'year_range']);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw invalidRequest('Only query, source_types, top_k, and year_range are accepted.');
  }
  if (typeof body.query !== 'string' || body.query.trim().length < 2 || body.query.trim().length > 500) {
    throw invalidRequest('query must contain between 2 and 500 characters.');
  }
  if (!Array.isArray(body.source_types) || body.source_types.length < 1
    || body.source_types.length > evidenceSearchSourceTypes.length
    || body.source_types.some((item) => !isSourceType(item))
    || new Set(body.source_types).size !== body.source_types.length) {
    throw invalidRequest('source_types must be a non-empty list of supported, unique sources.');
  }
  const topK = body.top_k === undefined ? MAX_TOP_K : body.top_k;
  if (!Number.isInteger(topK) || (topK as number) < 1 || (topK as number) > MAX_TOP_K) {
    throw invalidRequest(`top_k must be between 1 and ${MAX_TOP_K}.`);
  }
  let yearRange: { start: number; end: number } | undefined;
  if (body.year_range !== undefined) {
    if (!isRecord(body.year_range)
      || Object.keys(body.year_range).some((key) => key !== 'start' && key !== 'end')) {
      throw invalidRequest('year_range must contain only start and end.');
    }
    const { start, end } = body.year_range;
    if (!Number.isInteger(start) || !Number.isInteger(end)
      || (start as number) < 1970 || (end as number) > 2020
      || (start as number) > (end as number)) {
      throw invalidRequest('year_range must be an ordered range from 1970 through 2020.');
    }
    yearRange = { start: start as number, end: end as number };
  }
  if ((body.source_types as unknown[]).includes('era') && !yearRange) {
    throw invalidRequest('year_range is required when searching era evidence.');
  }
  return {
    query: body.query.trim(),
    source_types: body.source_types as EvidenceSearchSourceType[],
    top_k: topK as number,
    ...(yearRange ? { year_range: yearRange } : {}),
  };
}

function readTokenScope(value: unknown): EvidenceSearchTokenScope {
  if (!isRecord(value)
    || typeof value.task !== 'string'
    || typeof value.skill !== 'string'
    || !Array.isArray(value.allowedSourceTypes)
    || value.allowedSourceTypes.length === 0
    || value.allowedSourceTypes.some((item) => !isSourceType(item))
    || new Set(value.allowedSourceTypes).size !== value.allowedSourceTypes.length
    || ['storyId', 'stageId', 'shareId', 'currentSessionId'].some((key) => (
      value[key] !== undefined && (typeof value[key] !== 'string' || !value[key])
    ))) {
    throw new EvidenceSearchError('Evidence search token scope is invalid.', 'EVIDENCE_SEARCH_TOKEN_INVALID', 401);
  }
  return {
    task: value.task,
    skill: value.skill,
    allowedSourceTypes: value.allowedSourceTypes as EvidenceSearchSourceType[],
    ...(typeof value.storyId === 'string' ? { storyId: value.storyId } : {}),
    ...(typeof value.stageId === 'string' ? { stageId: value.stageId } : {}),
    ...(typeof value.shareId === 'string' ? { shareId: value.shareId } : {}),
    ...(typeof value.currentSessionId === 'string' ? { currentSessionId: value.currentSessionId } : {}),
  };
}

function cleanText(value: string): string {
  return Array.from(value.replace(/\r\n?/gu, '\n').trim()).slice(0, MAX_TEXT_CHARS).join('');
}

function transcriptText(value: string): string {
  const text = value.replace(/\r\n?/gu, '\n')
    .split('\n')
    .filter((line) => !/^\s*(?:#|user_id:|session_id:|story_id:|stage_id:|session_type:|source_type:|ended_at:)/iu.test(line))
    .join('\n')
    .trim();
  if (Array.from(text).length <= MAX_TEXT_CHARS) return text;

  const units = text.split(/(?=^\[segment_id=[^\]]+\]\[message_id=[^\]]+\]\[Q\+A\]$)/mu)
    .map((unit) => unit.trim())
    .filter(Boolean);
  if (units.length === 0 || units.some((unit) => (
    !/^\[segment_id=[^\]]+\]\[message_id=[^\]]+\]\[Q\+A\]$/u.test(unit.split('\n', 1)[0] ?? '')
  ))) return '';

  const bounded: string[] = [];
  let length = 0;
  for (const unit of units) {
    const unitLength = Array.from(unit).length;
    const separatorLength = bounded.length > 0 ? 1 : 0;
    if (length + separatorLength + unitLength > MAX_TEXT_CHARS) continue;
    bounded.push(unit);
    length += separatorLength + unitLength;
  }
  return bounded.join('\n');
}

function retainedReferences(values: string[], text: string, field: 'message_id' | 'segment_id'): string[] {
  const pattern = new RegExp(`\\[${field}=([^\\]]+)\\]`, 'gu');
  const present = new Set([...text.matchAll(pattern)].map((match) => match[1]));
  return values.filter((value) => present.size === 0 || present.has(value)).slice(0, 20);
}

function scoreText(query: string, text: string): number {
  const queryParts = query.toLocaleLowerCase().match(/[\p{Script=Han}]+|[a-z0-9]+/giu) ?? [];
  const terms = new Set<string>();
  for (const part of queryParts) {
    const normalized = part.toLocaleLowerCase();
    if (/^[\p{Script=Han}]+$/u.test(normalized)) {
      if (normalized.length >= 2) terms.add(normalized);
      const chars = Array.from(normalized);
      for (let index = 0; index < chars.length - 1; index += 1) {
        terms.add(chars[index]! + chars[index + 1]!);
      }
    } else if (normalized.length > 1) {
      terms.add(normalized);
    }
  }
  if (terms.size === 0) return 0;
  const normalizedText = text.toLocaleLowerCase();
  const matched = [...terms].filter((term) => normalizedText.includes(term)).length;
  if (matched === 0) return 0;
  const phraseBonus = normalizedText.includes(query.toLocaleLowerCase()) ? 0.25 : 0;
  return Math.min(1, matched / terms.size * 0.75 + phraseBonus);
}

function boundedScore(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function transcriptMatch(
  evidence: RetrieverEvidence,
  scope: SearchScope,
  sourceType: 'owner_transcript' | 'contributor_transcript',
): EvidenceSearchEvidence | undefined {
  const expectedSource = sourceType === 'owner_transcript' ? 'subject' : 'external_contributor';
  if (evidence.ownerId !== scope.ownerId
    || evidence.storyId !== scope.storyId
    || evidence.sourceType !== expectedSource
    || !evidence.sessionId
    || !evidence.text.trim()) return undefined;
  const text = transcriptText(evidence.text);
  if (!text) return undefined;
  return {
    source_type: sourceType,
    text,
    score: boundedScore(evidence.score),
    source_ref: evidence.sessionId,
    story_ref: evidence.storyId,
    ...(evidence.messageIds.length ? { message_refs: retainedReferences(evidence.messageIds, text, 'message_id') } : {}),
    ...(evidence.segmentIds.length ? { segment_refs: retainedReferences(evidence.segmentIds, text, 'segment_id') } : {}),
  };
}

function sessionIdsForContributor(
  databasePath: string | undefined,
  scope: SearchScope,
): string[] {
  if (!scope.storyId) return [];
  const connection = createDatabase(databasePath);
  try {
    return (connection.sqlite.prepare(`
      SELECT sessions.session_id AS sessionId
      FROM interview_sessions AS sessions
      JOIN story_share_links AS shares
        ON shares.share_id = sessions.source_share_id
       AND shares.user_id = sessions.user_id
       AND shares.story_id = sessions.story_id
      WHERE sessions.user_id = ?
        AND sessions.story_id = ?
        AND (? = '' OR sessions.source_share_id = ?)
        AND sessions.source_type = 'external_contributor'
        AND sessions.session_id <> ?
        AND shares.status = 'active'
      ORDER BY sessions.ended_at DESC, sessions.created_at DESC
      LIMIT ?
    `).all(
      scope.ownerId,
      scope.storyId,
      scope.shareId ?? '',
      scope.shareId ?? '',
      scope.currentSessionId ?? '',
      MAX_CONTRIBUTOR_SESSIONS,
    ) as Array<{ sessionId: string }>).map((row) => row.sessionId);
  } finally {
    connection.close();
  }
}

function structuredEvidence(
  databasePath: string | undefined,
  scope: SearchScope,
  request: EvidenceSearchRequest,
): EvidenceSearchEvidence[] {
  const wanted = new Set(request.source_types);
  if (![...wanted].some((item) => ['profile', 'life_stage', 'story_memory', 'story_summary', 'related_story'].includes(item))) {
    return [];
  }
  const connection = createDatabase(databasePath);
  try {
    const evidence: EvidenceSearchEvidence[] = [];
    const add = (
      sourceType: EvidenceSearchSourceType,
      text: string,
      sourceRef: string,
      scoreTextValue: string,
      extra: Pick<EvidenceSearchEvidence, 'story_ref' | 'time_hint'> = {},
    ) => {
      const score = scoreText(request.query, scoreTextValue);
      if (score > 0 && text.trim()) {
        evidence.push({ source_type: sourceType, text: cleanText(text), score, source_ref: sourceRef, ...extra });
      }
    };

    if (wanted.has('profile')) {
      const profile = connection.sqlite.prepare(`
        SELECT name, birth_date AS birthDate, gender, birth_place AS birthPlace,
          current_location AS currentLocation, current_status AS currentStatus,
          occupation_summary AS occupationSummary, family_summary AS familySummary,
          profile_summary AS profileSummary
        FROM users WHERE user_id = ? LIMIT 1
      `).get(scope.ownerId) as Record<string, string | null> | undefined;
      if (profile) {
        for (const [field, label] of [
          ['name', '姓名'], ['birthDate', '出生日期'], ['gender', '性别'],
          ['birthPlace', '出生地'], ['currentLocation', '现居地'], ['currentStatus', '当前状态'],
          ['occupationSummary', '职业概况'], ['familySummary', '家庭概况'], ['profileSummary', '人生概况'],
        ] as const) {
          const value = profile[field];
          if (typeof value === 'string' && value.trim()) {
            add('profile', `${label}：${value}`, `profile:${field}`, `${label} ${value}`);
          }
        }
      }
    }

    if (wanted.has('life_stage')) {
      const stages = connection.sqlite.prepare(`
        SELECT stage_id AS stageId, title, start_date AS startDate, end_date AS endDate, summary
        FROM life_stages WHERE user_id = ? ORDER BY sort_order, created_at LIMIT 100
      `).all(scope.ownerId) as Array<Record<string, string | null>>;
      for (const stage of stages) {
        const dates = [stage.startDate, stage.endDate].filter((value): value is string => Boolean(value));
        const text = [stage.title, dates.join('–'), stage.summary].filter(Boolean).join('；');
        add('life_stage', text, String(stage.stageId), text, dates.length ? { time_hint: dates.join('–') } : {});
      }
    }

    if ((wanted.has('story_memory') || wanted.has('story_summary')) && scope.storyId) {
      const story = connection.sqlite.prepare(`
        SELECT story_id AS storyId, title, summary, agent_memory AS agentMemory
        FROM stories WHERE user_id = ? AND story_id = ? LIMIT 1
      `).get(scope.ownerId, scope.storyId) as {
        storyId: string; title: string; summary: string | null; agentMemory: string;
      } | undefined;
      if (story) {
        if (wanted.has('story_memory') && story.agentMemory) {
          const text = `${story.title}：${story.agentMemory}`;
          add('story_memory', text, story.storyId, text, { story_ref: story.storyId });
        }
        if (wanted.has('story_summary') && story.summary) {
          const text = `${story.title}：${story.summary}`;
          add('story_summary', text, story.storyId, text, { story_ref: story.storyId });
        }
      }
    }

    if (wanted.has('related_story')) {
      const stories = connection.sqlite.prepare(`
        SELECT story_id AS storyId, title, summary
        FROM stories
        WHERE user_id = ? AND (? = '' OR story_id <> ?)
        ORDER BY updated_at DESC LIMIT 100
      `).all(scope.ownerId, scope.storyId ?? '', scope.storyId ?? '') as Array<{
        storyId: string; title: string; summary: string | null;
      }>;
      for (const story of stories) {
        const text = [story.title, story.summary].filter(Boolean).join('：');
        add('related_story', text, story.storyId, text, { story_ref: story.storyId });
      }
    }
    return evidence;
  } finally {
    connection.close();
  }
}

export class EvidenceSearchService {
  constructor(private readonly dependencies: EvidenceSearchDependencies) {}

  async searchScoped(
    scope: SearchScope,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<EvidenceSearchResponse> {
    const request = readRequest(body);
    if (request.source_types.some((source) => !scope.allowedSourceTypes.includes(source))) {
      throw new EvidenceSearchError('Requested sources exceed the signed task scope.', 'EVIDENCE_SEARCH_FORBIDDEN', 403);
    }
    if (request.source_types.some((source) => ['owner_transcript', 'story_memory', 'story_summary'].includes(source))
      && !scope.storyId) {
      throw new EvidenceSearchError('A Story id is required for this source.', 'EVIDENCE_SEARCH_FORBIDDEN', 403);
    }
    if (request.source_types.includes('contributor_transcript')
      && (!scope.storyId || (scope.task === 'interview.closeout:contributor' && !scope.shareId))) {
      throw new EvidenceSearchError('Contributor search requires a Story and the authorized contributor scope.', 'EVIDENCE_SEARCH_FORBIDDEN', 403);
    }

    const startedAt = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    const failures: EvidenceSearchSourceType[] = [];
    const remoteSearches = request.source_types.filter((source) => (
      ['owner_transcript', 'contributor_transcript', 'era'].includes(source)
    ));

    const results = await Promise.all(remoteSearches.map(async (source): Promise<EvidenceSearchEvidence[]> => {
      try {
        if (source === 'owner_transcript') {
          const found = await this.dependencies.retriever.searchTranscript({
            ownerId: scope.ownerId,
            storyId: scope.storyId,
            sourceType: 'subject',
            query: request.query,
            topK: request.top_k,
            signal: controller.signal,
          });
          return found.map((item) => transcriptMatch(item, scope, 'owner_transcript'))
            .filter((item): item is EvidenceSearchEvidence => Boolean(item));
        }
        if (source === 'contributor_transcript') {
          const sessionIds = sessionIdsForContributor(this.dependencies.databasePath, scope);
          const found = await Promise.all(sessionIds.map((sessionId) => this.dependencies.retriever.searchTranscript({
            ownerId: scope.ownerId,
            storyId: scope.storyId,
            sessionId,
            sourceType: 'external_contributor',
            query: request.query,
            topK: request.top_k,
            signal: controller.signal,
          })));
          const allowedSessions = new Set(sessionIds);
          return found.flat().filter((item) => allowedSessions.has(item.sessionId))
            .map((item) => transcriptMatch(item, scope, 'contributor_transcript'))
            .filter((item): item is EvidenceSearchEvidence => Boolean(item));
        }
        if (!this.dependencies.eraContext) throw new Error('ERA_CONTEXT_UNAVAILABLE');
        const matches = await this.dependencies.eraContext.search({
          query: request.query,
          start_year: request.year_range!.start,
          end_year: request.year_range!.end,
          top_k: request.top_k,
          signal: controller.signal,
        });
        return matches.slice(0, request.top_k).map((match) => ({
          source_type: 'era' as const,
          text: cleanText(`${match.title}：${match.summary}`),
          score: boundedScore(match.score),
          source_ref: `era:${match.category}:${match.start_year}-${match.end_year}`,
          time_hint: match.start_year === match.end_year
            ? String(match.start_year)
            : `${match.start_year}–${match.end_year}`,
        }));
      } catch (error) {
        failures.push(source);
        if (error instanceof EraContextClientError) return [];
        return [];
      }
    }));

    let structured: EvidenceSearchEvidence[] = [];
    if (request.source_types.some((source) => ['profile', 'life_stage', 'story_memory', 'story_summary', 'related_story'].includes(source))) {
      try {
        structured = structuredEvidence(this.dependencies.databasePath, scope, request);
      } catch {
        failures.push(...request.source_types.filter((source) => (
          ['profile', 'life_stage', 'story_memory', 'story_summary', 'related_story'].includes(source)
        )));
      }
    }

    const evidence = [...results.flat(), ...structured]
      .filter((item) => item.text.length > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, request.top_k);
    const latencyMs = Number((performance.now() - startedAt).toFixed(2));
    const status = failures.length > 0 || controller.signal.aborted ? 'unavailable' : 'ok';
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
    try {
      this.dependencies.onTrace?.({
        ...(scope.runId ? { runId: scope.runId } : {}),
        task: scope.task,
        skill: scope.skill,
        sourceTypes: request.source_types,
        resultCount: evidence.length,
        latencyMs,
        status,
        timeout: controller.signal.aborted,
      });
    } catch {
      // Search diagnostics must never affect a retrieval result.
    }
    return {
      evidence,
      retrieval: {
        status,
        result_count: evidence.length,
        query_chars: Array.from(request.query).length,
        latency_ms: latencyMs,
        timeout: controller.signal.aborted,
      },
    };
  }
}

export class EvidenceSearchGateway {
  private readonly service: EvidenceSearchService;
  private readonly tokenService: AgentToolTokenService;

  constructor(
    dependencies: EvidenceSearchDependencies & {
      tokenService: AgentToolTokenService;
      service?: EvidenceSearchService;
    },
  ) {
    this.tokenService = dependencies.tokenService;
    this.service = dependencies.service ?? new EvidenceSearchService(dependencies);
  }

  async search(token: string, body: unknown, signal?: AbortSignal): Promise<EvidenceSearchResponse> {
    let payload;
    try {
      payload = this.tokenService.verify(token, {
        tool: 'evidence_search',
        resourceType: 'agent_evidence_search',
      });
    } catch (error) {
      if (error instanceof AgentToolTokenError) {
        throw new EvidenceSearchError(error.message, 'EVIDENCE_SEARCH_TOKEN_INVALID', 401);
      }
      throw error;
    }
    const scope = readTokenScope(payload.evidenceSearch);
    return this.service.searchScoped({ ...scope, ownerId: payload.userId, runId: payload.runId }, body, signal);
  }

  searchTrusted(
    scope: SearchScope,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<EvidenceSearchResponse> {
    return this.service.searchScoped(scope, body, signal);
  }
}
