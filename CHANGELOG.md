# Changelog

All notable changes to the QwickBrain MCP Proxy will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] - 2026-01-08

### Fixed

- **Blocking Startup Issue**: Removed blocking connection attempts that prevented server from starting in offline mode
  - Removed `await this.qwickbrainClient.connect()` from startup sequence
  - Server now starts immediately (< 0.5s) regardless of network connectivity
  - Connection manager handles network state transitions gracefully without throwing errors
- **Health Check Blocking**: Changed initial health check to fire-and-forget background task
  - Eliminates 5-second timeout delay during startup
  - MCP server becomes available immediately while connection attempts continue in background

### Changed

- **Event-Driven Architecture**: Startup and network state management now fully event-driven
  - Server startup no longer blocks on network operations
  - Health checks run in background with exponential backoff (1s → 2s → 4s → 8s → 16s → 32s → 60s max)
  - Connection state changes trigger appropriate background actions via events
  - Added `onConnectionRestored()` handler for automatic cache sync when connection is restored
- **Improved Resilience**: Enhanced degraded mode operation
  - Server exposes fallback tools immediately even when offline
  - Background reconnection continues while serving cached data
  - Disconnect errors during shutdown are now gracefully ignored

### Added

- **Background Cache Sync**: Automatic cache population when connection is restored
  - Event-driven preloading of workflows and rules on `'connected'` event
  - Configurable preload items via `cache.preload` array
  - Foundation for sync queue processing (TODO: implementation)

### Technical Details

- **Non-Blocking Startup**: MCP server ready in < 0.5s vs previous 5+ second timeout/crash
- **Event Listeners**: Connection manager emits `stateChange`, `connected`, `disconnected`, `reconnecting` events
- **Graceful Degradation**: Tools available immediately with metadata indicating data source (live/cache/stale)

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
