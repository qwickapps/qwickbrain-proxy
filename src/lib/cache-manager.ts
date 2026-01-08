import { eq, and, lt, lte, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { documents, memories } from '../db/schema.js';
import type { Config } from '../types/config.js';

interface CachedItem<T> {
  data: T;
  cachedAt: Date;
  expiresAt: Date;
  age: number; // seconds
  isExpired: boolean;
}

export class CacheManager {
  constructor(
    private db: DB,
    private config: Config['cache']
  ) {}

  private getTTL(operation: string): number {
    const ttlMap: Record<string, number> = {
      get_workflow: this.config.ttl.workflows,
      get_document: this.config.ttl.documents,
      get_memory: this.config.ttl.memories,
    };

    return ttlMap[operation] || 0;
  }

  async getDocument(docType: string, name: string, project?: string): Promise<CachedItem<any> | null> {
    const projectValue = project || '';

    const [cached] = await this.db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.docType, docType),
          eq(documents.name, name),
          eq(documents.project, projectValue)
        )
      )
      .limit(1);

    if (!cached) {
      return null;
    }

    const now = new Date();
    const age = Math.floor((now.getTime() - cached.cachedAt.getTime()) / 1000);
    // Fix: Compare timestamp values explicitly to avoid Date comparison issues
    const isExpired = now.getTime() > cached.expiresAt.getTime();

    return {
      data: {
        name: cached.name,
        doc_type: cached.docType,
        project: cached.project,
        content: cached.content,
        metadata: cached.metadata ? JSON.parse(cached.metadata) : {},
      },
      cachedAt: cached.cachedAt,
      expiresAt: cached.expiresAt,
      age,
      isExpired,
    };
  }

  async setDocument(
    docType: string,
    name: string,
    content: string,
    project?: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const now = new Date();
    const ttl = this.getTTL('get_document');
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    // Use empty string instead of null for project to make unique constraint work
    // SQLite treats NULL as distinct values in unique constraints
    const projectValue = project || '';

    await this.db
      .insert(documents)
      .values({
        docType,
        name,
        project: projectValue,
        content,
        metadata: metadata ? JSON.stringify(metadata) : null,
        cachedAt: now,
        expiresAt,
        synced: true,
      })
      .onConflictDoUpdate({
        target: [documents.docType, documents.name, documents.project],
        set: {
          content,
          metadata: metadata ? JSON.stringify(metadata) : null,
          cachedAt: now,
          expiresAt,
          synced: true,
        },
      });
  }

  async getMemory(name: string, project?: string): Promise<CachedItem<any> | null> {
    const projectValue = project || '';

    const [cached] = await this.db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.name, name),
          eq(memories.project, projectValue)
        )
      )
      .limit(1);

    if (!cached) {
      return null;
    }

    const now = new Date();
    const age = Math.floor((now.getTime() - cached.cachedAt.getTime()) / 1000);
    // Fix: Compare timestamp values explicitly to avoid Date comparison issues
    const isExpired = now.getTime() > cached.expiresAt.getTime();

    return {
      data: {
        name: cached.name,
        project: cached.project,
        content: cached.content,
        metadata: cached.metadata ? JSON.parse(cached.metadata) : {},
      },
      cachedAt: cached.cachedAt,
      expiresAt: cached.expiresAt,
      age,
      isExpired,
    };
  }

  async setMemory(
    name: string,
    content: string,
    project?: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const now = new Date();
    const ttl = this.getTTL('get_memory');
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    // Use empty string instead of null for project to make unique constraint work
    const projectValue = project || '';

    await this.db
      .insert(memories)
      .values({
        name,
        project: projectValue,
        content,
        metadata: metadata ? JSON.stringify(metadata) : null,
        cachedAt: now,
        expiresAt,
        synced: true,
      })
      .onConflictDoUpdate({
        target: [memories.name, memories.project],
        set: {
          content,
          metadata: metadata ? JSON.stringify(metadata) : null,
          cachedAt: now,
          expiresAt,
          synced: true,
        },
      });
  }

  async cleanupExpiredEntries(): Promise<{ documentsDeleted: number; memoriesDeleted: number }> {
    const now = new Date();

    // Delete expired documents (use lte to include items expiring exactly now)
    const deletedDocs = await this.db
      .delete(documents)
      .where(lte(documents.expiresAt, now))
      .returning({ id: documents.id });

    // Delete expired memories (use lte to include items expiring exactly now)
    const deletedMems = await this.db
      .delete(memories)
      .where(lte(memories.expiresAt, now))
      .returning({ id: memories.id });

    return {
      documentsDeleted: deletedDocs.length,
      memoriesDeleted: deletedMems.length,
    };
  }
}
