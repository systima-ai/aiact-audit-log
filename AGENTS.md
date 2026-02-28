# AGENTS.md

Guide for AI coding agents contributing to `@systima/aiact-audit-log`.

## Project overview

TypeScript library providing structured, tamper-evident audit logging for AI systems, designed to satisfy EU AI Act Article 12 record-keeping obligations. Published to npm as `@systima/aiact-audit-log`.

- **Stack**: TypeScript, Node.js >= 18, vitest, tsup, pnpm
- **Storage**: S3-compatible object storage via `@aws-sdk/client-s3` (peer dependency)
- **Optional integration**: Vercel AI SDK (`ai` ^4.x, optional peer dependency)

## Setup commands

```bash
pnpm install          # Install dependencies
pnpm build            # Build ESM + CJS + DTS via tsup
pnpm test             # Run all tests (vitest)
pnpm test:watch       # Run tests in watch mode
pnpm lint             # Type-check with tsc --noEmit
```

## Directory structure

```
src/
  index.ts                    # Main barrel export
  schema.ts                   # Types + runtime validation
  hash-chain.ts               # SHA-256 chain logic
  context.ts                  # AsyncLocalStorage context propagation
  errors.ts                   # Custom error types
  logger.ts                   # AuditLogger class
  reader.ts                   # AuditLogReader class
  coverage.ts                 # Coverage diagnostic
  utils/
    serialise.ts              # Deterministic JSON stringify
    uuid.ts                   # UUIDv7 generation
    retention.ts              # S3 lifecycle policy management
  storage/
    interface.ts              # StorageBackend interface
    s3.ts                     # S3 implementation
    memory.ts                 # In-memory backend (testing only)
  ai-sdk/
    index.ts                  # logFromAISDKResult helper
    middleware/
      index.ts                # auditMiddleware (wrapLanguageModel)
  cli/
    index.ts                  # CLI entry point (citty)
    shared.ts                 # Shared CLI utilities
    query.ts, reconstruct.ts, verify.ts, stats.ts,
    coverage.ts, health.ts, export.ts

tests/
  serialise.test.ts, uuid.test.ts, schema.test.ts,
  hash-chain.test.ts, context.test.ts, logger.test.ts,
  reader.test.ts, coverage.test.ts
  ai-sdk/
    helper.test.ts, middleware.test.ts
  cli/
    verify.test.ts, reconstruct.test.ts, coverage.test.ts
```

## Code style

- **TypeScript strict mode**: all exports and public APIs must have explicit return types.
- **Never use `any`, `unknown`, or aggressive type-casting** (e.g. `as SomeType` to silence the compiler). If a value's type is genuinely unknowable, use a discriminated union, a generic constraint, or a type guard to narrow it. The only acceptable cast pattern is `Extract<Union, { discriminant: 'value' }>` for discriminated unions.
- **No comments inside code**: the code should be self-documenting through clear naming. JSDoc on exported interfaces/functions is acceptable for describing Article references.
- **British English** in all prose, documentation, and code comments (e.g. "serialise" not "serialize", "colour" not "color"). Variable names may use American English where the framework expects it.
- **Naming**: descriptive, full words. Functions as verbs, variables as nouns. Files in kebab-case, types/classes in PascalCase, utilities in camelCase.
- **No `console.log`/`console.error`**: use `process.stderr.write` for error output, `process.stdout.write` for CLI output.
- **Imports**: use `.js` extensions in relative imports (ESM convention).

## Testing conventions

- Test framework: vitest with `globals: true`
- All tests use `MemoryStorage` (from `src/storage/memory.ts`) instead of mocking S3
- Test setup pattern: `createTestSetup()` function returning `{ logger, reader, storage }`
- Use `AuditLogger.createWithStorage()` and `AuditLogReader.createWithStorage()` to inject the memory backend
- Always call `await logger.close()` in `afterEach`
- Always call `await logger.flush()` before reading back entries through the reader
- Test file location mirrors source: `src/foo.ts` tested in `tests/foo.test.ts`

## Build system

- **tsup** with 4 entry points: main index, ai-sdk helper, ai-sdk middleware, CLI
- Main/ai-sdk: ESM + CJS + DTS
- CLI: ESM only with `#!/usr/bin/env node` banner
- External dependencies: `@aws-sdk/client-s3`, `ai`
- Output directory: `dist/`

## Architecture notes

- **Hash chain**: every log entry has `seq`, `prevHash`, `hash`. Genesis entry uses `SHA-256("@systima/aiact-audit-log:genesis:{systemId}")` as seed. Chain cannot be disabled.
- **Batching**: entries buffered in memory, flushed at `maxSize` or `maxDelayMs`. Chain maintained in-memory, persisted to `_chain/head.json` on each flush.
- **Context propagation**: `AsyncLocalStorage` from `node:async_hooks`. `withAuditContext()` sets context; `getAuditContext()` reads it. Middleware auto-generates `decisionId` if no context is active.
- **Storage layout**: `{systemId}/{year}/{month}/{day}/{fileIndex}.jsonl` with date-partitioned prefixes for lifecycle policy and query performance.
- **Subpath exports**: `.` (core), `./ai-sdk` (helper), `./ai-sdk/middleware` (automatic capture). The `ai` package is an optional peer dependency.

## Important constraints

- The `ai` package uses `LanguageModelV1` types with `LanguageModelV1Middleware` interface. Import `wrapLanguageModel` from `ai`.
- `process.on('beforeExit', ...)` is used for shutdown hooks (not `process.once`, which causes MaxListenersExceeded warnings with many logger instances in tests).
- UUIDv7 generation within the same millisecond does not guarantee sort order (random lower bits). Tests should only assert ordering across different milliseconds.
- When a second logger instance writes to the same date path, it may overwrite the first logger's file (both start with `currentFileIndex = 0`). The chain head in `_chain/head.json` is the source of truth for continuity.

## Compliance context

This library maps to EU AI Act Article 12 (record-keeping) and Article 19 (log retention). Every schema field has an `@article` annotation. The compliance claims are scoped precisely in COMPLIANCE.md; the library is "necessary infrastructure, not sufficient compliance." Do not make broader compliance claims in code or documentation.
