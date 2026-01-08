import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { QwickBrainClient } from '../qwickbrain-client.js';
import type { Config } from '../../types/config.js';

// Mock the MCP SDK
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn(),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn(),
}));

// Mock fetch for HTTP mode
global.fetch = vi.fn();

describe('QwickBrainClient', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('SSE mode', () => {
    let client: QwickBrainClient;
    let config: Config['qwickbrain'];

    beforeEach(() => {
      config = {
        mode: 'sse',
        url: 'http://test.local:3000',
      };

      client = new QwickBrainClient(config);
    });

    it('should connect in SSE mode', async () => {
      await client.connect();

      expect(client['mode']).toBe('sse');
      expect(client['client']).toBeDefined();
    });

    it('should get document via MCP in SSE mode', async () => {
      await client.connect();

      const mockResponse = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              document: {
                content: 'test content',
                metadata: { version: 1 },
              },
            }),
          },
        ],
      };

      (client['client']!.callTool as any).mockResolvedValue(mockResponse);

      const result = await client.getDocument('workflow', 'test');

      expect(result.content).toBe('test content');
      expect(result.metadata).toEqual({ version: 1 });
    });

    it('should throw on invalid MCP response format', async () => {
      await client.connect();

      const mockResponse = {
        content: [
          {
            type: 'image', // Invalid type
            data: 'invalid',
          },
        ],
      };

      (client['client']!.callTool as any).mockResolvedValue(mockResponse);

      await expect(client.getDocument('workflow', 'test')).rejects.toThrow();
    });
  });

  describe('HTTP mode', () => {
    let client: QwickBrainClient;
    let config: Config['qwickbrain'];

    beforeEach(() => {
      config = {
        mode: 'http',
        url: 'http://api.test.com',
        apiKey: 'test-key',
      };

      client = new QwickBrainClient(config);
    });

    it('should get document via HTTP', async () => {
      const mockResponse = {
        content: 'test content',
        metadata: { version: 1 },
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await client.getDocument('workflow', 'test');

      expect(result.content).toBe('test content');
      expect(result.metadata).toEqual({ version: 1 });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://api.test.com/mcp/document',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-key',
          }),
        })
      );
    });

    it('should throw on HTTP error', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(client.getDocument('workflow', 'test')).rejects.toThrow('HTTP 404');
    });

    it('should validate HTTP response schema', async () => {
      const invalidResponse = {
        // Missing required 'content' field
        metadata: {},
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => invalidResponse,
      });

      await expect(client.getDocument('workflow', 'test')).rejects.toThrow();
    });

    it('should get memory via HTTP', async () => {
      const mockResponse = {
        content: 'memory content',
        metadata: {},
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await client.getMemory('test-memory');

      expect(result.content).toBe('memory content');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://api.test.com/mcp/memory',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });
  });

  describe('MCP mode', () => {
    let client: QwickBrainClient;
    let config: Config['qwickbrain'];

    beforeEach(() => {
      config = {
        mode: 'mcp',
        command: 'npx',
        args: ['qwickbrain-server'],
      };

      client = new QwickBrainClient(config);
    });

    it('should connect in MCP mode', async () => {
      await client.connect();

      expect(client['mode']).toBe('mcp');
      expect(client['client']).toBeDefined();
    });

    it('should require command in MCP mode', async () => {
      const invalidConfig: Config['qwickbrain'] = {
        mode: 'mcp',
        // Missing command
      };

      const invalidClient = new QwickBrainClient(invalidConfig);

      await expect(invalidClient.connect()).rejects.toThrow('MCP mode requires command');
    });
  });

  describe('healthCheck', () => {
    it('should return true for successful MCP health check', async () => {
      const config: Config['qwickbrain'] = {
        mode: 'sse',
        url: 'http://test.local:3000',
      };

      const client = new QwickBrainClient(config);
      await client.connect();

      const isHealthy = await client.healthCheck();

      expect(isHealthy).toBe(true);
    });

    it('should return true for successful HTTP health check', async () => {
      const config: Config['qwickbrain'] = {
        mode: 'http',
        url: 'http://api.test.com',
      };

      const client = new QwickBrainClient(config);

      (global.fetch as any).mockResolvedValue({
        ok: true,
      });

      const isHealthy = await client.healthCheck();

      expect(isHealthy).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith('http://api.test.com/health');
    });

    it('should return false on health check failure', async () => {
      const config: Config['qwickbrain'] = {
        mode: 'sse',
        url: 'http://test.local:3000',
      };

      const client = new QwickBrainClient(config);
      await client.connect();

      (client['client']!.listTools as any).mockRejectedValue(new Error('Failed'));

      const isHealthy = await client.healthCheck();

      expect(isHealthy).toBe(false);
    });

    it('should return false for missing URL in HTTP mode', async () => {
      const config: Config['qwickbrain'] = {
        mode: 'http',
        // Missing URL
      };

      const client = new QwickBrainClient(config);

      const isHealthy = await client.healthCheck();

      expect(isHealthy).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('should disconnect MCP client', async () => {
      const config: Config['qwickbrain'] = {
        mode: 'sse',
        url: 'http://test.local:3000',
      };

      const client = new QwickBrainClient(config);
      await client.connect();

      const closeMock = client['client']!.close;

      await client.disconnect();

      expect(closeMock).toHaveBeenCalled();
      expect(client['client']).toBeNull();
    });

    it('should handle disconnect when not connected', async () => {
      const config: Config['qwickbrain'] = {
        mode: 'http',
        url: 'http://api.test.com',
      };

      const client = new QwickBrainClient(config);

      // Should not throw
      await expect(client.disconnect()).resolves.toBeUndefined();
    });
  });
});
