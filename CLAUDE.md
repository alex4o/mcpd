# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

mcpd (MCP Service Daemon) is a lightweight MCP service manager written in Bun. It acts as a middleware layer between Claude Code and backend MCP servers, solving cold-start timeouts, manual lifecycle management, and verbose output formatting. Think of it as systemd for MCP servers.

**Single entry point:** Claude Code connects to mcpd via stdio; mcpd multiplexes connections to backend services via SSE or stdio.

## Build & Run Commands

```bash
bun install          # install dependencies
bun run index.ts     # run the project
bun test             # run tests
bun test <file>      # run a single test file
```

## Architecture

**Core components to implement:**

1. **Service Lifecycle Manager** — process startup, readiness gates (HTTP health checks), restart policies, health monitoring
2. **Request/Response Interceptor** — middleware chain that transforms MCP messages between client and backends
3. **Tool Aggregator** — merges tools from multiple backend MCP servers with namespacing to avoid collisions
4. **CLI Interface** — `mcpd start|stop|restart|status|logs [service]`

**Transport model:** stdio on the client-facing side; SSE or stdio to backends.

**Middleware pipeline:** Sync-first for low latency, async supported. Built-in transforms include: `strip-json-keys`, `strip-result-wrapper`, `compact-json`, `to-yaml`, `truncate`, `log`, `inject-context`, `cache`, `rate-limit`. Custom middleware implements `McpMiddleware` interface (TypeScript/JS plugins).

## Configuration

Config file: `mcpd.yml` — searched in `./mcpd.yml` then `~/.config/mcpd/config.yml`. CLI flags override both.

Per-service settings: command, transport type, readiness checks, restart policy. Also defines middleware pipelines and tool filtering/aliasing/namespacing.

## MCP Tools

**Serena** (LSP-based code navigation) is available via `.mcp.json`:
- Starts automatically when Claude Code connects
- Runs on port **8766** (SSE transport, proxied via stdio)
- Lifecycle: `./start-serena.sh` (default), `./start-serena.sh kill`, `./start-serena.sh restart`
- Logs: `.serena.log`, PID: `.serena.pid`

## Design Principles

- **KISS and DRY** — keep all implementations simple, avoid repetition
- Sync-first middleware for performance; only use async when necessary
- Pragmatic, direct problem-solving approach
