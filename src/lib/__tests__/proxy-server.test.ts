import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, runMigrations } from '../../db/client.js';
import { ProxyServer } from '../proxy-server.js';
import type { Config } from '../../types/config.js';

// Mock MCP SDK
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn(),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: vi.fn().mockImplementation(() => ({
    setRequestHandler: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn(),
}));

describe('ProxyServer', () => {
  let tmpDir: string;
  let config: Config;
  let db: ReturnType<typeof createDatabase>['db'];
  let server: ProxyServer;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'proxy-test-'));
    const dbResult = createDatabase(tmpDir);
    db = dbResult.db;

    // Run migrations to create tables
    runMigrations(db);

    config = {
      qwickbrain: {
        mode: 'sse',
        url: 'http://test.local:3000',
      },
      cache: {
        dir: tmpDir,
        maxCacheSizeBytes: 100 * 1024 * 1024, // 100MB
        preload: [],
      },
      connection: {
        healthCheckInterval: 30000,
        timeout: 5000,
        maxReconnectAttempts: 5,
        reconnectBackoff: {
          initial: 1000,
          multiplier: 2,
          max: 30000,
        },
      },
      sync: {
        interval: 60000,
        batchSize: 10,
      },
    };

    server = new ProxyServer(db, config);
  });

  afterEach(async () => {
    await server.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initialization', () => {
    it('should initialize with all components', () => {
      expect(server['server']).toBeDefined();
      expect(server['connectionManager']).toBeDefined();
      expect(server['cacheManager']).toBeDefined();
      expect(server['qwickbrainClient']).toBeDefined();
    });

    it('should set up MCP request handlers', () => {
      const setRequestHandlerMock = server['server'].setRequestHandler;

      // Should have set up handlers for ListTools and CallTool
      expect(setRequestHandlerMock).toHaveBeenCalled();
      expect((setRequestHandlerMock as any).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('cache behavior', () => {
    it('should use LRU cache with no expiration', async () => {
      // With LRU cache, items never expire by time
      await server['cacheManager'].setDocument('workflow', 'test', 'content');

      // Wait some time
      await new Promise(resolve => setTimeout(resolve, 100));

      // Entry should still be present (no TTL expiration)
      const cached = await server['cacheManager'].getDocument('workflow', 'test');
      expect(cached).not.toBeNull();
      expect(cached?.data.content).toBe('content');
    });
  });

  describe('graceful degradation', () => {
    it('should serve cached data when disconnected', async () => {
      // LRU cache always serves cached data (no staleness - always fresh)
      await server['cacheManager'].setDocument('workflow', 'test', 'cached content');

      // Simulate disconnected state
      server['connectionManager']['state'] = 'disconnected';

      const result = await server['handleGetDocument']('workflow', 'test');

      expect((result.data as any).content).toBe('cached content');
      expect(result._metadata.source).toBe('cache'); // Fresh cache, not stale
    });

    it('should return error when no cache available and disconnected', async () => {
      // Simulate disconnected state with no cache
      server['connectionManager']['state'] = 'disconnected';

      const result = await server['handleGetDocument']('workflow', 'non-existent');

      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('UNAVAILABLE');
      expect(result.error?.message).toContain('QwickBrain unavailable');
    });
  });

  describe('metadata', () => {
    it('should include correct metadata for cache hit', async () => {
      await server['cacheManager'].setDocument('workflow', 'test', 'content');

      // Simulate connected state
      server['connectionManager']['state'] = 'connected';

      const result = await server['handleGetDocument']('workflow', 'test');

      expect(result._metadata.source).toBe('cache');
      expect(result._metadata.age_seconds).toBeDefined();
      expect(typeof result._metadata.age_seconds).toBe('number');
    });

    it('should create metadata with correct source', () => {
      const cacheMeta = server['createMetadata']('cache', 100);
      expect(cacheMeta).toEqual({
        source: 'cache',
        age_seconds: 100,
        status: server['connectionManager'].getState(),
      });

      const liveMeta = server['createMetadata']('live');
      expect(liveMeta).toEqual({
        source: 'live',
        status: server['connectionManager'].getState(),
      });

      const staleMeta = server['createMetadata']('stale_cache', 500);
      expect(staleMeta).toEqual({
        source: 'stale_cache',
        age_seconds: 500,
        status: server['connectionManager'].getState(),
      });
    });
  });

  describe('error handling', () => {
    it('should handle QwickBrain errors gracefully', async () => {
      // Mock client to throw error
      server['qwickbrainClient'].getDocument = vi.fn().mockRejectedValue(
        new Error('Network error')
      );

      // Simulate connected state
      server['connectionManager']['state'] = 'connected';

      const result = await server['handleGetDocument']('workflow', 'test');

      // Should fall back to error response when remote fails and no cache
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('UNAVAILABLE');
    });
  });

  describe('project scoping', () => {
    it('should handle project-scoped documents', async () => {
      await server['cacheManager'].setDocument(
        'design',
        'test-design',
        'design content',
        'my-project'
      );

      server['connectionManager']['state'] = 'connected';

      const result = await server['handleGetDocument']('design', 'test-design', 'my-project');

      expect((result.data as any).content).toBe('design content');
      expect((result.data as any).project).toBe('my-project');
    });

    it('should distinguish global vs project-scoped items', async () => {
      await server['cacheManager'].setDocument('rule', 'test', 'global rule');
      await server['cacheManager'].setDocument('rule', 'test', 'project rule', 'proj1');

      server['connectionManager']['state'] = 'connected';

      const globalResult = await server['handleGetDocument']('rule', 'test');
      const projectResult = await server['handleGetDocument']('rule', 'test', 'proj1');

      expect((globalResult.data as any).content).toBe('global rule');
      expect((projectResult.data as any).content).toBe('project rule');
    });
  });
});
