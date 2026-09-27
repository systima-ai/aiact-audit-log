import { describe, it, expect } from 'vitest'
import { AuditLogger } from '../src/logger.js'
import { MemoryStorage } from '../src/storage/memory.js'
import { FileSystemStorage } from '../src/storage/filesystem.js'
import { ComplianceConfigError } from '../src/errors.js'
import { RecordingStorage, type RecordingStorageOptions } from './helpers/recording-storage.js'
import type { AuditLoggerConfig } from '../src/logger.js'

const S3_CONFIG = {
  type: 's3' as const,
  bucket: 'test-bucket',
  region: 'eu-west-1',
}

function createLogger(
  overrides: Partial<AuditLoggerConfig> = {},
  storageOptions: RecordingStorageOptions = {},
): { logger: AuditLogger; storage: RecordingStorage } {
  const storage = new RecordingStorage(storageOptions)
  const logger = AuditLogger.createWithStorage(
    {
      systemId: 'test-system',
      storage: S3_CONFIG,
      retention: { minimumDays: 180 },
      batching: { maxSize: 1000, maxDelayMs: 60000 },
      ...overrides,
    },
    storage,
  )
  return { logger, storage }
}

async function logOnce(logger: AuditLogger): Promise<void> {
  await logger.log({
    decisionId: 'dec_1',
    eventType: 'inference',
    modelId: 'test-model',
    providerId: 'test',
    input: { value: 'in' },
    output: { value: 'out' },
    latencyMs: 1,
    usage: null,
    parameters: null,
    error: null,
  })
  await logger.flush()
}

describe('Object Lock enforcement', () => {
  it('sends no lock parameters when objectLock is not enabled', async () => {
    const { logger, storage } = createLogger()
    await logger.init()
    await logOnce(logger)

    const entryWrites = storage.writesFor('.jsonl')
    expect(entryWrites.length).toBeGreaterThan(0)
    expect(entryWrites.every((w) => w.options === undefined)).toBe(true)

    await logger.close()
  })

  it('requests Object Lock retention on entry files when enabled', async () => {
    const { logger, storage } = createLogger({
      objectLock: { enabled: true, mode: 'COMPLIANCE' },
    })
    await logger.init()
    await logOnce(logger)

    const entryWrites = storage.writesFor('.jsonl')
    expect(entryWrites.length).toBeGreaterThan(0)

    for (const write of entryWrites) {
      expect(write.options?.objectLock?.mode).toBe('COMPLIANCE')
      expect(write.options?.objectLock?.retainUntil).toBeInstanceOf(Date)
    }

    await logger.close()
  })

  it('requests Object Lock retention on the chain head', async () => {
    const { logger, storage } = createLogger({
      objectLock: { enabled: true, mode: 'GOVERNANCE' },
    })
    await logger.init()
    await logOnce(logger)

    const headWrites = storage.writesFor('_chain/head.json')
    expect(headWrites.length).toBeGreaterThan(0)
    expect(headWrites.every((w) => w.options?.objectLock?.mode === 'GOVERNANCE')).toBe(true)

    await logger.close()
  })

  it('derives retainUntil from retention.minimumDays by default', async () => {
    const { logger, storage } = createLogger({
      retention: { minimumDays: 365 },
      objectLock: { enabled: true, mode: 'COMPLIANCE' },
    })
    await logger.init()
    await logOnce(logger)

    const retainUntil = storage.writesFor('.jsonl')[0].options?.objectLock?.retainUntil
    const expectedDays = 365
    const actualDays = (retainUntil!.getTime() - Date.now()) / (24 * 60 * 60 * 1000)

    expect(actualDays).toBeGreaterThan(expectedDays - 1)
    expect(actualDays).toBeLessThan(expectedDays + 1)

    await logger.close()
  })

  it('honours an explicit objectLock.retainDays', async () => {
    const { logger, storage } = createLogger({
      retention: { minimumDays: 180 },
      objectLock: { enabled: true, mode: 'COMPLIANCE', retainDays: 2555 },
    })
    await logger.init()
    await logOnce(logger)

    const retainUntil = storage.writesFor('.jsonl')[0].options?.objectLock?.retainUntil
    const actualDays = (retainUntil!.getTime() - Date.now()) / (24 * 60 * 60 * 1000)

    expect(actualDays).toBeGreaterThan(2554)
    expect(actualDays).toBeLessThan(2556)

    await logger.close()
  })

  it('does not lock the health probe object', async () => {
    const { logger, storage } = createLogger(
      { objectLock: { enabled: true, mode: 'COMPLIANCE' } },
      { objectLockStatus: { enabled: true, defaultMode: 'COMPLIANCE', defaultRetainDays: 180 } },
    )
    await logger.init()
    await logger.healthCheck()

    const probeWrites = storage.writesFor('_health/write-test')
    expect(probeWrites.length).toBeGreaterThan(0)
    expect(probeWrites.every((w) => w.options === undefined)).toBe(true)

    await logger.close()
  })

  it('refuses to construct when the backend cannot enforce write-once retention', () => {
    expect(() =>
      AuditLogger.createWithStorage(
        {
          systemId: 'test-system',
          storage: { type: 'filesystem', directory: '/tmp/aiact-test' },
          objectLock: { enabled: true, mode: 'COMPLIANCE' },
        },
        new FileSystemStorage('/tmp/aiact-test'),
      ),
    ).toThrow(ComplianceConfigError)
  })

  it('reports a bucket without Object Lock as a failed health check', async () => {
    const { logger } = createLogger(
      { objectLock: { enabled: true, mode: 'COMPLIANCE' } },
      { objectLockStatus: { enabled: false, defaultMode: null, defaultRetainDays: null } },
    )
    await logger.init()

    const result = await logger.healthCheck()
    const check = result.checks.find((c) => c.name === 'object_lock_configured')

    expect(check?.status).toBe('fail')
    expect(check?.message).toContain('does not have Object Lock enabled')
    expect(result.healthy).toBe(false)

    await logger.close()
  })

  it('passes the Object Lock check when the bucket has it enabled', async () => {
    const { logger } = createLogger(
      { objectLock: { enabled: true, mode: 'COMPLIANCE' } },
      {
        objectLockStatus: { enabled: true, defaultMode: 'COMPLIANCE', defaultRetainDays: 180 },
        retentionPolicyStatus: { policyExists: true, configuredDays: 180 },
      },
    )
    await logger.init()

    const result = await logger.healthCheck()
    const check = result.checks.find((c) => c.name === 'object_lock_configured')

    expect(check?.status).toBe('pass')
    expect(result.healthy).toBe(true)

    await logger.close()
  })

  it('states plainly that objects are overwritable when lock is not requested', async () => {
    const { logger } = createLogger({}, {
      retentionPolicyStatus: { policyExists: true, configuredDays: 180 },
    })
    await logger.init()

    const result = await logger.healthCheck()
    const check = result.checks.find((c) => c.name === 'object_lock_configured')

    expect(check?.status).toBe('pass')
    expect(check?.message).toContain('can be overwritten')

    await logger.close()
  })
})

