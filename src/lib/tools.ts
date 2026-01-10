/**
 * Static tool definitions for QwickBrain MCP Proxy
 *
 * These tools are always exposed regardless of connection state.
 * Non-cacheable tools return offline errors when QwickBrain is unavailable.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const QWICKBRAIN_TOOLS: ToolDefinition[] = [
  // Code Analysis Tools
  {
    name: 'analyze_repository',
    description: 'Analyze a repository and extract architecture-level information. Returns modules, files, languages, and import relationships. Use this for initial exploration of a codebase.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the repository root',
        },
        language: {
          type: 'string',
          description: 'Optional: filter by language (python, javascript, typescript, java, go)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'analyze_file',
    description: 'Analyze a single source file and extract its structure. Returns functions, classes, methods, interfaces, and type aliases. Use this to understand the contents of a specific file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the source file',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'find_functions',
    description: 'Find all functions in a file or repository matching a pattern. Returns function names, signatures, and locations.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to a file or repository',
        },
        pattern: {
          type: 'string',
          description: 'Optional: pattern to match function names (case-insensitive substring)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'find_classes',
    description: 'Find all classes in a file or repository matching a pattern. Returns class names, bases, and locations.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to a file or repository',
        },
        pattern: {
          type: 'string',
          description: 'Optional: pattern to match class names (case-insensitive substring)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_imports',
    description: 'Get all imports from a file or repository. Shows what modules and packages are imported and from where.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to a file or repository',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_codebase',
    description: 'Semantic search across the indexed codebase. Uses natural language to find relevant functions, classes, and methods. Requires the codebase to be indexed first. Returns ranked results with similarity scores.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query. Examples: "function to parse JSON", "class that handles authentication", "async method for file upload"',
        },
        limit: {
          type: 'integer',
          description: 'Maximum results to return (default: 10, max: 20)',
          default: 10,
        },
        min_score: {
          type: 'number',
          description: 'Minimum similarity score threshold (default: 0.5)',
          default: 0.5,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'explain_function',
    description: 'Get detailed explanation of a function or method. Analyzes implementation and provides insights.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file containing the function',
        },
        function_name: {
          type: 'string',
          description: 'Name of the function to explain',
        },
      },
      required: ['path', 'function_name'],
    },
  },

  // Repository Management Tools
  {
    name: 'add_repository',
    description: 'Add a repository to the index for semantic search.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the repository root',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_repositories',
    description: 'List all indexed repositories.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'remove_repository',
    description: 'Remove a repository from the index.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the repository to remove',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'update_repository',
    description: 'Update the index for a repository (re-index).',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the repository to update',
        },
      },
      required: ['path'],
    },
  },

  // Document Management Tools (Cacheable)
  {
    name: 'create_document',
    description: 'Create a new document.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Document name',
        },
        doc_type: {
          type: 'string',
          description: 'Document type',
          enum: ['adr', 'spike', 'frd', 'design', 'review', 'memory', 'workflow', 'rule'],
        },
        content: {
          type: 'string',
          description: 'Document content (markdown)',
        },
        project: {
          type: 'string',
          description: 'Optional: Project scope',
        },
        metadata: {
          type: 'object',
          description: 'Optional: Additional metadata',
        },
      },
      required: ['name', 'doc_type', 'content'],
    },
  },
  {
    name: 'get_document',
    description: 'Get a document by name, type, and optional project. Returns the full document content and metadata. CACHEABLE - works offline with cached data.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Document name',
        },
        doc_type: {
          type: 'string',
          description: 'Document type',
          enum: ['adr', 'spike', 'frd', 'design', 'review', 'memory', 'workflow', 'rule'],
        },
        project: {
          type: 'string',
          description: 'Optional: Project scope (omit for global documents)',
        },
      },
      required: ['name', 'doc_type'],
    },
  },
  {
    name: 'list_documents',
    description: 'List documents with optional filters. Can filter by type and/or project.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_type: {
          type: 'string',
          description: 'Optional: Filter by document type',
        },
        project: {
          type: 'string',
          description: 'Optional: Filter by project',
        },
      },
    },
  },
  {
    name: 'update_document',
    description: 'Update an existing document.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Document name',
        },
        doc_type: {
          type: 'string',
          description: 'Document type',
        },
        content: {
          type: 'string',
          description: 'New document content',
        },
        project: {
          type: 'string',
          description: 'Optional: Project scope',
        },
        metadata: {
          type: 'object',
          description: 'Optional: Updated metadata',
        },
      },
      required: ['name', 'doc_type', 'content'],
    },
  },
  {
    name: 'delete_document',
    description: 'Delete a document.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Document name',
        },
        doc_type: {
          type: 'string',
          description: 'Document type',
        },
        project: {
          type: 'string',
          description: 'Optional: Project scope',
        },
      },
      required: ['name', 'doc_type'],
    },
  },
  {
    name: 'search_documents',
    description: 'Search documents by content or metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
        doc_type: {
          type: 'string',
          description: 'Optional: Filter by document type',
        },
        project: {
          type: 'string',
          description: 'Optional: Filter by project',
        },
      },
      required: ['query'],
    },
  },

  // Workflow Tools (Cacheable)
  {
    name: 'get_workflow',
    description: 'Get a workflow definition by name. CACHEABLE - works offline with cached data.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Workflow name',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_workflows',
    description: 'List all available workflows.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'create_workflow',
    description: 'Create a new workflow definition.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Workflow name',
        },
        content: {
          type: 'string',
          description: 'Workflow content (markdown)',
        },
        metadata: {
          type: 'object',
          description: 'Optional: Workflow metadata',
        },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'update_workflow',
    description: 'Update an existing workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Workflow name',
        },
        content: {
          type: 'string',
          description: 'Updated workflow content',
        },
        metadata: {
          type: 'object',
          description: 'Optional: Updated metadata',
        },
      },
      required: ['name', 'content'],
    },
  },

  // Memory Tools (Cacheable)
  {
    name: 'get_memory',
    description: 'Get a memory/context document by name. CACHEABLE - works offline with cached data.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Memory name',
        },
        project: {
          type: 'string',
          description: 'Optional: Project scope',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'set_memory',
    description: 'Set or update a memory/context document.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Memory name',
        },
        content: {
          type: 'string',
          description: 'Memory content',
        },
        project: {
          type: 'string',
          description: 'Optional: Project scope',
        },
        metadata: {
          type: 'object',
          description: 'Optional: Memory metadata',
        },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'list_memories',
    description: 'List all memories with optional project filter.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Optional: Filter by project',
        },
      },
    },
  },
  {
    name: 'search_memories',
    description: 'Search memories by content.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
        project: {
          type: 'string',
          description: 'Optional: Filter by project',
        },
      },
      required: ['query'],
    },
  },
];

/**
 * Tools that are cacheable and work offline
 */
export const CACHEABLE_TOOLS = new Set([
  'get_workflow',
  'get_document',
  'get_memory',
]);

/**
 * Tools that require active connection
 */
export function requiresConnection(toolName: string): boolean {
  return !CACHEABLE_TOOLS.has(toolName);
}
