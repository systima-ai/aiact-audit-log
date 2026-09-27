/**
 * Storage backend interface.
 *
 * Abstraction layer for log persistence. Supports S3-compatible storage
 * and local filesystem backends.
 *
 * The three capability methods at the end of StorageBackend are optional.
 * A backend that cannot enforce write-once retention (filesystem, memory)
 * omits them, and the logger reports the capability as unavailable rather
 * than claiming a protection that is not there.
 */

export type ObjectLockMode = 'GOVERNANCE' | 'COMPLIANCE'

export interface ObjectLockWriteOptions {
  mode: ObjectLockMode
  retainUntil: Date
}

export interface WriteOptions {
  objectLock?: ObjectLockWriteOptions
}

export interface ObjectLockStatus {
  /** Whether the bucket itself has Object Lock enabled. */
  enabled: boolean
  /** The bucket's default retention mode, when one is configured. */
  defaultMode: ObjectLockMode | null
  /** The bucket's default retention period in days, when one is configured. */
  defaultRetainDays: number | null
}

export interface RetentionPolicyStatus {
  policyExists: boolean
  configuredDays: number | null
}

export interface StorageBackend {
  write(key: string, data: Buffer, options?: WriteOptions): Promise<void>
  read(key: string): Promise<Buffer>
  list(prefix: string): Promise<string[]>
  exists(key: string): Promise<boolean>
  getObjectMetadata(key: string): Promise<ObjectMetadata>
  getObjectLockStatus?(): Promise<ObjectLockStatus>
  getRetentionPolicyStatus?(): Promise<RetentionPolicyStatus>
  configureRetentionPolicy?(retentionDays: number): Promise<void>
}

export interface ObjectMetadata {
  lastModified: Date
  size: number
}

export interface S3StorageConfig {
  type: 's3'
  bucket: string
  region: string
  prefix?: string
  endpoint?: string
  forcePathStyle?: boolean
  credentials?: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
  }
}

export interface FileSystemStorageConfig {
  type: 'filesystem'
  directory: string
  prefix?: string
}

export type StorageConfig = S3StorageConfig | FileSystemStorageConfig
