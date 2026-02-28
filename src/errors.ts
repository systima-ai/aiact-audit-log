/**
 * Custom error types for the audit logger.
 */

export class ComplianceConfigError extends Error {
  constructor(message: string) {
    super(`Compliance configuration error: ${message}`)
    this.name = 'ComplianceConfigError'
  }
}

export class ComplianceDriftError extends Error {
  constructor(message: string) {
    super(`Compliance drift detected: ${message}`)
    this.name = 'ComplianceDriftError'
  }
}

export class StorageError extends Error {
  public readonly cause?: Error

  constructor(message: string, cause?: Error) {
    super(`Storage error: ${message}`)
    this.name = 'StorageError'
    this.cause = cause
  }
}

export class ChainIntegrityError extends Error {
  public readonly seq: number

  constructor(message: string, seq: number) {
    super(`Chain integrity error at seq ${seq}: ${message}`)
    this.name = 'ChainIntegrityError'
    this.seq = seq
  }
}
