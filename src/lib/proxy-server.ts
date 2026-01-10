import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ConnectionManager } from './connection-manager.js';
import { CacheManager } from './cache-manager.js';
import { QwickBrainClient } from './qwickbrain-client.js';
import { WriteQueueManager } from './write-queue-manager.js';
import { SSEInvalidationListener } from './sse-invalidation-listener.js';
import { QWICKBRAIN_TOOLS, requiresConnection } from './tools.js';
import type { Config } from '../types/config.js';
import type { DB } from '../db/client.js';
import type { MCPResponse, MCPResponseMetadata } from '../types/mcp.js';
import { VERSION } from '../version.js';

export class ProxyServer {
  private server: Server;
  private connectionManager: ConnectionManager;
  private cacheManager: CacheManager;
  private qwickbrainClient: QwickBrainClient;
  private writeQueueManager: WriteQueueManager;
  private sseInvalidationListener: SSEInvalidationListener | null = null;
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
    this.writeQueueManager = new WriteQueueManager(db, this.qwickbrainClient);

    // Initialize SSE invalidation listener if in SSE mode
    if (config.qwickbrain.mode === 'sse' && config.qwickbrain.url) {
      this.sseInvalidationListener = new SSEInvalidationListener(
        config.qwickbrain.url,
        this.cacheManager,
        config.qwickbrain.apiKey
      );
    }

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
      // Sync pending write operations
      this.syncWriteQueue().catch(err => {
        console.error('Write queue sync error:', err);
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

  private async syncWriteQueue(): Promise<void> {
    const pendingCount = await this.writeQueueManager.getPendingCount();
    if (pendingCount === 0) {
      return;
    }

    console.error(`Syncing ${pendingCount} pending write operations...`);
    const { synced, failed } = await this.writeQueueManager.syncPendingOperations();
    console.error(`Write queue sync complete: ${synced} synced, ${failed} failed`);
  }

  private setupHandlers(): void {
    // Static tool listing - always returns all tools regardless of connection state
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: QWICKBRAIN_TOOLS };
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
          case 'create_document':
          case 'update_document':
            result = await this.handleCreateDocument(
              args?.doc_type as string,
              args?.name as string,
              args?.content as string,
              args?.project as string | undefined,
              args?.metadata as Record<string, unknown> | undefined
            );
            break;
          case 'set_memory':
          case 'update_memory':
            result = await this.handleSetMemory(
              args?.name as string,
              args?.content as string,
              args?.project as string | undefined,
              args?.metadata as Record<string, unknown> | undefined
            );
            break;
          default:
            // Generic forwarding for all other tools (analyze_repository, search_codebase, etc.)
            // Check if tool requires connection
            if (requiresConnection(name) && this.connectionManager.getState() !== 'connected') {
              // Return offline error for non-cacheable tools
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      error: {
                        code: 'OFFLINE',
                        message: `QwickBrain offline - "${name}" requires active connection`,
                        suggestions: [
                          'Check internet connection',
                          'Wait for automatic reconnection',
                          'Cached tools (get_workflow, get_document, get_memory) work offline',
                        ],
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
    // Try cache first (LRU cache never expires, always valid if present)
    const cached = await this.cacheManager.getDocument(docType, name, project);

    if (cached) {
      return {
        data: cached.data,
        _metadata: this.createMetadata('cache', cached.age),
      };
    }

    // Not cached - try remote if connected
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
        // Fall through to error
      }
    }

    // No cache and remote failed/unavailable
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
    // Try cache first (LRU cache never expires, always valid if present)
    const cached = await this.cacheManager.getMemory(name, project);

    if (cached) {
      return {
        data: cached.data,
        _metadata: this.createMetadata('cache', cached.age),
      };
    }

    // Not cached - try remote if connected
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
        // Fall through to error
      }
    }

    // No cache and remote failed/unavailable
    return {
      error: {
        code: 'UNAVAILABLE',
        message: `QwickBrain unavailable and no cached memory: ${name}`,
        suggestions: ['Check connection', 'Wait for reconnection'],
      },
      _metadata: this.createMetadata('cache'),
    };
  }

  private async handleCreateDocument(
    docType: string,
    name: string,
    content: string,
    project?: string,
    metadata?: Record<string, unknown>
  ): Promise<MCPResponse> {
    // Always update local cache first
    await this.cacheManager.setDocument(docType, name, content, project, metadata);

    // If connected, sync immediately
    if (this.connectionManager.getState() === 'connected') {
      try {
        await this.connectionManager.execute(async () => {
          await this.qwickbrainClient.createDocument(docType, name, content, project, metadata);
        });

        return {
          data: { success: true },
          _metadata: this.createMetadata('live'),
        };
      } catch (error) {
        console.error('Failed to create document on QwickBrain:', error);
        // Fall through to queue
      }
    }

    // If offline or sync failed, queue for later
    await this.writeQueueManager.queueOperation('create_document', {
      docType,
      name,
      content,
      project,
      metadata,
    });

    return {
      data: { success: true, queued: true },
      _metadata: {
        ...this.createMetadata('cache'),
        warning: 'Operation queued - will sync when connection restored',
      },
    };
  }

  private async handleSetMemory(
    name: string,
    content: string,
    project?: string,
    metadata?: Record<string, unknown>
  ): Promise<MCPResponse> {
    // Always update local cache first
    await this.cacheManager.setMemory(name, content, project, metadata);

    // If connected, sync immediately
    if (this.connectionManager.getState() === 'connected') {
      try {
        await this.connectionManager.execute(async () => {
          await this.qwickbrainClient.setMemory(name, content, project, metadata);
        });

        return {
          data: { success: true },
          _metadata: this.createMetadata('live'),
        };
      } catch (error) {
        console.error('Failed to set memory on QwickBrain:', error);
        // Fall through to queue
      }
    }

    // If offline or sync failed, queue for later
    await this.writeQueueManager.queueOperation('set_memory', {
      name,
      content,
      project,
      metadata,
    });

    return {
      data: { success: true, queued: true },
      _metadata: {
        ...this.createMetadata('cache'),
        warning: 'Operation queued - will sync when connection restored',
      },
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
    // LRU cache handles eviction automatically when storage limit reached
    // No need for startup cleanup with LRU-based cache

    // Start connection manager (handles connection gracefully, doesn't throw)
    await this.connectionManager.start();

    // Start SSE invalidation listener if configured
    if (this.sseInvalidationListener) {
      await this.sseInvalidationListener.start();
      console.error('SSE cache invalidation listener started');
    }

    // Start MCP server
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error('QwickBrain Proxy started');
  }

  async stop(): Promise<void> {
    this.connectionManager.stop();

    // Stop SSE invalidation listener
    if (this.sseInvalidationListener) {
      this.sseInvalidationListener.stop();
    }

    try {
      await this.qwickbrainClient.disconnect();
    } catch (error) {
      // Ignore disconnect errors (client may never have connected)
      console.error('Disconnect error (ignoring):', error);
    }
    await this.server.close();
  }
}
