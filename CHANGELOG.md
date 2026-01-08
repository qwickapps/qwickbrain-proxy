# Changelog

All notable changes to the QwickBrain MCP Proxy will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2025-01-08

### Fixed

- **Database Migration Path**: Fixed relative path issue in drizzle migrations causing initialization failures when installed globally
  - Updated `runMigrations()` to use absolute path resolution with `fileURLToPath` and `dirname`
  - Migrations now correctly locate `drizzle/` directory relative to package installation
- **Server Configuration**: Corrected default QwickBrain server URL
  - Changed hostname from `macmini-devserver.local` to `macmini-devserver`
  - Added `/sse` endpoint path for SSE transport mode
  - Updated CLI init command and documentation

### Added

- **Dynamic Tool Forwarding**: Proxy now transparently forwards ALL tools from upstream QwickBrain server
  - Added `listTools()` method to dynamically fetch available tools from upstream
  - Added `callTool()` method for generic tool forwarding
  - Tools like `analyze_repository`, `search_codebase`, `list_documents`, etc. now available through proxy
- **Enhanced Tool Support**: Beyond cached document tools, now supports all QwickBrain tools including:
  - Code analysis tools (analyze_repository, analyze_file, find_functions, find_classes, get_imports, explain_function)
  - Semantic search tools (search_codebase, search_documents, search_memories)
  - Document management tools (create_document, update_document, delete_document, list_documents)
  - Repository management tools (add_repository, list_repositories, remove_repository, update_repository)

### Changed

- Tool listing now dynamically fetched from upstream server instead of hardcoded
- Fallback to minimal cached tool set when upstream unavailable
- Non-document tools forwarded directly without caching (real-time results)

## [1.0.0] - 2025-01-08

### Added

- **MCP Proxy Server**: Local MCP proxy server for QwickBrain with stdio communication
- **SQLite Cache**: Local caching for workflows, rules, documents, and memories with configurable TTL
- **Multi-Transport Support**: Three connection modes - SSE (Server-Sent Events), MCP (stdio), and HTTP (REST API)
- **Auto-Reconnect**: Automatic reconnection to QwickBrain server with exponential backoff
- **Graceful Degradation**: Serves stale cached data when QwickBrain server is unavailable
- **Write Queue**: Queues write operations when offline, syncs when reconnected
- **Health Monitoring**: Continuous health checks and connection state management
- **CLI Commands**:
  - `init` - Initialize configuration
  - `serve` - Start the proxy server
  - `status` - Check current configuration and cache
  - `config show/get/set` - Configuration management
- **Cache Strategy**: Intelligent caching with different TTL for different content types:
  - Workflows: 24h (global, rarely changes)
  - Rules: 24h (global, rarely changes)
  - Documents: 6h (project-scoped FRDs, designs)
  - Memories: 1h (project context, updated frequently)
- **Configuration Management**: JSON-based configuration at `~/.qwickbrain/config.json`
- **Database Migrations**: Drizzle ORM-based schema migrations

### Changed

- **License**: Updated from MIT to PolyForm Shield 1.0.0
- **Package Location**: Moved to `packages/qwickbrain-proxy` for public publishing

### Technical Details

- TypeScript implementation with full type safety
- MCP SDK integration for Model Context Protocol compliance
- Better-SQLite3 for high-performance local caching
- Commander.js for CLI interface
- Drizzle ORM for database schema management
- Zod for configuration validation
- Comprehensive test suite with Vitest

[1.0.0]: https://github.com/qwickapps/qwickbrain-proxy/releases/tag/v1.0.0
