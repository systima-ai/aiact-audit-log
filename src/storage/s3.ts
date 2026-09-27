/**
 * S3-compatible storage backend.
 *
 * Works with AWS S3, MinIO, Cloudflare R2, Backblaze B2, and DigitalOcean Spaces.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectLockConfigurationCommand,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3'
import type {
  StorageBackend,
  ObjectMetadata,
  S3StorageConfig,
  WriteOptions,
  ObjectLockStatus,
  RetentionPolicyStatus,
} from './interface.js'
import { StorageError } from '../errors.js'
import { configureRetentionPolicy, checkRetentionPolicy } from '../utils/retention.js'

/**
 * Build the PutObject input for an audit write.
 *
 * Exported so the lock parameters can be asserted without an S3 endpoint.
 * Before v0.2.0 the objectLock configuration never reached this call, so a
 * deployer requesting COMPLIANCE mode received no protection at all.
 */
export function buildPutObjectInput(
  bucket: string,
  fullKey: string,
  data: Buffer,
  options?: WriteOptions,
): PutObjectCommandInput {
  return {
    Bucket: bucket,
    Key: fullKey,
    Body: data,
    ContentType: fullKey.endsWith('.jsonl')
      ? 'application/x-ndjson'
      : 'application/json',
    ...(options?.objectLock
      ? {
          ObjectLockMode: options.objectLock.mode,
          ObjectLockRetainUntilDate: options.objectLock.retainUntil,
        }
      : {}),
  }
}

export class S3Storage implements StorageBackend {
  private readonly client: S3Client
  private readonly bucket: string
  private readonly prefix: string

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket
    this.prefix = config.prefix ?? 'aiact-logs'

    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.forcePathStyle ? { forcePathStyle: config.forcePathStyle } : {}),
      ...(config.credentials
        ? {
            credentials: {
              accessKeyId: config.credentials.accessKeyId,
              secretAccessKey: config.credentials.secretAccessKey,
              ...(config.credentials.sessionToken
                ? { sessionToken: config.credentials.sessionToken }
                : {}),
            },
          }
        : {}),
    })
  }

  private fullKey(key: string): string {
    return `${this.prefix}/${key}`
  }

  async write(key: string, data: Buffer, options?: WriteOptions): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand(
          buildPutObjectInput(this.bucket, this.fullKey(key), data, options),
        ),
      )
    } catch (error) {
      throw new StorageError(
        `Failed to write ${key} to S3`,
        error instanceof Error ? error : new Error(String(error)),
      )
    }
  }

  async read(key: string): Promise<Buffer> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.fullKey(key),
        }),
      )

      if (!response.Body) {
        throw new StorageError(`Empty response body for ${key}`)
      }

      const bytes = await response.Body.transformToByteArray()
      return Buffer.from(bytes)
    } catch (error) {
      if (error instanceof StorageError) throw error
      throw new StorageError(
        `Failed to read ${key} from S3`,
        error instanceof Error ? error : new Error(String(error)),
      )
    }
  }

  async list(prefix: string): Promise<string[]> {
    try {
      const keys: string[] = []
      let continuationToken: string | undefined

      do {
        const response = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: this.fullKey(prefix),
            ContinuationToken: continuationToken,
          }),
        )

        if (response.Contents) {
          for (const obj of response.Contents) {
            if (obj.Key) {
              const relativeKey = obj.Key.startsWith(this.prefix + '/')
                ? obj.Key.slice(this.prefix.length + 1)
                : obj.Key
              keys.push(relativeKey)
            }
          }
        }

        continuationToken = response.NextContinuationToken
      } while (continuationToken)

      return keys
    } catch (error) {
      throw new StorageError(
        `Failed to list objects with prefix ${prefix}`,
        error instanceof Error ? error : new Error(String(error)),
      )
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.fullKey(key),
        }),
      )
      return true
    } catch (error) {
      const errorName = (error as { name?: string }).name
      if (errorName === 'NotFound' || errorName === 'NoSuchKey') {
        return false
      }
      throw new StorageError(
        `Failed to check existence of ${key}`,
        error instanceof Error ? error : new Error(String(error)),
      )
    }
  }

  async getObjectMetadata(key: string): Promise<ObjectMetadata> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.fullKey(key),
        }),
      )

      return {
        lastModified: response.LastModified ?? new Date(),
        size: response.ContentLength ?? 0,
      }
    } catch (error) {
      throw new StorageError(
        `Failed to get metadata for ${key}`,
        error instanceof Error ? error : new Error(String(error)),
      )
    }
  }

  async getObjectLockStatus(): Promise<ObjectLockStatus> {
    try {
      const response = await this.client.send(
        new GetObjectLockConfigurationCommand({ Bucket: this.bucket }),
      )

      const enabled = response.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled'
      const defaultRetention = response.ObjectLockConfiguration?.Rule?.DefaultRetention
      const mode = defaultRetention?.Mode
      const days = defaultRetention?.Days
        ?? (defaultRetention?.Years !== undefined ? defaultRetention.Years * 365 : undefined)

      return {
        enabled,
        defaultMode: mode === 'GOVERNANCE' || mode === 'COMPLIANCE' ? mode : null,
        defaultRetainDays: days ?? null,
      }
    } catch (error) {
      const errorName = (error as { name?: string }).name
      if (
        errorName === 'ObjectLockConfigurationNotFoundError' ||
        errorName === 'NoSuchObjectLockConfiguration'
      ) {
        return { enabled: false, defaultMode: null, defaultRetainDays: null }
      }
      throw new StorageError(
        `Failed to read Object Lock configuration for bucket ${this.bucket}`,
        error instanceof Error ? error : new Error(String(error)),
      )
    }
  }

  async getRetentionPolicyStatus(): Promise<RetentionPolicyStatus> {
    return checkRetentionPolicy(this.client, this.bucket, this.prefix)
  }

  async configureRetentionPolicy(retentionDays: number): Promise<void> {
    await configureRetentionPolicy(this.client, this.bucket, this.prefix, retentionDays)
  }
}
