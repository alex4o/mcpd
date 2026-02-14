# Suggested Commands

## Setup
```bash
bun install          # install dependencies
```

## Running mcpd
```bash
bun run index.ts              # start mcpd (default, used by Claude Code)
bun run index.ts start        # same as above
bun run index.ts ps           # list running services with PIDs (aliases: list, ls)
bun run index.ts kill [name]  # kill a service or all
bun run index.ts restart [name] # restart a service or all
bun run index.ts stop         # kill everything (mcpd + all services)
```

Use `-c <path>` or `--config <path>` for a custom config file.

## Build
```bash
bun run build        # compile to standalone binary: ./mcpd
# or directly:
bun build --compile index.ts --outfile=mcpd
```

## Testing
```bash
bun test             # run all tests (~57 tests, ~1s)
bun test <file>      # run a single test file, e.g.: bun test tests/config.test.ts
```

## System Utilities
- `git` — version control
- `ls`, `cd`, `grep`, `find` — standard Linux commands
- `uv` / `uvx` — Python package runner (used to spawn Serena and cgc backends)
