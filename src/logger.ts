/**
 * AuditLogger — core class for structured, tamper-evident audit logging.
 *
 * Supports Article 12(1): automatic recording of events over the
 * lifetime of the system. Entries are batched in memory and flushed
 * to storage (S3 or local filesystem) in a hash chain.
 *
 * What that chain proves depends on configuration. See hash-chain.ts for the
 * threat model each of integrity.hmacKey, objectLock, and external anchoring
 * of getChainHead() covers; the default unkeyed chain on rewritable storage is
 * the weakest of them.
 */

import type {
  StorageBackend,
  StorageConfig,
  WriteOptions,
  ObjectLockMode,
} from './storage/interface.js'
import { S3Storage } from './storage/s3.js'
import { FileSystemStorage } from './storage/filesystem.js'
import type {
  AuditLogEntry,
  AuditLogEntryExtended,
  LogEntryInput,
  CaptureMethod,
  InputData,
  OutputData,
  HashAlgorithm,
} from './schema.js'
import { validateLogEntryInput } from './schema.js'
import { generateUUIDv7 } from './utils/uuid.js'
import {
  computeGenesisHash,
  computeEntryHash,
  type ChainHead,
  type ChainKeyOptions,
} from './hash-chain.js'
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
  /**
   * Request S3 Object Lock retention on every audit object written.
   *
   * Requires a bucket created with Object Lock enabled (which implies
   * versioning) and a credential holding s3:PutObjectRetention. When the
   * bucket does not have Object Lock, writes fail rather than silently
   * proceeding unprotected; the object_lock_configured health check reports
   * the mismatch up front.
   */
  enabled?: boolean
  mode?: ObjectLockMode
  /**
   * Days to retain each object for. Defaults to retention.minimumDays, so the
   * lock expires at the same point the lifecycle rule becomes free to expire
   * the object.
   */
  retainDays?: number
}

