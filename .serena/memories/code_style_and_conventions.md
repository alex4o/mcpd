# Code Style and Conventions

## Language & Config
- TypeScript with `strict: true`, ESNext target, bundler module resolution
- `verbatimModuleSyntax: true` — use `import type` for type-only imports
- `noUncheckedIndexedAccess: true` — indexed access returns `T | undefined`
- No unused locals/params enforcement (disabled in tsconfig)

## Naming Conventions
- **Files:** kebab-case (`service-manager.ts`, `sse-client.ts`)
- **Functions/methods:** camelCase (`parseDuration`, `waitForReady`, `loadConfig`)
- **Interfaces:** PascalCase (`ServiceConfig`, `McpdConfig`, `NamespacedTool`)
- **Classes:** PascalCase (`ServiceManager`, `ToolAggregator`, `BackendClient`)
- **Constants:** UPPER_SNAKE_CASE (`STATE_FILE`, `PID_FILE`, `SERVICE_DEFAULTS`)
- **Config keys (YAML):** snake_case (`keep_alive`, `on-failure`)

## Import Style
- Use `.ts` extensions for local imports: `import { loadConfig } from "./config.ts"`
- Use `.js` extensions for SDK imports: `import { Client } from "@modelcontextprotocol/sdk/client/index.js"`
- Use `import type` for type-only imports

## Testing
- Test framework: `bun:test` (describe/test/expect/beforeEach/afterEach)
- Test files: `tests/<module>.test.ts`
- Fixtures in `tests/fixtures/` (test-server.ts, test-mcp-server.ts)
- Tests use random/dynamic ports

## Design Principles
- **KISS and DRY** — simple implementations, avoid repetition
- Sync-first middleware for performance; only async when necessary
- No wrapper scripts — mcpd owns processes directly
- Reuse running backends instead of spawning duplicates
- No shell expansion in commands (Bun.spawn is not a shell)
- Pragmatic, direct problem-solving approach

## Documentation
- Brief JSDoc comments for exported functions (e.g., `/** Find the git repository root */`)
- No excessive commenting — only where logic isn't self-evident
- CLAUDE.md is the main project documentation
