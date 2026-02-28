/**
 * Coverage diagnostic — analyses logs for completeness gaps.
 *
 * Addresses the core feedback: the real compliance risk is not the
 * schema but incomplete instrumentation. This module makes logging
 * gaps visible.
 */

import type { AuditLogEntryExtended, EventType } from './schema.js'
import { EVENT_TYPES, CAPTURE_METHODS } from './schema.js'

// ── Types ───────────────────────────────────────────────────

export interface CoverageReport {
  period: { from: string; to: string }
  totalEntries: number
  byEventType: Record<string, { count: number; percentage: number }>
  byCaptureMethod: Record<string, { count: number; percentage: number }>
  warnings: CoverageWarning[]
  recommendations: string[]
}

export interface CoverageWarning {
  severity: 'high' | 'medium' | 'low'
  code: string
  message: string
}

export interface CoverageOptions {
  from?: string
  to?: string
}

// ── Analysis ────────────────────────────────────────────────

export function analyseCoverage(
  entries: AuditLogEntryExtended[],
  options?: CoverageOptions,
): CoverageReport {
  const from = options?.from ?? (entries.length > 0 ? entries[0].timestamp : '')
  const to = options?.to ?? (entries.length > 0 ? entries[entries.length - 1].timestamp : '')
  const total = entries.length

  const eventCounts: Record<string, number> = {}
  for (const type of EVENT_TYPES) {
    eventCounts[type] = 0
  }
  for (const entry of entries) {
    eventCounts[entry.eventType] = (eventCounts[entry.eventType] ?? 0) + 1
  }

  const captureCounts: Record<string, number> = {}
  for (const method of CAPTURE_METHODS) {
    captureCounts[method] = 0
  }
  for (const entry of entries) {
    captureCounts[entry.captureMethod] = (captureCounts[entry.captureMethod] ?? 0) + 1
  }

  const byEventType: Record<string, { count: number; percentage: number }> = {}
  for (const [type, count] of Object.entries(eventCounts)) {
    byEventType[type] = {
      count,
      percentage: total > 0 ? (count / total) * 100 : 0,
    }
  }

  const byCaptureMethod: Record<string, { count: number; percentage: number }> = {}
  for (const [method, count] of Object.entries(captureCounts)) {
    byCaptureMethod[method] = {
      count,
      percentage: total > 0 ? (count / total) * 100 : 0,
    }
  }

  const warnings = generateWarnings(entries, eventCounts, captureCounts)
  const recommendations = generateRecommendations(warnings)

  return {
    period: { from, to },
    totalEntries: total,
    byEventType,
    byCaptureMethod,
    warnings,
    recommendations,
  }
}

// ── Warning rules ───────────────────────────────────────────

function generateWarnings(
  entries: AuditLogEntryExtended[],
  eventCounts: Record<string, number>,
  captureCounts: Record<string, number>,
): CoverageWarning[] {
  const warnings: CoverageWarning[] = []

  if (entries.length === 0) {
    return warnings
  }

  if (eventCounts['human_intervention'] === 0) {
    warnings.push({
      severity: 'medium',
      code: 'NO_HUMAN_INTERVENTIONS',
      message: 'No human interventions logged. If this system has human oversight, ensure human_intervention events are logged.',
    })
  }

  if (eventCounts['session_start'] === 0 && eventCounts['session_end'] === 0) {
    warnings.push({
      severity: 'medium',
      code: 'NO_SESSION_BOUNDARIES',
      message: 'No session boundaries logged. Article 12(3)(a) requires recording of usage periods.',
    })
  }

  const toolCalls = eventCounts['tool_call'] ?? 0
  const toolResults = eventCounts['tool_result'] ?? 0
  if (toolCalls > 0 && Math.abs(toolCalls - toolResults) / toolCalls > 0.05) {
    const diff = Math.abs(toolCalls - toolResults)
    warnings.push({
      severity: 'high',
      code: 'TOOL_CALL_RESULT_MISMATCH',
      message: `${diff} tool calls have no matching tool_result. Verify error handling logs results for failed tool calls.`,
    })
  }

  if (eventCounts['system_event'] === 0) {
    warnings.push({
      severity: 'low',
      code: 'NO_SYSTEM_EVENTS',
      message: 'No system events logged. Consider logging configuration changes and deployments.',
    })
  }

  const total = entries.length
  if (total > 0 && captureCounts['manual'] === total) {
    warnings.push({
      severity: 'medium',
      code: 'ALL_MANUAL_CAPTURE',
      message: 'All entries are manually captured. Consider using middleware for automatic inference logging to reduce coverage risk.',
    })
  }

  const errorEntries = entries.filter((e) => e.error !== null)
  if (total > 1000 && errorEntries.length === 0) {
    warnings.push({
      severity: 'low',
      code: 'NO_ERROR_EVENTS',
      message: `No error events logged across ${total} entries. If errors are handled silently, they may not appear in the audit trail.`,
    })
  }

  const modelIds = new Set(
    entries.filter((e) => e.eventType === 'inference' && e.modelId).map((e) => e.modelId),
  )
  const inferenceCount = eventCounts['inference'] ?? 0
  if (inferenceCount > 100 && modelIds.size === 1) {
    warnings.push({
      severity: 'low',
      code: 'SINGLE_MODEL_ID',
      message: 'All inference entries use a single model. If the system uses multiple models or fallbacks, verify all model calls are instrumented.',
    })
  }

  const sorted = [...entries].sort((a, b) => a.seq - b.seq)
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1].timestamp)
    const curr = new Date(sorted[i].timestamp)
    const gapMs = curr.getTime() - prev.getTime()
    const gapHours = gapMs / (1000 * 60 * 60)

    if (gapHours > 24 && isWeekday(prev) && isWeekday(curr)) {
      warnings.push({
        severity: 'high',
        code: 'LONG_GAP',
        message: `Gap of ${Math.round(gapHours)} hours detected between seq ${sorted[i - 1].seq} and seq ${sorted[i].seq}. Verify the system was operational during this period, or log a system_event if it was intentionally offline.`,
      })
      break
    }
  }

  return warnings
}

function generateRecommendations(warnings: CoverageWarning[]): string[] {
  const recommendations: string[] = []
  const codes = new Set(warnings.map((w) => w.code))

  if (codes.has('ALL_MANUAL_CAPTURE')) {
    recommendations.push(
      'Consider using middleware for automatic inference logging (currently 0% middleware-captured).',
    )
  }

  if (codes.has('NO_HUMAN_INTERVENTIONS')) {
    recommendations.push(
      'If this system has human oversight, ensure human_intervention events are logged per Article 14.',
    )
  }

  if (codes.has('NO_SESSION_BOUNDARIES')) {
    recommendations.push(
      'Session boundaries (session_start/session_end) are recommended for Article 12(3)(a) compliance.',
    )
  }

  if (codes.has('TOOL_CALL_RESULT_MISMATCH')) {
    const w = warnings.find((w) => w.code === 'TOOL_CALL_RESULT_MISMATCH')
    if (w) {
      recommendations.push(w.message.replace(/\.$/, '; verify error paths log tool_result events.'))
    }
  }

  if (codes.has('LONG_GAP')) {
    recommendations.push(
      'Large gaps in logging detected. Document intentional downtime with system_event entries.',
    )
  }

  return recommendations
}

function isWeekday(date: Date): boolean {
  const day = date.getUTCDay()
  return day >= 1 && day <= 5
}
