/**
 * AuditLogger — core class for structured, tamper-evident audit logging.
 *
 * Satisfies Article 12(1): automatic recording of events over the
 * lifetime of the system. Entries are batched in memory and flushed
 * to S3-compatible storage with SHA-256 hash chains.
 */

import type { StorageBackend, StorageConfig, S3StorageConfig } from './storage/interface.js'
import { S3Storage } from './storage/s3.js'
import type {
  AuditLogEntry,
  AuditLogEntryExtended,
  LogEntryInput,
  CaptureMethod,
  InputData,
  OutputData,
} from './schema.js'
import { validateLogEntryInput } from './schema.js'
import { generateUUIDv7 } from './utils/uuid.js'
import { computeGenesisHash, computeEntryHash, type ChainHead } from './hash-chain.js'
import { getAuditContext, MissingDecisionIdError } from './context.js'
import { ComplianceConfigError } from './errors.js'
import { sha256 } from './hash-chain.js'

// ── Configuration types ─────────────────────────────────────

export interface RetentionOptions {
  minimumDays?: number
  acknowledgeSubMinimum?: boolean
  autoConfigureLifecycle?: boolean
}

export interface PIIOptions {
  hashInputs?: boolean
  hashOutputs?: boolean
  redactPatterns?: RegExp[]
}

export interface BatchingOptions {
  maxSize?: number
  maxDelayMs?: number
}

export interface ObjectLockOptions {
  enabled?: boolean
  mode?: 'GOVERNANCE' | 'COMPLIANCE'
}

export interface HealthCheckOptions {
  enabled?: boolean
  intervalMs?: number
  onDrift?: 'warn' | 'throw' | ((drift: ComplianceDrift) => void)
}

export interface ComplianceDrift {
  check: string
  status: 'fail' | 'warn'
  message: string
}

export type ErrorHandler = 'log-and-continue' | 'throw' | ((error: Error) => void)

export interface AuditLoggerConfig {
  systemId: string
  storage: StorageConfig
  retention?: RetentionOptions
  pii?: PIIOptions
  batching?: BatchingOptions
  onError?: ErrorHandler
  objectLock?: ObjectLockOptions
  healthCheck?: HealthCheckOptions
}

// ── Logger implementation ───────────────────────────────────

const MAX_FILE_SIZE = 100 * 1024 * 1024
const MINIMUM_RETENTION_DAYS = 180

export class AuditLogger {
  private readonly systemId: string
  private readonly storage: StorageBackend
  private readonly storageConfig: StorageConfig
  private readonly retention: Required<RetentionOptions>
  private readonly pii: Required<PIIOptions>
  private readonly batching: Required<BatchingOptions>
  private readonly onError: ErrorHandler
  private readonly objectLock: Required<ObjectLockOptions>

  private buffer: AuditLogEntryExtended[] = []
  private seq: number = 0
  private prevHash: string
  private currentFileIndex: number = 0
  private currentFileSize: number = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private closed: boolean = false
  private initialised: boolean = false
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null
  private shutdownHandler: (() => void) | null = null

  constructor(private readonly config: AuditLoggerConfig) {
    if (!config.systemId || config.systemId.trim().length === 0) {
      throw new ComplianceConfigError(
        'systemId is required. Logs without system identification are useless for compliance.',
      )
    }

    const retentionDays = config.retention?.minimumDays ?? MINIMUM_RETENTION_DAYS
    if (retentionDays < MINIMUM_RETENTION_DAYS && !config.retention?.acknowledgeSubMinimum) {
      throw new ComplianceConfigError(
        `retention.minimumDays (${retentionDays}) is below the Article 19(1) floor of ${MINIMUM_RETENTION_DAYS} days. ` +
        'Set retention.acknowledgeSubMinimum to true if this is intentional (non-high-risk systems only).',
      )
    }

    this.systemId = config.systemId
    this.storageConfig = config.storage

    if (config.storage.type === 's3') {
      this.storage = new S3Storage(config.storage)
    } else {
      throw new ComplianceConfigError(`Unsupported storage type: ${(config.storage as { type: string }).type}`)
    }

    this.retention = {
      minimumDays: retentionDays,
      acknowledgeSubMinimum: config.retention?.acknowledgeSubMinimum ?? false,
      autoConfigureLifecycle: config.retention?.autoConfigureLifecycle ?? true,
    }

    this.pii = {
      hashInputs: config.pii?.hashInputs ?? false,
      hashOutputs: config.pii?.hashOutputs ?? false,
      redactPatterns: config.pii?.redactPatterns ?? [],
    }

    this.batching = {
      maxSize: config.batching?.maxSize ?? 100,
      maxDelayMs: config.batching?.maxDelayMs ?? 5000,
    }

    this.onError = config.onError ?? 'log-and-continue'

    this.objectLock = {
      enabled: config.objectLock?.enabled ?? false,
      mode: config.objectLock?.mode ?? 'GOVERNANCE',
    }

    this.prevHash = computeGenesisHash(this.systemId)

    this.setupShutdownHooks()
  }

