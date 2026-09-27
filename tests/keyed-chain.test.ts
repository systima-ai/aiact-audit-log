import { describe, it, expect } from 'vitest'
import { AuditLogger } from '../src/logger.js'
import { AuditLogReader } from '../src/reader.js'
import { MemoryStorage } from '../src/storage/memory.js'
import {
  computeEntryHash,
  computeGenesisHash,
  verifyChain,
  verifyEntryHash,
  sha256,
  hmacSha256,
} from '../src/hash-chain.js'
import type { AuditLogEntryExtended } from '../src/schema.js'

const S3_CONFIG = {
  type: 's3' as const,
  bucket: 'test-bucket',
  region: 'eu-west-1',
}

function createLogger(hmacKey?: string): { logger: AuditLogger; storage: MemoryStorage } {
  const storage = new MemoryStorage()
  const logger = AuditLogger.createWithStorage(
    {
      systemId: 'test-system',
      storage: S3_CONFIG,
      retention: { minimumDays: 180 },
      batching: { maxSize: 1000, maxDelayMs: 60000 },
      ...(hmacKey ? { integrity: { hmacKey } } : {}),
    },
    storage,
  )
  return { logger, storage }
}

async function logEvent(logger: AuditLogger, value: string): Promise<AuditLogEntryExtended> {
  return logger.log({
    decisionId: 'dec_1',
    eventType: 'inference',
    modelId: 'test-model',
    providerId: 'test',
    input: { value },
    output: { value: 'out' },
    latencyMs: 1,
    usage: null,
    parameters: null,
    error: null,
  })
}

