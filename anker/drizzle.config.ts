import { defineConfig } from 'drizzle-kit';

const databasePath = process.env.DATABASE_PATH ?? './data/memoir.db';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: databasePath,
  },
  strict: true,
  verbose: true,
});
