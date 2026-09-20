import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { schema } from './schema.js';

export type AppDatabase = BetterSQLite3Database<typeof schema>;
export type SqliteDatabase = Database.Database;

export interface DatabaseHandle {
  db: AppDatabase;
  sqlite: Database.Database;
  databasePath: string;
  close: () => void;
}

export function resolveDatabasePath(databasePath?: string): string {
  return path.resolve(databasePath ?? process.env.DATABASE_PATH ?? './data/memoir.db');
}

export function createDatabase(databasePath?: string): DatabaseHandle {
  const resolvedPath = resolveDatabasePath(databasePath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const sqlite = new Database(resolvedPath);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');

  return {
    db: drizzle(sqlite, { schema }),
    sqlite,
    databasePath: resolvedPath,
    close: () => sqlite.close(),
  };
}