async function readEntries(
  storage: MemoryStorage,
): Promise<{ key: string; entries: AuditLogEntryExtended[] }> {
  const keys = await storage.list('test-system/')
  const key = keys.find((k) => k.endsWith('.jsonl'))
  if (!key) throw new Error('No entry file written')
  const entries = (await storage.read(key))
    .toString('utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as AuditLogEntryExtended)
  return { key, entries }
}

describe('hmacSha256', () => {
  it('differs from the unkeyed digest of the same data', () => {
    expect(hmacSha256('data', 'key')).not.toBe(sha256('data'))
  })

  it('differs between keys', () => {
    expect(hmacSha256('data', 'a')).not.toBe(hmacSha256('data', 'b'))
  })

  it('produces 64-character lowercase hex strings', () => {
    expect(hmacSha256('data', 'key')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('keyed genesis and entry hashes', () => {
  it('seeds genesis under the key', () => {
    expect(computeGenesisHash('s')).not.toBe(computeGenesisHash('s', { hmacKey: 'k' }))
  })

  it('treats an empty options object as unkeyed', () => {
    expect(computeGenesisHash('s', {})).toBe(computeGenesisHash('s'))
  })

  it('verifies an entry only under the key it was hashed with', async () => {
    const { logger } = createLogger('secret')
    const entry = await logEvent(logger, 'in')

    expect(verifyEntryHash(entry, { hmacKey: 'secret' })).toBe(true)
    expect(verifyEntryHash(entry, { hmacKey: 'wrong' })).toBe(false)
    expect(verifyEntryHash(entry)).toBe(false)

    await logger.close()
  })
})

describe('logger integrity mode', () => {
  it('omits hashAlgorithm when unkeyed, so v1 entries are unchanged', async () => {
    const { logger } = createLogger()
    const entry = await logEvent(logger, 'in')

    expect(entry.hashAlgorithm).toBeUndefined()
    expect(verifyEntryHash(entry)).toBe(true)

    await logger.close()
  })

  it('records hashAlgorithm when keyed', async () => {
    const { logger } = createLogger('secret')
    const entry = await logEvent(logger, 'in')

    expect(entry.hashAlgorithm).toBe('hmac-sha256')

    await logger.close()
  })

  it('stamps the algorithm on the persisted chain head', async () => {
    const { logger, storage } = createLogger('secret')
    await logEvent(logger, 'in')
    await logger.flush()

    const head = JSON.parse(
      (await storage.read('test-system/_chain/head.json')).toString('utf-8'),
    )
    expect(head.hashAlgorithm).toBe('hmac-sha256')

    await logger.close()
  })

  it('resumes a keyed chain across logger instances', async () => {
    const { logger, storage } = createLogger('secret')
    const first = await logEvent(logger, 'first')
    await logger.flush()
    await logger.close()

    const resumed = AuditLogger.createWithStorage(
      {
        systemId: 'test-system',
        storage: S3_CONFIG,
        retention: { minimumDays: 180 },
        batching: { maxSize: 1000, maxDelayMs: 60000 },
        integrity: { hmacKey: 'secret' },
      },
      storage,
    )
    await resumed.init()
    const second = await logEvent(resumed, 'second')

    expect(second.prevHash).toBe(first.hash)
    expect(verifyEntryHash(second, { hmacKey: 'secret' })).toBe(true)

    await resumed.close()
  })
})

describe('resistance to chain recomputation', () => {
  it('rejects a chain rebuilt by a tamperer who holds the bucket but not the key', async () => {
    const { logger, storage } = createLogger('secret')
    await logEvent(logger, 'first')
    await logEvent(logger, 'second')
    await logEvent(logger, 'third')
    await logger.flush()

    const { entries } = await readEntries(storage)
    expect(verifyChain(entries, { hmacKey: 'secret' }).valid).toBe(true)

    const forged = entries.map((e) => ({ ...e }))
    forged[1] = { ...forged[1], input: { type: 'raw', value: 'tampered' } }
    forged[1].hash = computeEntryHash(forged[1])
    forged[2] = { ...forged[2], prevHash: forged[1].hash }
    forged[2].hash = computeEntryHash(forged[2])

    expect(verifyChain(forged, { hmacKey: 'secret' }).valid).toBe(false)

    await logger.close()
  })

  it('accepts the same recomputation when the chain is unkeyed', async () => {
    const { logger, storage } = createLogger()
    await logEvent(logger, 'first')
    await logEvent(logger, 'second')
    await logEvent(logger, 'third')
    await logger.flush()

    const { entries } = await readEntries(storage)

    const forged = entries.map((e) => ({ ...e }))
    forged[1] = { ...forged[1], input: { type: 'raw', value: 'tampered' } }
    forged[1].hash = computeEntryHash(forged[1])
    forged[2] = { ...forged[2], prevHash: forged[1].hash }
    forged[2].hash = computeEntryHash(forged[2])

    expect(verifyChain(forged).valid).toBe(true)

    await logger.close()
  })

  it('cannot be downgraded by stripping hashAlgorithm from the entries', async () => {
    const { logger, storage } = createLogger('secret')
    await logEvent(logger, 'first')
    await logEvent(logger, 'second')
    await logger.flush()

    const { entries } = await readEntries(storage)

    const downgraded = entries.map((entry) => {
      const stripped = { ...entry }
      delete stripped.hashAlgorithm
      return { ...stripped, hash: computeEntryHash(stripped) }
    })
    for (let i = 1; i < downgraded.length; i++) {
      downgraded[i].prevHash = downgraded[i - 1].hash
      downgraded[i].hash = computeEntryHash(downgraded[i])
    }

    expect(verifyChain(downgraded, { hmacKey: 'secret' }).valid).toBe(false)

    await logger.close()
  })
})

describe('reader verification', () => {
  it('verifies a keyed chain with the key and rejects it without', async () => {
    const { logger, storage } = createLogger('secret')
    await logEvent(logger, 'in')
    await logger.flush()

    const keyed = AuditLogReader.createWithStorage(
      { storage: S3_CONFIG, systemId: 'test-system', integrity: { hmacKey: 'secret' } },
      storage,
    )
    const unkeyed = AuditLogReader.createWithStorage(
      { storage: S3_CONFIG, systemId: 'test-system' },
      storage,
    )

    expect((await keyed.verifyChain()).valid).toBe(true)
    expect((await unkeyed.verifyChain()).valid).toBe(false)

    await logger.close()
  })

  it('reports integrity under the key when reconstructing a decision', async () => {
    const { logger, storage } = createLogger('secret')
    await logEvent(logger, 'in')
    await logger.flush()

    const reader = AuditLogReader.createWithStorage(
      { storage: S3_CONFIG, systemId: 'test-system', integrity: { hmacKey: 'secret' } },
      storage,
    )
    const trace = await reader.reconstruct('dec_1')

    expect(trace.integrity.valid).toBe(true)
    expect(trace.integrity.entriesChecked).toBe(1)

    await logger.close()
  })
})

describe('getChainHead', () => {
  it('returns the current head for anchoring outside the log bucket', async () => {
    const { logger } = createLogger('secret')
    const entry = await logEvent(logger, 'in')

    const head = logger.getChainHead()

    expect(head.seq).toBe(entry.seq)
    expect(head.hash).toBe(entry.hash)
    expect(head.systemId).toBe('test-system')
    expect(head.hashAlgorithm).toBe('hmac-sha256')

    await logger.close()
  })

  it('reports sha256 when the chain is unkeyed', async () => {
    const { logger } = createLogger()
    await logEvent(logger, 'in')

    expect(logger.getChainHead().hashAlgorithm).toBe('sha256')

    await logger.close()
  })
})
