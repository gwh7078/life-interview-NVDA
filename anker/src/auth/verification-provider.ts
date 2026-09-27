import { randomUUID } from 'node:crypto';

export interface VerificationChallenge {
  challengeId: string;
  developmentCode?: string;
}

export interface VerificationProvider {
  requestCode(phone: string): Promise<VerificationChallenge>;
  verifyCode(phone: string, challengeId: string, code: string): Promise<boolean>;
}

export class VerificationUnavailableError extends Error {
  constructor() {
    super('当前环境未配置手机号验证码服务。');
    this.name = 'VerificationUnavailableError';
  }
}

/** A deliberately local adapter for development and automated tests only. */
export class DevelopmentVerificationProvider implements VerificationProvider {
  private readonly challenges = new Map<string, { phone: string; code: string; expiresAt: number }>();

  constructor(
    private readonly code = '000000',
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async requestCode(phone: string): Promise<VerificationChallenge> {
    const challengeId = randomUUID();
    this.challenges.set(challengeId, { phone, code: this.code, expiresAt: this.now() + this.ttlMs });
    return { challengeId, developmentCode: this.code };
  }

  async verifyCode(phone: string, challengeId: string, code: string): Promise<boolean> {
    const challenge = this.challenges.get(challengeId);
    this.challenges.delete(challengeId);
    return Boolean(challenge && challenge.expiresAt > this.now()
      && challenge.phone === phone && challenge.code === code);
  }
}

export class UnconfiguredSmsVerificationProvider implements VerificationProvider {
  async requestCode(): Promise<VerificationChallenge> {
    throw new VerificationUnavailableError();
  }

  async verifyCode(): Promise<boolean> {
    return false;
  }
}