export interface IntegrityOptions {
  /**
   * Chain entries with HMAC-SHA256 under this key instead of bare SHA-256.
   *
   * Store the key outside the log bucket and outside the credential that can
   * write to it, otherwise it provides no protection an attacker does not
   * already hold. Rotating the key breaks verification of entries written
   * under the previous key, so treat it as long-lived.
   */
  hmacKey?: string
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
  integrity?: IntegrityOptions
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
  private readonly chainKey: ChainKeyOptions
  private readonly hashAlgorithm: HashAlgorithm

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
    } else if (config.storage.type === 'filesystem') {
      this.storage = new FileSystemStorage(config.storage.directory)
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
      retainDays: config.objectLock?.retainDays ?? retentionDays,
    }

    if (this.objectLock.enabled && !this.storage.getObjectLockStatus) {
      throw new ComplianceConfigError(
        'objectLock.enabled is set, but the configured storage backend cannot enforce write-once retention. ' +
        'Object Lock requires the S3 backend and a bucket created with Object Lock enabled.',
      )
    }

    this.chainKey = config.integrity?.hmacKey
      ? { hmacKey: config.integrity.hmacKey }
      : {}
    this.hashAlgorithm = this.chainKey.hmacKey ? 'hmac-sha256' : 'sha256'

    this.prevHash = computeGenesisHash(this.systemId, this.chainKey)

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

    await this.applyRetentionPolicy()

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
      ...(this.hashAlgorithm === 'sha256' ? {} : { hashAlgorithm: this.hashAlgorithm }),
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

    const hash = computeEntryHash(entryWithoutHash, this.chainKey)
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
    checks.push(await this.checkObjectLock())
    checks.push(await this.checkRetentionPolicy())

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

  /**
   * The current chain head.
   *
   * Neither the hash chain nor Object Lock proves when an entry was written.
   * Publish this periodically into a separate trust domain (a different
   * account, a timestamping authority, or a transparency log) to obtain
   * evidence that does not depend on the log bucket or its credentials.
   */
  getChainHead(): ChainHead {
    return {
      seq: this.seq - 1,
      hash: this.prevHash,
      systemId: this.systemId,
      updatedAt: new Date().toISOString(),
      hashAlgorithm: this.hashAlgorithm,
    }
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
    const options = this.writeOptions()

    if (this.currentFileSize > 0) {
      try {
        const existing = await this.storage.read(key)
        const combined = Buffer.concat([existing, data])
        await this.storage.write(key, combined, options)
        this.currentFileSize = combined.length
      } catch {
        await this.storage.write(key, data, options)
        this.currentFileSize = data.length
      }
    } else {
      await this.storage.write(key, data, options)
      this.currentFileSize = data.length
    }
  }

  /**
   * Retention options for writes that carry audit evidence.
   *
   * Applied to entry files and the chain head. Operational objects (the health
   * probe, the schema marker, the config snapshot) are written without a lock,
   * so a repeatedly restarted process does not accumulate locked versions of
   * files that are not evidence.
   */
  private writeOptions(): WriteOptions | undefined {
    if (!this.objectLock.enabled) return undefined

    const retainUntil = new Date(
      Date.now() + this.objectLock.retainDays * 24 * 60 * 60 * 1000,
    )

    return { objectLock: { mode: this.objectLock.mode, retainUntil } }
  }

  private async persistChainHead(): Promise<void> {
    const data = Buffer.from(JSON.stringify(this.getChainHead(), null, 2), 'utf-8')
    await this.storage.write(
      `${this.systemId}/_chain/head.json`,
      data,
      this.writeOptions(),
    )
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

  private async applyRetentionPolicy(): Promise<void> {
    if (!this.retention.autoConfigureLifecycle) return

    const configure = this.storage.configureRetentionPolicy
    if (!configure) return

    try {
      await configure.call(this.storage, this.retention.minimumDays)
    } catch (error) {
      this.handleError(
        new Error(
          `Failed to configure the ${this.retention.minimumDays}-day retention lifecycle policy: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          'Article 19(1) retention is not enforced at the storage layer until this policy exists. ' +
          'Grant s3:PutLifecycleConfiguration, or set retention.autoConfigureLifecycle to false and manage the policy yourself.',
        ),
      )
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

  private async checkObjectLock(): Promise<HealthCheck> {
    const name = 'object_lock_configured'

    if (!this.objectLock.enabled) {
      return {
        name,
        status: 'pass',
        message: 'Not requested (objectLock.enabled is false); stored objects can be overwritten',
      }
    }

    const getStatus = this.storage.getObjectLockStatus
    if (!getStatus) {
      return {
        name,
        status: 'fail',
        message: 'Object Lock requested, but this storage backend cannot enforce write-once retention',
      }
    }

    try {
      const status = await getStatus.call(this.storage)

      if (!status.enabled) {
        return {
          name,
          status: 'fail',
          message:
            `Object Lock requested in ${this.objectLock.mode} mode, but the bucket does not have Object Lock enabled. ` +
            'Object Lock can only be enabled when a bucket is created, so this bucket must be replaced.',
        }
      }

      return {
        name,
        status: 'pass',
        message: `Bucket Object Lock enabled; writing in ${this.objectLock.mode} mode for ${this.objectLock.retainDays} days`,
      }
    } catch (error) {
      return {
        name,
        status: 'fail',
        message: `Object Lock check failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  private async checkRetentionPolicy(): Promise<HealthCheck> {
    const name = 'lifecycle_policy_exists'

    const getStatus = this.storage.getRetentionPolicyStatus
    if (!getStatus) {
      return {
        name,
        status: 'pass',
        message: 'Not applicable; this storage backend has no lifecycle policy layer',
      }
    }

    try {
      const status = await getStatus.call(this.storage)

      if (!status.policyExists) {
        return {
          name,
          status: 'fail',
          message: `No enabled lifecycle rule covers this prefix; the ${this.retention.minimumDays}-day retention period is not enforced at the storage layer`,
        }
      }

      if (status.configuredDays !== null && status.configuredDays < this.retention.minimumDays) {
        return {
          name,
          status: 'fail',
          message: `Lifecycle rule expires objects after ${status.configuredDays} days, below the configured retention of ${this.retention.minimumDays} days`,
        }
      }

      return {
        name,
        status: 'pass',
        message: `Lifecycle rule expires objects after ${status.configuredDays} days`,
      }
    } catch (error) {
      return {
        name,
        status: 'warn',
        message: `Lifecycle policy check failed: ${error instanceof Error ? error.message : String(error)}`,
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