  /**
   * Initialise the logger. Loads chain head from storage,
   * recovers chain state, and writes initial metadata.
   *
   * Must be called before the first log() call. If not called
   * explicitly, log() will call it lazily.
   */
  async init(): Promise<void> {
    if (this.initialised) return

    try {
      await this.loadChainHead()
      await this.writeMetadata()
      this.initialised = true
    } catch (error) {
      this.handleError(new Error(`Failed to initialise logger: ${error instanceof Error ? error.message : String(error)}`))
      this.initialised = true
    }

    if (this.config.healthCheck?.enabled) {
      const intervalMs = this.config.healthCheck.intervalMs ?? 3_600_000
      this.healthCheckTimer = setInterval(() => {
        void this.healthCheck()
      }, intervalMs)
      this.healthCheckTimer.unref()
    }
  }

  /**
   * Log a single event.
   *
   * If no decisionId is provided and no AsyncLocalStorage context is active,
   * throws MissingDecisionIdError.
   */
  async log(input: LogEntryInput): Promise<AuditLogEntryExtended> {
    if (this.closed) {
      throw new Error('Logger is closed. Create a new instance.')
    }

    if (!this.initialised) {
      await this.init()
    }

    validateLogEntryInput(input)

    const context = getAuditContext()
    const decisionId = input.decisionId ?? context?.decisionId
    if (!decisionId) {
      throw new MissingDecisionIdError()
    }

    const captureMethod: CaptureMethod = input.captureMethod
      ?? (context ? 'context' : 'manual')

    const processedInput = this.processInputData(input.input)
    const processedOutput = input.output
      ? this.processOutputData(input.output)
      : null

    const entryWithoutHash: Omit<AuditLogEntryExtended, 'hash'> = {
      schemaVersion: 'v1',
      entryId: generateUUIDv7(),
      decisionId,
      systemId: this.systemId,
      timestamp: new Date().toISOString(),
      eventType: input.eventType,
      modelId: input.modelId,
      providerId: input.providerId,
      input: processedInput,
      output: processedOutput,
      latencyMs: input.latencyMs,
      usage: input.usage,
      error: input.error,
      parameters: input.parameters,
      captureMethod,
      seq: this.seq,
      prevHash: this.prevHash,
      ...(input.humanIntervention ? { humanIntervention: input.humanIntervention } : {}),
      ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
      ...(input.parentEntryId ? { parentEntryId: input.parentEntryId } : {}),
      ...(input.toolCall ? { toolCall: input.toolCall } : {}),
      ...(input.referenceDatabase ? { referenceDatabase: input.referenceDatabase } : {}),
      ...(input.matchResult ? { matchResult: input.matchResult } : {}),
      ...(input.metadata || context?.metadata
        ? { metadata: { ...context?.metadata, ...input.metadata } }
        : {}),
    }

    const hash = computeEntryHash(entryWithoutHash)
    const entry: AuditLogEntryExtended = { ...entryWithoutHash, hash }

    this.seq++
    this.prevHash = hash
    this.buffer.push(entry)

    if (this.buffer.length >= this.batching.maxSize) {
      await this.flush()
    } else {
      this.scheduleFlush()
    }

    return entry
  }

  /**
   * Force flush all buffered entries to storage.
   */
  async flush(): Promise<void> {
    this.clearFlushTimer()

    if (this.buffer.length === 0) return

    const entries = [...this.buffer]
    this.buffer = []

    try {
      await this.writeEntries(entries)
      await this.persistChainHead()
    } catch (error) {
      this.buffer.unshift(...entries)
      this.handleError(
        error instanceof Error
          ? error
          : new Error(`Flush failed: ${String(error)}`),
      )
    }
  }

