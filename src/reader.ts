/**
 * AuditLogReader — query, reconstruct, verify, and analyse audit logs.
 *
 * Supports Article 12(2) traceability requirements: given a decision
 * identifier, reconstruct everything. Given a time range, query and
 * analyse for post-market monitoring (Article 72).
 */

import type { StorageBackend, StorageConfig } from './storage/interface.js'
import { S3Storage } from './storage/s3.js'
import { FileSystemStorage } from './storage/filesystem.js'
import type { AuditLogEntry, AuditLogEntryExtended, EventType } from './schema.js'
import {
  verifyChain,
  verifyChainFromGenesis,
  type ChainVerificationResult,
} from './hash-chain.js'

// ── Configuration ───────────────────────────────────────────

export interface AuditLogReaderConfig {
  storage: StorageConfig
  systemId: string
}

// ── Query types ─────────────────────────────────────────────

export interface QueryOptions {
  from?: string
  to?: string
  eventType?: EventType
  decisionId?: string
  limit?: number
}

export interface ReconstructResult {
  decisionId: string
  entries: AuditLogEntryExtended[]
  timeline: TimelineEntry[]
  integrity: { valid: boolean; entriesChecked: number }
}

export interface TimelineEntry {
  timestamp: string
  eventType: string
  summary: string
  entryId: string
}

export interface StatsResult {
  totalEntries: number
  byEventType: Record<string, number>
  byModel: Record<string, number>
  byCaptureMethod: Record<string, number>
  errorRate: number
  avgLatencyMs: number | null
  p95LatencyMs: number | null
  p99LatencyMs: number | null
  tokenUsage: { prompt: number; completion: number; total: number }
}

// ── Reader implementation ───────────────────────────────────

export class AuditLogReader {
  private readonly storage: StorageBackend
  private readonly systemId: string

  constructor(config: AuditLogReaderConfig) {
    this.systemId = config.systemId

    if (config.storage.type === 's3') {
      this.storage = new S3Storage(config.storage)
    } else if (config.storage.type === 'filesystem') {
      this.storage = new FileSystemStorage(config.storage.directory)
    } else {
      throw new Error(`Unsupported storage type: ${(config.storage as { type: string }).type}`)
    }
  }

  static createWithStorage(
    config: AuditLogReaderConfig,
    storage: StorageBackend,
  ): AuditLogReader {
    const reader = new AuditLogReader(config)
    ;(reader as unknown as { storage: StorageBackend }).storage = storage
    return reader
  }

  getStorageBackend(): StorageBackend {
    return this.storage
  }

  async query(options: QueryOptions = {}): Promise<AuditLogEntryExtended[]> {
    const entries = await this.loadEntries(options.from, options.to)

    let filtered = entries

    if (options.eventType) {
      filtered = filtered.filter((e) => e.eventType === options.eventType)
    }

    if (options.decisionId) {
      filtered = filtered.filter((e) => e.decisionId === options.decisionId)
    }

    filtered.sort((a, b) => a.seq - b.seq)

    if (options.limit && filtered.length > options.limit) {
      filtered = filtered.slice(0, options.limit)
    }

    return filtered
  }

  async reconstruct(decisionId: string): Promise<ReconstructResult> {
    const allEntries = await this.loadAllEntries()
    const entries = allEntries
      .filter((e) => e.decisionId === decisionId)
      .sort((a, b) => a.seq - b.seq)

    const integrity = verifyChain(entries)

    const timeline: TimelineEntry[] = entries.map((e) => ({
      timestamp: e.timestamp,
      eventType: e.eventType,
      summary: buildSummary(e),
      entryId: e.entryId,
    }))

    return {
      decisionId,
      entries,
      timeline,
      integrity: { valid: integrity.valid, entriesChecked: integrity.entriesChecked },
    }
  }

  async verifyChain(options?: {
    from?: string
    to?: string
  }): Promise<ChainVerificationResult> {
    const entries = await this.loadEntries(options?.from, options?.to)
    return verifyChainFromGenesis(entries, this.systemId)
  }

