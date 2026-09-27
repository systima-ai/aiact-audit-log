/**
 * Storage backend that records what the logger asked it to do.
 *
 * MemoryStorage deliberately implements none of the optional retention
 * capabilities, which is what a backend without write-once support looks like.
 * This one implements them so the tests can assert that the logger actually
 * requests Object Lock and lifecycle configuration, rather than only recording
 * its intent in metadata.
 */

import { MemoryStorage } from '../../src/storage/memory.js'
import type {
  ObjectLockStatus,
  RetentionPolicyStatus,
  WriteOptions,
} from '../../src/storage/interface.js'

export interface RecordedWrite {
  key: string
  options?: WriteOptions
}

export interface RecordingStorageOptions {
  objectLockStatus?: ObjectLockStatus
  retentionPolicyStatus?: RetentionPolicyStatus
  failConfigureRetention?: boolean
  failObjectLockStatus?: boolean
}

export class RecordingStorage extends MemoryStorage {
  readonly writes: RecordedWrite[] = []
  readonly configuredRetentionDays: number[] = []

  constructor(private readonly options: RecordingStorageOptions = {}) {
    super()
  }

  override async write(key: string, data: Buffer, options?: WriteOptions): Promise<void> {
    this.writes.push({ key, options })
    await super.write(key, data)
  }

  async getObjectLockStatus(): Promise<ObjectLockStatus> {
    if (this.options.failObjectLockStatus) {
      throw new Error('AccessDenied')
    }
    return (
      this.options.objectLockStatus
      ?? { enabled: false, defaultMode: null, defaultRetainDays: null }
    )
  }

  async getRetentionPolicyStatus(): Promise<RetentionPolicyStatus> {
    return this.options.retentionPolicyStatus ?? { policyExists: false, configuredDays: null }
  }

  async configureRetentionPolicy(retentionDays: number): Promise<void> {
    if (this.options.failConfigureRetention) {
      throw new Error('AccessDenied: s3:PutLifecycleConfiguration')
    }
    this.configuredRetentionDays.push(retentionDays)
  }

  writesFor(suffix: string): RecordedWrite[] {
    return this.writes.filter((w) => w.key.endsWith(suffix))
  }
}
