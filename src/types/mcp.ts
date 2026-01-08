import { z } from 'zod';

// Base MCP request schema
export const MCPRequestSchema = z.object({
  operation: z.string(),
  arguments: z.record(z.unknown()).optional(),
});

export type MCPRequest = z.infer<typeof MCPRequestSchema>;

// Document operations
export const GetWorkflowArgsSchema = z.object({
  name: z.string(),
});

export const GetDocumentArgsSchema = z.object({
  name: z.string(),
  doc_type: z.string(),
  project: z.string().optional(),
});

export const CreateDocumentArgsSchema = z.object({
  doc_type: z.string(),
  name: z.string(),
  content: z.string(),
  project: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const UpdateDocumentArgsSchema = z.object({
  doc_type: z.string(),
  name: z.string(),
  project: z.string().optional(),
  content: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const ListDocumentsArgsSchema = z.object({
  doc_type: z.string().optional(),
  project: z.string().optional(),
  limit: z.number().default(100),
});

export const SearchDocumentsArgsSchema = z.object({
  query: z.string(),
  doc_type: z.string().optional(),
  project: z.string().optional(),
  limit: z.number().default(10),
  min_score: z.number().default(0.3),
});

// Memory operations
export const GetMemoryArgsSchema = z.object({
  name: z.string(),
  project: z.string().optional(),
});

export const SetMemoryArgsSchema = z.object({
  name: z.string(),
  content: z.string(),
  project: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// MCP Response with metadata
export const MCPResponseMetadataSchema = z.object({
  source: z.enum(['live', 'cache', 'stale_cache']),
  age_seconds: z.number().optional(),
  status: z.enum(['connected', 'disconnected', 'reconnecting', 'offline']),
  warning: z.string().optional(),
  cached_at: z.string().optional(),
  latency_ms: z.number().optional(),
});

export type MCPResponseMetadata = z.infer<typeof MCPResponseMetadataSchema>;

export const MCPResponseSchema = z.object({
  data: z.unknown().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    suggestions: z.array(z.string()).optional(),
  }).optional(),
  _metadata: MCPResponseMetadataSchema,
});

export type MCPResponse = z.infer<typeof MCPResponseSchema>;

// Connection states
export const ConnectionState = z.enum([
  'connected',
  'disconnected',
  'reconnecting',
  'offline',
]);

export type ConnectionState = z.infer<typeof ConnectionState>;
