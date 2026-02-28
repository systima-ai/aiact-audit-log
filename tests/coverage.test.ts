import { describe, it, expect } from 'vitest'
import { analyseCoverage, type CoverageWarning } from '../src/coverage.js'
import type { AuditLogEntryExtended } from '../src/schema.js'
import { computeEntryHash, computeGenesisHash } from '../src/hash-chain.js'

function makeEntry(
  overrides: Partial<AuditLogEntryExtended> & { seq: number },
): AuditLogEntryExtended {
  const { seq, ...rest } = overrides
  const base: Omit<AuditLogEntryExtended, 'hash'> = {
    schemaVersion: 'v1',
    entryId: `entry-${seq}`,
    decisionId: 'dec_1',
    systemId: 'test-system',
    timestamp: '2026-03-15T10:00:00.000Z',
    eventType: 'inference',
    modelId: 'model-a',
    providerId: 'test',
    input: { type: 'raw', value: 'test' },
    output: { type: 'raw', value: 'response' },
    latencyMs: 100,
    usage: null,
    error: null,
    parameters: null,
    captureMethod: 'manual',
    seq,
    prevHash: computeGenesisHash('test-system'),
    ...rest,
  }

  const hash = computeEntryHash(base)
  return { ...base, hash } as AuditLogEntryExtended
}

function getCodes(warnings: CoverageWarning[]): string[] {
  return warnings.map((w) => w.code)
}

describe('analyseCoverage', () => {
  it('reports event type distribution', () => {
    const entries = [
      makeEntry({ seq: 0, eventType: 'inference' }),
      makeEntry({ seq: 1, eventType: 'inference' }),
      makeEntry({ seq: 2, eventType: 'tool_call', toolCall: { toolName: 'search', toolArgs: {} } }),
    ]

    const report = analyseCoverage(entries)

    expect(report.totalEntries).toBe(3)
    expect(report.byEventType['inference'].count).toBe(2)
    expect(report.byEventType['tool_call'].count).toBe(1)
  })

  it('reports capture method distribution', () => {
    const entries = [
      makeEntry({ seq: 0, captureMethod: 'middleware' }),
      makeEntry({ seq: 1, captureMethod: 'middleware' }),
      makeEntry({ seq: 2, captureMethod: 'manual' }),
    ]

    const report = analyseCoverage(entries)

    expect(report.byCaptureMethod['middleware'].count).toBe(2)
    expect(report.byCaptureMethod['manual'].count).toBe(1)
  })

  it('warns NO_HUMAN_INTERVENTIONS when none present', () => {
    const entries = [
      makeEntry({ seq: 0, eventType: 'inference' }),
    ]

    const report = analyseCoverage(entries)
    expect(getCodes(report.warnings)).toContain('NO_HUMAN_INTERVENTIONS')
  })

  it('does not warn NO_HUMAN_INTERVENTIONS when present', () => {
    const entries = [
      makeEntry({ seq: 0, eventType: 'inference' }),
      makeEntry({
        seq: 1,
        eventType: 'human_intervention',
        humanIntervention: {
          type: 'approval',
          userId: 'user_1',
          timestamp: '2026-03-15T10:00:01.000Z',
        },
      }),
    ]

    const report = analyseCoverage(entries)
    expect(getCodes(report.warnings)).not.toContain('NO_HUMAN_INTERVENTIONS')
  })

  it('warns NO_SESSION_BOUNDARIES when no session events', () => {
    const entries = [
      makeEntry({ seq: 0, eventType: 'inference' }),
    ]

    const report = analyseCoverage(entries)
    expect(getCodes(report.warnings)).toContain('NO_SESSION_BOUNDARIES')
  })

  it('warns TOOL_CALL_RESULT_MISMATCH when counts differ', () => {
    const entries: AuditLogEntryExtended[] = []
    for (let i = 0; i < 20; i++) {
      entries.push(makeEntry({
        seq: i,
        eventType: 'tool_call',
        toolCall: { toolName: 'search', toolArgs: {} },
      }))
    }
    for (let i = 0; i < 15; i++) {
      entries.push(makeEntry({
        seq: 20 + i,
        eventType: 'tool_result',
        toolCall: { toolName: 'search', toolArgs: {}, toolResult: 'result' },
      }))
    }

    const report = analyseCoverage(entries)
    expect(getCodes(report.warnings)).toContain('TOOL_CALL_RESULT_MISMATCH')
  })

  it('warns ALL_MANUAL_CAPTURE when 100% manual', () => {
    const entries = [
      makeEntry({ seq: 0, captureMethod: 'manual' }),
      makeEntry({ seq: 1, captureMethod: 'manual' }),
    ]

    const report = analyseCoverage(entries)
    expect(getCodes(report.warnings)).toContain('ALL_MANUAL_CAPTURE')
  })

  it('does not warn ALL_MANUAL_CAPTURE when middleware used', () => {
    const entries = [
      makeEntry({ seq: 0, captureMethod: 'middleware' }),
      makeEntry({ seq: 1, captureMethod: 'manual' }),
    ]

    const report = analyseCoverage(entries)
    expect(getCodes(report.warnings)).not.toContain('ALL_MANUAL_CAPTURE')
  })

  it('warns NO_ERROR_EVENTS for large error-free datasets', () => {
    const entries: AuditLogEntryExtended[] = []
    for (let i = 0; i < 1001; i++) {
      entries.push(makeEntry({ seq: i, error: null }))
    }

    const report = analyseCoverage(entries)
    expect(getCodes(report.warnings)).toContain('NO_ERROR_EVENTS')
  })

  it('does not warn NO_ERROR_EVENTS for small datasets', () => {
    const entries = [
      makeEntry({ seq: 0, error: null }),
    ]

    const report = analyseCoverage(entries)
    expect(getCodes(report.warnings)).not.toContain('NO_ERROR_EVENTS')
  })

  it('warns SINGLE_MODEL_ID for large single-model datasets', () => {
    const entries: AuditLogEntryExtended[] = []
    for (let i = 0; i < 101; i++) {
      entries.push(makeEntry({ seq: i, eventType: 'inference', modelId: 'model-a' }))
    }

    const report = analyseCoverage(entries)
    expect(getCodes(report.warnings)).toContain('SINGLE_MODEL_ID')
  })

  it('does not warn SINGLE_MODEL_ID for multiple models', () => {
    const entries: AuditLogEntryExtended[] = []
    for (let i = 0; i < 101; i++) {
      entries.push(makeEntry({
        seq: i,
        eventType: 'inference',
        modelId: i % 2 === 0 ? 'model-a' : 'model-b',
      }))
    }

    const report = analyseCoverage(entries)
    expect(getCodes(report.warnings)).not.toContain('SINGLE_MODEL_ID')
  })

  it('generates recommendations based on warnings', () => {
    const entries = [
      makeEntry({ seq: 0, captureMethod: 'manual' }),
    ]

    const report = analyseCoverage(entries)
    expect(report.recommendations.length).toBeGreaterThan(0)
  })

  it('handles empty entries array', () => {
    const report = analyseCoverage([])

    expect(report.totalEntries).toBe(0)
    expect(report.warnings.length).toBe(0)
    expect(report.recommendations.length).toBe(0)
  })
})
