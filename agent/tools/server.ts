import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AgentToolTokenError, type AgentToolTokenService } from './token.js';
import { StoryContextTool } from './get-story-context.js';
import { FileAgentToolAuditLogger, type AgentToolAuditSink } from './audit-log.js';
import type { AgentTaskContextStore } from './task-context-store.js';

const MAX_REQUEST_BYTES = 16 * 1024;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_JSON_BODY');
  return value as Record<string, unknown>;
}

function bearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  if (!value?.startsWith('Bearer ')) return null;
  const token = value.slice('Bearer '.length).trim();
  return token || null;
}

export function createAgentToolServer(options: {
  databasePath?: string;
  tokenService: AgentToolTokenService;
  taskContexts?: AgentTaskContextStore;
  audit?: AgentToolAuditSink;
}): Server {
  const storyContext = new StoryContextTool(options.databasePath);
  const audit = options.audit ?? new FileAgentToolAuditLogger();

  return createServer(async (request, response) => {
    const started = Date.now();

    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, { status: 'ok', service: 'life-interview-agent-tools' });
      return;
    }

    const isStoryContext = request.method === 'POST'
      && request.url === '/internal/agent-tools/get_story_context';
    const isTaskContext = request.method === 'POST'
      && request.url === '/internal/agent-tools/get_task_context';
    if (!isStoryContext && !isTaskContext) {
      sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Tool endpoint not found.', retryable: false } });
      return;
    }

    const tool = isTaskContext ? 'get_task_context' : 'get_story_context';
    let runId: string | null = null;
    let userId: string | null = null;
    let resourceType = isStoryContext ? 'story' : 'task';
    let resourceId: string | null = null;

    try {
      const token = bearerToken(request);
      if (!token) throw new AgentToolTokenError('Missing Bearer token.', 'INVALID_TOKEN');
      const body = await readJson(request);

      if (isStoryContext) {
        const storyId = typeof body.story_id === 'string' ? body.story_id.trim() : '';
        resourceType = 'story';
        resourceId = storyId || null;
        if (!storyId) {
          sendJson(response, 400, { error: { code: 'INVALID_RESOURCE', message: 'story_id is required.', retryable: false } });
          audit.write({ timestamp: new Date().toISOString(), runId, userId, tool, resourceType,
            resourceId, outcome: 'denied', latencyMs: Date.now() - started, errorCode: 'INVALID_RESOURCE' });
          return;
        }

        const payload = options.tokenService.verify(token, {
          tool,
          resourceType: 'story',
          resourceId: storyId,
        });
        runId = payload.runId;
        userId = payload.userId;

        const result = storyContext.getForOwner(payload.userId, storyId);
        if (!result) {
          sendJson(response, 404, { error: { code: 'STORY_NOT_FOUND', message: 'Story not found in token owner scope.', retryable: false } });
          audit.write({ timestamp: new Date().toISOString(), runId, userId, tool, resourceType,
            resourceId, outcome: 'not_found', latencyMs: Date.now() - started, errorCode: 'STORY_NOT_FOUND' });
          return;
        }

        sendJson(response, 200, result);
        audit.write({ timestamp: new Date().toISOString(), runId, userId, tool, resourceType,
          resourceId, outcome: 'allowed', latencyMs: Date.now() - started });
        return;
      }

      const requestedRunId = typeof body.run_id === 'string' ? body.run_id.trim() : '';
      const requestedResourceType = typeof body.resource_type === 'string' ? body.resource_type.trim() : '';
      const requestedResourceId = typeof body.resource_id === 'string' ? body.resource_id.trim() : '';
      runId = requestedRunId || null;
      resourceType = requestedResourceType || 'task';
      resourceId = requestedResourceId || null;

      if (!requestedRunId || !requestedResourceType || !requestedResourceId) {
        sendJson(response, 400, { error: { code: 'INVALID_RESOURCE', message: 'run_id, resource_type and resource_id are required.', retryable: false } });
        audit.write({ timestamp: new Date().toISOString(), runId, userId, tool, resourceType,
          resourceId, outcome: 'denied', latencyMs: Date.now() - started, errorCode: 'INVALID_RESOURCE' });
        return;
      }

      if (!options.taskContexts) {
        sendJson(response, 503, { error: { code: 'TASK_CONTEXT_STORE_UNAVAILABLE', message: 'Task context store is unavailable.', retryable: true } });
        return;
      }

      const tokenPayload = options.tokenService.verify(token, {
        tool,
        resourceType: requestedResourceType,
        resourceId: requestedResourceId,
      });
      userId = tokenPayload.userId;
      if (tokenPayload.runId !== requestedRunId) {
        throw new AgentToolTokenError('Agent tool token run scope mismatch.', 'TOKEN_SCOPE_MISMATCH');
      }

      const context = options.taskContexts.get(requestedRunId);
      if (!context) {
        sendJson(response, 404, { error: { code: 'TASK_CONTEXT_NOT_FOUND', message: 'Task context is missing or expired.', retryable: false } });
        audit.write({ timestamp: new Date().toISOString(), runId, userId, tool, resourceType,
          resourceId, outcome: 'not_found', latencyMs: Date.now() - started, errorCode: 'TASK_CONTEXT_NOT_FOUND' });
        return;
      }
      if (context.userId !== tokenPayload.userId
        || context.resourceType !== requestedResourceType
        || context.resourceId !== requestedResourceId) {
        throw new AgentToolTokenError('Agent tool token context scope mismatch.', 'TOKEN_SCOPE_MISMATCH');
      }

      sendJson(response, 200, {
        task_type: context.taskType,
        ...(context.mode ? { mode: context.mode } : {}),
        schema_version: context.schemaVersion,
        skill: context.skill,
        context: context.payload,
      });
      audit.write({ timestamp: new Date().toISOString(), runId, userId, tool, resourceType,
        resourceId, outcome: 'allowed', latencyMs: Date.now() - started });
    } catch (error) {
      if (error instanceof AgentToolTokenError) {
        const status = error.code === 'TOKEN_SCOPE_MISMATCH' ? 403 : 401;
        sendJson(response, status, { error: { code: error.code, message: error.message, retryable: false } });
        audit.write({ timestamp: new Date().toISOString(), runId, userId, tool, resourceType,
          resourceId, outcome: 'denied', latencyMs: Date.now() - started, errorCode: error.code });
        return;
      }
      const code = error instanceof SyntaxError ? 'INVALID_JSON_BODY'
        : error instanceof Error ? error.message : 'TOOL_INTERNAL_ERROR';
      const status = code === 'REQUEST_TOO_LARGE' ? 413 : code === 'INVALID_JSON_BODY' ? 400 : 500;
      sendJson(response, status, { error: { code, message: 'Agent Tool request failed.', retryable: status >= 500 } });
      audit.write({ timestamp: new Date().toISOString(), runId, userId, tool, resourceType,
        resourceId, outcome: 'error', latencyMs: Date.now() - started, errorCode: code });
    }
  });
}
