import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, runMigrations } from '../../db/client.js';
import { CacheManager } from '../cache-manager.js';
import type { Config } from '../../types/config.js';

describe('CacheManager', () => {
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
      ttl: {
        workflows: 3600,
        rules: 3600,
        documents: 1800,
        memories: 900,
      },
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
      expect(cached?.isExpired).toBe(false);
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

    it('should mark document as expired after TTL', async () => {
      // Override config to have very short TTL for testing
      const shortTTLConfig: Config['cache'] = {
        dir: tmpDir,
        ttl: {
          workflows: 0, // Expire immediately
          rules: 0,
          documents: 0,
          memories: 0,
        },
        preload: [],
      };

      const shortCacheManager = new CacheManager(db, shortTTLConfig);
      await shortCacheManager.setDocument('workflow', 'test', 'content');

      // Wait to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 100));

      const cached = await shortCacheManager.getDocument('workflow', 'test');

      expect(cached).not.toBeNull();
      expect(cached?.isExpired).toBe(true);
    });
  });

  describe('setMemory and getMemory', () => {
    it('should store and retrieve a memory', async () => {
      await cacheManager.setMemory('test-memory', 'memory content');

      const cached = await cacheManager.getMemory('test-memory');

      expect(cached).not.toBeNull();
      expect(cached?.data.content).toBe('memory content');
      expect(cached?.data.name).toBe('test-memory');
      expect(cached?.isExpired).toBe(false);
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

    it('should mark memory as expired after TTL', async () => {
      const shortTTLConfig: Config['cache'] = {
        dir: tmpDir,
        ttl: {
          workflows: 0,
          rules: 0,
          documents: 0,
          memories: 0,
        },
        preload: [],
      };

      const shortCacheManager = new CacheManager(db, shortTTLConfig);
      await shortCacheManager.setMemory('test', 'content');

      await new Promise(resolve => setTimeout(resolve, 100));

      const cached = await shortCacheManager.getMemory('test');

      expect(cached).not.toBeNull();
      expect(cached?.isExpired).toBe(true);
    });
  });

  describe('cleanupExpiredEntries', () => {
    it('should delete expired documents and memories', async () => {
      const shortTTLConfig: Config['cache'] = {
        dir: tmpDir,
        ttl: {
          workflows: 0,
          rules: 0,
          documents: 0,
          memories: 0,
        },
        preload: [],
      };

      const shortCacheManager = new CacheManager(db, shortTTLConfig);

      // Add some items that will immediately expire
      await shortCacheManager.setDocument('workflow', 'test1', 'content1');
      await shortCacheManager.setDocument('rule', 'test2', 'content2');
      await shortCacheManager.setMemory('memory1', 'content3');

      // Wait to ensure they're expired (need sufficient time for clock to advance)
      await new Promise(resolve => setTimeout(resolve, 100));

      // Clean up
      const result = await shortCacheManager.cleanupExpiredEntries();

      expect(result.documentsDeleted).toBe(2);
      expect(result.memoriesDeleted).toBe(1);

      // Verify they're gone
      const doc1 = await shortCacheManager.getDocument('workflow', 'test1');
      const mem1 = await shortCacheManager.getMemory('memory1');

      expect(doc1).toBeNull();
      expect(mem1).toBeNull();
    });

    it('should not delete non-expired items', async () => {
      await cacheManager.setDocument('workflow', 'test', 'content');
      await cacheManager.setMemory('memory', 'content');

      const result = await cacheManager.cleanupExpiredEntries();

      expect(result.documentsDeleted).toBe(0);
      expect(result.memoriesDeleted).toBe(0);

      // Verify they're still there
      const doc = await cacheManager.getDocument('workflow', 'test');
      const mem = await cacheManager.getMemory('memory');

      expect(doc).not.toBeNull();
      expect(mem).not.toBeNull();
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
