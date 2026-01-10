import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, runMigrations } from '../../db/client.js';
import { CacheManager } from '../cache-manager.js';
import { SSEInvalidationListener } from '../sse-invalidation-listener.js';
import type { Config } from '../../types/config.js';
import { EventSource } from 'eventsource';

// Mock EventSource
vi.mock('eventsource', () => {
  const EventSourceMock = vi.fn();
  return { EventSource: EventSourceMock };
});

describe('SSEInvalidationListener', () => {
  let tmpDir: string;
  let cacheManager: CacheManager;
  let listener: SSEInvalidationListener;
  let db: ReturnType<typeof createDatabase>['db'];
  let mockEventSource: any;
  let eventListeners: Map<string, Function[]>;

  beforeEach(() => {
    // Create temporary directory for test database
    tmpDir = mkdtempSync(join(tmpdir(), 'sse-test-'));
    const dbResult = createDatabase(tmpDir);
    db = dbResult.db;

    // Run migrations to create tables
    runMigrations(db);

    const config: Config['cache'] = {
      dir: tmpDir,
      maxCacheSizeBytes: 100 * 1024 * 1024,
      preload: [],
    };

    cacheManager = new CacheManager(db, config);

    // Setup EventSource mock
    eventListeners = new Map();

    mockEventSource = {
      readyState: 1, // OPEN
      addEventListener: vi.fn((event: string, handler: Function) => {
        if (!eventListeners.has(event)) {
          eventListeners.set(event, []);
        }
        eventListeners.get(event)!.push(handler);
      }),
      close: vi.fn(),
      onopen: null,
      onerror: null,
    };

    (EventSource as any).mockImplementation(() => mockEventSource);
    (EventSource as any).OPEN = 1;
    (EventSource as any).CLOSED = 2;

    listener = new SSEInvalidationListener(
      'http://test.local:3000',
      cacheManager,
      'test-api-key'
    );
  });

  afterEach(() => {
    listener.stop();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('start', () => {
    it('should connect to SSE endpoint', async () => {
      await listener.start();

      expect(EventSource).toHaveBeenCalledWith(
        'http://test.local:3000/sse/cache-invalidation',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-api-key',
          }),
        })
      );
    });

    it('should register event listeners', async () => {
      await listener.start();

      expect(mockEventSource.addEventListener).toHaveBeenCalledWith(
        'document:invalidate',
        expect.any(Function)
      );
      expect(mockEventSource.addEventListener).toHaveBeenCalledWith(
        'memory:invalidate',
        expect.any(Function)
      );
      expect(mockEventSource.addEventListener).toHaveBeenCalledWith(
        'cache:invalidate:batch',
        expect.any(Function)
      );
    });

    it('should call onopen handler', async () => {
      await listener.start();

      // Trigger onopen
      mockEventSource.onopen?.();

      // Should be listening
      expect(listener.isListening()).toBe(true);
    });
  });

  describe('document invalidation', () => {
    it('should invalidate document cache on event', async () => {
      // Pre-populate cache
      await cacheManager.setDocument('workflow', 'test-workflow', 'content');

      const cached1 = await cacheManager.getDocument('workflow', 'test-workflow');
      expect(cached1).not.toBeNull();

      // Start listener
      await listener.start();

      // Trigger invalidation event
      const handlers = eventListeners.get('document:invalidate') || [];
      const invalidationEvent = {
        data: JSON.stringify({
          type: 'document',
          docType: 'workflow',
          name: 'test-workflow',
        }),
      };

      for (const handler of handlers) {
        await handler(invalidationEvent);
      }

      // Cache should be invalidated
      const cached2 = await cacheManager.getDocument('workflow', 'test-workflow');
      expect(cached2).toBeNull();
    });

    it('should invalidate project-scoped document', async () => {
      await cacheManager.setDocument('rule', 'test-rule', 'content', 'my-project');

      const cached1 = await cacheManager.getDocument('rule', 'test-rule', 'my-project');
      expect(cached1).not.toBeNull();

      await listener.start();

      const handlers = eventListeners.get('document:invalidate') || [];
      const invalidationEvent = {
        data: JSON.stringify({
          type: 'document',
          docType: 'rule',
          name: 'test-rule',
          project: 'my-project',
        }),
      };

      for (const handler of handlers) {
        await handler(invalidationEvent);
      }

      const cached2 = await cacheManager.getDocument('rule', 'test-rule', 'my-project');
      expect(cached2).toBeNull();
    });
  });

  describe('memory invalidation', () => {
    it('should invalidate memory cache on event', async () => {
      await cacheManager.setMemory('test-memory', 'content');

      const cached1 = await cacheManager.getMemory('test-memory');
      expect(cached1).not.toBeNull();

      await listener.start();

      const handlers = eventListeners.get('memory:invalidate') || [];
      const invalidationEvent = {
        data: JSON.stringify({
          type: 'memory',
          name: 'test-memory',
        }),
      };

      for (const handler of handlers) {
        await handler(invalidationEvent);
      }

      const cached2 = await cacheManager.getMemory('test-memory');
      expect(cached2).toBeNull();
    });

    it('should invalidate project-scoped memory', async () => {
      await cacheManager.setMemory('test-memory', 'content', 'my-project');

      const cached1 = await cacheManager.getMemory('test-memory', 'my-project');
      expect(cached1).not.toBeNull();

      await listener.start();

      const handlers = eventListeners.get('memory:invalidate') || [];
      const invalidationEvent = {
        data: JSON.stringify({
          type: 'memory',
          name: 'test-memory',
          project: 'my-project',
        }),
      };

      for (const handler of handlers) {
        await handler(invalidationEvent);
      }

      const cached2 = await cacheManager.getMemory('test-memory', 'my-project');
      expect(cached2).toBeNull();
    });
  });

  describe('batch invalidation', () => {
    it('should invalidate multiple items in batch', async () => {
      // Pre-populate cache
      await cacheManager.setDocument('workflow', 'wf1', 'content');
      await cacheManager.setDocument('rule', 'rule1', 'content');
      await cacheManager.setMemory('mem1', 'content');

      await listener.start();

      const handlers = eventListeners.get('cache:invalidate:batch') || [];
      const batchEvent = {
        data: JSON.stringify([
          { type: 'document', docType: 'workflow', name: 'wf1' },
          { type: 'document', docType: 'rule', name: 'rule1' },
          { type: 'memory', name: 'mem1' },
        ]),
      };

      for (const handler of handlers) {
        await handler(batchEvent);
      }

      // All should be invalidated
      const wf1 = await cacheManager.getDocument('workflow', 'wf1');
      const rule1 = await cacheManager.getDocument('rule', 'rule1');
      const mem1 = await cacheManager.getMemory('mem1');

      expect(wf1).toBeNull();
      expect(rule1).toBeNull();
      expect(mem1).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should handle malformed invalidation events', async () => {
      await listener.start();

      const handlers = eventListeners.get('document:invalidate') || [];

      // Should not throw on malformed JSON
      expect(() => {
        for (const handler of handlers) {
          handler({ data: 'invalid json' });
        }
      }).not.toThrow();
    });

    it('should handle missing docType in document event', async () => {
      await cacheManager.setDocument('workflow', 'test', 'content');

      await listener.start();

      const handlers = eventListeners.get('document:invalidate') || [];
      const invalidEvent = {
        data: JSON.stringify({
          type: 'document',
          name: 'test',
          // Missing docType
        }),
      };

      // Should not throw
      expect(() => {
        for (const handler of handlers) {
          handler(invalidEvent);
        }
      }).not.toThrow();

      // Cache should still be present (invalidation skipped)
      const cached = await cacheManager.getDocument('workflow', 'test');
      expect(cached).not.toBeNull();
    });
  });

  describe('stop', () => {
    it('should close EventSource and stop listening', async () => {
      await listener.start();

      expect(listener.isListening()).toBe(true);

      listener.stop();

      expect(mockEventSource.close).toHaveBeenCalled();
      expect(listener.isListening()).toBe(false);
    });

    it('should prevent reconnection after stop', async () => {
      await listener.start();

      listener.stop();

      // Trigger error (would normally trigger reconnect)
      mockEventSource.onerror?.(new Error('Connection lost'));

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should not have tried to reconnect
      expect(EventSource).toHaveBeenCalledTimes(1);
    });
  });
});
