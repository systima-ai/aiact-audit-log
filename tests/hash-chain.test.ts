import { describe, it, expect } from 'vitest'
import {
  computeGenesisHash,
  computeEntryHash,
  verifyEntryHash,
  verifyChain,
  verifyChainFromGenesis,
  sha256,
} from '../src/hash-chain.js'
import type { AuditLogEntry } from '../src/schema.js'

function makeEntry(
  seq: number,
  prevHash: string,
  overrides?: Partial<AuditLogEntry>,
): AuditLogEntry {
  const base: Omit<AuditLogEntry, 'hash'> = {
    schemaVersion: 'v1',
    entryId: `entry-${seq}`,
    decisionId: 'dec_test',
    systemId: 'test-system',
    timestamp: `2026-03-15T10:30:0${seq}.000Z`,
    eventType: 'inference',
    modelId: 'test-model',
    providerId: 'test',
    input: { type: 'raw', value: `input-${seq}` },
    output: { type: 'raw', value: `output-${seq}` },
    latencyMs: 100,
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    error: null,
    parameters: null,
    captureMethod: 'manual',
    seq,
    prevHash,
    ...overrides,
  }

  const hash = computeEntryHash(base)
  return { ...base, hash }
}

function buildChain(systemId: string, count: number): AuditLogEntry[] {
  const entries: AuditLogEntry[] = []
  let prevHash = computeGenesisHash(systemId)

  for (let i = 0; i < count; i++) {
    const entry = makeEntry(i, prevHash, { systemId })
    entries.push(entry)
    prevHash = entry.hash
  }

  return entries
}

