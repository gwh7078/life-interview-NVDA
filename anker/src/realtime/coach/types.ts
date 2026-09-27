export type CoachScenario = 'onboarding' | 'story_create' | 'story_continue' | 'contributor';
export type CoachAction = 'none' | 'guide' | 'correct';
export type CoachReason =
  | 'normal'
  | 'repeated_question'
  | 'direction_drift'
  | 'history_reference'
  | 'possible_conflict'
  | 'missing_key_detail'
  | 'scenario_boundary';

export interface CoachConversationMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface CoachGateInput {
  scenario: CoachScenario;
  lastAssistantQuestion: string | null;
  currentUserAnswer: string;
  boundedRecentContext: CoachConversationMessage[];
  scenarioState: Record<string, unknown>;
}

export interface CoachGateResult {
  action: CoachAction;
  retrieve_memory: boolean;
  memory_query: string | null;
  retrieve_era: boolean;
  era_query: string | null;
  era_start_year: number | null;
  era_end_year: number | null;
  reason: CoachReason;
  avoid: string | null;
  direction: string | null;
}

export interface CoachEvidence {
  id: string;
  question: string;
  answer: string;
}

export interface CoachEraEvidence {
  id: string;
  startYear: number;
  endYear: number;
  title?: string;
  summary: string;
}

export interface CoachResolveInput {
  scenario: CoachScenario;
  currentUserAnswer: string;
  gate: CoachGateResult;
  memoryEvidence: CoachEvidence[];
  eraEvidence: CoachEraEvidence[];
}

export interface CoachPacket {
  selectedEvidenceIds: string[];
  known: string[];
  backgroundHint: string | null;
  conflict: string | null;
  avoid: string | null;
  direction: string | null;
}

export interface RealtimeCoachPort {
  evaluate(input: CoachGateInput, options?: { signal?: AbortSignal }): Promise<CoachGateResult>;
  resolve(input: CoachResolveInput, options?: { signal?: AbortSignal }): Promise<CoachPacket>;
}
