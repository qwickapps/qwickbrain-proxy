import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

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
  // Use absolute path relative to package installation
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const migrationsFolder = join(__dirname, '../../drizzle');
  migrate(db, { migrationsFolder });
}

export type DB = ReturnType<typeof createDatabase>['db'];
