import { describe, it, expect } from 'vitest'
import {
  validateLogEntryInput,
  validateAuditLogEntry,
  SchemaValidationError,
  type LogEntryInput,
  type AuditLogEntry,
} from '../src/schema.js'

function validInput(overrides?: Partial<LogEntryInput>): LogEntryInput {
  return {
    eventType: 'inference',
    modelId: 'anthropic/claude-sonnet-4-5-20250929',
    providerId: 'anthropic',
    input: { value: 'test prompt' },
    output: { value: 'test response' },
    latencyMs: 100,
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    parameters: { temperature: 0.7 },
    error: null,
    ...overrides,
  }
}

function validEntry(overrides?: Partial<AuditLogEntry>): AuditLogEntry {
  return {
    schemaVersion: 'v1',
    entryId: '01234567-89ab-7cde-8f01-234567890abc',
    decisionId: 'dec_test',
    systemId: 'test-system',
    timestamp: '2026-03-15T10:30:00.000Z',
    eventType: 'inference',
    modelId: 'anthropic/claude-sonnet-4-5-20250929',
    providerId: 'anthropic',
    input: { type: 'raw', value: 'test prompt' },
    output: { type: 'raw', value: 'test response' },
    latencyMs: 100,
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    error: null,
    parameters: { temperature: 0.7 },
    captureMethod: 'manual',
    seq: 0,
    prevHash: 'abc123',
    hash: 'def456',
    ...overrides,
  }
}

describe('validateLogEntryInput', () => {
  it('accepts a valid input', () => {
    expect(() => validateLogEntryInput(validInput())).not.toThrow()
  })

  it('rejects invalid eventType', () => {
    expect(() =>
      validateLogEntryInput(validInput({ eventType: 'invalid' as 'inference' })),
    ).toThrow(SchemaValidationError)
  })

  it('rejects missing input value', () => {
    expect(() =>
      validateLogEntryInput(validInput({ input: { value: 123 as unknown as string } })),
    ).toThrow(SchemaValidationError)
  })

  it('accepts null output', () => {
    expect(() => validateLogEntryInput(validInput({ output: null }))).not.toThrow()
  })

  it('rejects output with non-string value', () => {
    expect(() =>
      validateLogEntryInput(
        validInput({ output: { value: 123 as unknown as string } }),
      ),
    ).toThrow(SchemaValidationError)
  })

  it('rejects usage with non-number fields', () => {
    expect(() =>
      validateLogEntryInput(
        validInput({
          usage: {
            promptTokens: 'ten' as unknown as number,
            completionTokens: 20,
            totalTokens: 30,
          },
        }),
      ),
    ).toThrow(SchemaValidationError)
  })

  it('accepts null usage', () => {
    expect(() => validateLogEntryInput(validInput({ usage: null }))).not.toThrow()
  })

  it('rejects error with missing code', () => {
    expect(() =>
      validateLogEntryInput(
        validInput({
          error: { code: undefined as unknown as string, message: 'oops' },
        }),
      ),
    ).toThrow(SchemaValidationError)
  })

  it('rejects invalid captureMethod', () => {
    expect(() =>
      validateLogEntryInput(
        validInput({ captureMethod: 'invalid' as 'manual' }),
      ),
    ).toThrow(SchemaValidationError)
  })

  it('rejects negative latencyMs', () => {
    expect(() =>
      validateLogEntryInput(validInput({ latencyMs: -1 })),
    ).toThrow(SchemaValidationError)
  })

  it('accepts null latencyMs', () => {
    expect(() =>
      validateLogEntryInput(validInput({ latencyMs: null })),
    ).not.toThrow()
  })

  it('rejects invalid humanIntervention type', () => {
    expect(() =>
      validateLogEntryInput(
        validInput({
          humanIntervention: {
            type: 'invalid' as 'approval',
            userId: 'user_1',
            timestamp: '2026-03-15T10:30:00.000Z',
          },
        }),
      ),
    ).toThrow(SchemaValidationError)
  })

  it('rejects humanIntervention with empty userId', () => {
    expect(() =>
      validateLogEntryInput(
        validInput({
          humanIntervention: {
            type: 'approval',
            userId: '',
            timestamp: '2026-03-15T10:30:00.000Z',
          },
        }),
      ),
    ).toThrow(SchemaValidationError)
  })

  it('rejects toolCall with empty toolName', () => {
    expect(() =>
      validateLogEntryInput(
        validInput({
          toolCall: { toolName: '', toolArgs: {} },
        }),
      ),
    ).toThrow(SchemaValidationError)
  })

  it('rejects metadata with invalid value types', () => {
    expect(() =>
      validateLogEntryInput(
        validInput({
          metadata: { nested: { bad: true } as unknown as string },
        }),
      ),
    ).toThrow(SchemaValidationError)
  })

  it('accepts valid metadata', () => {
    expect(() =>
      validateLogEntryInput(
        validInput({
          metadata: { key: 'value', count: 42, active: true },
        }),
      ),
    ).not.toThrow()
  })
})

describe('validateAuditLogEntry', () => {
  it('accepts a valid entry', () => {
    expect(() => validateAuditLogEntry(validEntry())).not.toThrow()
  })

  it('rejects wrong schemaVersion', () => {
    expect(() =>
      validateAuditLogEntry(validEntry({ schemaVersion: 'v2' as 'v1' })),
    ).toThrow(SchemaValidationError)
  })

  it('rejects empty entryId', () => {
    expect(() =>
      validateAuditLogEntry(validEntry({ entryId: '' })),
    ).toThrow(SchemaValidationError)
  })

  it('rejects empty decisionId', () => {
    expect(() =>
      validateAuditLogEntry(validEntry({ decisionId: '' })),
    ).toThrow(SchemaValidationError)
  })

  it('rejects empty systemId', () => {
    expect(() =>
      validateAuditLogEntry(validEntry({ systemId: '' })),
    ).toThrow(SchemaValidationError)
  })

  it('rejects empty timestamp', () => {
    expect(() =>
      validateAuditLogEntry(validEntry({ timestamp: '' })),
    ).toThrow(SchemaValidationError)
  })

  it('rejects negative seq', () => {
    expect(() =>
      validateAuditLogEntry(validEntry({ seq: -1 })),
    ).toThrow(SchemaValidationError)
  })

  it('rejects non-integer seq', () => {
    expect(() =>
      validateAuditLogEntry(validEntry({ seq: 1.5 })),
    ).toThrow(SchemaValidationError)
  })

  it('rejects empty prevHash', () => {
    expect(() =>
      validateAuditLogEntry(validEntry({ prevHash: '' })),
    ).toThrow(SchemaValidationError)
  })

  it('rejects empty hash', () => {
    expect(() =>
      validateAuditLogEntry(validEntry({ hash: '' })),
    ).toThrow(SchemaValidationError)
  })

  it('rejects invalid captureMethod', () => {
    expect(() =>
      validateAuditLogEntry(validEntry({ captureMethod: 'auto' as 'manual' })),
    ).toThrow(SchemaValidationError)
  })
})
