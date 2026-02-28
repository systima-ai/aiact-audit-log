import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AuditLogger } from '../src/logger.js'
import { AuditLogReader } from '../src/reader.js'
import { MemoryStorage } from '../src/storage/memory.js'

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

describe('AuditLogReader', () => {
  let logger: AuditLogger
  let reader: AuditLogReader

  beforeEach(() => {
    const setup = createTestSetup()
    logger = setup.logger
    reader = setup.reader
  })

  afterEach(async () => {
    await logger.close()
  })

  describe('query()', () => {
    it('returns all entries with no filters', async () => {
      await logger.log({
        decisionId: 'dec_1',
        eventType: 'inference',
        modelId: 'model-a',
        providerId: 'test',
        input: { value: 'prompt 1' },
        output: { value: 'response 1' },
        latencyMs: 100,
        usage: null,
        parameters: null,
        error: null,
      })

      await logger.log({
        decisionId: 'dec_2',
        eventType: 'tool_call',
        modelId: null,
        providerId: null,
        input: { value: 'tool input' },
        output: null,
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
        toolCall: { toolName: 'search', toolArgs: {} },
      })

      await logger.flush()

      const entries = await reader.query()
      expect(entries.length).toBe(2)
    })

    it('filters by eventType', async () => {
      await logger.log({
        decisionId: 'dec_1',
        eventType: 'inference',
        modelId: 'model-a',
        providerId: null,
        input: { value: '' },
        output: null,
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
      })

      await logger.log({
        decisionId: 'dec_1',
        eventType: 'tool_call',
        modelId: null,
        providerId: null,
        input: { value: '' },
        output: null,
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
        toolCall: { toolName: 'search', toolArgs: {} },
      })

      await logger.flush()

      const entries = await reader.query({ eventType: 'inference' })
      expect(entries.length).toBe(1)
      expect(entries[0].eventType).toBe('inference')
    })

    it('filters by decisionId', async () => {
      await logger.log({
        decisionId: 'dec_1',
        eventType: 'inference',
        modelId: null,
        providerId: null,
        input: { value: '' },
        output: null,
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
      })

      await logger.log({
        decisionId: 'dec_2',
        eventType: 'inference',
        modelId: null,
        providerId: null,
        input: { value: '' },
        output: null,
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
      })

      await logger.flush()

      const entries = await reader.query({ decisionId: 'dec_1' })
      expect(entries.length).toBe(1)
      expect(entries[0].decisionId).toBe('dec_1')
    })

    it('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await logger.log({
          decisionId: `dec_${i}`,
          eventType: 'inference',
          modelId: null,
          providerId: null,
          input: { value: '' },
          output: null,
          latencyMs: null,
          usage: null,
          parameters: null,
          error: null,
        })
      }

      await logger.flush()

      const entries = await reader.query({ limit: 3 })
      expect(entries.length).toBe(3)
    })
  })

  describe('reconstruct()', () => {
    it('reconstructs a multi-step decision', async () => {
      await logger.log({
        decisionId: 'dec_multi',
        eventType: 'inference',
        modelId: 'model-a',
        providerId: 'test',
        input: { value: 'initial prompt' },
        output: { value: 'initial response' },
        latencyMs: 100,
        usage: null,
        parameters: null,
        error: null,
      })

      await logger.log({
        decisionId: 'dec_multi',
        eventType: 'tool_call',
        modelId: null,
        providerId: null,
        input: { value: '{}' },
        output: null,
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
        toolCall: { toolName: 'search', toolArgs: { query: 'test' } },
      })

      await logger.log({
        decisionId: 'dec_multi',
        eventType: 'human_intervention',
        modelId: null,
        providerId: null,
        input: { value: '' },
        output: { value: 'approved' },
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
        humanIntervention: {
          type: 'approval',
          userId: 'reviewer_1',
          timestamp: new Date().toISOString(),
        },
      })

      await logger.flush()

      const result = await reader.reconstruct('dec_multi')

      expect(result.decisionId).toBe('dec_multi')
      expect(result.entries.length).toBe(3)
      expect(result.timeline.length).toBe(3)
      expect(result.integrity.valid).toBe(true)
      expect(result.entries[0].eventType).toBe('inference')
      expect(result.entries[1].eventType).toBe('tool_call')
      expect(result.entries[2].eventType).toBe('human_intervention')
    })

    it('returns empty result for unknown decisionId', async () => {
      await logger.log({
        decisionId: 'dec_1',
        eventType: 'inference',
        modelId: null,
        providerId: null,
        input: { value: '' },
        output: null,
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
      })

      await logger.flush()

      const result = await reader.reconstruct('dec_nonexistent')

      expect(result.entries.length).toBe(0)
      expect(result.timeline.length).toBe(0)
    })
  })

  describe('verifyChain()', () => {
    it('verifies a valid chain', async () => {
      for (let i = 0; i < 5; i++) {
        await logger.log({
          decisionId: `dec_${i}`,
          eventType: 'inference',
          modelId: null,
          providerId: null,
          input: { value: `test-${i}` },
          output: null,
          latencyMs: null,
          usage: null,
          parameters: null,
          error: null,
        })
      }

      await logger.flush()

      const result = await reader.verifyChain()

      expect(result.valid).toBe(true)
      expect(result.entriesChecked).toBe(5)
    })
  })

  describe('stats()', () => {
    it('computes aggregate statistics', async () => {
      for (let i = 0; i < 3; i++) {
        await logger.log({
          decisionId: `dec_${i}`,
          eventType: 'inference',
          modelId: 'model-a',
          providerId: 'test',
          input: { value: '' },
          output: { value: '' },
          latencyMs: 100 + i * 50,
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          parameters: null,
          error: null,
        })
      }

      await logger.log({
        decisionId: 'dec_err',
        eventType: 'inference',
        modelId: 'model-a',
        providerId: 'test',
        input: { value: '' },
        output: null,
        latencyMs: 500,
        usage: null,
        parameters: null,
        error: { code: 'TIMEOUT', message: 'Request timed out' },
      })

      await logger.flush()

      const stats = await reader.stats()

      expect(stats.totalEntries).toBe(4)
      expect(stats.byEventType['inference']).toBe(4)
      expect(stats.byModel['model-a']).toBe(4)
      expect(stats.errorRate).toBe(0.25)
      expect(stats.avgLatencyMs).toBeGreaterThan(0)
      expect(stats.tokenUsage.total).toBe(90)
    })
  })
})
