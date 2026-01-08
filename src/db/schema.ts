import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

/**
 * Cached documents (workflows, rules, FRDs, designs, etc.)
 */
export const documents = sqliteTable('documents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  docType: text('doc_type').notNull(), // workflow, rule, frd, design, spike, etc.
  name: text('name').notNull(),
  project: text('project'), // null for global documents
  content: text('content').notNull(),
  metadata: text('metadata'), // JSON string
  cachedAt: integer('cached_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  synced: integer('synced', { mode: 'boolean' }).notNull().default(true),
}, (table) => ({
  uniqueDocument: unique().on(table.docType, table.name, table.project),
}));

/**
 * Cached memories (project context, patterns, decisions)
 */
export const memories = sqliteTable('memories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  project: text('project'), // null for global memories
  content: text('content').notNull(),
  metadata: text('metadata'), // JSON string
  cachedAt: integer('cached_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  synced: integer('synced', { mode: 'boolean' }).notNull().default(true),
}, (table) => ({
  uniqueMemory: unique().on(table.name, table.project),
}));

/**
 * Write queue for offline operations
 */
export const syncQueue = sqliteTable('sync_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  operation: text('operation').notNull(), // create_document, update_document, set_memory, etc.
  payload: text('payload').notNull(), // JSON string
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  status: text('status').notNull().default('pending'), // pending, completed, failed
  error: text('error'),
  attempts: integer('attempts').notNull().default(0),
  lastAttemptAt: integer('last_attempt_at', { mode: 'timestamp' }),
});

/**
 * Connection health log
 */
export const connectionLog = sqliteTable('connection_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: integer('timestamp', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  state: text('state').notNull(), // connected, disconnected, reconnecting, failed
  latencyMs: integer('latency_ms'),
  error: text('error'),
});
