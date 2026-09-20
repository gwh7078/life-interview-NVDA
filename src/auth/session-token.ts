import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const AUTH_COOKIE_NAME = 'rensheng_session';
export const AUTH_SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

interface SessionClaims {
  v: 1;
  accountId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signAuthSession(accountId: string, secret: string, now = Date.now()): string {
  const claims: SessionClaims = {
    v: 1,
    accountId,
    issuedAt: Math.floor(now / 1_000),
    expiresAt: Math.floor(now / 1_000) + AUTH_SESSION_TTL_SECONDS,
    nonce: randomUUID(),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyAuthSession(token: string, secret: string, now = Date.now()): string | null {
  const [payload, suppliedSignature, extra] = token.split('.');
  if (!payload || !suppliedSignature || extra !== undefined) return null;
  const expected = Buffer.from(signature(payload, secret));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<SessionClaims>;
    const nowSeconds = Math.floor(now / 1_000);
    if (claims.v !== 1 || typeof claims.accountId !== 'string' || !claims.accountId
      || typeof claims.issuedAt !== 'number' || typeof claims.expiresAt !== 'number'
      || typeof claims.nonce !== 'string' || claims.issuedAt > nowSeconds + 60
      || claims.expiresAt <= nowSeconds || claims.expiresAt - claims.issuedAt > AUTH_SESSION_TTL_SECONDS) {
      return null;
    }
    return claims.accountId;
  } catch {
    return null;
  }
}

export function readAuthCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');
    if (name !== AUTH_COOKIE_NAME) continue;
    const value = valueParts.join('=');
    return value || null;
  }
  return null;
}

export function authCookieHeader(token: string, secure = false): string {
  return `${AUTH_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${AUTH_SESSION_TTL_SECONDS}${secure ? '; Secure' : ''}`;
}

export function clearAuthCookieHeader(secure = false): string {
  return `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}
