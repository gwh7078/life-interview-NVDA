import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthContext } from './context.js';
import { AuthError, AuthService } from './service.js';
import { authCookieHeader, clearAuthCookieHeader, readAuthCookie } from './session-token.js';

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function requestIsLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress?.toLowerCase() ?? '';
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

function sameOrigin(request: IncomingMessage): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host.toLowerCase() === String(request.headers.host ?? '').toLowerCase();
  } catch {
    return false;
  }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of request) {
    body += Buffer.from(chunk).toString('utf8');
    if (body.length > 16_384) throw new AuthError('请求内容过大。', 'REQUEST_TOO_LARGE', 413);
  }
  if (!body) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    throw new Error('not an object');
  } catch {
    throw new AuthError('请求内容必须是 JSON 对象。', 'INVALID_REQUEST', 400);
  }
}

function stringField(body: Record<string, unknown>, name: string): string {
  return typeof body[name] === 'string' ? String(body[name]).trim() : '';
}

function publicProfile(profile: AuthContext & { phone: string | null; name: string | null; onboardingStatus: string }) {
  return {
    account_id: profile.accountId,
    user_id: profile.userId,
    phone: profile.phone,
    name: profile.name,
    onboarding_status: profile.onboardingStatus,
  };
}

function sendFailure(response: ServerResponse, error: unknown): void {
  if (error instanceof AuthError) {
    sendJson(response, error.httpStatus, { error: error.message, errorCode: error.code });
    return;
  }
  sendJson(response, 500, { error: '认证服务暂时不可用。', errorCode: 'AUTH_FAILED' });
}

/** Handles only /api/auth routes; returns false for paths owned by other HTTP modules. */
export async function handleAuthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  authService: AuthService,
  options: { developmentAuthEnabled: boolean; secureCookie: boolean; authMode?: 'sms' | 'demo_phone' },
): Promise<boolean> {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (!pathname.startsWith('/api/auth/')) return false;

  if (pathname === '/api/auth/me' && request.method === 'GET') {
    const token = readAuthCookie(request.headers.cookie);
    const profile = authService.resolveToken(token);
    if (!profile) sendJson(response, 401, {
      error: '请先登录。',
      errorCode: 'AUTH_REQUIRED',
      authMode: options.authMode ?? authService.authMode,
      developmentAuthEnabled: options.developmentAuthEnabled && requestIsLoopback(request),
    });
    else sendJson(response, 200, { profile: publicProfile(profile), authMode: options.authMode ?? authService.authMode });
    return true;
  }

  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return true;
  }
  if (!sameOrigin(request)) {
    sendJson(response, 403, { error: '跨站认证请求已拒绝。', errorCode: 'CROSS_SITE_REQUEST' });
    return true;
  }

  if (pathname === '/api/auth/logout') {
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': clearAuthCookieHeader(options.secureCookie),
    });
    response.end(JSON.stringify({ success: true }));
    return true;
  }

  if (pathname === '/api/auth/development/legacy-session') {
    if (!options.developmentAuthEnabled || !requestIsLoopback(request)) {
      sendJson(response, 404, { error: 'Not found.' });
      return true;
    }
    try {
      const session = authService.createLegacyDevelopmentSession();
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': authCookieHeader(session.token, options.secureCookie),
      });
      response.end(JSON.stringify({ profile: publicProfile(session.profile), developmentOnly: true }));
    } catch (error) { sendFailure(response, error); }
    return true;
  }

  if (pathname === '/api/auth/demo-phone') {
    try {
      const body = await readBody(request);
      const session = await authService.loginWithDemoPhone(stringField(body, 'phone'));
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': authCookieHeader(session.token, options.secureCookie),
      });
      response.end(JSON.stringify({ profile: publicProfile(session.profile), authMode: authService.authMode }));
    } catch (error) { sendFailure(response, error); }
    return true;
  }

  try {
    const body = await readBody(request);
    if (pathname === '/api/auth/verification') {
      const challenge = await authService.requestPhoneVerification(stringField(body, 'phone'));
      sendJson(response, 200, {
        challengeId: challenge.challengeId,
        ...(options.developmentAuthEnabled && requestIsLoopback(request) && challenge.developmentCode
          ? { developmentCode: challenge.developmentCode }
          : {}),
      });
      return true;
    }
    if (pathname === '/api/auth/verify') {
      const session = await authService.verifyPhone(
        stringField(body, 'phone'),
        stringField(body, 'challengeId'),
        stringField(body, 'code'),
      );
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': authCookieHeader(session.token, options.secureCookie),
      });
      response.end(JSON.stringify({ profile: publicProfile(session.profile) }));
      return true;
    }
  } catch (error) {
    sendFailure(response, error);
    return true;
  }

  sendJson(response, 404, { error: 'Not found.' });
  return true;
}
