import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AuditLogger } from '../../src/logger.js'
import { AuditLogReader } from '../../src/reader.js'
import { MemoryStorage } from '../../src/storage/memory.js'
import type { AuditLogEntryExtended } from '../../src/schema.js'

function createTestSetup(): {
  logger: AuditLogger
  reader: AuditLogReader
  storage: MemoryStorage
} {
  const storage = new MemoryStorage()
  const storageConfig = {
    type: 's3' as const,
    bucket: 'test-bucket',
    region: 'eu-west-1',
  }

  const logger = AuditLogger.createWithStorage(
    {
      systemId: 'test-system',
      storage: storageConfig,
      retention: { minimumDays: 180 },
      batching: { maxSize: 1000, maxDelayMs: 60000 },
    },
    storage,
  )

  const reader = AuditLogReader.createWithStorage(
    {
      storage: storageConfig,
      systemId: 'test-system',
    },
    storage,
  )

  return { logger, reader, storage }
}

describe('CLI verify (chain verification)', () => {
  let logger: AuditLogger
  let reader: AuditLogReader
  let storage: MemoryStorage

  beforeEach(() => {
    const setup = createTestSetup()
    logger = setup.logger
    reader = setup.reader
    storage = setup.storage
  })

  afterEach(async () => {
    await logger.close()
  })

  it('verifies a valid chain from genesis', async () => {
    for (let i = 0; i < 10; i++) {
      await logger.log({
        decisionId: `dec_${i}`,
        eventType: 'inference',
        modelId: 'model-a',
        providerId: 'test',
        input: { value: `prompt-${i}` },
        output: { value: `response-${i}` },
        latencyMs: 100 + i,
        usage: null,
        parameters: null,
        error: null,
      })
    }
    await logger.flush()

    const result = await reader.verifyChain()

    expect(result.valid).toBe(true)
    expect(result.entriesChecked).toBe(10)
    expect(result.firstBreak).toBeNull()
  })

  it('detects a tampered entry', async () => {
    for (let i = 0; i < 5; i++) {
      await logger.log({
        decisionId: `dec_${i}`,
        eventType: 'inference',
        modelId: 'model-a',
        providerId: 'test',
        input: { value: `prompt-${i}` },
        output: { value: `response-${i}` },
        latencyMs: 100,
        usage: null,
        parameters: null,
        error: null,
      })
    }
    await logger.flush()

    const allKeys = await storage.list('')
    const jsonlKey = allKeys.find((k) => k.endsWith('.jsonl'))
    expect(jsonlKey).toBeDefined()

    const data = await storage.read(jsonlKey!)
    const lines = data.toString('utf-8').trim().split('\n')
    const entries: AuditLogEntryExtended[] = lines.map((l) => JSON.parse(l))

    entries[2].input.value = 'TAMPERED INPUT'

    const tamperedContent = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
    await storage.write(jsonlKey!, Buffer.from(tamperedContent, 'utf-8'))

    const result = await reader.verifyChain()

    expect(result.valid).toBe(false)
    expect(result.firstBreak).not.toBeNull()
    expect(result.firstBreak!.seq).toBe(2)
  })

  it('detects a deleted entry (gap in sequence)', async () => {
    for (let i = 0; i < 5; i++) {
      await logger.log({
        decisionId: `dec_${i}`,
        eventType: 'inference',
        modelId: null,
        providerId: null,
        input: { value: `prompt-${i}` },
        output: null,
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
      })
    }
    await logger.flush()

    const allKeys = await storage.list('')
    const jsonlKey = allKeys.find((k) => k.endsWith('.jsonl'))
    expect(jsonlKey).toBeDefined()

    const data = await storage.read(jsonlKey!)
    const lines = data.toString('utf-8').trim().split('\n')
    const entries: AuditLogEntryExtended[] = lines.map((l) => JSON.parse(l))

    const withoutEntry2 = [...entries.slice(0, 2), ...entries.slice(3)]
    const modifiedContent = withoutEntry2.map((e) => JSON.stringify(e)).join('\n') + '\n'
    await storage.write(jsonlKey!, Buffer.from(modifiedContent, 'utf-8'))

    const result = await reader.verifyChain()

    expect(result.valid).toBe(false)
    expect(result.firstBreak).not.toBeNull()
  })

  it('handles an empty log (no entries)', async () => {
    const result = await reader.verifyChain()

    expect(result.valid).toBe(true)
    expect(result.entriesChecked).toBe(0)
    expect(result.firstBreak).toBeNull()
  })

  it('verifies a single-entry chain', async () => {
    await logger.log({
      decisionId: 'dec_solo',
      eventType: 'inference',
      modelId: 'model-a',
      providerId: 'test',
      input: { value: 'only prompt' },
      output: { value: 'only response' },
      latencyMs: 42,
      usage: null,
      parameters: null,
      error: null,
    })
    await logger.flush()

    const result = await reader.verifyChain()

    expect(result.valid).toBe(true)
    expect(result.entriesChecked).toBe(1)
  })

  it('verifies chain continuity across logger restarts', async () => {
    const lastEntries: AuditLogEntryExtended[] = []

    for (let i = 0; i < 3; i++) {
      const entry = await logger.log({
        decisionId: `dec_${i}`,
        eventType: 'inference',
        modelId: null,
        providerId: null,
        input: { value: `prompt-${i}` },
        output: null,
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
      })
      lastEntries.push(entry)
    }
    await logger.close()

    const storageConfig = {
      type: 's3' as const,
      bucket: 'test-bucket',
      region: 'eu-west-1',
    }

    const logger2 = AuditLogger.createWithStorage(
      {
        systemId: 'test-system',
        storage: storageConfig,
        retention: { minimumDays: 180 },
        batching: { maxSize: 1000, maxDelayMs: 60000 },
      },
      storage,
    )

    const e4 = await logger2.log({
      decisionId: 'dec_3',
      eventType: 'inference',
      modelId: null,
      providerId: null,
      input: { value: 'prompt-3' },
      output: null,
      latencyMs: null,
      usage: null,
      parameters: null,
      error: null,
    })

    expect(e4.seq).toBe(3)
    expect(e4.prevHash).toBe(lastEntries[2].hash)

    await logger2.close()
  })
})
