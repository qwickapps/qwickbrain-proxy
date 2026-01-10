import { eq, and, sql, desc } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { documents, memories } from '../db/schema.js';
import type { Config } from '../types/config.js';

// Critical document types - never evicted, not counted toward storage limit
const CRITICAL_DOC_TYPES = ['workflow', 'rule', 'agent', 'template'];

interface CachedItem<T> {
  data: T;
  cachedAt: Date;
  age: number; // seconds
}

export class CacheManager {
  private maxDynamicCacheSize: number; // Storage limit for dynamic tier only (bytes)

  constructor(
    private db: DB,
    private config: Config['cache']
  ) {
    // Default to 100MB if not configured
    this.maxDynamicCacheSize = config.maxCacheSizeBytes || 100 * 1024 * 1024;
  }

  /**
   * Get current size of dynamic tier cache (excludes critical tier)
   */
  private async getDynamicCacheSize(): Promise<number> {
    const result = await this.db
      .select({ total: sql<number>`COALESCE(sum(${documents.sizeBytes}), 0) + COALESCE((SELECT sum(${memories.sizeBytes}) FROM ${memories}), 0)` })
      .from(documents)
      .where(eq(documents.isCritical, false));

    return result[0]?.total || 0;
  }

  /**
   * Evict LRU entries from dynamic tier to free up space
   * NEVER touches critical tier
   */
  private async evictLRU(bytesToFree: number): Promise<void> {
    let freed = 0;

    // Evict from documents (dynamic tier only)
    const docCandidates = await this.db
      .select()
      .from(documents)
      .where(eq(documents.isCritical, false))
      .orderBy(documents.lastAccessedAt) // ASC = oldest first
      .limit(100);

    for (const doc of docCandidates) {
      if (freed >= bytesToFree) break;

      await this.db.delete(documents).where(eq(documents.id, doc.id));
      freed += doc.sizeBytes;
      console.error(`LRU evicted document: ${doc.docType}:${doc.name} (${doc.sizeBytes} bytes)`);
    }

    // Evict from memories if needed
    if (freed < bytesToFree) {
      const memCandidates = await this.db
        .select()
        .from(memories)
        .orderBy(memories.lastAccessedAt) // ASC = oldest first
        .limit(100);

      for (const mem of memCandidates) {
        if (freed >= bytesToFree) break;

        await this.db.delete(memories).where(eq(memories.id, mem.id));
        freed += mem.sizeBytes;
        console.error(`LRU evicted memory: ${mem.name} (${mem.sizeBytes} bytes)`);
      }
    }

    console.error(`LRU eviction complete: freed ${freed} bytes`);
  }

