import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AuditLogger } from '../src/logger.js'
import { MemoryStorage } from '../src/storage/memory.js'
import { ComplianceConfigError } from '../src/errors.js'
import { MissingDecisionIdError } from '../src/context.js'
import { withAuditContext } from '../src/context.js'
import { verifyEntryHash, computeGenesisHash } from '../src/hash-chain.js'
import type { AuditLogEntry } from '../src/schema.js'

function createTestLogger(
  overrides?: Partial<Parameters<typeof AuditLogger.createWithStorage>[0]>,
  storage?: MemoryStorage,
): { logger: AuditLogger; storage: MemoryStorage } {
  const mem = storage ?? new MemoryStorage()
  const config = {
    systemId: 'test-system',
    storage: {
      type: 's3' as const,
      bucket: 'test-bucket',
      region: 'eu-west-1',
    },
    retention: { minimumDays: 180 },
    batching: { maxSize: 1000, maxDelayMs: 60000 },
    ...overrides,
  }
  const logger = AuditLogger.createWithStorage(config, mem)
  return { logger, storage: mem }
}

describe('AuditLogger', () => {
  describe('constructor validation', () => {
    it('throws ComplianceConfigError for empty systemId', () => {
      expect(() =>
        createTestLogger({ systemId: '' }),
      ).toThrow(ComplianceConfigError)
    })

    it('throws ComplianceConfigError for whitespace-only systemId', () => {
      expect(() =>
        createTestLogger({ systemId: '   ' }),
      ).toThrow(ComplianceConfigError)
    })

    it('throws ComplianceConfigError for retention below 180 days', () => {
      expect(() =>
        createTestLogger({ retention: { minimumDays: 90 } }),
      ).toThrow(ComplianceConfigError)
    })

    it('allows sub-minimum retention with acknowledgeSubMinimum', () => {
      expect(() =>
        createTestLogger({
          retention: { minimumDays: 90, acknowledgeSubMinimum: true },
        }),
      ).not.toThrow()
    })

    it('accepts valid configuration', () => {
      expect(() => createTestLogger()).not.toThrow()
    })
  })

  describe('log()', () => {
    let logger: AuditLogger
    let storage: MemoryStorage

    beforeEach(() => {
      const result = createTestLogger()
      logger = result.logger
      storage = result.storage
    })

    afterEach(async () => {
      await logger.close()
    })

    it('logs an inference event', async () => {
      const entry = await logger.log({
        decisionId: 'dec_1',
        eventType: 'inference',
        modelId: 'test-model',
        providerId: 'test',
        input: { value: 'test prompt' },
        output: { value: 'test response' },
        latencyMs: 100,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        parameters: { temperature: 0.7 },
        error: null,
      })

      expect(entry.schemaVersion).toBe('v1')
      expect(entry.decisionId).toBe('dec_1')
      expect(entry.systemId).toBe('test-system')
      expect(entry.eventType).toBe('inference')
      expect(entry.seq).toBe(0)
      expect(entry.captureMethod).toBe('manual')
      expect(entry.entryId).toBeTruthy()
      expect(entry.hash).toBeTruthy()
      expect(entry.prevHash).toBeTruthy()
    })

    it('increments seq for each entry', async () => {
      const e1 = await logger.log({
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

      const e2 = await logger.log({
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

      expect(e1.seq).toBe(0)
      expect(e2.seq).toBe(1)
    })

    it('chains prevHash correctly', async () => {
      const e1 = await logger.log({
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

      const e2 = await logger.log({
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

      expect(e1.prevHash).toBe(computeGenesisHash('test-system'))
      expect(e2.prevHash).toBe(e1.hash)
    })

    it('produces verifiable entry hashes', async () => {
      const entry = await logger.log({
        decisionId: 'dec_1',
        eventType: 'inference',
        modelId: 'test-model',
        providerId: 'test',
        input: { value: 'test' },
        output: { value: 'response' },
        latencyMs: 50,
        usage: null,
        parameters: null,
        error: null,
      })

      expect(verifyEntryHash(entry as AuditLogEntry)).toBe(true)
    })

    it('throws MissingDecisionIdError without decisionId or context', async () => {
      await expect(
        logger.log({
          eventType: 'inference',
          modelId: null,
          providerId: null,
          input: { value: '' },
          output: null,
          latencyMs: null,
          usage: null,
          parameters: null,
          error: null,
        }),
      ).rejects.toThrow(MissingDecisionIdError)
    })

    it('inherits decisionId from AsyncLocalStorage context', async () => {
      const entry = await withAuditContext(
        { decisionId: 'ctx_dec_1' },
        () =>
          logger.log({
            eventType: 'inference',
            modelId: null,
            providerId: null,
            input: { value: '' },
            output: null,
            latencyMs: null,
            usage: null,
            parameters: null,
            error: null,
          }),
      )

      expect(entry.decisionId).toBe('ctx_dec_1')
    })

    it('inherits metadata from context', async () => {
      const entry = await withAuditContext(
        { decisionId: 'ctx_dec_1', metadata: { source: 'test' } },
        () =>
          logger.log({
            eventType: 'inference',
            modelId: null,
            providerId: null,
            input: { value: '' },
            output: null,
            latencyMs: null,
            usage: null,
            parameters: null,
            error: null,
          }),
      )

      expect(entry.metadata).toEqual({ source: 'test' })
    })

    it('merges entry metadata with context metadata', async () => {
      const entry = await withAuditContext(
        { decisionId: 'ctx_dec_1', metadata: { source: 'test' } },
        () =>
          logger.log({
            eventType: 'inference',
            modelId: null,
            providerId: null,
            input: { value: '' },
            output: null,
            latencyMs: null,
            usage: null,
            parameters: null,
            error: null,
            metadata: { extra: 'value' },
          }),
      )

      expect(entry.metadata).toEqual({ source: 'test', extra: 'value' })
    })

    it('sets captureMethod to context when context is active', async () => {
      const entry = await withAuditContext(
        { decisionId: 'ctx_dec_1' },
        () =>
          logger.log({
            eventType: 'inference',
            modelId: null,
            providerId: null,
            input: { value: '' },
            output: null,
            latencyMs: null,
            usage: null,
            parameters: null,
            error: null,
          }),
      )

      expect(entry.captureMethod).toBe('context')
    })

    it('explicit captureMethod overrides context default', async () => {
      const entry = await withAuditContext(
        { decisionId: 'ctx_dec_1' },
        () =>
          logger.log({
            eventType: 'inference',
            modelId: null,
            providerId: null,
            input: { value: '' },
            output: null,
            latencyMs: null,
            usage: null,
            parameters: null,
            error: null,
            captureMethod: 'middleware',
          }),
      )

      expect(entry.captureMethod).toBe('middleware')
    })
  })

  describe('PII handling', () => {
    it('hashes inputs when hashInputs is enabled', async () => {
      const { logger } = createTestLogger({
        pii: { hashInputs: true },
      })

      const entry = await logger.log({
        decisionId: 'dec_1',
        eventType: 'inference',
        modelId: null,
        providerId: null,
        input: { value: 'sensitive data' },
        output: null,
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
      })

      expect(entry.input.type).toBe('hash')
      expect(entry.input.value).not.toBe('sensitive data')
      expect(entry.input.value).toMatch(/^[0-9a-f]{64}$/)
    })

    it('hashes outputs when hashOutputs is enabled', async () => {
      const { logger } = createTestLogger({
        pii: { hashOutputs: true },
      })

      const entry = await logger.log({
        decisionId: 'dec_1',
        eventType: 'inference',
        modelId: null,
        providerId: null,
        input: { value: '' },
        output: { value: 'sensitive output' },
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
      })

      expect(entry.output!.type).toBe('hash')
      expect(entry.output!.value).not.toBe('sensitive output')
      expect(entry.output!.value).toMatch(/^[0-9a-f]{64}$/)
    })

    it('redacts patterns from input', async () => {
      const { logger } = createTestLogger({
        pii: { redactPatterns: [/\b[\w.-]+@[\w.-]+\.\w+\b/g] },
      })

      const entry = await logger.log({
        decisionId: 'dec_1',
        eventType: 'inference',
        modelId: null,
        providerId: null,
        input: { value: 'Contact user@example.com for details' },
        output: null,
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
      })

      expect(entry.input.value).toBe('Contact [REDACTED] for details')
    })
  })

  describe('flush()', () => {
    it('writes entries to storage', async () => {
      const { logger, storage } = createTestLogger()

      await logger.log({
        decisionId: 'dec_1',
        eventType: 'inference',
        modelId: null,
        providerId: null,
        input: { value: 'test' },
        output: null,
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
      })

      await logger.flush()

      const allFiles = await storage.list('')
      const jsonlFiles = allFiles.filter((k) => k.endsWith('.jsonl'))
      expect(jsonlFiles.length).toBeGreaterThan(0)
    })

    it('persists chain head after flush', async () => {
      const { logger, storage } = createTestLogger()

      await logger.log({
        decisionId: 'dec_1',
        eventType: 'inference',
        modelId: null,
        providerId: null,
        input: { value: 'test' },
        output: null,
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
      })

      await logger.flush()

      const headExists = await storage.exists('test-system/_chain/head.json')
      expect(headExists).toBe(true)

      const headData = await storage.read('test-system/_chain/head.json')
      const head = JSON.parse(headData.toString('utf-8'))
      expect(head.seq).toBe(0)
      expect(head.systemId).toBe('test-system')
    })

    it('auto-flushes when batch size is reached', async () => {
      const { logger, storage } = createTestLogger({
        batching: { maxSize: 3, maxDelayMs: 60000 },
      })

      for (let i = 0; i < 3; i++) {
        await logger.log({
          decisionId: 'dec_1',
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

      const allFiles = await storage.list('')
      const jsonlFiles = allFiles.filter((k) => k.endsWith('.jsonl'))
      expect(jsonlFiles.length).toBeGreaterThan(0)
    })
  })

  describe('close()', () => {
    it('flushes remaining entries on close', async () => {
      const { logger, storage } = createTestLogger()

      await logger.log({
        decisionId: 'dec_1',
        eventType: 'inference',
        modelId: null,
        providerId: null,
        input: { value: 'test' },
        output: null,
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
      })

      await logger.close()

      const allFiles = await storage.list('')
      const jsonlFiles = allFiles.filter((k) => k.endsWith('.jsonl'))
      expect(jsonlFiles.length).toBeGreaterThan(0)
    })

    it('rejects log() calls after close', async () => {
      const { logger } = createTestLogger()
      await logger.close()

      await expect(
        logger.log({
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
        }),
      ).rejects.toThrow('Logger is closed')
    })
  })

  describe('chain continuity across restarts', () => {
    it('resumes chain from stored head', async () => {
      const mem = new MemoryStorage()

      const { logger: logger1 } = createTestLogger({}, mem)
      const e1 = await logger1.log({
        decisionId: 'dec_1',
        eventType: 'inference',
        modelId: null,
        providerId: null,
        input: { value: 'first' },
        output: null,
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
      })
      await logger1.close()

      const { logger: logger2 } = createTestLogger({}, mem)
      const e2 = await logger2.log({
        decisionId: 'dec_2',
        eventType: 'inference',
        modelId: null,
        providerId: null,
        input: { value: 'second' },
        output: null,
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
      })

      expect(e2.seq).toBe(1)
      expect(e2.prevHash).toBe(e1.hash)

      await logger2.close()
    })
  })

  describe('healthCheck()', () => {
    it('returns healthy result for working storage', async () => {
      const { logger } = createTestLogger()
      await logger.init()

      const result = await logger.healthCheck()

      expect(result.healthy).toBe(true)
      expect(result.checks.length).toBeGreaterThan(0)
      expect(result.checks.every((c) => c.status === 'pass')).toBe(true)
    })
  })
})