describe('sha256', () => {
  it('produces consistent hashes for the same input', () => {
    const a = sha256('hello world')
    const b = sha256('hello world')

    expect(a).toBe(b)
  })

  it('produces different hashes for different inputs', () => {
    const a = sha256('hello')
    const b = sha256('world')

    expect(a).not.toBe(b)
  })

  it('produces 64-character lowercase hex strings', () => {
    const h = sha256('test')

    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('computeGenesisHash', () => {
  it('produces consistent hashes for the same systemId', () => {
    const a = computeGenesisHash('system-1')
    const b = computeGenesisHash('system-1')

    expect(a).toBe(b)
  })

  it('produces different hashes for different systemIds', () => {
    const a = computeGenesisHash('system-1')
    const b = computeGenesisHash('system-2')

    expect(a).not.toBe(b)
  })

  it('uses the documented seed format', () => {
    const hash = computeGenesisHash('my-system')
    const expected = sha256('@systima/aiact-audit-log:genesis:my-system')

    expect(hash).toBe(expected)
  })
})

describe('computeEntryHash', () => {
  it('produces consistent hashes for the same entry', () => {
    const entry: Omit<AuditLogEntry, 'hash'> = {
      schemaVersion: 'v1',
      entryId: 'entry-0',
      decisionId: 'dec_test',
      systemId: 'test-system',
      timestamp: '2026-03-15T10:30:00.000Z',
      eventType: 'inference',
      modelId: 'test-model',
      providerId: 'test',
      input: { type: 'raw', value: 'test input' },
      output: { type: 'raw', value: 'test output' },
      latencyMs: 100,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      error: null,
      parameters: null,
      captureMethod: 'manual',
      seq: 0,
      prevHash: 'genesis',
    }

    const a = computeEntryHash(entry)
    const b = computeEntryHash(entry)

    expect(a).toBe(b)
  })

  it('produces different hashes when entry content differs', () => {
    const base: Omit<AuditLogEntry, 'hash'> = {
      schemaVersion: 'v1',
      entryId: 'entry-0',
      decisionId: 'dec_test',
      systemId: 'test-system',
      timestamp: '2026-03-15T10:30:00.000Z',
      eventType: 'inference',
      modelId: 'test-model',
      providerId: 'test',
      input: { type: 'raw', value: 'test input' },
      output: { type: 'raw', value: 'test output' },
      latencyMs: 100,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      error: null,
      parameters: null,
      captureMethod: 'manual',
      seq: 0,
      prevHash: 'genesis',
    }

    const modified = { ...base, input: { type: 'raw' as const, value: 'different input' } }

    expect(computeEntryHash(base)).not.toBe(computeEntryHash(modified))
  })

  it('ignores the hash field if present on the input', () => {
    const entry: Omit<AuditLogEntry, 'hash'> = {
      schemaVersion: 'v1',
      entryId: 'entry-0',
      decisionId: 'dec_test',
      systemId: 'test-system',
      timestamp: '2026-03-15T10:30:00.000Z',
      eventType: 'inference',
      modelId: 'test-model',
      providerId: 'test',
      input: { type: 'raw', value: 'test input' },
      output: { type: 'raw', value: 'test output' },
      latencyMs: 100,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      error: null,
      parameters: null,
      captureMethod: 'manual',
      seq: 0,
      prevHash: 'genesis',
    }

    const withHash = { ...entry, hash: 'should-be-ignored' }
    const withoutHash = { ...entry }

    expect(computeEntryHash(withHash)).toBe(computeEntryHash(withoutHash))
  })
})

describe('verifyEntryHash', () => {
  it('returns true for a correctly hashed entry', () => {
    const entry = makeEntry(0, 'genesis')

    expect(verifyEntryHash(entry)).toBe(true)
  })

  it('returns false if entry content was modified', () => {
    const entry = makeEntry(0, 'genesis')
    const tampered = { ...entry, input: { type: 'raw' as const, value: 'tampered' } }

    expect(verifyEntryHash(tampered)).toBe(false)
  })

  it('returns false if hash was replaced', () => {
    const entry = makeEntry(0, 'genesis')
    const tampered = { ...entry, hash: 'wrong-hash' }

    expect(verifyEntryHash(tampered)).toBe(false)
  })
})

describe('verifyChain', () => {
  it('returns valid for an empty chain', () => {
    const result = verifyChain([])

    expect(result.valid).toBe(true)
    expect(result.entriesChecked).toBe(0)
    expect(result.firstBreak).toBeNull()
  })

  it('returns valid for a single entry', () => {
    const entry = makeEntry(0, 'genesis')
    const result = verifyChain([entry])

    expect(result.valid).toBe(true)
    expect(result.entriesChecked).toBe(1)
  })

  it('returns valid for a correct chain of entries', () => {
    const chain = buildChain('test-system', 10)
    const result = verifyChain(chain)

    expect(result.valid).toBe(true)
    expect(result.entriesChecked).toBe(10)
    expect(result.firstBreak).toBeNull()
  })

  it('detects a tampered entry in the middle of the chain', () => {
    const chain = buildChain('test-system', 5)
    chain[2] = { ...chain[2], input: { type: 'raw', value: 'tampered' } }

    const result = verifyChain(chain)

    expect(result.valid).toBe(false)
    expect(result.firstBreak).not.toBeNull()
    expect(result.firstBreak!.seq).toBe(2)
  })

  it('detects a broken prevHash link', () => {
    const chain = buildChain('test-system', 5)
    const tamperedEntry = makeEntry(3, 'wrong-prev-hash', { systemId: 'test-system' })
    chain[3] = tamperedEntry

    const result = verifyChain(chain)

    expect(result.valid).toBe(false)
    expect(result.firstBreak).not.toBeNull()
    expect(result.firstBreak!.seq).toBe(3)
  })

  it('handles entries in non-sequential order (sorts by seq)', () => {
    const chain = buildChain('test-system', 5)
    const shuffled = [chain[3], chain[0], chain[4], chain[1], chain[2]]

    const result = verifyChain(shuffled)

    expect(result.valid).toBe(true)
    expect(result.entriesChecked).toBe(5)
  })
})

describe('verifyChainFromGenesis', () => {
  it('validates genesis entry prevHash matches computed genesis hash', () => {
    const chain = buildChain('test-system', 3)
    const result = verifyChainFromGenesis(chain, 'test-system')

    expect(result.valid).toBe(true)
  })

  it('detects wrong genesis prevHash', () => {
    const chain = buildChain('test-system', 3)
    chain[0] = { ...chain[0], prevHash: 'wrong-genesis' }
    const recomputedHash = computeEntryHash(chain[0])
    chain[0] = { ...chain[0], hash: recomputedHash }

    const result = verifyChainFromGenesis(chain, 'test-system')

    expect(result.valid).toBe(false)
    expect(result.firstBreak).not.toBeNull()
    expect(result.firstBreak!.seq).toBe(0)
  })

  it('returns valid for empty entries', () => {
    const result = verifyChainFromGenesis([], 'test-system')

    expect(result.valid).toBe(true)
    expect(result.entriesChecked).toBe(0)
  })
})
