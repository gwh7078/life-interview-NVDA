import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { accounts, users } from '../src/db/schema.js';
import { AuthError, AuthService } from '../src/auth/service.js';
import { normalizeDemoPhone, normalizePhone, PhoneNormalizationError } from '../src/auth/phone.js';
import { DevelopmentVerificationProvider, UnconfiguredSmsVerificationProvider } from '../src/auth/verification-provider.js';

const temporaryDirectories: string[] = [];
const testTempRoot = path.resolve('data/test-tmp');
mkdirSync(testTempRoot, { recursive: true });

after(() => temporaryDirectories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

test('phone normalization converges common China-number formats to one identity', () => {
  const canonical = '+8613800138000';
  assert.equal(normalizePhone('13800138000'), canonical);
  assert.equal(normalizePhone('86 138-0013-8000'), canonical);
  assert.equal(normalizePhone('+86 (138) 0013.8000'), canonical);
  assert.equal(normalizePhone('001 415 555 0134'), '+14155550134');
  assert.throws(() => normalizePhone('1380013'), PhoneNormalizationError);
  assert.throws(() => normalizePhone('someone@example.com'), PhoneNormalizationError);
});

test('Demo phone normalization accepts the competition format without carrier-prefix restrictions', () => {
  const canonical = '+8610000000000';
  assert.equal(normalizeDemoPhone('10000000000'), canonical);
  assert.equal(normalizeDemoPhone('+86 100 0000 0000'), canonical);
  assert.equal(normalizeDemoPhone('86 100-0000-0000'), canonical);
  assert.throws(() => normalizeDemoPhone('123'), PhoneNormalizationError);
  assert.throws(() => normalizeDemoPhone('abcdefghijk'), PhoneNormalizationError);
  assert.throws(() => normalizeDemoPhone('01234567890'), PhoneNormalizationError);
  assert.throws(() => normalizeDemoPhone('+14155550134'), PhoneNormalizationError);
});

test('verified phone resolves one Account and one nullable default Profile; invalid tokens fail closed', async () => {
  const directory = mkdtempSync(path.join(testTempRoot, 'rensheng-auth-test-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'auth.db');
  const db = createDatabase(databasePath);
  try { runMigrations(db); } finally { db.close(); }

  const provider = new DevelopmentVerificationProvider('123456');
  const auth = new AuthService({
    databasePath,
    sessionSecret: 'test-session-secret-with-more-than-32-chars',
    verificationProvider: provider,
    developmentAuthEnabled: true,
  });
  const firstChallenge = await auth.requestPhoneVerification('138 0013 8000');
  await assert.rejects(
    auth.verifyPhone('13800138000', firstChallenge.challengeId, '000000'),
    (error: unknown) => error instanceof AuthError && error.code === 'INVALID_VERIFICATION',
  );

  const validChallenge = await auth.requestPhoneVerification('+86 138-0013-8000');
  const first = await auth.verifyPhone('13800138000', validChallenge.challengeId, '123456');
  assert.equal(first.profile.phone, '+8613800138000');
  assert.equal(first.profile.name, null);
  assert.equal(first.profile.onboardingStatus, 'not_started');
  assert.equal(auth.resolveToken(first.token)?.userId, first.profile.userId);
  assert.equal(auth.resolveToken(first.token + 'tampered'), null);

  const equivalentChallenge = await auth.requestPhoneVerification('8613800138000');
  const second = await auth.verifyPhone('+8613800138000', equivalentChallenge.challengeId, '123456');
  assert.equal(second.profile.accountId, first.profile.accountId);
  assert.equal(second.profile.userId, first.profile.userId);

  const verify = createDatabase(databasePath);
  try {
    const savedAccount = verify.db.select().from(accounts).where(eq(accounts.accountId, first.profile.accountId)).get();
    const profiles = verify.db.select().from(users).where(eq(users.accountId, first.profile.accountId)).all();
    assert.equal(savedAccount?.phone, '+8613800138000');
    assert.equal(savedAccount?.phoneVerified, true);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]?.name, null);
    assert.equal(profiles[0]?.onboardingStatus, 'not_started');
  } finally { verify.close(); }
});

test('development verification challenges expire and SMS absence is an explicit service error', async () => {
  let now = 1_000;
  const provider = new DevelopmentVerificationProvider('654321', 100, () => now);
  const challenge = await provider.requestCode('+14155550134');
  now += 101;
  assert.equal(await provider.verifyCode('+14155550134', challenge.challengeId, '654321'), false);
  await assert.rejects(new UnconfiguredSmsVerificationProvider().requestCode(), /未配置手机号验证码服务/);
});

test('Demo phone auth creates one Account and Profile without claiming phone verification', async () => {
  const directory = mkdtempSync(path.join(testTempRoot, 'rensheng-demo-auth-test-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'demo-auth.db');
  const db = createDatabase(databasePath);
  try { runMigrations(db); } finally { db.close(); }

  const auth = new AuthService({
    databasePath,
    sessionSecret: 'test-session-secret-with-more-than-32-chars',
    verificationProvider: new UnconfiguredSmsVerificationProvider(),
    developmentAuthEnabled: false,
    authMode: 'demo_phone',
  });

  for (const invalidPhone of ['123', 'abcdefghijk', '01234567890']) {
    await assert.rejects(
      auth.loginWithDemoPhone(invalidPhone),
      (error: unknown) => error instanceof AuthError && error.code === 'INVALID_PHONE',
    );
  }

  const first = await auth.loginWithDemoPhone('10000000000');
  const second = await auth.loginWithDemoPhone('+86 100-0000-0000');
  assert.equal(first.profile.accountId, second.profile.accountId);
  assert.equal(first.profile.userId, second.profile.userId);
  assert.equal(first.profile.phone, '+8610000000000');
  assert.equal(first.profile.name, null);
  assert.equal(first.profile.onboardingStatus, 'not_started');
  assert.equal(auth.resolveToken(first.token)?.userId, first.profile.userId);

  const verify = createDatabase(databasePath);
  try {
    const savedAccount = verify.db.select().from(accounts).where(eq(accounts.accountId, first.profile.accountId)).get();
    const profiles = verify.db.select().from(users).where(eq(users.accountId, first.profile.accountId)).all();
    assert.equal(savedAccount?.phone, '+8610000000000');
    assert.equal(savedAccount?.phoneVerified, false);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]?.onboardingStatus, 'not_started');
    assert.equal(verify.db.select().from(accounts).all().length, 1);
    assert.equal(verify.db.select().from(users).all().length, 1);
  } finally { verify.close(); }
});
