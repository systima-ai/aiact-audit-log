/**
 * SHA-256 hash chain logic for tamper-evident audit logging.
 *
 * Each log entry contains:
 *   - seq: monotonically increasing sequence number
 *   - prevHash: SHA-256 hash of the previous entry
 *   - hash: SHA-256 hash of the current entry (excluding the hash field itself)
 *
 * The chain proves ordering and non-modification. Combined with S3 Object Lock,
 * this provides the tamper-evidence required for trustworthy automatic recording
 * under Article 12(1).
 */

import { createHash } from 'node:crypto'
import { deterministicStringify } from './utils/serialise.js'
import type { AuditLogEntry } from './schema.js'

export interface ChainHead {
  seq: number
  hash: string
  systemId: string
  updatedAt: string
}

export interface ChainVerificationResult {
  valid: boolean
  entriesChecked: number
  firstBreak: {
    seq: number
    expectedPrevHash: string
    actualPrevHash: string
  } | null
}

export function computeGenesisHash(systemId: string): string {
  const seed = `@systima/aiact-audit-log:genesis:${systemId}`
  return sha256(seed)
}

export function computeEntryHash(entry: Omit<AuditLogEntry, 'hash'>): string {
  const plain = entry as unknown as Record<string, unknown>
  const withoutHash: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(plain)) {
    if (key !== 'hash') {
      withoutHash[key] = value
    }
  }
  return sha256(deterministicStringify(withoutHash))
}

export function verifyEntryHash(entry: AuditLogEntry): boolean {
  const computed = computeEntryHash(entry)
  return computed === entry.hash
}

export function verifyChain(entries: AuditLogEntry[]): ChainVerificationResult {
  if (entries.length === 0) {
    return { valid: true, entriesChecked: 0, firstBreak: null }
  }

  const sorted = [...entries].sort((a, b) => a.seq - b.seq)

  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i]

    if (!verifyEntryHash(entry)) {
      return {
        valid: false,
        entriesChecked: i + 1,
        firstBreak: {
          seq: entry.seq,
          expectedPrevHash: entry.prevHash,
          actualPrevHash: `[hash mismatch on entry itself: computed ${computeEntryHash(entry)}, stored ${entry.hash}]`,
        },
      }
    }

    if (i > 0) {
      const previousEntry = sorted[i - 1]
      if (entry.prevHash !== previousEntry.hash) {
        return {
          valid: false,
          entriesChecked: i + 1,
          firstBreak: {
            seq: entry.seq,
            expectedPrevHash: previousEntry.hash,
            actualPrevHash: entry.prevHash,
          },
        }
      }
    }
  }

  return {
    valid: true,
    entriesChecked: sorted.length,
    firstBreak: null,
  }
}

export function verifyChainFromGenesis(
  entries: AuditLogEntry[],
  systemId: string,
): ChainVerificationResult {
  if (entries.length === 0) {
    return { valid: true, entriesChecked: 0, firstBreak: null }
  }

  const sorted = [...entries].sort((a, b) => a.seq - b.seq)
  const genesisEntry = sorted[0]

  if (genesisEntry.seq === 0) {
    const expectedGenesisPrevHash = computeGenesisHash(systemId)
    if (genesisEntry.prevHash !== expectedGenesisPrevHash) {
      return {
        valid: false,
        entriesChecked: 1,
        firstBreak: {
          seq: 0,
          expectedPrevHash: expectedGenesisPrevHash,
          actualPrevHash: genesisEntry.prevHash,
        },
      }
    }
  }

  return verifyChain(sorted)
}

export function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}
