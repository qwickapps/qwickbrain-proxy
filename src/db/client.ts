import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';

const DEFAULT_CACHE_DIR = join(homedir(), '.qwickbrain', 'cache');

export function createDatabase(cacheDir: string = DEFAULT_CACHE_DIR): {
  db: ReturnType<typeof drizzle<typeof schema>>;
  sqlite: Database.Database
} {
  // Ensure cache directory exists
  mkdirSync(cacheDir, { recursive: true });

  const dbPath = join(cacheDir, 'qwickbrain.db');
  const sqlite = new Database(dbPath);

  // Enable WAL mode for better concurrency
  sqlite.pragma('journal_mode = WAL');

  const db = drizzle(sqlite, { schema });

  return { db, sqlite };
}

export function runMigrations(db: ReturnType<typeof drizzle>) {
  // Drizzle will look for migrations in drizzle/ directory
  migrate(db, { migrationsFolder: './drizzle' });
}

export type DB = ReturnType<typeof createDatabase>['db'];
