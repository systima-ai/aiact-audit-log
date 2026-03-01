/**
 * Storage backend interface.
 *
 * Abstraction layer for log persistence. Supports S3-compatible storage
 * and local filesystem backends.
 */

export interface StorageBackend {
  write(key: string, data: Buffer): Promise<void>
  read(key: string): Promise<Buffer>
  list(prefix: string): Promise<string[]>
  exists(key: string): Promise<boolean>
  getObjectMetadata(key: string): Promise<ObjectMetadata>
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
