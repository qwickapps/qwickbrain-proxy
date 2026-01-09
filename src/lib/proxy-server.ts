import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ConnectionManager } from './connection-manager.js';
import { CacheManager } from './cache-manager.js';
import { QwickBrainClient } from './qwickbrain-client.js';
import type { Config } from '../types/config.js';
import type { DB } from '../db/client.js';
import type { MCPResponse, MCPResponseMetadata } from '../types/mcp.js';
import { VERSION } from '../version.js';

export class ProxyServer {
  private server: Server;
  private connectionManager: ConnectionManager;
  private cacheManager: CacheManager;
  private qwickbrainClient: QwickBrainClient;
  private config: Config;

  constructor(db: DB, config: Config) {
    this.config = config;
    this.server = new Server(
      {
        name: 'qwickbrain-proxy',
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.qwickbrainClient = new QwickBrainClient(config.qwickbrain);

    this.connectionManager = new ConnectionManager(
      this.qwickbrainClient,
      config.connection
    );

    this.cacheManager = new CacheManager(db, config.cache);

    this.setupHandlers();
    this.setupConnectionListeners();
  }

  private setupConnectionListeners(): void {
    this.connectionManager.on('stateChange', ({ from, to }) => {
      console.error(`Connection state: ${from} → ${to}`);
    });

    this.connectionManager.on('reconnecting', ({ attempt, delay }) => {
      console.error(`Reconnecting (attempt ${attempt}, delay ${delay}ms)...`);
    });

    this.connectionManager.on('connected', ({ latencyMs }) => {
      console.error(`Connected to QwickBrain (latency: ${latencyMs}ms)`);
      // Event-driven: trigger background sync when connection restored
      this.onConnectionRestored().catch(err => {
        console.error('Background sync error:', err);
      });
    });

    this.connectionManager.on('disconnected', ({ error }) => {
      console.error(`Disconnected from QwickBrain: ${error}`);
    });
  }

  private async onConnectionRestored(): Promise<void> {
    console.error('Starting background cache sync...');

    // Preload critical documents in background
    const preloadItems = this.config.cache.preload || [];
    for (const itemType of preloadItems) {
      try {
        if (itemType === 'workflows') {
          // TODO: List and cache all workflows
          console.error('Preloading workflows...');
        } else if (itemType === 'rules') {
          // TODO: List and cache all rules
          console.error('Preloading rules...');
        }
      } catch (error) {
        console.error(`Failed to preload ${itemType}:`, error);
      }
    }

    console.error('Background cache sync complete');
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Try to fetch tools from upstream if connected
      if (this.connectionManager.getState() === 'connected') {
        try {
          const tools = await this.connectionManager.execute(async () => {
            return await this.qwickbrainClient.listTools();
          });
          return { tools };
        } catch (error) {
          console.error('Failed to list tools from upstream:', error);
        }
      }

      // Fallback to minimal tool set when offline or error
      return {
        tools: [
          {
            name: 'get_workflow',
            description: 'Get a workflow definition by name (cached)',
            inputSchema: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Workflow name' },
              },
              required: ['name'],
            },
          },
          {
            name: 'get_document',
            description: 'Get a document by name and type (cached)',
            inputSchema: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Document name' },
                doc_type: { type: 'string', description: 'Document type (rule, frd, design, etc.)' },
                project: { type: 'string', description: 'Project name (optional)' },
              },
              required: ['name', 'doc_type'],
            },
          },
          {
            name: 'get_memory',
            description: 'Get a memory/context document by name (cached)',
            inputSchema: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Memory name' },
                project: { type: 'string', description: 'Project name (optional)' },
              },
              required: ['name'],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        let result: MCPResponse;

        // Handle cacheable document tools specially
        switch (name) {
          case 'get_workflow':
            result = await this.handleGetWorkflow(args?.name as string);
            break;
          case 'get_document':
            result = await this.handleGetDocument(
              args?.doc_type as string,
              args?.name as string,
              args?.project as string | undefined
            );
            break;
          case 'get_memory':
            result = await this.handleGetMemory(
              args?.name as string,
              args?.project as string | undefined
            );
            break;
          default:
            // Generic forwarding for all other tools (analyze_repository, search_codebase, etc.)
            result = await this.handleGenericTool(name, args || {});
            break;
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: {
                  code: 'TOOL_ERROR',
                  message: errorMessage,
                },
                _metadata: {
                  source: 'cache',
                  status: this.connectionManager.getState(),
                },
              }, null, 2),
            },
          ],
          isError: true,
        };
      }
    });
  }

  private createMetadata(source: 'live' | 'cache' | 'stale_cache', age?: number): MCPResponseMetadata {
    return {
      source,
      age_seconds: age,
      status: this.connectionManager.getState(),
    };
  }

  private async handleGetWorkflow(name: string): Promise<MCPResponse> {
    return this.handleGetDocument('workflow', name);
  }

  private async handleGetDocument(
    docType: string,
    name: string,
    project?: string
  ): Promise<MCPResponse> {
    // Try cache first
    const cached = await this.cacheManager.getDocument(docType, name, project);

    if (cached && !cached.isExpired) {
      return {
        data: cached.data,
        _metadata: this.createMetadata('cache', cached.age),
      };
    }

    // Try remote if connected
    if (this.connectionManager.getState() === 'connected') {
      try {
        const result = await this.connectionManager.execute(async () => {
          return await this.qwickbrainClient.getDocument(docType, name, project);
        });

        // Cache the result
        await this.cacheManager.setDocument(
          docType,
          name,
          result.content,
          project,
          result.metadata
        );

        return {
          data: result,
          _metadata: this.createMetadata('live'),
        };
      } catch (error) {
        console.error('Failed to fetch from QwickBrain:', error);
        // Fall through to stale cache
      }
    }

    // Try stale cache
    if (cached) {
      return {
        data: cached.data,
        _metadata: {
          ...this.createMetadata('stale_cache', cached.age),
          warning: `QwickBrain unavailable - serving cached data (${cached.age}s old)`,
        },
      };
    }

    // No cache, no connection
    return {
      error: {
        code: 'UNAVAILABLE',
        message: `QwickBrain unavailable and no cached data for ${docType}:${name}`,
        suggestions: [
          'Check internet connection',
          'Wait for automatic reconnection',
          docType === 'workflow' ? 'Try /plan command as fallback' : undefined,
        ].filter(Boolean) as string[],
      },
      _metadata: this.createMetadata('cache'),
    };
  }

  private async handleGetMemory(name: string, project?: string): Promise<MCPResponse> {
    // Similar logic to handleGetDocument but for memories
    const cached = await this.cacheManager.getMemory(name, project);

    if (cached && !cached.isExpired) {
      return {
        data: cached.data,
        _metadata: this.createMetadata('cache', cached.age),
      };
    }

    if (this.connectionManager.getState() === 'connected') {
      try {
        const result = await this.connectionManager.execute(async () => {
          return await this.qwickbrainClient.getMemory(name, project);
        });

        await this.cacheManager.setMemory(name, result.content, project, result.metadata);

        return {
          data: result,
          _metadata: this.createMetadata('live'),
        };
      } catch (error) {
        console.error('Failed to fetch memory from QwickBrain:', error);
      }
    }

    if (cached) {
      return {
        data: cached.data,
        _metadata: {
          ...this.createMetadata('stale_cache', cached.age),
          warning: `QwickBrain unavailable - serving cached memory (${cached.age}s old)`,
        },
      };
    }

    return {
      error: {
        code: 'UNAVAILABLE',
        message: `QwickBrain unavailable and no cached memory: ${name}`,
        suggestions: ['Check connection', 'Wait for reconnection'],
      },
      _metadata: this.createMetadata('cache'),
    };
  }

  private async handleGenericTool(name: string, args: Record<string, unknown>): Promise<MCPResponse> {
    // Generic tool forwarding - no caching for non-document tools
    if (this.connectionManager.getState() !== 'connected') {
      return {
        error: {
          code: 'UNAVAILABLE',
          message: `QwickBrain unavailable - cannot call tool: ${name}`,
          suggestions: [
            'Check internet connection',
            'Wait for automatic reconnection',
          ],
        },
        _metadata: this.createMetadata('cache'),
      };
    }

    try {
      const result = await this.connectionManager.execute(async () => {
        return await this.qwickbrainClient.callTool(name, args);
      });

      // Parse the MCP response format
      if (result && typeof result === 'object' && 'content' in result) {
        const content = (result as any).content;
        if (Array.isArray(content) && content[0]?.type === 'text') {
          // Parse the text content as JSON
          const data = JSON.parse(content[0].text);
          return {
            data,
            _metadata: this.createMetadata('live'),
          };
        }
      }

      // Fallback: return raw result
      return {
        data: result,
        _metadata: this.createMetadata('live'),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        error: {
          code: 'TOOL_ERROR',
          message: `Tool call failed: ${errorMessage}`,
        },
        _metadata: this.createMetadata('cache'),
      };
    }
  }

  async start(): Promise<void> {
    // Clean up expired cache entries on startup
    const { documentsDeleted, memoriesDeleted } = await this.cacheManager.cleanupExpiredEntries();
    if (documentsDeleted > 0 || memoriesDeleted > 0) {
      console.error(`Cache cleanup: removed ${documentsDeleted} documents, ${memoriesDeleted} memories`);
    }

    // Start connection manager (handles connection gracefully, doesn't throw)
    await this.connectionManager.start();

    // Start MCP server
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error('QwickBrain Proxy started');
  }

  async stop(): Promise<void> {
    this.connectionManager.stop();
    try {
      await this.qwickbrainClient.disconnect();
    } catch (error) {
      // Ignore disconnect errors (client may never have connected)
      console.error('Disconnect error (ignoring):', error);
    }
    await this.server.close();
  }
}
