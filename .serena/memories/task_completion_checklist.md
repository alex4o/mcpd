# Task Completion Checklist

When a coding task is completed, perform the following steps:

1. **Run tests:** `bun test` — all tests should pass
2. **Verify no regressions:** If changes affect specific modules, also run targeted tests:
   - `bun test tests/config.test.ts`
   - `bun test tests/service-manager.test.ts`
   - `bun test tests/middleware.test.ts`
   - `bun test tests/aggregator.test.ts`
   - `bun test tests/integration.test.ts`
   - `bun test tests/stdio-backend.test.ts`
3. **Type checking:** TypeScript strict mode is enforced by tsconfig. The project uses `noEmit: true` so there's no separate type-check command — type errors surface at test/run time via Bun.
4. **No linter/formatter configured:** The project doesn't use ESLint or Prettier. Follow existing code style manually.
5. **Build check (if relevant):** `bun run build` to verify the standalone binary compiles.
