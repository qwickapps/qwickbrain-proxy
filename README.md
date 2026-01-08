# QwickBrain MCP Proxy

Local MCP proxy for QwickBrain with caching and resilience features.

## Features

- **Local caching**: SQLite-based cache for workflows, rules, documents, and memories
- **Auto-reconnect**: Automatic reconnection to QwickBrain server with exponential backoff
- **Graceful degradation**: Serves stale cached data when QwickBrain is unavailable
- **Write queue**: Queues write operations when offline, syncs when reconnected
- **Health monitoring**: Continuous health checks and connection state management

## Installation

```bash
npm install -g @qwickapps/qwickbrain-proxy
```

## Configuration

### Initialize

```bash
qwickbrain-proxy init
```

This creates a default configuration at `~/.qwickbrain/config.json` with:
- QwickBrain URL: `http://macmini-devserver.local:3000`
- Connection mode: `sse` (Server-Sent Events)
- Cache directory: `~/.qwickbrain/cache`

### Connection Modes

The proxy supports three connection modes:

1. **SSE (Server-Sent Events)** - Default, for remote QwickBrain servers
2. **MCP (stdio)** - For local MCP server processes
3. **HTTP** - Direct HTTP REST API calls

Configure mode:
```bash
# SSE mode (default)
qwickbrain-proxy config set qwickbrain.mode sse
qwickbrain-proxy config set qwickbrain.url http://macmini-devserver.local:3000

# MCP stdio mode
qwickbrain-proxy config set qwickbrain.mode mcp
qwickbrain-proxy config set qwickbrain.command npx
qwickbrain-proxy config set qwickbrain.args '["@qwickapps/qwickbrain-server"]'

# HTTP mode
qwickbrain-proxy config set qwickbrain.mode http
qwickbrain-proxy config set qwickbrain.url http://qwickbrain.qwickapps.com
```

### View Configuration

```bash
# Show all configuration
qwickbrain-proxy config show

# Get specific value
qwickbrain-proxy config get qwickbrain.url
```

## Usage

### Start the Proxy

```bash
# Start the proxy server (runs in stdio mode for MCP)
qwickbrain-proxy serve
```

The proxy runs in stdio mode, communicating via standard input/output with the MCP client (Claude Code).

### Check Status

```bash
qwickbrain-proxy status
```

Shows current configuration and cache location.

## Claude Code Configuration

Add to your Claude Code MCP configuration:

```json
{
  "mcpServers": {
    "qwickbrain": {
      "command": "qwickbrain-proxy",
      "args": ["serve"]
    }
  }
}
```

## Cache Strategy

| Content Type | Default TTL | Offline | Notes |
|--------------|-------------|---------|-------|
| workflows | 24h (86400s) | ✓ | Global, rarely changes |
| rules | 24h (86400s) | ✓ | Global, rarely changes |
| documents | 6h (21600s) | ✓ | Project-scoped FRDs, designs |
| memories | 1h (3600s) | ✓ | Project context, updated frequently |

Cache is automatically populated on first access and refreshed when TTL expires.

## Development

```bash
# Install dependencies
npm install

# Run in development mode (with watch)
npm run dev

# Run tests
npm test

# Format code
npm run format
```

## Architecture

```
Claude Code (MCP Client)
    ↓ (stdio)
qwickbrain-proxy (MCP Server)
    ├─ Local Cache (SQLite)
    │  ├─ Documents (workflows, rules, FRDs, designs)
    │  ├─ Memories (project context)
    │  └─ Sync Queue (offline writes)
    ├─ Connection Manager
    │  ├─ Health checks
    │  ├─ Auto-reconnect with exponential backoff
    │  └─ Graceful degradation
    └─ QwickBrain Client (multi-mode)
       ├─ SSE (Server-Sent Events) → QwickBrain Server
       ├─ MCP (stdio) → Local QwickBrain Server
       └─ HTTP (REST API) → Cloud QwickBrain Server
```

**Connection Flow:**
1. Claude Code requests document via MCP
2. Proxy checks local cache (SQLite)
3. If cached and fresh, returns immediately
4. If expired or missing, fetches from QwickBrain (if connected)
5. Updates cache and returns data
6. If offline, serves stale cache with metadata indicating age

## License

This project is licensed under the [PolyForm Shield License 1.0.0](LICENSE).

**Summary:**
- Free to use for non-competitive purposes
- Source code available for learning and development
- Cannot be used to compete with QwickApps
- Commercial licensing available for competitive use cases

For questions about licensing, contact legal@qwickapps.com
