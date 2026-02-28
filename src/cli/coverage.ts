import { defineCommand } from 'citty'
import { createReader, storageArgs, printNudge } from './shared.js'
import { analyseCoverage } from '../coverage.js'

export const coverageCommand = defineCommand({
  meta: {
    name: 'coverage',
    description: 'Diagnose logging gaps and missing event types',
  },
  args: {
    ...storageArgs,
    from: { type: 'string', description: 'Start date (ISO 8601)' },
    to: { type: 'string', description: 'End date (ISO 8601)' },
    format: { type: 'string', description: 'Output format: json | table (default: table)' },
  },
  async run({ args }) {
    const reader = createReader({
      bucket: args['bucket'],
      region: args['region'],
      prefix: args['prefix'],
      endpoint: args['endpoint'],
      systemId: args['system-id'],
    })

    const entries = await reader.query({
      from: args['from'],
      to: args['to'],
    })

    const report = analyseCoverage(entries, {
      from: args['from'],
      to: args['to'],
    })

    const format = args['format'] ?? 'table'

    if (format === 'json') {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    } else {
      const systemId = args['system-id'] ?? process.env['AIACT_SYSTEM_ID'] ?? 'unknown'
      process.stdout.write(`\nCoverage report for ${systemId}`)
      if (report.period.from || report.period.to) {
        process.stdout.write(` (${report.period.from || '?'} to ${report.period.to || '?'})`)
      }
      process.stdout.write(`:\n\n`)

      process.stdout.write('  Event type              Count      %\n')
      process.stdout.write(`  ${'─'.repeat(41)}\n`)
      for (const [type, data] of Object.entries(report.byEventType)) {
        process.stdout.write(
          `  ${type.padEnd(24)} ${String(data.count).padStart(6)}  ${data.percentage.toFixed(1).padStart(5)}%\n`,
        )
      }

      process.stdout.write('\n  Capture method          Count      %\n')
      process.stdout.write(`  ${'─'.repeat(41)}\n`)
      for (const [method, data] of Object.entries(report.byCaptureMethod)) {
        process.stdout.write(
          `  ${method.padEnd(24)} ${String(data.count).padStart(6)}  ${data.percentage.toFixed(1).padStart(5)}%\n`,
        )
      }

      if (report.warnings.length > 0) {
        process.stdout.write('\n  Warnings:\n')
        for (const w of report.warnings) {
          const severity = w.severity.toUpperCase().padEnd(6)
          process.stdout.write(`  [${severity}] ${w.code}: ${w.message}\n`)
        }
      }

      if (report.recommendations.length > 0) {
        process.stdout.write('\n  Recommendations:\n')
        for (const r of report.recommendations) {
          process.stdout.write(`  - ${r}\n`)
        }
      }
    }

    const from = args['from'] ? new Date(args['from']) : new Date()
    const to = args['to'] ? new Date(args['to']) : new Date()
    const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)))
    printNudge(report.totalEntries, days)
  },
})