  /**
   * Flush remaining entries and release all resources.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true

    this.clearFlushTimer()
    this.removeShutdownHooks()
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }

    await this.flush()
  }

  /**
   * Run a health check against the storage backend.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const checks: HealthCheck[] = []
    const timestamp = new Date().toISOString()

    checks.push(await this.checkWriteAccess())
    checks.push(await this.checkReadAccess())
    checks.push(await this.checkChainHeadConsistency())
    checks.push(await this.checkSchemaVersion())

    const healthy = checks.every((c) => c.status === 'pass')

    const result: HealthCheckResult = { timestamp, checks, healthy }

    if (!healthy && this.config.healthCheck?.onDrift) {
      const failedChecks = checks.filter((c) => c.status !== 'pass')
      for (const check of failedChecks) {
        const drift: ComplianceDrift = {
          check: check.name,
          status: check.status as 'fail' | 'warn',
          message: check.message,
        }

        const handler = this.config.healthCheck.onDrift
        if (handler === 'warn') {
          process.stderr.write(`[aiact-audit-log] DRIFT: ${drift.check} — ${drift.message}\n`)
        } else if (handler === 'throw') {
          throw new Error(`Compliance drift: ${drift.check} — ${drift.message}`)
        } else {
          handler(drift)
        }
      }
    }

    return result
  }

  getSystemId(): string {
    return this.systemId
  }

  getStorageBackend(): StorageBackend {
    return this.storage
  }

  getStorageConfig(): StorageConfig {
    return this.storageConfig
  }

  getCurrentSeq(): number {
    return this.seq
  }

  getPrevHash(): string {
    return this.prevHash
  }

  // ── Internal methods ────────────────────────────────────

  /** Exposed for testing with custom storage backends */
  static createWithStorage(
    config: Omit<AuditLoggerConfig, 'storage'> & { storage: StorageConfig },
    storage: StorageBackend,
  ): AuditLogger {
    const logger = new AuditLogger(config)
    ;(logger as unknown as { storage: StorageBackend }).storage = storage
    return logger
  }

  private processInputData(input: LogEntryInput['input']): InputData {
    let value = input.value

    if (this.pii.redactPatterns.length > 0) {
      value = this.redact(value)
    }

    if (this.pii.hashInputs) {
      return {
        type: 'hash',
        value: sha256(value),
        ...(input.tokenCount !== undefined ? { tokenCount: input.tokenCount } : {}),
      }
    }

    return {
      type: input.type ?? 'raw',
      value,
      ...(input.tokenCount !== undefined ? { tokenCount: input.tokenCount } : {}),
    }
  }

  private processOutputData(output: NonNullable<LogEntryInput['output']>): OutputData {
    let value = output.value

    if (this.pii.redactPatterns.length > 0) {
      value = this.redact(value)
    }

    if (this.pii.hashOutputs) {
      return {
        type: 'hash',
        value: sha256(value),
        ...(output.tokenCount !== undefined ? { tokenCount: output.tokenCount } : {}),
        ...(output.finishReason ? { finishReason: output.finishReason } : {}),
      }
    }

    return {
      type: output.type ?? 'raw',
      value,
      ...(output.tokenCount !== undefined ? { tokenCount: output.tokenCount } : {}),
      ...(output.finishReason ? { finishReason: output.finishReason } : {}),
    }
  }

  private redact(text: string): string {
    let result = text
    for (const pattern of this.pii.redactPatterns) {
      result = result.replace(pattern, '[REDACTED]')
    }
    return result
  }

  private currentDatePath(): string {
    const now = new Date()
    const year = now.getUTCFullYear()
    const month = String(now.getUTCMonth() + 1).padStart(2, '0')
    const day = String(now.getUTCDate()).padStart(2, '0')
    return `${this.systemId}/${year}/${month}/${day}`
  }

  private currentFilePath(): string {
    return `${this.currentDatePath()}/${String(this.currentFileIndex).padStart(6, '0')}.jsonl`
  }

  private async writeEntries(entries: AuditLogEntryExtended[]): Promise<void> {
    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
    const data = Buffer.from(lines, 'utf-8')

    if (this.currentFileSize + data.length > MAX_FILE_SIZE) {
      this.currentFileIndex++
      this.currentFileSize = 0
    }

    const key = this.currentFilePath()

    if (this.currentFileSize > 0) {
      try {
        const existing = await this.storage.read(key)
        const combined = Buffer.concat([existing, data])
        await this.storage.write(key, combined)
        this.currentFileSize = combined.length
      } catch {
        await this.storage.write(key, data)
        this.currentFileSize = data.length
      }
    } else {
      await this.storage.write(key, data)
      this.currentFileSize = data.length
    }
  }

  private async persistChainHead(): Promise<void> {
    const head: ChainHead = {
      seq: this.seq - 1,
      hash: this.prevHash,
      systemId: this.systemId,
      updatedAt: new Date().toISOString(),
    }

    const data = Buffer.from(JSON.stringify(head, null, 2), 'utf-8')
    await this.storage.write(`${this.systemId}/_chain/head.json`, data)
  }

