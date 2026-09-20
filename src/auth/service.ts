import { normalizeDemoPhone, normalizePhone, PhoneNormalizationError } from './phone.js';
import { signAuthSession, verifyAuthSession } from './session-token.js';
import type { AuthContext } from './context.js';
import {
  AccountRepository,
  type DefaultProfileSummary,
} from '../repositories/account-repository.js';
import {
  type VerificationProvider,
  VerificationUnavailableError,
} from './verification-provider.js';

export class AuthError extends Error {
  constructor(message: string, readonly code: string, readonly httpStatus: number) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface AuthServiceOptions {
  databasePath?: string;
  sessionSecret: string;
  verificationProvider: VerificationProvider;
  developmentAuthEnabled: boolean;
  authMode?: 'sms' | 'demo_phone';
}

export interface AuthenticatedSession {
  token: string;
  profile: DefaultProfileSummary;
}

export class AuthService {
  private readonly accounts: AccountRepository;
  readonly authMode: 'sms' | 'demo_phone';

  constructor(private readonly options: AuthServiceOptions) {
    if (options.sessionSecret.length < 32) throw new Error('AUTH_SESSION_SECRET must contain at least 32 characters.');
    this.accounts = new AccountRepository(options.databasePath);
    this.authMode = options.authMode ?? 'sms';
  }

  async loginWithDemoPhone(phoneInput: string): Promise<AuthenticatedSession> {
    if (this.authMode !== 'demo_phone') {
      throw new AuthError('当前登录模式不支持 Demo 手机号登录。', 'DEMO_PHONE_AUTH_DISABLED', 404);
    }
    let phone: string;
    try {
      phone = normalizeDemoPhone(phoneInput);
    } catch (error) {
      if (error instanceof PhoneNormalizationError) throw new AuthError(error.message, 'INVALID_PHONE', 400);
      throw error;
    }

    let profile: DefaultProfileSummary;
    try {
      profile = this.accounts.getOrCreateDemoPhoneProfile(phone);
    } catch (error) {
      if (error instanceof Error && error.message === 'ACCOUNT_DISABLED') {
        throw new AuthError('此账号当前不可用。', 'ACCOUNT_DISABLED', 403);
      }
      throw error;
    }
    return { token: this.createToken(profile.accountId), profile };
  }

  async requestPhoneVerification(phoneInput: string): Promise<{ challengeId: string; developmentCode?: string }> {
    if (this.authMode !== 'sms') {
      throw new AuthError('当前 Demo 登录不使用短信验证码。', 'AUTH_MODE_ROUTE_DISABLED', 404);
    }
    let phone: string;
    try {
      phone = normalizePhone(phoneInput);
    } catch (error) {
      if (error instanceof PhoneNormalizationError) throw new AuthError(error.message, 'INVALID_PHONE', 400);
      throw error;
    }
    try {
      return await this.options.verificationProvider.requestCode(phone);
    } catch (error) {
      if (error instanceof VerificationUnavailableError) throw new AuthError(error.message, 'VERIFICATION_UNAVAILABLE', 503);
      throw error;
    }
  }

  async verifyPhone(phoneInput: string, challengeId: string, code: string): Promise<AuthenticatedSession> {
    if (this.authMode !== 'sms') {
      throw new AuthError('当前 Demo 登录不使用短信验证码。', 'AUTH_MODE_ROUTE_DISABLED', 404);
    }
    let phone: string;
    try {
      phone = normalizePhone(phoneInput);
    } catch (error) {
      if (error instanceof PhoneNormalizationError) throw new AuthError(error.message, 'INVALID_PHONE', 400);
      throw error;
    }
    if (!challengeId || !/^\d{4,8}$/.test(code)) {
      throw new AuthError('验证码无效或已过期。', 'INVALID_VERIFICATION', 401);
    }
    const valid = await this.options.verificationProvider.verifyCode(phone, challengeId, code);
    if (!valid) throw new AuthError('验证码无效或已过期。', 'INVALID_VERIFICATION', 401);

    let profile: DefaultProfileSummary;
    try {
      profile = this.accounts.getOrCreateVerifiedPhoneProfile(phone);
    } catch (error) {
      if (error instanceof Error && error.message === 'ACCOUNT_DISABLED') {
        throw new AuthError('此账号当前不可用。', 'ACCOUNT_DISABLED', 403);
      }
      throw error;
    }
    return { token: this.createToken(profile.accountId), profile };
  }

  resolveToken(token: string | null | undefined): (AuthContext & DefaultProfileSummary) | null {
    if (!token) return null;
    const accountId = verifyAuthSession(token, this.options.sessionSecret);
    if (!accountId) return null;
    return this.accounts.resolveAuthContext(
      accountId,
      this.options.developmentAuthEnabled,
      this.authMode === 'demo_phone',
    );
  }

  createLegacyDevelopmentSession(): AuthenticatedSession {
    if (!this.options.developmentAuthEnabled) {
      throw new AuthError('开发档案登录未启用。', 'DEVELOPMENT_AUTH_DISABLED', 404);
    }
    const profile = this.accounts.getOnlyLegacyProfile();
    if (!profile) throw new AuthError('没有唯一的无手机号旧档案可供本地开发登录。', 'LEGACY_PROFILE_UNAVAILABLE', 409);
    return { token: this.createToken(profile.accountId), profile };
  }

  private createToken(accountId: string): string {
    return signAuthSession(accountId, this.options.sessionSecret);
  }
}
