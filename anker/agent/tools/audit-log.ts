import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface AgentToolAuditEvent {
  timestamp: string;
  runId: string | null;
  userId: string | null;
  tool: string;
  resourceType: string;
  resourceId: string | null;
  outcome: 'allowed' | 'denied' | 'not_found' | 'error';
  latencyMs: number;
  errorCode?: string;
}

export interface AgentToolAuditSink {
  write(event: AgentToolAuditEvent): void;
}

export class FileAgentToolAuditLogger implements AgentToolAuditSink {
  constructor(private readonly filePath = process.env.AGENT_TOOL_AUDIT_LOG ?? './runtime/diagnostics/agent-tools.jsonl') {}

  write(event: AgentToolAuditEvent): void {
    const resolved = path.resolve(this.filePath);
    mkdirSync(path.dirname(resolved), { recursive: true });
    appendFileSync(resolved, JSON.stringify(event) + '\n', 'utf8');
  }
}

export const noOpAgentToolAudit: AgentToolAuditSink = { write: () => undefined };
