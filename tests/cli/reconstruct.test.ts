import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AuditLogger } from '../../src/logger.js'
import { AuditLogReader } from '../../src/reader.js'
import { MemoryStorage } from '../../src/storage/memory.js'

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

describe('CLI reconstruct (decision trace)', () => {
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

  it('reconstructs a complete multi-step decision', async () => {
    await logger.log({
      decisionId: 'dec_loan_123',
      eventType: 'inference',
      modelId: 'anthropic/claude-sonnet-4-5-20250929',
      providerId: 'anthropic',
      input: { value: 'Assess credit risk for application #12345' },
      output: { value: 'Based on the data, risk score is 0.72' },
      latencyMs: 342,
      usage: { promptTokens: 150, completionTokens: 80, totalTokens: 230 },
      parameters: { temperature: 0.7 },
      error: null,
    })

    await logger.log({
      decisionId: 'dec_loan_123',
      eventType: 'tool_call',
      modelId: null,
      providerId: null,
      input: { value: '{"query": "credit_history"}' },
      output: null,
      latencyMs: null,
      usage: null,
      parameters: null,
      error: null,
      toolCall: { toolName: 'credit_lookup', toolArgs: { query: 'credit_history' } },
    })

    await logger.log({
      decisionId: 'dec_loan_123',
      eventType: 'tool_result',
      modelId: null,
      providerId: null,
      input: { value: '' },
      output: { value: '{"score": 720, "history": "good"}' },
      latencyMs: 45,
      usage: null,
      parameters: null,
      error: null,
      toolCall: { toolName: 'credit_lookup', toolArgs: {}, toolResult: '{"score": 720}' },
    })

    await logger.log({
      decisionId: 'dec_loan_123',
      eventType: 'human_intervention',
      modelId: null,
      providerId: null,
      input: { value: '' },
      output: { value: 'Approved with modified terms' },
      latencyMs: null,
      usage: null,
      parameters: null,
      error: null,
      humanIntervention: {
        type: 'modification',
        userId: 'reviewer_hash_a1b2c3',
        reason: 'Applicant provided additional documentation',
        originalOutput: { type: 'raw', value: 'Loan application rejected: insufficient income' },
        timestamp: new Date().toISOString(),
      },
    })

    await logger.flush()

    const result = await reader.reconstruct('dec_loan_123')

    expect(result.decisionId).toBe('dec_loan_123')
    expect(result.entries.length).toBe(4)
    expect(result.entries[0].eventType).toBe('inference')
    expect(result.entries[1].eventType).toBe('tool_call')
    expect(result.entries[2].eventType).toBe('tool_result')
    expect(result.entries[3].eventType).toBe('human_intervention')
    expect(result.integrity.valid).toBe(true)
    expect(result.integrity.entriesChecked).toBe(4)
  })

  it('builds a human-readable timeline', async () => {
    await logger.log({
      decisionId: 'dec_timeline',
      eventType: 'inference',
      modelId: 'model-a',
      providerId: 'test',
      input: { value: 'prompt' },
      output: { value: 'response' },
      latencyMs: 200,
      usage: null,
      parameters: null,
      error: null,
    })

    await logger.log({
      decisionId: 'dec_timeline',
      eventType: 'tool_call',
      modelId: null,
      providerId: null,
      input: { value: '' },
      output: null,
      latencyMs: null,
      usage: null,
      parameters: null,
      error: null,
      toolCall: { toolName: 'search', toolArgs: { q: 'test' } },
    })

    await logger.flush()

    const result = await reader.reconstruct('dec_timeline')

    expect(result.timeline.length).toBe(2)
    expect(result.timeline[0].eventType).toBe('inference')
    expect(result.timeline[0].summary).toContain('Inference')
    expect(result.timeline[0].summary).toContain('model-a')
    expect(result.timeline[1].eventType).toBe('tool_call')
    expect(result.timeline[1].summary).toContain('Tool call')
    expect(result.timeline[1].summary).toContain('search')
  })

  it('returns empty result for non-existent decision', async () => {
    await logger.log({
      decisionId: 'dec_other',
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

    expect(result.decisionId).toBe('dec_nonexistent')
    expect(result.entries.length).toBe(0)
    expect(result.timeline.length).toBe(0)
  })

  it('isolates entries by decisionId', async () => {
    await logger.log({
      decisionId: 'dec_A',
      eventType: 'inference',
      modelId: 'model-a',
      providerId: null,
      input: { value: 'A prompt' },
      output: { value: 'A response' },
      latencyMs: 100,
      usage: null,
      parameters: null,
      error: null,
    })

    await logger.log({
      decisionId: 'dec_B',
      eventType: 'inference',
      modelId: 'model-b',
      providerId: null,
      input: { value: 'B prompt' },
      output: { value: 'B response' },
      latencyMs: 200,
      usage: null,
      parameters: null,
      error: null,
    })

    await logger.log({
      decisionId: 'dec_A',
      eventType: 'tool_call',
      modelId: null,
      providerId: null,
      input: { value: '' },
      output: null,
      latencyMs: null,
      usage: null,
      parameters: null,
      error: null,
      toolCall: { toolName: 'lookup', toolArgs: {} },
    })

    await logger.flush()

    const resultA = await reader.reconstruct('dec_A')
    const resultB = await reader.reconstruct('dec_B')

    expect(resultA.entries.length).toBe(2)
    expect(resultB.entries.length).toBe(1)
    expect(resultA.entries.every((e) => e.decisionId === 'dec_A')).toBe(true)
    expect(resultB.entries.every((e) => e.decisionId === 'dec_B')).toBe(true)
  })

  it('orders entries by sequence number', async () => {
    for (let i = 0; i < 5; i++) {
      await logger.log({
        decisionId: 'dec_ordered',
        eventType: 'inference',
        modelId: null,
        providerId: null,
        input: { value: `step-${i}` },
        output: null,
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
        stepIndex: i,
      })
    }
    await logger.flush()

    const result = await reader.reconstruct('dec_ordered')

    for (let i = 1; i < result.entries.length; i++) {
      expect(result.entries[i].seq).toBeGreaterThan(result.entries[i - 1].seq)
    }
  })

  it('includes timeline entries with valid entryIds', async () => {
    await logger.log({
      decisionId: 'dec_ids',
      eventType: 'session_start',
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
      decisionId: 'dec_ids',
      eventType: 'inference',
      modelId: 'model-a',
      providerId: null,
      input: { value: 'test' },
      output: { value: 'result' },
      latencyMs: 50,
      usage: null,
      parameters: null,
      error: null,
    })

    await logger.log({
      decisionId: 'dec_ids',
      eventType: 'session_end',
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

    const result = await reader.reconstruct('dec_ids')

    expect(result.timeline.length).toBe(3)
    for (const t of result.timeline) {
      expect(t.entryId).toBeTruthy()
      expect(t.timestamp).toBeTruthy()
    }
    expect(result.timeline[0].summary).toContain('Session started')
    expect(result.timeline[1].summary).toContain('Inference')
    expect(result.timeline[2].summary).toContain('Session ended')
  })
})
