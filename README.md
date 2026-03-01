# @systima/aiact-audit-log

Structured, tamper-evident audit logging for AI systems. Technical logging capability for EU AI Act Article 12 compliance.

- **Schema mapped to Article 12**: every field is annotated with the Article 12 paragraph it relates to
- **SHA-256 hash chains**: tamper-evident log integrity that a regulator can independently verify
- **Flexible storage**: S3-compatible or local filesystem; logs stay in your infrastructure
- **AI SDK middleware**: automatic capture for every LLM call via [Vercel AI SDK](https://sdk.vercel.ai)
- **AsyncLocalStorage context**: correlate multi-step decisions without manual threading
- **CLI tooling**: query, reconstruct, verify, coverage diagnostics, and compliance export
- **Retention enforcement**: configurable minimum retention with Article 19(1) floor (180 days)

```
npm install @systima/aiact-audit-log
```

> **Important**: this package provides the **technical logging capability** required by Article 12. It is necessary infrastructure for compliance, not sufficient compliance in itself. See [From Logging to Compliance](#from-logging-to-compliance) and [COMPLIANCE.md](./COMPLIANCE.md).

## Quick Start

```typescript
import { AuditLogger } from '@systima/aiact-audit-log'

// S3 storage (production)
const logger = new AuditLogger({
  systemId: 'loan-scorer-v2',
  storage: {
    type: 's3',
    bucket: 'my-audit-logs',
    region: 'eu-west-1',
  },
})

// Or local filesystem (development / testing)
const devLogger = new AuditLogger({
  systemId: 'loan-scorer-v2',
  storage: {
    type: 'filesystem',
    directory: './audit-logs',
  },
})

await logger.log({
  decisionId: 'dec_abc123',
  eventType: 'inference',
  modelId: 'anthropic/claude-sonnet-4-5-20250929',
  providerId: 'anthropic',
  input: { value: 'Assess credit risk for application #12345' },
  output: { value: 'Risk score: 0.72, recommendation: approve with conditions' },
  latencyMs: 342,
  usage: { promptTokens: 150, completionTokens: 80, totalTokens: 230 },
  parameters: { temperature: 0.7 },
  error: null,
})

// Flush on shutdown
await logger.close()
```

### Automatic Capture with AI SDK Middleware

```typescript
import { auditMiddleware } from '@systima/aiact-audit-log/ai-sdk/middleware'
import { anthropic } from '@ai-sdk/anthropic'
import { generateText, streamText } from 'ai'

const model = auditMiddleware(anthropic('claude-sonnet-4-5-20250929'), {
  logger,
})

// Every call through the wrapped model is automatically logged
const result = await generateText({
  model,
  prompt: 'Assess the credit risk for application #12345',
})

// Streaming works too; the log entry is written when the stream completes
const stream = streamText({
  model,
  prompt: 'Explain the assessment criteria',
})

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk)
}
```

### Context Propagation

```typescript
import { withAuditContext } from '@systima/aiact-audit-log'

await withAuditContext(
  { decisionId: 'dec_loan_12345', metadata: { endpoint: '/api/score' } },
  async () => {
    // All middleware-captured and manual log calls inherit the context
    const result = await generateText({ model, prompt: 'Score this application' })

    await logger.log({
      eventType: 'human_intervention',
      modelId: null,
      providerId: null,
      input: { value: '' },
      output: { value: 'Approved with modified terms' },
      latencyMs: null,
      usage: null,
      parameters: null,
      error: null,
      humanIntervention: {
        type: 'modification',
        userId: 'reviewer_hash_a1b2c3',
        reason: 'Additional documentation provided',
        timestamp: new Date().toISOString(),
      },
    })
  }
)
```

## API Reference

### `AuditLogger`

The core class for structured, tamper-evident audit logging.

```typescript
const logger = new AuditLogger({
  // Required
  systemId: 'loan-scorer-v2',

  // Option A: S3 storage (production)
  storage: {
    type: 's3',
    bucket: 'my-audit-logs',
    region: 'eu-west-1',
    prefix: 'aiact-logs',           // Default: 'aiact-logs'
  },

  // Option B: Local filesystem (development)
  // storage: {
  //   type: 'filesystem',
  //   directory: './audit-logs',
  // },

  // Compliance settings (safe defaults)
  retention: {
    minimumDays: 180,               // Default: 180 (Article 19 floor)
    autoConfigureLifecycle: true,    // Default: true
  },

  // Privacy / GDPR
  pii: {
    hashInputs: false,              // Store SHA-256 hashes instead of raw inputs
    hashOutputs: false,             // Store SHA-256 hashes instead of raw outputs
    redactPatterns: [],             // Regex patterns to redact before logging
  },

  // Performance
  batching: {
    maxSize: 100,                   // Flush after N entries
    maxDelayMs: 5000,               // Flush after N milliseconds
  },

  // Error handling
  onError: 'log-and-continue',     // 'log-and-continue' | 'throw' | (error) => void

  // Immutability
  objectLock: {
    enabled: false,                 // Set true if bucket has Object Lock
    mode: 'GOVERNANCE',             // 'GOVERNANCE' | 'COMPLIANCE'
  },

  // Periodic health checks
  healthCheck: {
    enabled: false,                 // Set true to enable
    intervalMs: 3_600_000,          // Default: 1 hour
    onDrift: 'warn',               // 'warn' | 'throw' | (drift) => void
  },
})
```

#### `logger.log(input)`

Log a single event. Returns the complete `AuditLogEntryExtended` with hash chain fields.

If no `decisionId` is provided and no `withAuditContext` scope is active, throws `MissingDecisionIdError`.

#### `logger.flush()`

Force flush all buffered entries to storage.

#### `logger.close()`

Flush remaining entries and release all resources. Call on shutdown.

#### `logger.healthCheck()`

Run a health check against the storage backend. Returns `HealthCheckResult` with individual check statuses.

### `AuditLogReader`

Query, reconstruct, verify, and analyse audit logs.

```typescript
import { AuditLogReader } from '@systima/aiact-audit-log'

// S3
const reader = new AuditLogReader({
  storage: { type: 's3', bucket: 'my-audit-logs', region: 'eu-west-1' },
  systemId: 'loan-scorer-v2',
})

// Or local filesystem
const devReader = new AuditLogReader({
  storage: { type: 'filesystem', directory: './audit-logs' },
  systemId: 'loan-scorer-v2',
})
```

#### `reader.query(options?)`

Search logs by time range, event type, decision ID, with optional limit.

```typescript
const entries = await reader.query({
  from: '2026-03-01T00:00:00Z',
  to: '2026-03-15T23:59:59Z',
  eventType: 'inference',
  limit: 1000,
})
```

#### `reader.reconstruct(decisionId)`

Reconstruct a complete decision trace from a single identifier. Returns all entries, a human-readable timeline, and integrity verification.

```typescript
const trace = await reader.reconstruct('dec_abc123')
// { decisionId, entries, timeline, integrity: { valid, entriesChecked } }
```

#### `reader.verifyChain(options?)`

Validate hash chain integrity across all entries or a time range.

```typescript
const result = await reader.verifyChain({
  from: '2026-03-01T00:00:00Z',
  to: '2026-03-31T23:59:59Z',
})
// { valid: boolean, entriesChecked: number, firstBreak: { seq, expectedPrevHash, actualPrevHash } | null }
```

#### `reader.stats(options?)`

Aggregate metrics that can feed into post-market monitoring (Article 72).

```typescript
const stats = await reader.stats({ from: '2026-03-01T00:00:00Z', to: '2026-03-31T23:59:59Z' })
// { totalEntries, byEventType, byModel, errorRate, avgLatencyMs, p95LatencyMs, p99LatencyMs, tokenUsage }
```

### `withAuditContext(context, callback)`

Propagate decision IDs and metadata through async call chains using `AsyncLocalStorage`.

```typescript
await withAuditContext(
  { decisionId: 'dec_abc123', metadata: { endpoint: '/api/score' } },
  async () => {
    // All logger.log() and middleware calls inherit context
  }
)
```

### `getAuditContext()`

Read the current context (returns `undefined` if no context is active).

### `analyseCoverage(entries, options?)`

Analyse logs for completeness gaps. Returns event type distribution, capture method distribution, warnings, and recommendations.

```typescript
import { analyseCoverage } from '@systima/aiact-audit-log'

const report = analyseCoverage(entries, { from: '2026-03-01', to: '2026-03-31' })
```

### AI SDK Helper

Post-call helper for manual logging of AI SDK results (alternative to middleware):

```typescript
import { logFromAISDKResult } from '@systima/aiact-audit-log/ai-sdk'

const result = await generateText({ model: anthropic('claude-sonnet-4-5-20250929'), prompt })
await logFromAISDKResult(logger, { decisionId: 'dec_123', prompt, result })
```

### AI SDK Middleware

Automatic capture middleware:

```typescript
import { auditMiddleware } from '@systima/aiact-audit-log/ai-sdk/middleware'

const model = auditMiddleware(anthropic('claude-sonnet-4-5-20250929'), {
  logger,
  captureInputs: true,       // Default: true
  captureOutputs: true,       // Default: true
  captureToolCalls: true,     // Default: true
  captureParameters: true,    // Default: true
})
```

**What the middleware logs automatically**: every `generateText`, `streamText`, and `generateObject` call (including errors and tool calls).

**What requires manual `logger.log()`**: `human_intervention`, `session_start`, `session_end`, `system_event`, `tool_result` from external execution, and custom business logic events.

## CLI

```bash
npx @systima/aiact-audit-log <command> [options]
```

All commands accept storage flags for either local filesystem or S3:

- **Local filesystem**: `--dir` (or `AIACT_LOCAL_DIR` env var)
- **S3**: `--bucket`, `--region`, `--prefix`, `--endpoint` (or `AIACT_S3_BUCKET`, `AIACT_S3_REGION`, `AIACT_S3_PREFIX`, `AIACT_S3_ENDPOINT` env vars)

All commands also accept `--system-id` (or `AIACT_SYSTEM_ID`).

### Commands

```bash
# Query logs (local filesystem)
npx @systima/aiact-audit-log query \
  --dir ./audit-logs \
  --system-id loan-scorer-v2 \
  --from 2026-03-01 --to 2026-03-15 \
  --event-type inference --format json

# Query logs (S3)
npx @systima/aiact-audit-log query \
  --bucket my-audit-logs --region eu-west-1 \
  --system-id loan-scorer-v2 \
  --from 2026-03-01 --to 2026-03-15 \
  --event-type inference --format json

# Reconstruct a decision trace
npx @systima/aiact-audit-log reconstruct \
  --dir ./audit-logs \
  --system-id loan-scorer-v2 \
  --decision-id dec_abc123 --format timeline

# Verify hash chain integrity
npx @systima/aiact-audit-log verify \
  --dir ./audit-logs \
  --system-id loan-scorer-v2 \
  --from 2026-03-01 --to 2026-03-31

# Aggregate statistics
npx @systima/aiact-audit-log stats \
  --dir ./audit-logs \
  --system-id loan-scorer-v2 \
  --from 2026-03-01 --to 2026-03-31

# Coverage diagnostic
npx @systima/aiact-audit-log coverage \
  --dir ./audit-logs \
  --system-id loan-scorer-v2 \
  --from 2026-03-01 --to 2026-03-31

# Health check
npx @systima/aiact-audit-log health \
  --dir ./audit-logs \
  --system-id loan-scorer-v2

# Export compliance evidence package
npx @systima/aiact-audit-log export \
  --dir ./audit-logs \
  --system-id loan-scorer-v2 \
  --from 2026-03-01 --to 2026-03-31 \
  --include-verification --include-coverage \
  --output ./compliance-evidence/
```

## Schema

Every log entry follows a schema annotated with references to the Article 12 paragraphs each field relates to. Required fields:

| Field | Type | Article Reference |
|---|---|---|
| `schemaVersion` | `'v1'` | Forward compatibility |
| `entryId` | UUIDv7 | 12(1) unique event identification |
| `decisionId` | string | 12(2)(a) risk identification |
| `systemId` | string | 12(1) system identification |
| `timestamp` | ISO 8601 | 12(1), 12(3)(a) automatic recording |
| `eventType` | enum | 12(2)(a) risk situation identification |
| `modelId` | string or null | 12(2)(a), 72 model version tracking |
| `providerId` | string or null | Provider identification |
| `input` | `{ type, value }` | 12(2)(a), 12(2)(c), 12(3)(c) |
| `output` | `{ type, value }` or null | 12(2)(a), 12(2)(b) |
| `latencyMs` | number or null | 12(2)(b), 72 performance monitoring |
| `usage` | token counts or null | 72 post-market monitoring |
| `error` | `{ code, message }` or null | 12(2)(a) risk identification |
| `parameters` | object or null | 12(2)(a) configuration tracking |
| `captureMethod` | `'middleware'` / `'manual'` / `'context'` | Coverage analysis |
| `seq` | number | 12(1) event ordering |
| `prevHash` | SHA-256 hex | Tamper evidence |
| `hash` | SHA-256 hex | Tamper evidence |

Extended fields (optional): `humanIntervention`, `stepIndex`, `parentEntryId`, `toolCall`, `referenceDatabase`, `matchResult`, `metadata`.

Event types: `inference`, `tool_call`, `tool_result`, `human_intervention`, `system_event`, `session_start`, `session_end`.

## Sector-Specific Configuration

| Sector | Recommended `retention.minimumDays` | Basis |
|---|---|---|
| General (default) | 180 | Article 19(1) floor |
| Financial services | 2555 (7 years) | MiFID II record-keeping |
| Healthcare | 3650 (10 years) | Clinical record retention |
| Employment | 1095 (3 years) | Tribunal limitation periods |

For systems processing personal data, enable `pii.hashInputs` and `pii.hashOutputs` to store SHA-256 hashes instead of raw content (GDPR Article 5(1)(c) data minimisation).

## From Logging to Compliance

This package provides the **technical logging capability** required by Article 12. Full EU AI Act compliance for a high-risk system also requires:

- **Risk management system** (Article 9): defining what constitutes a risk for your specific system, implementing risk scoring, and generating risk assessments. The audit log provides raw data that feeds into risk management; it does not define what constitutes a risk.
- **Human oversight design** (Article 14): designing and documenting oversight mechanisms, defining when human review is required. The audit log records human interventions when they occur; it does not design the oversight mechanism.
- **Post-market monitoring procedures** (Article 72): defining monitoring KPIs, alert thresholds, and escalation procedures. The audit log provides the data layer for monitoring (via `stats`, `query`, and `export`); it does not define monitoring procedures.
- **Technical documentation** (Annex IV): the complete documentation package required for conformity assessment. The audit log's schema documentation and COMPLIANCE.md contribute to this; they do not constitute the full package.

The audit log is the data layer. It provides the raw material that feeds into all of the above. It does not implement them.

For a compliance assessment of your specific system covering risk management, human oversight design, monitoring procedures, and technical documentation, visit [systima.ai](https://systima.ai).

## Requirements

- Node.js >= 18
- `@aws-sdk/client-s3` ^3.x (peer dependency; required for S3 storage, not needed for filesystem storage)
- `ai` >=4.0.0 (optional peer dependency, for AI SDK middleware integration)

## Licence

[MIT](./LICENSE)