  /**
   * Ensure sufficient cache space
   * Critical items bypass this check
   */
  private async ensureCacheSize(requiredBytes: number, isCritical: boolean): Promise<void> {
    // Critical files bypass storage limit check
    if (isCritical) {
      return;
    }

    // Only count dynamic tier toward storage limit
    const currentSize = await this.getDynamicCacheSize();
    if (currentSize + requiredBytes <= this.maxDynamicCacheSize) {
      return;
    }

    // Evict LRU entries from dynamic tier only
    const toEvict = currentSize + requiredBytes - this.maxDynamicCacheSize;
    console.error(`Cache size limit reached: ${currentSize} + ${requiredBytes} > ${this.maxDynamicCacheSize}, evicting ${toEvict} bytes`);
    await this.evictLRU(toEvict);
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

    // Update last accessed timestamp for LRU tracking
    const now = new Date();
    await this.db.update(documents)
      .set({ lastAccessedAt: now })
      .where(eq(documents.id, cached.id));

    const age = Math.floor((now.getTime() - cached.cachedAt.getTime()) / 1000);

    return {
      data: {
        name: cached.name,
        doc_type: cached.docType,
        project: cached.project,
        content: cached.content,
        metadata: cached.metadata ? JSON.parse(cached.metadata) : {},
      },
      cachedAt: cached.cachedAt,
      age,
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
    const projectValue = project || '';
    const isCritical = CRITICAL_DOC_TYPES.includes(docType);
    const sizeBytes = Buffer.byteLength(content, 'utf8');

    // Ensure space available (skips check if critical)
    await this.ensureCacheSize(sizeBytes, isCritical);

    await this.db
      .insert(documents)
      .values({
        docType,
        name,
        project: projectValue,
        content,
        metadata: metadata ? JSON.stringify(metadata) : null,
        cachedAt: now,
        lastAccessedAt: now,
        isCritical,
        sizeBytes,
        synced: true,
      })
      .onConflictDoUpdate({
        target: [documents.docType, documents.name, documents.project],
        set: {
          content,
          metadata: metadata ? JSON.stringify(metadata) : null,
          lastAccessedAt: now,
          sizeBytes,
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

    // Update last accessed timestamp for LRU tracking
    const now = new Date();
    await this.db.update(memories)
      .set({ lastAccessedAt: now })
      .where(eq(memories.id, cached.id));

    const age = Math.floor((now.getTime() - cached.cachedAt.getTime()) / 1000);

    return {
      data: {
        name: cached.name,
        project: cached.project,
        content: cached.content,
        metadata: cached.metadata ? JSON.parse(cached.metadata) : {},
      },
      cachedAt: cached.cachedAt,
      age,
    };
  }

  async setMemory(
    name: string,
    content: string,
    project?: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const now = new Date();
    const projectValue = project || '';
    const sizeBytes = Buffer.byteLength(content, 'utf8');

    // Memories are always dynamic tier (not critical)
    await this.ensureCacheSize(sizeBytes, false);

    await this.db
      .insert(memories)
      .values({
        name,
        project: projectValue,
        content,
        metadata: metadata ? JSON.stringify(metadata) : null,
        cachedAt: now,
        lastAccessedAt: now,
        sizeBytes,
        synced: true,
      })
      .onConflictDoUpdate({
        target: [memories.name, memories.project],
        set: {
          content,
          metadata: metadata ? JSON.stringify(metadata) : null,
          lastAccessedAt: now,
          sizeBytes,
          synced: true,
        },
      });
  }

  /**
   * Invalidate a document from cache (for SSE-based cache invalidation)
   */
  async invalidateDocument(docType: string, name: string, project?: string): Promise<void> {
    const projectValue = project || '';

    await this.db
      .delete(documents)
      .where(
        and(
          eq(documents.docType, docType),
          eq(documents.name, name),
          eq(documents.project, projectValue)
        )
      );

    console.error(`Cache invalidated: ${docType}:${name}`);
  }

  /**
   * Invalidate a memory from cache (for SSE-based cache invalidation)
   */
  async invalidateMemory(name: string, project?: string): Promise<void> {
    const projectValue = project || '';

    await this.db
      .delete(memories)
      .where(
        and(
          eq(memories.name, name),
          eq(memories.project, projectValue)
        )
      );

    console.error(`Cache invalidated: memory:${name}`);
  }

  /**
   * Get cache statistics
   */
  async getCacheStats(): Promise<{
    criticalSize: number;
    criticalCount: number;
    dynamicSize: number;
    dynamicCount: number;
    totalSize: number;
    totalCount: number;
    memorySize: number;
    memoryCount: number;
  }> {
    // Critical documents
    const criticalResult = await this.db
      .select({
        size: sql<number>`COALESCE(sum(${documents.sizeBytes}), 0)`,
        count: sql<number>`count(*)`
      })
      .from(documents)
      .where(eq(documents.isCritical, true));

    // Dynamic documents
    const dynamicResult = await this.db
      .select({
        size: sql<number>`COALESCE(sum(${documents.sizeBytes}), 0)`,
        count: sql<number>`count(*)`
      })
      .from(documents)
      .where(eq(documents.isCritical, false));

    // Memories
    const memoryResult = await this.db
      .select({
        size: sql<number>`COALESCE(sum(${memories.sizeBytes}), 0)`,
        count: sql<number>`count(*)`
      })
      .from(memories);

    const criticalSize = criticalResult[0]?.size || 0;
    const criticalCount = criticalResult[0]?.count || 0;
    const dynamicSize = dynamicResult[0]?.size || 0;
    const dynamicCount = dynamicResult[0]?.count || 0;
    const memorySize = memoryResult[0]?.size || 0;
    const memoryCount = memoryResult[0]?.count || 0;

    return {
      criticalSize,
      criticalCount,
      dynamicSize: dynamicSize + memorySize,
      dynamicCount: dynamicCount + memoryCount,
      totalSize: criticalSize + dynamicSize + memorySize,
      totalCount: criticalCount + dynamicCount + memoryCount,
      memorySize,
      memoryCount,
    };
  }
}
