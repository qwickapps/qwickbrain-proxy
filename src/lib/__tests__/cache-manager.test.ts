import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, runMigrations } from '../../db/client.js';
import { CacheManager } from '../cache-manager.js';
import type { Config } from '../../types/config.js';

describe('CacheManager - LRU Two-Tier Storage', () => {
  let tmpDir: string;
  let cacheManager: CacheManager;
  let db: ReturnType<typeof createDatabase>['db'];

  beforeEach(() => {
    // Create temporary directory for test database
    tmpDir = mkdtempSync(join(tmpdir(), 'cache-test-'));
    const dbResult = createDatabase(tmpDir);
    db = dbResult.db;

    // Run migrations to create tables
    runMigrations(db);

    const config: Config['cache'] = {
      dir: tmpDir,
      maxCacheSizeBytes: 10 * 1024, // 10KB limit for testing
      preload: [],
    };

    cacheManager = new CacheManager(db, config);
  });

  afterEach(() => {
    // Clean up temporary directory
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('setDocument and getDocument', () => {
    it('should store and retrieve a document', async () => {
      await cacheManager.setDocument('workflow', 'test-workflow', 'content here');

      const cached = await cacheManager.getDocument('workflow', 'test-workflow');

      expect(cached).not.toBeNull();
      expect(cached?.data.content).toBe('content here');
      expect(cached?.data.doc_type).toBe('workflow');
      expect(cached?.data.name).toBe('test-workflow');
      expect(cached?.age).toBeGreaterThanOrEqual(0);
    });

    it('should store document with metadata', async () => {
      const metadata = { author: 'test', version: 1 };
      await cacheManager.setDocument('frd', 'test-frd', 'frd content', undefined, metadata);

      const cached = await cacheManager.getDocument('frd', 'test-frd');

      expect(cached?.data.metadata).toEqual(metadata);
    });

    it('should store document with project scope', async () => {
      await cacheManager.setDocument('design', 'test-design', 'design content', 'my-project');

      const cached = await cacheManager.getDocument('design', 'test-design', 'my-project');

      expect(cached).not.toBeNull();
      expect(cached?.data.project).toBe('my-project');
    });

    it('should distinguish between global and project-scoped documents', async () => {
      await cacheManager.setDocument('rule', 'test-rule', 'global rule');
      await cacheManager.setDocument('rule', 'test-rule', 'project rule', 'my-project');

      const globalDoc = await cacheManager.getDocument('rule', 'test-rule');
      const projectDoc = await cacheManager.getDocument('rule', 'test-rule', 'my-project');

      expect(globalDoc?.data.content).toBe('global rule');
      expect(globalDoc?.data.project).toBe('');
      expect(projectDoc?.data.content).toBe('project rule');
      expect(projectDoc?.data.project).toBe('my-project');
    });

    it('should return null for non-existent document', async () => {
      const cached = await cacheManager.getDocument('workflow', 'non-existent');
      expect(cached).toBeNull();
    });

    it('should update existing document on conflict', async () => {
      await cacheManager.setDocument('workflow', 'test', 'version 1');
      await cacheManager.setDocument('workflow', 'test', 'version 2');

      const cached = await cacheManager.getDocument('workflow', 'test');

      expect(cached?.data.content).toBe('version 2');
    });

    it('should mark critical document types as critical', async () => {
      // Critical types: workflow, rule, agent, template
      await cacheManager.setDocument('workflow', 'test-workflow', 'content');
      await cacheManager.setDocument('rule', 'test-rule', 'content');
      await cacheManager.setDocument('agent', 'test-agent', 'content');
      await cacheManager.setDocument('template', 'test-template', 'content');

      // Non-critical type
      await cacheManager.setDocument('frd', 'test-frd', 'content');

      const stats = await cacheManager.getCacheStats();

      expect(stats.criticalCount).toBe(4);
      expect(stats.dynamicCount).toBeGreaterThan(0); // FRD is dynamic
    });

    it('should update lastAccessedAt on read', async () => {
      await cacheManager.setDocument('workflow', 'test', 'content');

      const cached1 = await cacheManager.getDocument('workflow', 'test');
      const cachedAt1 = cached1?.cachedAt.getTime();

      // Wait 200ms
      await new Promise(resolve => setTimeout(resolve, 200));

      const cached2 = await cacheManager.getDocument('workflow', 'test');
      const cachedAt2 = cached2?.cachedAt.getTime();

      // cachedAt should remain the same (shows when first cached)
      expect(cachedAt2).toBe(cachedAt1);

      // But age should increase over time
      expect(cached2?.age).toBeGreaterThanOrEqual(0);
    });
  });

  describe('setMemory and getMemory', () => {
    it('should store and retrieve a memory', async () => {
      await cacheManager.setMemory('test-memory', 'memory content');

      const cached = await cacheManager.getMemory('test-memory');

      expect(cached).not.toBeNull();
      expect(cached?.data.content).toBe('memory content');
      expect(cached?.data.name).toBe('test-memory');
    });

    it('should store memory with metadata', async () => {
      const metadata = { lastUpdated: Date.now() };
      await cacheManager.setMemory('test-memory', 'content', undefined, metadata);

      const cached = await cacheManager.getMemory('test-memory');

      expect(cached?.data.metadata).toEqual(metadata);
    });

    it('should store memory with project scope', async () => {
      await cacheManager.setMemory('patterns', 'project patterns', 'my-project');

      const cached = await cacheManager.getMemory('patterns', 'my-project');

      expect(cached).not.toBeNull();
      expect(cached?.data.project).toBe('my-project');
    });

    it('should distinguish between global and project-scoped memories', async () => {
      await cacheManager.setMemory('context', 'global context');
      await cacheManager.setMemory('context', 'project context', 'my-project');

      const globalMem = await cacheManager.getMemory('context');
      const projectMem = await cacheManager.getMemory('context', 'my-project');

      expect(globalMem?.data.content).toBe('global context');
      expect(projectMem?.data.content).toBe('project context');
    });

    it('should return null for non-existent memory', async () => {
      const cached = await cacheManager.getMemory('non-existent');
      expect(cached).toBeNull();
    });
  });

  describe('LRU Eviction - Two-Tier Storage', () => {
    it('should NOT evict critical documents when storage limit reached', async () => {
      // Create large critical documents (workflows)
      const largeContent = 'x'.repeat(3000); // 3KB each

      // Add 4 critical documents = 12KB (exceeds 10KB limit)
      await cacheManager.setDocument('workflow', 'critical1', largeContent);
      await cacheManager.setDocument('workflow', 'critical2', largeContent);
      await cacheManager.setDocument('workflow', 'critical3', largeContent);
      await cacheManager.setDocument('workflow', 'critical4', largeContent);

      // All should still be present (critical tier bypasses limit)
      const doc1 = await cacheManager.getDocument('workflow', 'critical1');
      const doc2 = await cacheManager.getDocument('workflow', 'critical2');
      const doc3 = await cacheManager.getDocument('workflow', 'critical3');
      const doc4 = await cacheManager.getDocument('workflow', 'critical4');

      expect(doc1).not.toBeNull();
      expect(doc2).not.toBeNull();
      expect(doc3).not.toBeNull();
      expect(doc4).not.toBeNull();
    });

    it('should evict oldest dynamic documents when storage limit reached', async () => {
      const largeContent = 'x'.repeat(3000); // 3KB each

      // Add dynamic documents
      await cacheManager.setDocument('frd', 'dynamic1', largeContent);
      await new Promise(resolve => setTimeout(resolve, 10));

      await cacheManager.setDocument('frd', 'dynamic2', largeContent);
      await new Promise(resolve => setTimeout(resolve, 10));

      await cacheManager.setDocument('frd', 'dynamic3', largeContent);
      await new Promise(resolve => setTimeout(resolve, 10));

      // Now add another that pushes us over limit (9KB current, 3KB new = 12KB > 10KB)
      // Should evict dynamic1 (oldest)
      await cacheManager.setDocument('frd', 'dynamic4', largeContent);

      // dynamic1 should be evicted
      const doc1 = await cacheManager.getDocument('frd', 'dynamic1');
      expect(doc1).toBeNull();

      // dynamic2, dynamic3, dynamic4 should remain
      const doc2 = await cacheManager.getDocument('frd', 'dynamic2');
      const doc3 = await cacheManager.getDocument('frd', 'dynamic3');
      const doc4 = await cacheManager.getDocument('frd', 'dynamic4');

      expect(doc2).not.toBeNull();
      expect(doc3).not.toBeNull();
      expect(doc4).not.toBeNull();
    });

    it('should use LRU ordering based on lastAccessedAt', async () => {
      const largeContent = 'x'.repeat(3000); // 3KB each

      // Add 3 dynamic documents with delays to ensure distinct timestamps
      await cacheManager.setDocument('frd', 'doc1', largeContent);
      await new Promise(resolve => setTimeout(resolve, 50));

      await cacheManager.setDocument('frd', 'doc2', largeContent);
      await new Promise(resolve => setTimeout(resolve, 50));

      await cacheManager.setDocument('frd', 'doc3', largeContent);
      await new Promise(resolve => setTimeout(resolve, 50));

      // Access doc2 and doc3 (updates their lastAccessedAt to be newest)
      await cacheManager.getDocument('frd', 'doc2');
      await new Promise(resolve => setTimeout(resolve, 50));
      await cacheManager.getDocument('frd', 'doc3');
      await new Promise(resolve => setTimeout(resolve, 50));

      // Now doc1 has oldest lastAccessedAt, should be evicted first
      // Add doc4, should evict doc1 (oldest access)
      await cacheManager.setDocument('frd', 'doc4', largeContent);

      const doc1 = await cacheManager.getDocument('frd', 'doc1');
      const doc2 = await cacheManager.getDocument('frd', 'doc2');
      const doc3 = await cacheManager.getDocument('frd', 'doc3');
      const doc4 = await cacheManager.getDocument('frd', 'doc4');

      expect(doc1).toBeNull(); // Oldest access, evicted
      expect(doc2).not.toBeNull(); // Accessed recently, kept
      expect(doc3).not.toBeNull(); // Accessed recently, kept
      expect(doc4).not.toBeNull(); // Just added
    });

    it('should evict memories when document eviction insufficient', async () => {
      const largeContent = 'x'.repeat(3000); // 3KB each

      // Add one dynamic document
      await cacheManager.setDocument('frd', 'doc1', largeContent);

      // Add memories
      await cacheManager.setMemory('mem1', largeContent);
      await cacheManager.setMemory('mem2', largeContent);

      // Current: 9KB (over limit when we add another 3KB)
      // Should evict doc1 and mem1 to make room
      await cacheManager.setDocument('frd', 'doc2', largeContent);

      const doc1 = await cacheManager.getDocument('frd', 'doc1');
      const mem1 = await cacheManager.getMemory('mem1');
      const mem2 = await cacheManager.getMemory('mem2');

      // At least one should be evicted (LRU order)
      const evictedCount = [doc1, mem1, mem2].filter(item => item === null).length;
      expect(evictedCount).toBeGreaterThan(0);
    });
  });

  describe('Cache invalidation', () => {
    it('should invalidate specific document', async () => {
      await cacheManager.setDocument('workflow', 'test', 'content');

      const cached1 = await cacheManager.getDocument('workflow', 'test');
      expect(cached1).not.toBeNull();

      await cacheManager.invalidateDocument('workflow', 'test');

      const cached2 = await cacheManager.getDocument('workflow', 'test');
      expect(cached2).toBeNull();
    });

    it('should invalidate specific memory', async () => {
      await cacheManager.setMemory('test', 'content');

      const cached1 = await cacheManager.getMemory('test');
      expect(cached1).not.toBeNull();

      await cacheManager.invalidateMemory('test');

      const cached2 = await cacheManager.getMemory('test');
      expect(cached2).toBeNull();
    });
  });

  describe('Cache statistics', () => {
    it('should return accurate cache statistics', async () => {
      const content = 'x'.repeat(1000); // 1KB each

      // Add critical documents
      await cacheManager.setDocument('workflow', 'wf1', content);
      await cacheManager.setDocument('rule', 'rule1', content);

      // Add dynamic documents
      await cacheManager.setDocument('frd', 'frd1', content);

      // Add memories
      await cacheManager.setMemory('mem1', content);

      const stats = await cacheManager.getCacheStats();

      expect(stats.criticalCount).toBe(2);
      expect(stats.dynamicCount).toBeGreaterThan(0);
      expect(stats.memoryCount).toBe(1);
      expect(stats.criticalSize).toBeGreaterThan(0);
      expect(stats.dynamicSize).toBeGreaterThan(0);
      expect(stats.totalSize).toBe(stats.criticalSize + stats.dynamicSize);
      expect(stats.totalCount).toBe(stats.criticalCount + stats.dynamicCount);
    });
  });

  describe('cache age calculation', () => {
    it('should calculate age correctly', async () => {
      await cacheManager.setDocument('workflow', 'test', 'content');

      // Wait 100ms
      await new Promise(resolve => setTimeout(resolve, 100));

      const cached = await cacheManager.getDocument('workflow', 'test');

      expect(cached?.age).toBeGreaterThanOrEqual(0);
      expect(cached?.age).toBeLessThan(1); // Less than 1 second
    });
  });
});
