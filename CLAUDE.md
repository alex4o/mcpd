# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

mcpd (MCP Service Daemon) is a lightweight MCP service manager written in Bun. It acts as a middleware layer between Claude Code and backend MCP servers, solving cold-start timeouts, manual lifecycle management, and verbose output formatting. Think of it as systemd for MCP servers.

**Single entry point:** Claude Code connects to mcpd via stdio; mcpd multiplexes connections to backend services via SSE or stdio.

## Build & Run Commands

```bash
bun install          # install dependencies
bun run index.ts     # start mcpd (default, used by Claude Code)
bun test             # run all 57 tests
bun test <file>      # run a single test file
```

## CLI Commands

```bash
bun run index.ts              # start mcpd (default mode for .mcp.json)
bun run index.ts start        # same as above
bun run index.ts ps           # list running services with PIDs (aliases: list, ls)
bun run index.ts kill [name]  # kill a service or all
bun run index.ts restart [name] # restart a service or all
bun run index.ts stop         # kill everything (mcpd + all services)
```

Use `-c <path>` or `--config <path>` for a custom config file.

## Architecture

### File Structure

| File | Purpose |
|------|---------|
| `index.ts` | CLI entry point using `parseArgs`, dispatches to commands |
| `config.ts` | YAML config loader (`Bun.YAML.parse`), types, duration parsing, defaults |
| `service-manager.ts` | Process lifecycle: spawn, readiness polling, restart policies, state persistence |
| `sse-client.ts` | Backend MCP client wrapping SDK `Client` + `SSEClientTransport` |
| `aggregator.ts` | Tool merging with smart namespacing and routing |
| `middleware.ts` | Middleware pipeline with built-in transforms |
| `server.ts` | Client-facing stdio MCP server using SDK `Server` + `StdioServerTransport` |

### Key Dependencies

- `@modelcontextprotocol/sdk` — MCP protocol implementation (Client, Server, transports)
- `zod` — schema validation (used by MCP SDK)
- Import paths: `@modelcontextprotocol/sdk/client/index.js`, `@modelcontextprotocol/sdk/server/index.js`, `@modelcontextprotocol/sdk/types.js`

### Transport Model

- **Client-facing:** stdio (via `StdioServerTransport`) — this is what Claude Code connects to
- **Backend SSE:** `SSEClientTransport` connects to backends like Serena
- **Backend stdio:** planned but not yet wired through the aggregator

### Tool Namespacing

- **Single backend:** tools are exposed with no prefix (e.g., `find_symbol`)
- **Multiple backends:** tools get `servicename_` prefix (e.g., `serena_find_symbol`, `db_run_query`)
- Claude Code adds its own `mcp__<servername>__` prefix on top — keep the `.mcp.json` key name short

### Service Reuse (Critical)

Multiple Claude Code sessions share the same backend processes:

1. On start, `ServiceManager.start()` checks if the service is already reachable (via HTTP fetch to readiness URL)
2. If reachable, it skips spawning and just marks the service as ready
3. It also checks `.mcpd-state.json` for saved PIDs and verifies they're alive
4. On exit, services with `keep_alive: true` are NOT killed — they persist for the next session
5. Only services with `keep_alive: false` (or unset) are stopped on mcpd shutdown

### State Files

- `.mcpd.pid` — mcpd's own PID (for `ps`/`kill` commands)
- `.mcpd-state.json` — persisted service state (pid, url, state) for cross-session reuse
- Both are gitignored

### Readiness Checks

- SSE endpoints return `text/event-stream` which keeps connections open
- `isReachable()` uses `AbortController` to abort immediately after getting response headers
- `waitForReady()` polls at the configured interval until timeout

### Middleware Pipeline

Built-in middlewares (configured in `mcpd.yml` per-service):

- `strip-json-keys` — removes quotes from JSON keys (`"name":` → `name:`)
- `strip-result-wrapper` — unwraps `{"result": "..."}` envelopes

Middleware runs synchronously in order via `applyMiddleware()`. Custom middleware implements `McpMiddleware` interface.

## Configuration

Config file: `mcpd.yml` — searched in `./mcpd.yml` then `~/.config/mcpd/config.yml`.

### Key Config Fields

```yaml
services:
  serena:
    command: uv              # spawned directly by Bun.spawn (no shell)
    args: [run, ...]         # tilde (~) won't expand — use absolute paths
    transport: sse           # "sse" or "stdio"
    url: http://localhost:8766/sse
    readiness:
      check: http
      url: http://localhost:8766/sse  # defaults to service url
      timeout: 60s           # duration strings: "500ms", "30s", "2m"
      interval: 500ms
    restart: on-failure      # "on-failure" | "always" | "never"
    keep_alive: true         # don't kill on mcpd exit (for shared backends)
    middleware:
      response: [strip-json-keys]
```

### Important: No Shell Expansion

`Bun.spawn` doesn't go through a shell, so:
- `~` does NOT expand — use full paths like `/home/user/...`
- Environment variables in args don't expand
- Pipes/redirects don't work in command/args

## MCP Tools

**Serena** (LSP-based code navigation) is managed directly by mcpd:
- Spawned as `uv run --directory /path/to/serena serena start-mcp-server ...`
- Runs on port **8766** (SSE transport)
- `keep_alive: true` — persists across mcpd restarts and multiple Claude Code sessions

## Tests

```
tests/
  config.test.ts           # Config loading, defaults, duration parsing
  service-manager.test.ts  # Start/stop/restart lifecycle, readiness, timeout
  middleware.test.ts        # strip-json-keys, strip-result-wrapper, pipeline
  aggregator.test.ts       # Tool namespacing (single/multi), routing
  integration.test.ts      # End-to-end stdio MCP client ↔ server
  mcp-config.test.ts       # .mcp.json validation
  sanity.test.ts           # Basic sanity checks
  fixtures/
    test-server.ts         # Tiny HTTP server for readiness tests
    test-mcp-server.ts     # Tiny MCP server (stdio) for integration tests
```

Test fixtures use random/dynamic ports. Tests run in ~1s.

## Design Principles

- **KISS and DRY** — keep all implementations simple, avoid repetition
- Sync-first middleware for performance; only use async when necessary
- Pragmatic, direct problem-solving approach
- No wrapper scripts — mcpd owns processes directly
- Reuse running backends instead of spawning duplicates

Bun docs: https://bun.com/docs/llms.txt