import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AuditLogger } from '../../src/logger.js'
import { AuditLogReader } from '../../src/reader.js'
import { MemoryStorage } from '../../src/storage/memory.js'
import { analyseCoverage } from '../../src/coverage.js'
import type { CoverageWarning } from '../../src/coverage.js'

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

function getCodes(warnings: CoverageWarning[]): string[] {
  return warnings.map((w) => w.code)
}

describe('CLI coverage (end-to-end via reader + analyseCoverage)', () => {
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

  it('produces a complete coverage report from real logged entries', async () => {
    await logger.log({
      decisionId: 'dec_1',
      eventType: 'inference',
      modelId: 'model-a',
      providerId: 'test',
      input: { value: 'prompt' },
      output: { value: 'response' },
      latencyMs: 100,
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

    await logger.log({
      decisionId: 'dec_1',
      eventType: 'tool_result',
      modelId: null,
      providerId: null,
      input: { value: '' },
      output: { value: 'result' },
      latencyMs: 20,
      usage: null,
      parameters: null,
      error: null,
      toolCall: { toolName: 'search', toolArgs: {}, toolResult: 'result' },
    })

    await logger.flush()

    const entries = await reader.query()
    const report = analyseCoverage(entries)

    expect(report.totalEntries).toBe(3)
    expect(report.byEventType['inference'].count).toBe(1)
    expect(report.byEventType['tool_call'].count).toBe(1)
    expect(report.byEventType['tool_result'].count).toBe(1)
    expect(report.byEventType['human_intervention'].count).toBe(0)

    expect(getCodes(report.warnings)).toContain('NO_HUMAN_INTERVENTIONS')
    expect(getCodes(report.warnings)).toContain('NO_SESSION_BOUNDARIES')
    expect(getCodes(report.warnings)).toContain('ALL_MANUAL_CAPTURE')
  })

  it('does not warn when all event types are present', async () => {
    await logger.log({
      decisionId: 'dec_1',
      eventType: 'session_start',
      modelId: null,
      providerId: null,
      input: { value: '' },
      output: null,
      latencyMs: null,
      usage: null,
      parameters: null,
      error: null,
      captureMethod: 'middleware',
    })

    await logger.log({
      decisionId: 'dec_1',
      eventType: 'inference',
      modelId: 'model-a',
      providerId: 'test',
      input: { value: 'prompt' },
      output: { value: 'response' },
      latencyMs: 100,
      usage: null,
      parameters: null,
      error: null,
      captureMethod: 'middleware',
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
      captureMethod: 'middleware',
    })

    await logger.log({
      decisionId: 'dec_1',
      eventType: 'tool_result',
      modelId: null,
      providerId: null,
      input: { value: '' },
      output: { value: 'result' },
      latencyMs: null,
      usage: null,
      parameters: null,
      error: null,
      toolCall: { toolName: 'search', toolArgs: {}, toolResult: 'found' },
      captureMethod: 'middleware',
    })

    await logger.log({
      decisionId: 'dec_1',
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

    await logger.log({
      decisionId: 'dec_1',
      eventType: 'system_event',
      modelId: null,
      providerId: null,
      input: { value: 'config change' },
      output: null,
      latencyMs: null,
      usage: null,
      parameters: null,
      error: null,
    })

    await logger.log({
      decisionId: 'dec_1',
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

    const entries = await reader.query()
    const report = analyseCoverage(entries)

    expect(getCodes(report.warnings)).not.toContain('NO_HUMAN_INTERVENTIONS')
    expect(getCodes(report.warnings)).not.toContain('NO_SESSION_BOUNDARIES')
    expect(getCodes(report.warnings)).not.toContain('ALL_MANUAL_CAPTURE')
    expect(getCodes(report.warnings)).not.toContain('NO_SYSTEM_EVENTS')
  })

  it('detects tool call/result mismatch from real entries', async () => {
    for (let i = 0; i < 20; i++) {
      await logger.log({
        decisionId: `dec_${i}`,
        eventType: 'tool_call',
        modelId: null,
        providerId: null,
        input: { value: '' },
        output: null,
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
        toolCall: { toolName: `tool_${i}`, toolArgs: {} },
      })
    }

    for (let i = 0; i < 15; i++) {
      await logger.log({
        decisionId: `dec_${i}`,
        eventType: 'tool_result',
        modelId: null,
        providerId: null,
        input: { value: '' },
        output: { value: `result_${i}` },
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
        toolCall: { toolName: `tool_${i}`, toolArgs: {}, toolResult: `result_${i}` },
      })
    }

    await logger.flush()

    const entries = await reader.query()
    const report = analyseCoverage(entries)

    expect(getCodes(report.warnings)).toContain('TOOL_CALL_RESULT_MISMATCH')
    const mismatchWarning = report.warnings.find((w) => w.code === 'TOOL_CALL_RESULT_MISMATCH')
    expect(mismatchWarning!.severity).toBe('high')
  })

  it('reports capture method distribution from middleware entries', async () => {
    await logger.log({
      decisionId: 'dec_1',
      eventType: 'inference',
      modelId: 'model-a',
      providerId: 'test',
      input: { value: '' },
      output: { value: '' },
      latencyMs: 100,
      usage: null,
      parameters: null,
      error: null,
      captureMethod: 'middleware',
    })

    await logger.log({
      decisionId: 'dec_2',
      eventType: 'inference',
      modelId: 'model-a',
      providerId: 'test',
      input: { value: '' },
      output: { value: '' },
      latencyMs: 100,
      usage: null,
      parameters: null,
      error: null,
      captureMethod: 'middleware',
    })

    await logger.log({
      decisionId: 'dec_3',
      eventType: 'human_intervention',
      modelId: null,
      providerId: null,
      input: { value: '' },
      output: { value: 'noted' },
      latencyMs: null,
      usage: null,
      parameters: null,
      error: null,
      humanIntervention: {
        type: 'approval',
        userId: 'user_1',
        timestamp: new Date().toISOString(),
      },
    })

    await logger.flush()

    const entries = await reader.query()
    const report = analyseCoverage(entries)

    expect(report.byCaptureMethod['middleware'].count).toBe(2)
    expect(report.byCaptureMethod['manual'].count).toBe(1)
    expect(report.byCaptureMethod['middleware'].percentage).toBeCloseTo(66.7, 0)
  })

  it('generates relevant recommendations for identified gaps', async () => {
    await logger.log({
      decisionId: 'dec_1',
      eventType: 'inference',
      modelId: 'model-a',
      providerId: 'test',
      input: { value: '' },
      output: { value: '' },
      latencyMs: 100,
      usage: null,
      parameters: null,
      error: null,
    })

    await logger.flush()

    const entries = await reader.query()
    const report = analyseCoverage(entries)

    expect(report.recommendations.length).toBeGreaterThan(0)
    const allRecs = report.recommendations.join(' ')
    expect(allRecs).toContain('middleware')
  })
})
