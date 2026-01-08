import { z } from 'zod';

export const ConfigSchema = z.object({
  qwickbrain: z.object({
    mode: z.enum(['mcp', 'http', 'sse']).default('sse'),
    // For MCP mode (local stdio)
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    // For HTTP mode (cloud/remote) or SSE mode
    url: z.string().url().optional(),
    apiKey: z.string().optional(),
  }).default({}),
  cache: z.object({
    dir: z.string().optional(),
    ttl: z.object({
      workflows: z.number().default(86400), // 24 hours
      rules: z.number().default(86400), // 24 hours
      documents: z.number().default(21600), // 6 hours
      memories: z.number().default(3600), // 1 hour
    }).default({}),
    preload: z.array(z.string()).default(['workflows', 'rules']),
  }).default({}),
  connection: z.object({
    healthCheckInterval: z.number().default(30000), // 30 seconds
    timeout: z.number().default(5000), // 5 seconds
    maxReconnectAttempts: z.number().default(10),
    reconnectBackoff: z.object({
      initial: z.number().default(1000), // 1 second
      max: z.number().default(60000), // 60 seconds
      multiplier: z.number().default(2),
    }).default({}),
  }).default({}),
  sync: z.object({
    interval: z.number().default(300000), // 5 minutes
    batchSize: z.number().default(10),
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export const CacheConfigSchema = z.object({
  ttl: z.number(),
  offline: z.boolean(),
  preload: z.boolean(),
});

export type CacheConfig = z.infer<typeof CacheConfigSchema>;
