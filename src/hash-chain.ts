/**
 * Hash chain logic for tamper-evident audit logging.
 *
 * Each log entry contains:
 *   - seq: monotonically increasing sequence number
 *   - prevHash: hash of the previous entry
 *   - hash: hash of the current entry (excluding the hash field itself)
 *
 * The chain detects modification, deletion, and insertion by any party that
 * cannot recompute it. What "cannot recompute it" means depends on the mode:
 *
 *   - Unkeyed SHA-256 (default): anyone who can read and overwrite the stored
 *     objects can also recompute a self-consistent replacement chain, because
 *     the hash function takes no secret. In this mode the chain detects
 *     accidental corruption and partial tampering, and it detects deliberate
 *     tampering only when the log objects themselves cannot be rewritten.
 *     Pair it with write-once storage (S3 Object Lock) for that guarantee.
 *
 *   - HMAC-SHA256 (integrity.hmacKey set): recomputing the chain additionally
 *     requires the key. An attacker who reaches the storage bucket but not the
 *     key cannot forge a valid chain. An attacker who compromises the logging
 *     process itself holds the key and can, so this raises the bar rather than
 *     removing the need for write-once storage or an external anchor.
 *
 * Neither mode, on its own, proves when an entry was written. For that, anchor
 * the chain head periodically in a separate trust domain (a different account,
 * a timestamping authority, or a transparency log).
 */

import { createHash, createHmac } from 'node:crypto'
import { deterministicStringify } from './utils/serialise.js'
import type { AuditLogEntry, HashAlgorithm } from './schema.js'

export interface ChainKeyOptions {
  /** When present, entries are chained with HMAC-SHA256 under this key. */
  hmacKey?: string
}

export interface ChainHead {
  seq: number
  hash: string
  systemId: string
  updatedAt: string
  hashAlgorithm?: HashAlgorithm
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

export function computeGenesisHash(systemId: string, options?: ChainKeyOptions): string {
  const seed = `@systima/aiact-audit-log:genesis:${systemId}`
  return digest(seed, options)
}

export function computeEntryHash(
  entry: Omit<AuditLogEntry, 'hash'>,
  options?: ChainKeyOptions,
): string {
  const plain = entry as unknown as Record<string, unknown>
  const withoutHash: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(plain)) {
    if (key !== 'hash') {
      withoutHash[key] = value
    }
  }
  return digest(deterministicStringify(withoutHash), options)
}

export function verifyEntryHash(entry: AuditLogEntry, options?: ChainKeyOptions): boolean {
  const computed = computeEntryHash(entry, options)
  return timingSafeEqualHex(computed, entry.hash)
}

export function verifyChain(
  entries: AuditLogEntry[],
  options?: ChainKeyOptions,
): ChainVerificationResult {
  if (entries.length === 0) {
    return { valid: true, entriesChecked: 0, firstBreak: null }
  }

  const sorted = [...entries].sort((a, b) => a.seq - b.seq)

  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i]

    if (!verifyEntryHash(entry, options)) {
      return {
        valid: false,
        entriesChecked: i + 1,
        firstBreak: {
          seq: entry.seq,
          expectedPrevHash: entry.prevHash,
          actualPrevHash: `[hash mismatch on entry itself: computed ${computeEntryHash(entry, options)}, stored ${entry.hash}]`,
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
  options?: ChainKeyOptions,
): ChainVerificationResult {
  if (entries.length === 0) {
    return { valid: true, entriesChecked: 0, firstBreak: null }
  }

  const sorted = [...entries].sort((a, b) => a.seq - b.seq)
  const genesisEntry = sorted[0]

  if (genesisEntry.seq === 0) {
    const expectedGenesisPrevHash = computeGenesisHash(systemId, options)
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

  return verifyChain(sorted, options)
}

export function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

export function hmacSha256(data: string, key: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex')
}

function digest(data: string, options?: ChainKeyOptions): string {
  return options?.hmacKey ? hmacSha256(data, options.hmacKey) : sha256(data)
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return difference === 0
}
