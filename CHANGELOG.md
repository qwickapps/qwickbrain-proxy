# Changelog

All notable changes to the QwickBrain MCP Proxy will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
