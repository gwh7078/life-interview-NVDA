import { createHmac, timingSafeEqual } from 'node:crypto';

export interface AgentToolTokenPayload {
  runId: string;
  userId: string;
  tool: string;
  resourceType: string;
  resourceId: string;
  exp: number;
}

export interface AgentToolTokenExpectation {
  tool: string;
  resourceType: string;
  resourceId?: string;
}

export class AgentToolTokenError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_TOKEN' | 'TOKEN_EXPIRED' | 'TOKEN_SCOPE_MISMATCH',
  ) {
    super(message);
    this.name = 'AgentToolTokenError';
  }
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export class AgentToolTokenService {
  constructor(
    private readonly secret: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (Buffer.byteLength(secret, 'utf8') < 32) {
      throw new Error('AGENT_TOOL_TOKEN_SECRET must contain at least 32 bytes.');
    }
  }

  issue(input: Omit<AgentToolTokenPayload, 'exp'> & { ttlMs?: number }): string {
    const payload: AgentToolTokenPayload = {
      runId: input.runId,
      userId: input.userId,
      tool: input.tool,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      exp: this.now() + (input.ttlMs ?? 120_000),
    };
    const body = encode(payload);
    const signature = createHmac('sha256', this.secret).update(body).digest('base64url');
    return body + '.' + signature;
  }

  verify(token: string, expected: AgentToolTokenExpectation): AgentToolTokenPayload {
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra) throw new AgentToolTokenError('Invalid agent tool token.', 'INVALID_TOKEN');
    const expectedSignature = createHmac('sha256', this.secret).update(body).digest('base64url');
    const actualBuffer = Buffer.from(signature, 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
      throw new AgentToolTokenError('Invalid agent tool token.', 'INVALID_TOKEN');
    }

    let payload: AgentToolTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AgentToolTokenPayload;
    } catch {
      throw new AgentToolTokenError('Invalid agent tool token.', 'INVALID_TOKEN');
    }
    if (!payload || typeof payload.runId !== 'string' || typeof payload.userId !== 'string'
      || typeof payload.tool !== 'string' || typeof payload.resourceType !== 'string'
      || typeof payload.resourceId !== 'string' || typeof payload.exp !== 'number') {
      throw new AgentToolTokenError('Invalid agent tool token.', 'INVALID_TOKEN');
    }
    if (payload.exp <= this.now()) throw new AgentToolTokenError('Agent tool token expired.', 'TOKEN_EXPIRED');
    if (payload.tool !== expected.tool || payload.resourceType !== expected.resourceType
      || (expected.resourceId !== undefined && payload.resourceId !== expected.resourceId)) {
      throw new AgentToolTokenError('Agent tool token scope mismatch.', 'TOKEN_SCOPE_MISMATCH');
    }
    return payload;
  }
}
