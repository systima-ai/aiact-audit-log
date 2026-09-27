/**
 * @systima/aiact-audit-log
 *
 * Structured, tamper-evident audit logging for AI systems.
 * Technical logging capability for Article 12 EU AI Act compliance.
 *
 * @see https://github.com/systima-ai/aiact-audit-log
 */

export { AuditLogger } from './logger.js'
export type {
  AuditLoggerConfig,
  RetentionOptions,
  PIIOptions,
  BatchingOptions,
  ObjectLockOptions,
  IntegrityOptions,
  HealthCheckOptions,
  ComplianceDrift,
  ErrorHandler,
  HealthCheckResult,
  HealthCheck,
} from './logger.js'

export { AuditLogReader } from './reader.js'
export type {
  AuditLogReaderConfig,
  QueryOptions,
  ReconstructResult,
  TimelineEntry,
  StatsResult,
} from './reader.js'

export type {
  AuditLogEntry,
  AuditLogEntryExtended,
  LogEntryInput,
  EventType,
  CaptureMethod,
  InputData,
  OutputData,
  TokenUsage,
  ErrorData,
  HumanIntervention,
  HumanInterventionType,
  ToolCallData,
  MatchResult,
} from './schema.js'
export type { HashAlgorithm } from './schema.js'
export {
  EVENT_TYPES,
  CAPTURE_METHODS,
  HUMAN_INTERVENTION_TYPES,
  HASH_ALGORITHMS,
  SchemaValidationError,
  validateLogEntryInput,
  validateAuditLogEntry,
} from './schema.js'

export { withAuditContext, getAuditContext, MissingDecisionIdError } from './context.js'
export type { AuditContext } from './context.js'

export {
  computeGenesisHash,
  computeEntryHash,
  verifyEntryHash,
  verifyChain,
  verifyChainFromGenesis,
  sha256,
  hmacSha256,
} from './hash-chain.js'
export type {
  ChainHead,
  ChainVerificationResult,
  ChainKeyOptions,
} from './hash-chain.js'

export { analyseCoverage } from './coverage.js'
export type { CoverageReport, CoverageWarning, CoverageOptions } from './coverage.js'

export {
  ComplianceConfigError,
  ComplianceDriftError,
  StorageError,
  ChainIntegrityError,
} from './errors.js'

export type {
  StorageBackend,
  ObjectMetadata,
  S3StorageConfig,
  FileSystemStorageConfig,
  StorageConfig,
  WriteOptions,
  ObjectLockMode,
  ObjectLockWriteOptions,
  ObjectLockStatus,
  RetentionPolicyStatus,
} from './storage/interface.js'

export {
  configureRetentionPolicy,
  checkRetentionPolicy,
  retentionRuleId,
} from './utils/retention.js'

export { FileSystemStorage } from './storage/filesystem.js'
export { MemoryStorage } from './storage/memory.js'
