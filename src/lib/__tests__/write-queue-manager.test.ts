import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, runMigrations } from '../../db/client.js';
import { WriteQueueManager } from '../write-queue-manager.js';
import { QwickBrainClient } from '../qwickbrain-client.js';
import type { Config } from '../../types/config.js';

describe('WriteQueueManager', () => {
  let tmpDir: string;
  let writeQueueManager: WriteQueueManager;
  let qwickbrainClient: QwickBrainClient;
  let db: ReturnType<typeof createDatabase>['db'];

  beforeEach(() => {
    // Create temporary directory for test database
    tmpDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
    const dbResult = createDatabase(tmpDir);
    db = dbResult.db;

    // Run migrations to create tables
    runMigrations(db);

    // Create mock client
    const config: Config['qwickbrain'] = {
      mode: 'sse',
      url: 'http://test.local:3000',
    };

    qwickbrainClient = new QwickBrainClient(config);

    // Mock the write methods
    vi.spyOn(qwickbrainClient, 'createDocument').mockResolvedValue();
    vi.spyOn(qwickbrainClient, 'setMemory').mockResolvedValue();
    vi.spyOn(qwickbrainClient, 'deleteDocument').mockResolvedValue();
    vi.spyOn(qwickbrainClient, 'deleteMemory').mockResolvedValue();

    writeQueueManager = new WriteQueueManager(db, qwickbrainClient);
  });

  afterEach(() => {
    // Clean up temporary directory
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('queueOperation', () => {
    it('should queue a create_document operation', async () => {
      await writeQueueManager.queueOperation('create_document', {
        docType: 'workflow',
        name: 'test-workflow',
        content: 'workflow content',
      });

      const stats = await writeQueueManager.getQueueStats();
      expect(stats.pending).toBe(1);
      expect(stats.total).toBe(1);
    });

    it('should queue a set_memory operation', async () => {
      await writeQueueManager.queueOperation('set_memory', {
        name: 'test-memory',
        content: 'memory content',
      });

      const stats = await writeQueueManager.getQueueStats();
      expect(stats.pending).toBe(1);
    });

    it('should queue multiple operations', async () => {
      await writeQueueManager.queueOperation('create_document', {
        docType: 'workflow',
        name: 'wf1',
        content: 'content1',
      });

      await writeQueueManager.queueOperation('set_memory', {
        name: 'mem1',
        content: 'content2',
      });

      await writeQueueManager.queueOperation('create_document', {
        docType: 'rule',
        name: 'rule1',
        content: 'content3',
      });

      const stats = await writeQueueManager.getQueueStats();
      expect(stats.pending).toBe(3);
      expect(stats.total).toBe(3);
    });
  });

  describe('syncPendingOperations', () => {
    it('should sync pending create_document operations', async () => {
      await writeQueueManager.queueOperation('create_document', {
        docType: 'workflow',
        name: 'test-workflow',
        content: 'workflow content',
        project: 'my-project',
        metadata: { author: 'test' },
      });

      const { synced, failed } = await writeQueueManager.syncPendingOperations();

      expect(synced).toBe(1);
      expect(failed).toBe(0);
      expect(qwickbrainClient.createDocument).toHaveBeenCalledWith(
        'workflow',
        'test-workflow',
        'workflow content',
        'my-project',
        { author: 'test' }
      );

      const stats = await writeQueueManager.getQueueStats();
      expect(stats.pending).toBe(0);
      expect(stats.total).toBe(0); // Completed operations are cleaned up
    });

    it('should sync pending set_memory operations', async () => {
      await writeQueueManager.queueOperation('set_memory', {
        name: 'test-memory',
        content: 'memory content',
        project: 'my-project',
      });

      const { synced, failed } = await writeQueueManager.syncPendingOperations();

      expect(synced).toBe(1);
      expect(failed).toBe(0);
      expect(qwickbrainClient.setMemory).toHaveBeenCalledWith(
        'test-memory',
        'memory content',
        'my-project',
        undefined
      );
    });

    it('should sync multiple operations in order (FIFO)', async () => {
      const callOrder: string[] = [];

      vi.spyOn(qwickbrainClient, 'createDocument').mockImplementation(async (docType, name) => {
        callOrder.push(`doc:${name}`);
      });

      vi.spyOn(qwickbrainClient, 'setMemory').mockImplementation(async (name) => {
        callOrder.push(`mem:${name}`);
      });

      await writeQueueManager.queueOperation('create_document', {
        docType: 'workflow',
        name: 'first',
        content: 'content',
      });

      await writeQueueManager.queueOperation('set_memory', {
        name: 'second',
        content: 'content',
      });

      await writeQueueManager.queueOperation('create_document', {
        docType: 'rule',
        name: 'third',
        content: 'content',
      });

      const { synced } = await writeQueueManager.syncPendingOperations();

      expect(synced).toBe(3);
      expect(callOrder).toEqual(['doc:first', 'mem:second', 'doc:third']);
    });

    it('should handle operation failures and retry', async () => {
      let callCount = 0;
      vi.spyOn(qwickbrainClient, 'createDocument').mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          throw new Error('Network error');
        }
      });

      await writeQueueManager.queueOperation('create_document', {
        docType: 'workflow',
        name: 'test',
        content: 'content',
      });

      // First sync - should fail (attempt 1)
      let result = await writeQueueManager.syncPendingOperations();
      expect(result.synced).toBe(0);
      expect(result.failed).toBe(0);

      let stats = await writeQueueManager.getQueueStats();
      expect(stats.pending).toBe(1); // Still pending

      // Second sync - should fail (attempt 2)
      result = await writeQueueManager.syncPendingOperations();
      expect(result.synced).toBe(0);
      expect(result.failed).toBe(0);

      // Third sync - should succeed (attempt 3)
      result = await writeQueueManager.syncPendingOperations();
      expect(result.synced).toBe(1);
      expect(result.failed).toBe(0);

      stats = await writeQueueManager.getQueueStats();
      expect(stats.pending).toBe(0);
    });

    it('should mark operation as failed after max attempts', async () => {
      vi.spyOn(qwickbrainClient, 'createDocument').mockRejectedValue(new Error('Permanent error'));

      await writeQueueManager.queueOperation('create_document', {
        docType: 'workflow',
        name: 'test',
        content: 'content',
      });

      // Attempt 1
      let result = await writeQueueManager.syncPendingOperations();
      expect(result.failed).toBe(0);

      // Attempt 2
      result = await writeQueueManager.syncPendingOperations();
      expect(result.failed).toBe(0);

      // Attempt 3 - max reached, marked as failed
      result = await writeQueueManager.syncPendingOperations();
      expect(result.synced).toBe(0);
      expect(result.failed).toBe(1);

      const stats = await writeQueueManager.getQueueStats();
      expect(stats.pending).toBe(0);
      expect(stats.failed).toBe(1);

      const failedOps = await writeQueueManager.getFailedOperations();
      expect(failedOps.length).toBe(1);
      expect(failedOps[0].error).toContain('Permanent error');
      expect(failedOps[0].attempts).toBe(3);
    });

    it('should skip sync if already syncing', async () => {
      // Queue an operation that takes time
      let resolveSync: () => void;
      const syncPromise = new Promise<void>((resolve) => {
        resolveSync = resolve;
      });

      vi.spyOn(qwickbrainClient, 'createDocument').mockImplementation(async () => {
        await syncPromise;
      });

      await writeQueueManager.queueOperation('create_document', {
        docType: 'workflow',
        name: 'test',
        content: 'content',
      });

      // Start first sync (won't complete)
      const sync1 = writeQueueManager.syncPendingOperations();

      // Start second sync while first is running
      const sync2 = writeQueueManager.syncPendingOperations();

      // Second should skip
      const result2 = await sync2;
      expect(result2.synced).toBe(0);
      expect(result2.failed).toBe(0);

      // Complete first sync
      resolveSync!();
      const result1 = await sync1;
      expect(result1.synced).toBe(1);
    });
  });

  describe('retryOperation', () => {
    it('should reset a failed operation for retry', async () => {
      vi.spyOn(qwickbrainClient, 'createDocument').mockRejectedValue(new Error('Error'));

      await writeQueueManager.queueOperation('create_document', {
        docType: 'workflow',
        name: 'test',
        content: 'content',
      });

      // Fail 3 times to mark as failed
      await writeQueueManager.syncPendingOperations();
      await writeQueueManager.syncPendingOperations();
      await writeQueueManager.syncPendingOperations();

      let stats = await writeQueueManager.getQueueStats();
      expect(stats.failed).toBe(1);

      const failedOps = await writeQueueManager.getFailedOperations();
      const opId = failedOps[0].id;

      // Fix the mock
      vi.spyOn(qwickbrainClient, 'createDocument').mockResolvedValue();

      // Retry the operation
      await writeQueueManager.retryOperation(opId);

      stats = await writeQueueManager.getQueueStats();
      expect(stats.pending).toBe(1);
      expect(stats.failed).toBe(0);

      // Sync should now succeed
      const result = await writeQueueManager.syncPendingOperations();
      expect(result.synced).toBe(1);
    });
  });

  describe('clearFailed', () => {
    it('should clear all failed operations', async () => {
      vi.spyOn(qwickbrainClient, 'createDocument').mockRejectedValue(new Error('Error'));

      // Queue and fail 2 operations
      await writeQueueManager.queueOperation('create_document', {
        docType: 'workflow',
        name: 'test1',
        content: 'content',
      });

      await writeQueueManager.queueOperation('create_document', {
        docType: 'rule',
        name: 'test2',
        content: 'content',
      });

      // Fail them
      for (let i = 0; i < 3; i++) {
        await writeQueueManager.syncPendingOperations();
      }

      let stats = await writeQueueManager.getQueueStats();
      expect(stats.failed).toBe(2);

      const cleared = await writeQueueManager.clearFailed();
      expect(cleared).toBe(2);

      stats = await writeQueueManager.getQueueStats();
      expect(stats.failed).toBe(0);
      expect(stats.total).toBe(0);
    });
  });

  describe('delete operations', () => {
    it('should sync delete_document operations', async () => {
      await writeQueueManager.queueOperation('delete_document', {
        docType: 'workflow',
        name: 'test-workflow',
        project: 'my-project',
      });

      const { synced } = await writeQueueManager.syncPendingOperations();

      expect(synced).toBe(1);
      expect(qwickbrainClient.deleteDocument).toHaveBeenCalledWith(
        'workflow',
        'test-workflow',
        'my-project'
      );
    });

    it('should sync delete_memory operations', async () => {
      await writeQueueManager.queueOperation('delete_memory', {
        name: 'test-memory',
        project: 'my-project',
      });

      const { synced } = await writeQueueManager.syncPendingOperations();

      expect(synced).toBe(1);
      expect(qwickbrainClient.deleteMemory).toHaveBeenCalledWith(
        'test-memory',
        'my-project'
      );
    });
  });
});
