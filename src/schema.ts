/**
 * Schema definitions and runtime validation for audit log entries.
 *
 * Every field is annotated with the Article paragraph it satisfies.
 * The schema IS the Article 12 mapping.
 */

// ── Event types ─────────────────────────────────────────────

export const EVENT_TYPES = [
  'inference',
  'tool_call',
  'tool_result',
  'human_intervention',
  'system_event',
  'session_start',
  'session_end',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

// ── Capture methods ─────────────────────────────────────────

export const CAPTURE_METHODS = ['middleware', 'manual', 'context'] as const

export type CaptureMethod = (typeof CAPTURE_METHODS)[number]

// ── Input/Output types ──────────────────────────────────────

export interface InputData {
  type: 'raw' | 'hash'
  value: string
  tokenCount?: number
}

export interface OutputData {
  type: 'raw' | 'hash'
  value: string
  tokenCount?: number
  finishReason?: string
}

// ── Token usage ─────────────────────────────────────────────

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

// ── Error data ──────────────────────────────────────────────

export interface ErrorData {
  code: string
  message: string
  stack?: string
}

// ── Human intervention ──────────────────────────────────────

export const HUMAN_INTERVENTION_TYPES = [
  'approval',
  'rejection',
  'modification',
  'override',
  'escalation',
] as const

export type HumanInterventionType = (typeof HUMAN_INTERVENTION_TYPES)[number]

export interface HumanIntervention {
  /** @article 12(2)(c), 14(5), 12(3)(d) */
  type: HumanInterventionType
  userId: string
  reason?: string
  originalOutput?: {
    type: 'raw' | 'hash'
    value: string
  }
  timestamp: string
}

// ── Tool call data ──────────────────────────────────────────

export interface ToolCallData {
  toolName: string
  toolArgs: Record<string, unknown> | string
  toolResult?: string
}

// ── Match result (biometric) ────────────────────────────────

export interface MatchResult {
  matched: boolean
  matchConfidence?: number
  matchedRecordId?: string
}

// ── Core log entry (required fields) ────────────────────────

export interface AuditLogEntry {
  schemaVersion: 'v1'

  /** @article 12(1) — unique event identification */
  entryId: string

  /** @article 12(2)(a) — risk identification requires correlating related events */
  decisionId: string

  /** @article 12(1) — system identification */
  systemId: string

  /** @article 12(1), 12(3)(a) — automatic recording, period of each use */
  timestamp: string

  /** @article 12(2)(a) — identifying situations that may present a risk */
  eventType: EventType

  /** @article 12(2)(a), 72 — model version tracking */
  modelId: string | null

  providerId: string | null

  /** @article 12(2)(a), 12(2)(c), 12(3)(c) — input context and deployer monitoring */
  input: InputData

  /** @article 12(2)(a), 12(2)(b) — risk identification and post-market monitoring */
  output: OutputData | null

  /** @article 12(2)(b), 72 — performance degradation detection */
  latencyMs: number | null

  /** @article 72 — post-market monitoring (usage tracking) */
  usage: TokenUsage | null

  /** @article 12(2)(a) — identifying situations that may present a risk */
  error: ErrorData | null

  /** @article 12(2)(a) — risk identification requires knowing configuration */
  parameters: Record<string, unknown> | null

  captureMethod: CaptureMethod

  /** @article 12(1) — event ordering */
  seq: number

  prevHash: string

  hash: string
}

// ── Extended log entry (optional fields) ────────────────────

export interface AuditLogEntryExtended extends AuditLogEntry {
  /** @article 12(2)(c), 14(5), 12(3)(d) */
  humanIntervention?: HumanIntervention

  /** @article 12(2)(a) — tracing complex decision chains */
  stepIndex?: number

  parentEntryId?: string

  /** @article 12(2)(a) — tool calls as risk vectors */
  toolCall?: ToolCallData

  /** @article 12(3)(b) — reference database for biometric systems */
  referenceDatabase?: string

  /** @article 12(3)(c) — match results for biometric systems */
  matchResult?: MatchResult

  metadata?: Record<string, string | number | boolean>
}

// ── Input type for logger.log() ─────────────────────────────
// What the user provides (before entryId, seq, hash chain, etc. are added)

export interface LogEntryInput {
  decisionId?: string
  eventType: EventType
  modelId: string | null
  providerId: string | null
  input: { value: string; type?: 'raw' | 'hash'; tokenCount?: number }
  output: { value: string; type?: 'raw' | 'hash'; tokenCount?: number; finishReason?: string } | null
  latencyMs: number | null
  usage: TokenUsage | null
  parameters: Record<string, unknown> | null
  error: ErrorData | null
  captureMethod?: CaptureMethod
  humanIntervention?: HumanIntervention
  stepIndex?: number
  parentEntryId?: string
  toolCall?: ToolCallData
  referenceDatabase?: string
  matchResult?: MatchResult
  metadata?: Record<string, string | number | boolean>
}

// ── Validation ──────────────────────────────────────────────

export class SchemaValidationError extends Error {
  public readonly field: string
  public readonly reason: string

  constructor(field: string, reason: string) {
    super(`Schema validation failed: ${field} — ${reason}`)
    this.name = 'SchemaValidationError'
    this.field = field
    this.reason = reason
  }
}

export function validateLogEntryInput(entry: LogEntryInput): void {
  if (!entry.eventType || !EVENT_TYPES.includes(entry.eventType)) {
    throw new SchemaValidationError(
      'eventType',
      `must be one of: ${EVENT_TYPES.join(', ')}`,
    )
  }

  if (!entry.input || typeof entry.input.value !== 'string') {
    throw new SchemaValidationError('input', 'must have a string value')
  }

  if (entry.output !== null && entry.output !== undefined) {
    if (typeof entry.output.value !== 'string') {
      throw new SchemaValidationError('output', 'must have a string value when present')
    }
  }

  if (entry.usage !== null && entry.usage !== undefined) {
    if (
      typeof entry.usage.promptTokens !== 'number' ||
      typeof entry.usage.completionTokens !== 'number' ||
      typeof entry.usage.totalTokens !== 'number'
    ) {
      throw new SchemaValidationError(
        'usage',
        'promptTokens, completionTokens, and totalTokens must be numbers',
      )
    }
  }

  if (entry.error !== null && entry.error !== undefined) {
    if (typeof entry.error.code !== 'string' || typeof entry.error.message !== 'string') {
      throw new SchemaValidationError('error', 'code and message must be strings')
    }
  }

  if (entry.humanIntervention !== undefined) {
    const hi = entry.humanIntervention
    if (!HUMAN_INTERVENTION_TYPES.includes(hi.type)) {
      throw new SchemaValidationError(
        'humanIntervention.type',
        `must be one of: ${HUMAN_INTERVENTION_TYPES.join(', ')}`,
      )
    }
    if (typeof hi.userId !== 'string' || hi.userId.length === 0) {
      throw new SchemaValidationError('humanIntervention.userId', 'must be a non-empty string')
    }
    if (typeof hi.timestamp !== 'string' || hi.timestamp.length === 0) {
      throw new SchemaValidationError('humanIntervention.timestamp', 'must be a non-empty string')
    }
  }

  if (entry.toolCall !== undefined) {
    if (typeof entry.toolCall.toolName !== 'string' || entry.toolCall.toolName.length === 0) {
      throw new SchemaValidationError('toolCall.toolName', 'must be a non-empty string')
    }
  }

  if (entry.captureMethod !== undefined && !CAPTURE_METHODS.includes(entry.captureMethod)) {
    throw new SchemaValidationError(
      'captureMethod',
      `must be one of: ${CAPTURE_METHODS.join(', ')}`,
    )
  }

  if (entry.latencyMs !== null && entry.latencyMs !== undefined) {
    if (typeof entry.latencyMs !== 'number' || entry.latencyMs < 0) {
      throw new SchemaValidationError('latencyMs', 'must be a non-negative number')
    }
  }

  if (entry.metadata !== undefined && entry.metadata !== null) {
    for (const [key, val] of Object.entries(entry.metadata)) {
      if (
        typeof val !== 'string' &&
        typeof val !== 'number' &&
        typeof val !== 'boolean'
      ) {
        throw new SchemaValidationError(
          `metadata.${key}`,
          'values must be string, number, or boolean',
        )
      }
    }
  }
}

export function validateAuditLogEntry(entry: AuditLogEntry): void {
  if (entry.schemaVersion !== 'v1') {
    throw new SchemaValidationError('schemaVersion', "must be 'v1'")
  }

  if (typeof entry.entryId !== 'string' || entry.entryId.length === 0) {
    throw new SchemaValidationError('entryId', 'must be a non-empty string')
  }

  if (typeof entry.decisionId !== 'string' || entry.decisionId.length === 0) {
    throw new SchemaValidationError('decisionId', 'must be a non-empty string')
  }

  if (typeof entry.systemId !== 'string' || entry.systemId.length === 0) {
    throw new SchemaValidationError('systemId', 'must be a non-empty string')
  }

  if (typeof entry.timestamp !== 'string' || entry.timestamp.length === 0) {
    throw new SchemaValidationError('timestamp', 'must be a non-empty ISO 8601 string')
  }

  if (!EVENT_TYPES.includes(entry.eventType)) {
    throw new SchemaValidationError(
      'eventType',
      `must be one of: ${EVENT_TYPES.join(', ')}`,
    )
  }

  if (!CAPTURE_METHODS.includes(entry.captureMethod)) {
    throw new SchemaValidationError(
      'captureMethod',
      `must be one of: ${CAPTURE_METHODS.join(', ')}`,
    )
  }

  if (typeof entry.seq !== 'number' || entry.seq < 0 || !Number.isInteger(entry.seq)) {
    throw new SchemaValidationError('seq', 'must be a non-negative integer')
  }

  if (typeof entry.prevHash !== 'string' || entry.prevHash.length === 0) {
    throw new SchemaValidationError('prevHash', 'must be a non-empty string')
  }

  if (typeof entry.hash !== 'string' || entry.hash.length === 0) {
    throw new SchemaValidationError('hash', 'must be a non-empty string')
  }
}
