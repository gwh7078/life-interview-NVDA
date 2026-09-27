import { writeDiagnosticLog } from '../diagnostics/logger.js';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizePhone } from '../auth/phone.js';
import { createDatabase, type DatabaseHandle } from './client.js';

export const migrationsFolder = path.resolve(fileURLToPath(new URL('./migrations', import.meta.url)));
const accountMigrationTimestamp = 1789304690077;

function tableExists(connection: DatabaseHandle, name: string): boolean {
  return Boolean(connection.sqlite.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

function columnsOf(connection: DatabaseHandle, table: string): Set<string> {
  if (!tableExists(connection, table)) return new Set();
  return new Set((connection.sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name));
}

function stageLegacyRows(connection: DatabaseHandle): void {
  const existing = connection.sqlite.prepare(
    'SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'__drizzle_migrations\'',
  ).get();
  const applied = existing
    ? Number((connection.sqlite.prepare('SELECT max(created_at) AS latest FROM __drizzle_migrations').get() as { latest?: number | null }).latest ?? 0)
    : 0;
  if (applied >= accountMigrationTimestamp) return;

  const usersColumns = columnsOf(connection, 'users');
  const sessionColumns = columnsOf(connection, 'interview_sessions');
  let profiles: Array<{ user_id: string; phone: string | null; created_at: string; updated_at: string }> = [];
  if (usersColumns.size && !usersColumns.has('account_id')) {
    profiles = connection.sqlite.prepare(
      'SELECT user_id, phone, created_at, updated_at FROM users ORDER BY user_id',
    ).all() as typeof profiles;
  }

  const normalizedByUser = new Map<string, string | null>();
  const ownerByPhone = new Map<string, string>();
  for (const profile of profiles) {
    let phone: string | null = null;
    if (profile.phone != null && String(profile.phone).trim()) {
      try {
        phone = normalizePhone(String(profile.phone));
      } catch {
        throw new Error(`Account migration stopped: a legacy phone on user ${profile.user_id} cannot be normalized safely.`);
      }
      const previousOwner = ownerByPhone.get(phone);
      if (previousOwner && previousOwner !== profile.user_id) {
        throw new Error('Account migration stopped: multiple legacy profiles normalize to the same phone; resolve ownership before migrating.');
      }
      ownerByPhone.set(phone, profile.user_id);
    }
    normalizedByUser.set(profile.user_id, phone);
  }

  if (tableExists(connection, 'memoir_documents')) {
    const legacyStageDocuments = Number((connection.sqlite.prepare(
      "SELECT count(*) AS count FROM memoir_documents WHERE scope_type = 'life_stage'",
    ).get() as { count: number }).count);
    if (legacyStageDocuments > 0) {
      throw new Error('Account migration stopped: LifeStage-scoped memoir documents exist and need an explicit rescope.');
    }
  }

  if (sessionColumns.has('story_id') && sessionColumns.has('stage_id') && tableExists(connection, 'stories')) {
    const inconsistent = connection.sqlite.prepare(`
      SELECT count(*) AS count
      FROM interview_sessions AS sessions
      JOIN stories ON stories.story_id = sessions.story_id
      WHERE sessions.story_id IS NOT NULL
        AND sessions.session_type = 'story'
        AND sessions.stage_id IS NOT NULL
        AND (sessions.stage_id != stories.stage_id OR sessions.user_id != stories.user_id)
    `).get() as { count: number };
    if (inconsistent.count > 0) {
      throw new Error('Account migration stopped: Story Sessions contain mismatched user or stage ownership.');
    }
  }

  connection.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __codex_user_account_backfill (
      user_id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL,
      phone TEXT,
      account_status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS __codex_legacy_provider_sessions (
      session_id TEXT PRIMARY KEY NOT NULL,
      provider_session_id TEXT NOT NULL
    );
  `);

  const existingBackfill = connection.sqlite.prepare(
    'SELECT account_id, phone FROM __codex_user_account_backfill WHERE user_id = ?',
  );
  const saveBackfill = connection.sqlite.prepare(`
    INSERT OR IGNORE INTO __codex_user_account_backfill
      (user_id, account_id, phone, account_status, created_at, updated_at)
    VALUES (@userId, @accountId, @phone, @status, @createdAt, @updatedAt)
  `);
  const saveProfileAccounts = connection.sqlite.transaction(() => {
    for (const profile of profiles) {
      const phone = normalizedByUser.get(profile.user_id) ?? null;
      const saved = existingBackfill.get(profile.user_id) as { account_id: string; phone: string | null } | undefined;
      if (saved && saved.phone !== phone) {
        throw new Error(`Account migration stopped: the staged phone for user ${profile.user_id} changed during migration.`);
      }
      saveBackfill.run({
        userId: profile.user_id,
        accountId: saved?.account_id ?? randomUUID(),
        phone,
        status: phone ? 'active' : 'legacy',
        createdAt: profile.created_at,
        updatedAt: profile.updated_at,
      });
    }
  });
  saveProfileAccounts();

  if (sessionColumns.has('openclaw_session_key') && !sessionColumns.has('provider_session_id')) {
    connection.sqlite.prepare(`
      INSERT OR IGNORE INTO __codex_legacy_provider_sessions (session_id, provider_session_id)
      SELECT session_id, openclaw_session_key FROM interview_sessions
    `).run();
  }
}

export function runMigrations(connection: DatabaseHandle): void {
  const sqlite = connection.sqlite;
  const foreignKeysWereEnabled = Boolean(sqlite.pragma('foreign_keys', { simple: true }));
  try {
    stageLegacyRows(connection);
    if (foreignKeysWereEnabled) sqlite.pragma('foreign_keys = OFF');
    migrate(connection.db, { migrationsFolder });
    if (foreignKeysWereEnabled) sqlite.pragma('foreign_keys = ON');

    const integrity = sqlite.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error('Database migration completed with an integrity_check failure.');
    }
    const foreignKeyViolations = sqlite.pragma('foreign_key_check') as unknown[];
    if (foreignKeyViolations.length > 0) throw new Error('Database migration completed with foreign-key violations.');
    sqlite.exec('DROP TABLE IF EXISTS __codex_user_account_backfill; DROP TABLE IF EXISTS __codex_legacy_provider_sessions;');
  } finally {
    if (foreignKeysWereEnabled && !Boolean(sqlite.pragma('foreign_keys', { simple: true }))) {
      sqlite.pragma('foreign_keys = ON');
    }
  }
}

export function main(): void {
  const connection = createDatabase();

  try {
    runMigrations(connection);
    console.log(`Database ready: ${connection.databasePath}`);
    writeDiagnosticLog('database', 'info', 'Database migrations completed.', { databasePath: connection.databasePath });
  } finally {
    connection.close();
  }
}

const invokedScript = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;

if (invokedScript === import.meta.url) {
  main();
}
