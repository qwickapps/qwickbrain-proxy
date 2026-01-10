import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

/**
 * Cached documents (workflows, rules, FRDs, designs, etc.)
 *
 * Two-tier storage:
 * - Critical tier (isCritical=true): workflows, rules, agents, templates - never evicted, not counted toward limit
 * - Dynamic tier (isCritical=false): other documents - LRU eviction when storage limit reached
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
  lastAccessedAt: integer('last_accessed_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  isCritical: integer('is_critical', { mode: 'boolean' })
    .notNull()
    .default(false),
  sizeBytes: integer('size_bytes').notNull().default(0),
  synced: integer('synced', { mode: 'boolean' }).notNull().default(true),
}, (table) => ({
  uniqueDocument: unique().on(table.docType, table.name, table.project),
}));

/**
 * Cached memories (project context, patterns, decisions)
 *
 * Memories are always dynamic tier - LRU eviction applies
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
  lastAccessedAt: integer('last_accessed_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  sizeBytes: integer('size_bytes').notNull().default(0),
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