describe('lifecycle policy configuration', () => {
  it('configures the retention policy on init by default', async () => {
    const { logger, storage } = createLogger({ retention: { minimumDays: 365 } })
    await logger.init()

    expect(storage.configuredRetentionDays).toEqual([365])

    await logger.close()
  })

  it('does not configure the policy when autoConfigureLifecycle is false', async () => {
    const { logger, storage } = createLogger({
      retention: { minimumDays: 180, autoConfigureLifecycle: false },
    })
    await logger.init()

    expect(storage.configuredRetentionDays).toEqual([])

    await logger.close()
  })

  it('skips configuration on a backend with no lifecycle layer', async () => {
    const storage = new MemoryStorage()
    const logger = AuditLogger.createWithStorage(
      { systemId: 'test-system', storage: S3_CONFIG, retention: { minimumDays: 180 } },
      storage,
    )

    await expect(logger.init()).resolves.toBeUndefined()

    await logger.close()
  })

  it('surfaces a configuration failure through onError', async () => {
    const errors: Error[] = []
    const { logger } = createLogger(
      { onError: (error) => errors.push(error) },
      { failConfigureRetention: true },
    )

    await logger.init()

    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('retention lifecycle policy')
    expect(errors[0].message).toContain('s3:PutLifecycleConfiguration')

    await logger.close()
  })

  it('fails the health check when no lifecycle rule covers the prefix', async () => {
    const { logger } = createLogger({}, {
      retentionPolicyStatus: { policyExists: false, configuredDays: null },
    })
    await logger.init()

    const result = await logger.healthCheck()
    const check = result.checks.find((c) => c.name === 'lifecycle_policy_exists')

    expect(check?.status).toBe('fail')
    expect(check?.message).toContain('not enforced at the storage layer')

    await logger.close()
  })

  it('fails the health check when the rule expires below the configured retention', async () => {
    const { logger } = createLogger({}, {
      retentionPolicyStatus: { policyExists: true, configuredDays: 90 },
    })
    await logger.init()

    const result = await logger.healthCheck()
    const check = result.checks.find((c) => c.name === 'lifecycle_policy_exists')

    expect(check?.status).toBe('fail')
    expect(check?.message).toContain('below the configured retention')

    await logger.close()
  })

  it('passes the health check when the rule meets the configured retention', async () => {
    const { logger } = createLogger({}, {
      retentionPolicyStatus: { policyExists: true, configuredDays: 400 },
    })
    await logger.init()

    const result = await logger.healthCheck()
    const check = result.checks.find((c) => c.name === 'lifecycle_policy_exists')

    expect(check?.status).toBe('pass')
    expect(result.healthy).toBe(true)

    await logger.close()
  })

  it('reports not applicable on a backend with no lifecycle layer', async () => {
    const storage = new MemoryStorage()
    const logger = AuditLogger.createWithStorage(
      { systemId: 'test-system', storage: S3_CONFIG, retention: { minimumDays: 180 } },
      storage,
    )
    await logger.init()

    const result = await logger.healthCheck()
    const check = result.checks.find((c) => c.name === 'lifecycle_policy_exists')

    expect(check?.status).toBe('pass')
    expect(check?.message).toContain('Not applicable')
    expect(result.healthy).toBe(true)

    await logger.close()
  })
})
