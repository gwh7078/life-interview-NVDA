import type { AgentToolTokenService } from '../../agent/tools/token.js';
import { getAgentTaskDefinition } from './definitions/task-definition-registry.js';
import type { AgentScriptContext } from './ports/agent-task-port.js';
import type { AgentTaskRequestUnion } from './contracts/index.js';

export interface EvidenceSearchScriptConfig {
  baseUrl: string;
  tokenService: AgentToolTokenService;
}

export function createEvidenceSearchScriptContext(
  config: EvidenceSearchScriptConfig | undefined,
  request: AgentTaskRequestUnion,
  extra: { storyId?: string; shareId?: string; currentSessionId?: string } = {},
): AgentScriptContext | undefined {
  if (!config) return undefined;
  const definition = getAgentTaskDefinition(request.taskType, request.mode);
  if (!definition.executionPolicy.scriptCapabilities.includes('evidence-search')) return undefined;
  const storyId = extra.storyId ?? (request.resource.type === 'story' ? request.resource.id : undefined);
  const shareId = extra.shareId ?? (request.resource.type === 'story_share' ? request.resource.id : undefined);
  const ttlMs = definition.executionPolicy.timeoutMs * definition.executionPolicy.maxAttempts + 60_000;
  return {
    baseUrl: config.baseUrl,
    token: config.tokenService.issue({
      runId: request.runId,
      userId: request.ownerId,
      tool: 'evidence_search',
      resourceType: 'agent_evidence_search',
      resourceId: request.runId,
      evidenceSearch: {
        task: `${request.taskType}${request.mode ? `:${request.mode}` : ''}`,
        skill: definition.skill,
        allowedSourceTypes: [...definition.executionPolicy.evidenceSourceTypes],
        ...(storyId ? { storyId } : {}),
        ...(shareId ? { shareId } : {}),
        ...(extra.currentSessionId ? { currentSessionId: extra.currentSessionId } : {}),
      },
      ttlMs,
    }),
  };
}
