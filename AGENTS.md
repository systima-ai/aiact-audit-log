# AGENTS.md

Guide for AI coding agents contributing to `@systima/aiact-audit-log`.

## Project overview

TypeScript library providing structured, tamper-evident audit logging for AI systems, designed to support EU AI Act Article 12 record-keeping obligations. Published to npm as `@systima/aiact-audit-log`.

- **Stack**: TypeScript, Node.js >= 18, vitest, tsup, pnpm
- **Storage**: S3-compatible object storage via `@aws-sdk/client-s3` (peer dependency) or local filesystem via built-in `FileSystemStorage`
- **Optional integration**: Vercel AI SDK (`ai` >=4.0.0, optional peer dependency; middleware handles both V1 and V3 result formats)

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
    retention.ts              # S3 lifecycle policy helpers (driven by S3Storage)
  storage/
    interface.ts              # StorageBackend interface + StorageConfig union
    s3.ts                     # S3 implementation + buildPutObjectInput
    filesystem.ts             # Local filesystem implementation
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
  reader.test.ts, coverage.test.ts,
  keyed-chain.test.ts           # HMAC chaining, downgrade resistance, anchoring
  retention-enforcement.test.ts # Object Lock + lifecycle plumbing and health checks
  helpers/
    recording-storage.ts        # Backend that records write options and capability calls
  storage/
    s3-put-object.test.ts       # Asserts the lock parameters reach PutObject
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

- **Hash chain**: every log entry has `seq`, `prevHash`, `hash`. Genesis entry uses `digest("@systima/aiact-audit-log:genesis:{systemId}")` as seed. Chain cannot be disabled. The digest is SHA-256 unless `integrity.hmacKey` is set, in which case it is HMAC-SHA256 under that key and entries carry `hashAlgorithm: 'hmac-sha256'`. Verification always uses the key the caller supplies, never the entry's own `hashAlgorithm` field, so an attacker cannot strip the field to downgrade a chain to unkeyed. Genesis is seeded under the key too, so a keyed and an unkeyed chain for the same `systemId` share no hashes.
- **Batching**: entries buffered in memory, flushed at `maxSize` or `maxDelayMs`. Chain maintained in-memory, persisted to `_chain/head.json` on each flush.
- **Retention capabilities are optional on the interface**: `StorageBackend` declares `getObjectLockStatus`, `getRetentionPolicyStatus`, and `configureRetentionPolicy` as optional methods. Only `S3Storage` implements them. The logger feature-detects rather than assuming, so `FileSystemStorage` and `MemoryStorage` report the capability as unavailable instead of appearing to provide it. A logger constructed with `objectLock.enabled` against a backend lacking `getObjectLockStatus` throws `ComplianceConfigError`.
- **Object Lock applies to evidence, not operational objects**: `writeOptions()` returns lock parameters for entry files and `_chain/head.json` only. The health probe, schema marker, and config snapshot are written unlocked, so a repeatedly restarted process does not accumulate locked versions of files that carry no evidence.
- **Lifecycle policy is applied on `init()`**, after metadata, via `applyRetentionPolicy()`. Failure is reported through `onError` and does not block logging, because a missing lifecycle rule is a retention problem rather than a reason to stop recording. Configuration is skipped entirely when `retention.autoConfigureLifecycle` is false.
- **Context propagation**: `AsyncLocalStorage` from `node:async_hooks`. `withAuditContext()` sets context; `getAuditContext()` reads it. Middleware auto-generates `decisionId` if no context is active.
- **Storage layout**: `{systemId}/{year}/{month}/{day}/{fileIndex}.jsonl` with date-partitioned prefixes for lifecycle policy and query performance. Works identically across S3 and filesystem backends.
- **Storage backends**: `S3Storage` for production (requires `@aws-sdk/client-s3`), `FileSystemStorage` for local development and CLI inspection, `MemoryStorage` for tests. The `StorageConfig` union type is `S3StorageConfig | FileSystemStorageConfig`.
- **Subpath exports**: `.` (core), `./ai-sdk` (helper), `./ai-sdk/middleware` (automatic capture). The `ai` package is an optional peer dependency.

## Important constraints

- The `ai` package types differ across versions: AI SDK v4 exports `LanguageModelV1` and `LanguageModelV1Middleware`; AI SDK v5/v6 renames these to `LanguageModel` and `LanguageModelMiddleware` (V3 spec). The library's dev dependency is `ai@^4.1.0` for type compatibility, but the middleware extraction functions handle both V1 and V3 result formats at runtime (content arrays, nested usage objects, object finishReason). Import `wrapLanguageModel` from `ai`.
- `process.on('beforeExit', ...)` is used for shutdown hooks (not `process.once`, which causes MaxListenersExceeded warnings with many logger instances in tests).
- UUIDv7 generation within the same millisecond does not guarantee sort order (random lower bits). Tests should only assert ordering across different milliseconds.
- When a second logger instance writes to the same date path, it may overwrite the first logger's file (both start with `currentFileIndex = 0`). The chain head in `_chain/head.json` is the source of truth for continuity.

## Compliance context

This library maps to EU AI Act Article 12 (record-keeping) and Article 19 (log retention). Every schema field has an `@article` annotation. The compliance claims are scoped precisely in COMPLIANCE.md; the library is "necessary infrastructure, not sufficient compliance." Do not make broader compliance claims in code or documentation.

**Never document a protection the code does not request.** Before v0.2.0, `objectLock` and `retention.autoConfigureLifecycle` were both accepted, serialised into `_meta/config.json`, and described in COMPLIANCE.md as active mechanisms, while neither reached a storage call: `PutObjectCommand` carried no lock parameters, and `utils/retention.ts` had no importer. A deployer setting `mode: 'COMPLIANCE'` got exactly the protection of leaving it at the default, which is none. This was reported externally in September 2026 and is the reason for the capability methods, the two extra health checks, and the integrity threat-model tables in both documents.

Two rules follow. First, any configuration option that names a storage-layer or cryptographic guarantee needs a test asserting the parameter reaches the boundary, not merely that the logger stored the setting; `tests/storage/s3-put-object.test.ts` asserts against `buildPutObjectInput` for exactly this reason. Second, when a mechanism's strength depends on deployment, say what it does not cover in the same place you claim what it does. The tables in README.md and COMPLIANCE.md section 4 are the canonical statement, and they must be updated together with any change to the chain or the lock path.
