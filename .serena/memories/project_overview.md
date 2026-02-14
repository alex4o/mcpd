# Project Overview

## Purpose
**mcpd** (MCP Service Daemon) is a lightweight MCP service manager written in Bun/TypeScript. It acts as a middleware layer between Claude Code and backend MCP servers, solving cold-start timeouts, manual lifecycle management, and verbose output formatting. Think of it as "systemd for MCP servers."

## Tech Stack
- **Runtime:** Bun (latest)
- **Language:** TypeScript (strict mode, ESNext target)
- **Key Dependencies:**
  - `@modelcontextprotocol/sdk` (^1.26.0) — MCP protocol (Client, Server, transports)
  - `zod` (^4.3.6) — schema validation (used by MCP SDK)
- **Build:** `bun build --compile index.ts --outfile=mcpd`
- **Config format:** YAML (`mcpd.yml`), parsed via `Bun.YAML.parse`

## Architecture (flat, all files in root)
| File | Purpose |
|------|---------|
| `index.ts` | CLI entry point (parseArgs), dispatches to commands (start/ps/kill/restart/stop) |
| `config.ts` | YAML config loader, types, duration parsing, defaults, variable substitution |
| `service-manager.ts` | Process lifecycle: spawn, readiness polling, restart policies, state persistence |
| `sse-client.ts` | Backend MCP client (BackendClient class) wrapping SDK Client + SSE/stdio transports |
| `aggregator.ts` | Tool merging (ToolAggregator class) with smart namespacing and routing |
| `middleware.ts` | Middleware pipeline with built-in transforms (strip-json-keys, strip-result-wrapper) |
| `server.ts` | Client-facing stdio MCP server using SDK Server + StdioServerTransport |

## Transport Model
- **Client-facing:** stdio (StdioServerTransport) — Claude Code connects here
- **Backend SSE:** SSEClientTransport connects to backends like Serena
- **Backend stdio:** supported for services like cgc

## Service Reuse (Critical)
Multiple Claude Code sessions share the same backend processes via PID tracking (`.mcpd-state.json`) and readiness checks. Services with `keep_alive: true` persist across mcpd restarts.

## State Files (gitignored)
- `.mcpd.pid` — mcpd's own PID
- `.mcpd-state.json` — persisted service state (pid, url, state)