  private async loadChainHead(): Promise<void> {
    const key = `${this.systemId}/_chain/head.json`

    try {
      const exists = await this.storage.exists(key)
      if (!exists) return

      const data = await this.storage.read(key)
      const head: ChainHead = JSON.parse(data.toString('utf-8'))

      this.seq = head.seq + 1
      this.prevHash = head.hash
    } catch {
      // Chain head not found or corrupted; start fresh
    }
  }

  private async writeMetadata(): Promise<void> {
    try {
      const schemaKey = `${this.systemId}/_schema/v1.json`
      const schemaExists = await this.storage.exists(schemaKey)
      if (!schemaExists) {
        await this.storage.write(
          schemaKey,
          Buffer.from(JSON.stringify({ schemaVersion: 'v1', createdAt: new Date().toISOString() })),
        )
      }

      const configKey = `${this.systemId}/_meta/config.json`
      const configSnapshot = {
        systemId: this.systemId,
        retention: this.retention,
        pii: {
          hashInputs: this.pii.hashInputs,
          hashOutputs: this.pii.hashOutputs,
          redactPatternCount: this.pii.redactPatterns.length,
        },
        batching: this.batching,
        objectLock: this.objectLock,
        initialisedAt: new Date().toISOString(),
      }
      await this.storage.write(configKey, Buffer.from(JSON.stringify(configSnapshot, null, 2)))
    } catch {
      // Non-critical; metadata write failure should not block logging
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, this.batching.maxDelayMs)

    if (this.flushTimer.unref) {
      this.flushTimer.unref()
    }
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }

  private handleError(error: Error): void {
    if (this.onError === 'throw') {
      throw error
    } else if (this.onError === 'log-and-continue') {
      process.stderr.write(`[aiact-audit-log] ERROR: ${error.message}\n`)
    } else {
      this.onError(error)
    }
  }

  private setupShutdownHooks(): void {
    this.shutdownHandler = (): void => {
      void this.flush()
    }

    process.on('beforeExit', this.shutdownHandler)
  }

  private removeShutdownHooks(): void {
    if (this.shutdownHandler) {
      process.removeListener('beforeExit', this.shutdownHandler)
      this.shutdownHandler = null
    }
  }

  // ── Health check implementations ────────────────────────

  private async checkWriteAccess(): Promise<HealthCheck> {
    try {
      const testKey = `${this.systemId}/_health/write-test`
      await this.storage.write(testKey, Buffer.from('ok'))
      return { name: 's3_write_access', status: 'pass', message: 'Write access confirmed' }
    } catch (error) {
      return {
        name: 's3_write_access',
        status: 'fail',
        message: `Write access failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  private async checkReadAccess(): Promise<HealthCheck> {
    try {
      const testKey = `${this.systemId}/_health/write-test`
      await this.storage.read(testKey)
      return { name: 's3_read_access', status: 'pass', message: 'Read access confirmed' }
    } catch (error) {
      return {
        name: 's3_read_access',
        status: 'fail',
        message: `Read access failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  private async checkChainHeadConsistency(): Promise<HealthCheck> {
    try {
      const key = `${this.systemId}/_chain/head.json`
      const exists = await this.storage.exists(key)
      if (!exists) {
        if (this.seq === 0) {
          return { name: 'chain_head_consistency', status: 'pass', message: 'No chain head yet (seq 0)' }
        }
        return { name: 'chain_head_consistency', status: 'warn', message: 'Chain head file missing but entries have been written' }
      }

      const data = await this.storage.read(key)
      const head: ChainHead = JSON.parse(data.toString('utf-8'))

      if (head.systemId !== this.systemId) {
        return { name: 'chain_head_consistency', status: 'fail', message: `Chain head systemId mismatch: expected ${this.systemId}, got ${head.systemId}` }
      }

      return { name: 'chain_head_consistency', status: 'pass', message: `Chain head matches (seq ${head.seq})` }
    } catch (error) {
      return {
        name: 'chain_head_consistency',
        status: 'warn',
        message: `Chain head check failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  private async checkSchemaVersion(): Promise<HealthCheck> {
    try {
      const key = `${this.systemId}/_schema/v1.json`
      const exists = await this.storage.exists(key)
      if (!exists) {
        return { name: 'schema_version_match', status: 'warn', message: 'Schema version file not found' }
      }
      return { name: 'schema_version_match', status: 'pass', message: 'Schema v1' }
    } catch (error) {
      return {
        name: 'schema_version_match',
        status: 'warn',
        message: `Schema version check failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
}

// ── Health check types ──────────────────────────────────────

export interface HealthCheckResult {
  timestamp: string
  checks: HealthCheck[]
  healthy: boolean
}

export interface HealthCheck {
  name: string
  status: 'pass' | 'fail' | 'warn'
  message: string
}
