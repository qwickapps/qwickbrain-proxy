import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Config } from '../types/config.js';
import { z } from 'zod';
import { VERSION } from '../version.js';

// Zod schema for MCP tool response validation
const MCPToolResponseSchema = z.object({
  content: z.array(
    z.object({
      type: z.literal('text'),
      text: z.string(),
    })
  ),
});

// Zod schema for the document/memory data inside the MCP response
const QwickBrainDocumentSchema = z.object({
  document: z
    .object({
      content: z.string(),
      metadata: z.record(z.unknown()).optional(),
    })
    .optional(),
});

// Zod schema for HTTP API responses
const HTTPResponseSchema = z.object({
  content: z.string(),
  metadata: z.record(z.unknown()).optional(),
});

export interface QwickBrainResponse {
  content: string;
  metadata?: Record<string, unknown>;
}

export class QwickBrainClient {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private mode: 'mcp' | 'http' | 'sse';
  private config: Config['qwickbrain'];

  constructor(config: Config['qwickbrain']) {
    this.mode = config.mode;
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.mode === 'mcp') {
      await this.connectMCP();
    } else if (this.mode === 'sse') {
      await this.connectSSE();
    }
    // HTTP mode doesn't need persistent connection
  }

  private async connectMCP(): Promise<void> {
    if (!this.config.command) {
      throw new Error('MCP mode requires command to be configured');
    }

    this.client = new Client(
      {
        name: 'qwickbrain-proxy',
        version: VERSION,
      },
      {
        capabilities: {},
      }
    );

    this.transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args || [],
    });

    await this.client.connect(this.transport);
  }

  private async connectSSE(): Promise<void> {
    if (!this.config.url) {
      throw new Error('SSE mode requires url to be configured');
    }

    this.client = new Client(
      {
        name: 'qwickbrain-proxy',
        version: VERSION,
      },
      {
        capabilities: {},
      }
    );

    this.transport = new SSEClientTransport(
      new URL(this.config.url)
    );

    await this.client.connect(this.transport);
  }

  async getDocument(
    docType: string,
    name: string,
    project?: string
  ): Promise<QwickBrainResponse> {
    if (this.mode === 'mcp' || this.mode === 'sse') {
      return this.getDocumentMCP(docType, name, project);
    } else {
      return this.getDocumentHTTP(docType, name, project);
    }
  }

  private async getDocumentMCP(
    docType: string,
    name: string,
    project?: string
  ): Promise<QwickBrainResponse> {
    if (!this.client) {
      throw new Error('MCP client not connected');
    }

    const result = await this.client.callTool({
      name: 'get_document',
      arguments: {
        doc_type: docType,
        name,
        project,
      },
    });

    // Validate MCP response structure
    const parsed = MCPToolResponseSchema.parse(result);
    const data = QwickBrainDocumentSchema.parse(JSON.parse(parsed.content[0].text));

    return {
      content: data.document?.content || '',
      metadata: data.document?.metadata,
    };
  }

  private async getDocumentHTTP(
    docType: string,
    name: string,
    project?: string
  ): Promise<QwickBrainResponse> {
    if (!this.config.url) {
      throw new Error('HTTP mode requires url to be configured');
    }

    const response = await fetch(`${this.config.url}/mcp/document`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` }),
      },
      body: JSON.stringify({ doc_type: docType, name, project }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const json = await response.json();
    return HTTPResponseSchema.parse(json);
  }

  async getMemory(name: string, project?: string): Promise<QwickBrainResponse> {
    if (this.mode === 'mcp' || this.mode === 'sse') {
      return this.getMemoryMCP(name, project);
    } else {
      return this.getMemoryHTTP(name, project);
    }
  }

  private async getMemoryMCP(
    name: string,
    project?: string
  ): Promise<QwickBrainResponse> {
    if (!this.client) {
      throw new Error('MCP client not connected');
    }

    const result = await this.client.callTool({
      name: 'get_memory',
      arguments: {
        name,
        project,
      },
    });

    // Validate MCP response structure
    const parsed = MCPToolResponseSchema.parse(result);
    const data = QwickBrainDocumentSchema.parse(JSON.parse(parsed.content[0].text));

    return {
      content: data.document?.content || '',
      metadata: data.document?.metadata,
    };
  }

  private async getMemoryHTTP(
    name: string,
    project?: string
  ): Promise<QwickBrainResponse> {
    if (!this.config.url) {
      throw new Error('HTTP mode requires url to be configured');
    }

    const response = await fetch(`${this.config.url}/mcp/memory`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` }),
      },
      body: JSON.stringify({ name, project }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const json = await response.json();
    return HTTPResponseSchema.parse(json);
  }

  async healthCheck(): Promise<boolean> {
    try {
      if (this.mode === 'mcp' || this.mode === 'sse') {
        // For MCP/SSE mode, check if client is connected
        if (!this.client) {
          await this.connect();
        }
        // Try listing tools as health check
        await this.client!.listTools();
        return true;
      } else {
        // For HTTP mode, ping health endpoint
        if (!this.config.url) {
          return false;
        }
        const response = await fetch(`${this.config.url}/health`);
        return response.ok;
      }
    } catch (error) {
      return false;
    }
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    if (this.mode === 'mcp' || this.mode === 'sse') {
      if (!this.client) {
        throw new Error('MCP client not connected');
      }
      const result = await this.client.listTools();
      return result.tools;
    } else {
      // For HTTP mode, fetch tools from API
      if (!this.config.url) {
        throw new Error('HTTP mode requires url to be configured');
      }
      const response = await fetch(`${this.config.url}/mcp/tools`, {
        headers: {
          ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` }),
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const json = await response.json() as { tools: Array<{ name: string; description?: string; inputSchema?: unknown }> };
      return json.tools;
    }
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<unknown> {
    if (this.mode === 'mcp' || this.mode === 'sse') {
      if (!this.client) {
        throw new Error('MCP client not connected');
      }
      const result = await this.client.callTool({
        name,
        arguments: args || {},
      });
      // Return the raw result - let the caller parse it
      return result;
    } else {
      // For HTTP mode, call tool via API
      if (!this.config.url) {
        throw new Error('HTTP mode requires url to be configured');
      }
      const response = await fetch(`${this.config.url}/mcp/tool`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` }),
        },
        body: JSON.stringify({ name, arguments: args || {} }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response.json();
    }
  }

  async disconnect(): Promise<void> {
    if ((this.mode === 'mcp' || this.mode === 'sse') && this.client && this.transport) {
      await this.client.close();
      this.client = null;
      this.transport = null;
    }
  }
}
