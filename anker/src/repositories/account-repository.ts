import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { createDatabase } from '../db/client.js';
import { accounts, users } from '../db/schema.js';
import { nowUtcIso } from '../db/time.js';
import type { AuthContext } from '../auth/context.js';

export interface DefaultProfileSummary extends AuthContext {
  phone: string | null;
  name: string | null;
  onboardingStatus: 'not_started' | 'in_progress' | 'completed';
}

export class AccountRepository {
  constructor(private readonly databasePath?: string) {}

  getOrCreateVerifiedPhoneProfile(phone: string): DefaultProfileSummary {
    return this.getOrCreatePhoneProfile(phone, true);
  }

  getOrCreateDemoPhoneProfile(phone: string): DefaultProfileSummary {
    return this.getOrCreatePhoneProfile(phone, false);
  }

  private getOrCreatePhoneProfile(phone: string, markPhoneVerified: boolean): DefaultProfileSummary {
    const connection = createDatabase(this.databasePath);
    try {
      return connection.db.transaction((tx) => {
        const timestamp = nowUtcIso();
        let account = tx.select().from(accounts).where(eq(accounts.phone, phone)).get();
        if (account?.status === 'disabled') throw new Error('ACCOUNT_DISABLED');
        if (!account) {
          const accountId = randomUUID();
          tx.insert(accounts).values({
            accountId,
            phone,
            phoneVerified: markPhoneVerified,
            status: 'active',
            createdAt: timestamp,
            updatedAt: timestamp,
          }).run();
          account = tx.select().from(accounts).where(eq(accounts.accountId, accountId)).get();
        } else {
          if (markPhoneVerified || account.status !== 'active') {
            tx.update(accounts).set({
              ...(markPhoneVerified ? { phoneVerified: true } : {}),
              status: 'active',
              updatedAt: timestamp,
            }).where(eq(accounts.accountId, account.accountId)).run();
          }
        }
        if (!account) throw new Error('ACCOUNT_CREATE_FAILED');

        let profile = tx.select().from(users).where(eq(users.accountId, account.accountId)).get();
        if (!profile) {
          const userId = randomUUID();
          tx.insert(users).values({
            userId,
            accountId: account.accountId,
            name: null,
            onboardingStatus: 'not_started',
            createdAt: timestamp,
            updatedAt: timestamp,
          }).run();
          profile = tx.select().from(users).where(eq(users.userId, userId)).get();
        }
        if (!profile) throw new Error('DEFAULT_PROFILE_CREATE_FAILED');
        return {
          accountId: account.accountId,
          userId: profile.userId,
          phone: account.phone,
          name: profile.name,
          onboardingStatus: profile.onboardingStatus,
        };
      });
    } finally {
      connection.close();
    }
  }

  resolveAuthContext(accountId: string, allowLegacy = false, allowDemoPhone = false): DefaultProfileSummary | null {
    const connection = createDatabase(this.databasePath);
    try {
      const account = connection.db.select().from(accounts).where(eq(accounts.accountId, accountId)).get();
      if (!account || account.status === 'disabled') return null;
      const isDevelopmentLegacy = allowLegacy && account.status === 'legacy' && account.phone === null;
      const isDemoPhone = allowDemoPhone && account.status === 'active' && account.phone !== null;
      if (!account.phoneVerified && !isDevelopmentLegacy && !isDemoPhone) return null;
      const profile = connection.db.select().from(users).where(eq(users.accountId, accountId)).get();
      if (!profile) return null;
      return {
        accountId: account.accountId,
        userId: profile.userId,
        phone: account.phone,
        name: profile.name,
        onboardingStatus: profile.onboardingStatus,
      };
    } finally {
      connection.close();
    }
  }

  getOnlyLegacyProfile(): DefaultProfileSummary | null {
    const connection = createDatabase(this.databasePath);
    try {
      const rows = connection.db.select({ accountId: accounts.accountId, userId: users.userId, phone: accounts.phone, name: users.name, onboardingStatus: users.onboardingStatus })
        .from(accounts)
        .innerJoin(users, eq(users.accountId, accounts.accountId))
        .where(and(eq(accounts.status, 'legacy'), isNull(accounts.phone)))
        .all();
      if (rows.length !== 1) return null;
      return { ...rows[0]! };
    } finally {
      connection.close();
    }
  }
}