  async stats(options?: { from?: string; to?: string }): Promise<StatsResult> {
    const entries = await this.loadEntries(options?.from, options?.to)

    const byEventType: Record<string, number> = {}
    const byModel: Record<string, number> = {}
    const byCaptureMethod: Record<string, number> = {}
    let errorCount = 0
    const latencies: number[] = []
    let promptTokens = 0
    let completionTokens = 0
    let totalTokens = 0

    for (const entry of entries) {
      byEventType[entry.eventType] = (byEventType[entry.eventType] ?? 0) + 1

      if (entry.modelId) {
        byModel[entry.modelId] = (byModel[entry.modelId] ?? 0) + 1
      }

      byCaptureMethod[entry.captureMethod] = (byCaptureMethod[entry.captureMethod] ?? 0) + 1

      if (entry.error) {
        errorCount++
      }

      if (entry.latencyMs !== null && entry.latencyMs !== undefined) {
        latencies.push(entry.latencyMs)
      }

      if (entry.usage) {
        promptTokens += entry.usage.promptTokens
        completionTokens += entry.usage.completionTokens
        totalTokens += entry.usage.totalTokens
      }
    }

    latencies.sort((a, b) => a - b)

    return {
      totalEntries: entries.length,
      byEventType,
      byModel,
      byCaptureMethod,
      errorRate: entries.length > 0 ? errorCount / entries.length : 0,
      avgLatencyMs: latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : null,
      p95LatencyMs: latencies.length > 0
        ? percentile(latencies, 0.95)
        : null,
      p99LatencyMs: latencies.length > 0
        ? percentile(latencies, 0.99)
        : null,
      tokenUsage: { prompt: promptTokens, completion: completionTokens, total: totalTokens },
    }
  }

  // ── Internal ──────────────────────────────────────────────

  private async loadEntries(from?: string, to?: string): Promise<AuditLogEntryExtended[]> {
    const datePrefixes = this.getDatePrefixes(from, to)
    const entries: AuditLogEntryExtended[] = []

    for (const prefix of datePrefixes) {
      const keys = await this.storage.list(prefix)
      const jsonlKeys = keys.filter((k) => k.endsWith('.jsonl'))

      for (const key of jsonlKeys) {
        try {
          const data = await this.storage.read(key)
          const lines = data.toString('utf-8').trim().split('\n')
          for (const line of lines) {
            if (line.trim()) {
              const entry = JSON.parse(line) as AuditLogEntryExtended
              if (isInTimeRange(entry.timestamp, from, to)) {
                entries.push(entry)
              }
            }
          }
        } catch {
          // Skip corrupted files
        }
      }
    }

    return entries
  }

  private async loadAllEntries(): Promise<AuditLogEntryExtended[]> {
    const keys = await this.storage.list(`${this.systemId}/`)
    const jsonlKeys = keys.filter((k) => k.endsWith('.jsonl'))
    const entries: AuditLogEntryExtended[] = []

    for (const key of jsonlKeys) {
      try {
        const data = await this.storage.read(key)
        const lines = data.toString('utf-8').trim().split('\n')
        for (const line of lines) {
          if (line.trim()) {
            entries.push(JSON.parse(line) as AuditLogEntryExtended)
          }
        }
      } catch {
        // Skip corrupted files
      }
    }

    return entries
  }

  private getDatePrefixes(from?: string, to?: string): string[] {
    if (!from && !to) {
      return [`${this.systemId}/`]
    }

    const startDate = from ? new Date(from) : new Date('2020-01-01')
    const endDate = to ? new Date(to) : new Date()
    const prefixes: string[] = []

    const current = new Date(startDate)
    while (current <= endDate) {
      const year = current.getUTCFullYear()
      const month = String(current.getUTCMonth() + 1).padStart(2, '0')
      const day = String(current.getUTCDate()).padStart(2, '0')
      prefixes.push(`${this.systemId}/${year}/${month}/${day}`)
      current.setUTCDate(current.getUTCDate() + 1)
    }

    return prefixes
  }
}

// ── Helpers ─────────────────────────────────────────────────

function isInTimeRange(timestamp: string, from?: string, to?: string): boolean {
  if (from && timestamp < from) return false
  if (to && timestamp > to) return false
  return true
}

function percentile(sorted: number[], p: number): number {
  const index = Math.ceil(sorted.length * p) - 1
  return sorted[Math.max(0, index)]
}

function buildSummary(entry: AuditLogEntryExtended): string {
  switch (entry.eventType) {
    case 'inference':
      return `Inference: ${entry.modelId ?? 'unknown model'}${entry.latencyMs ? ` (${entry.latencyMs}ms)` : ''}`
    case 'tool_call':
      return `Tool call: ${entry.toolCall?.toolName ?? 'unknown'}`
    case 'tool_result':
      return `Tool result: ${entry.toolCall?.toolName ?? 'unknown'}`
    case 'human_intervention':
      return `Human intervention: ${entry.humanIntervention?.type ?? 'unknown'} by ${entry.humanIntervention?.userId ?? 'unknown'}`
    case 'system_event':
      return `System event${entry.error ? ` (error: ${entry.error.code})` : ''}`
    case 'session_start':
      return 'Session started'
    case 'session_end':
      return 'Session ended'
    default:
      return entry.eventType
  }
}
