/**
 * CLI entry point for @systima/aiact-audit-log
 *
 * Commands:
 *   query       — Search logs by time range, filters
 *   reconstruct — Full decision trace from ID
 *   verify      — Validate hash chain integrity
 *   stats       — Aggregate metrics for monitoring
 *   coverage    — Diagnose logging gaps
 *   health      — Check compliance configuration
 *   export      — Export logs in compliance formats
 */

import { defineCommand, runMain } from 'citty'
import { queryCommand } from './query.js'
import { reconstructCommand } from './reconstruct.js'
import { verifyCommand } from './verify.js'
import { statsCommand } from './stats.js'
import { coverageCommand } from './coverage.js'
import { healthCommand } from './health.js'
import { exportCommand } from './export.js'

const main = defineCommand({
  meta: {
    name: 'aiact-audit-log',
    version: '0.1.0',
    description: 'EU AI Act Article 12 audit log management',
  },
  subCommands: {
    query: queryCommand,
    reconstruct: reconstructCommand,
    verify: verifyCommand,
    stats: statsCommand,
    coverage: coverageCommand,
    health: healthCommand,
    export: exportCommand,
  },
})

runMain(main)
