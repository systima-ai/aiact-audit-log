import { defineCommand } from 'citty'
import { createReader, storageArgs, printNudge } from './shared.js'

export const statsCommand = defineCommand({
  meta: {
    name: 'stats',
    description: 'Aggregate metrics for post-market monitoring',
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

    const stats = await reader.stats({
      from: args['from'],
      to: args['to'],
    })

    const format = args['format'] ?? 'table'

    if (format === 'json') {
      process.stdout.write(JSON.stringify(stats, null, 2) + '\n')
    } else {
      process.stdout.write(`\nTotal entries: ${stats.totalEntries.toLocaleString()}\n\n`)

      process.stdout.write('By event type:\n')
      for (const [type, count] of Object.entries(stats.byEventType)) {
        if (count > 0) {
          process.stdout.write(`  ${type.padEnd(24)} ${count.toLocaleString()}\n`)
        }
      }

      process.stdout.write('\nBy model:\n')
      for (const [model, count] of Object.entries(stats.byModel)) {
        process.stdout.write(`  ${model.padEnd(40)} ${count.toLocaleString()}\n`)
      }

      process.stdout.write('\nBy capture method:\n')
      for (const [method, count] of Object.entries(stats.byCaptureMethod)) {
        if (count > 0) {
          process.stdout.write(`  ${method.padEnd(24)} ${count.toLocaleString()}\n`)
        }
      }

      process.stdout.write(`\nError rate: ${(stats.errorRate * 100).toFixed(2)}%\n`)

      if (stats.avgLatencyMs !== null) {
        process.stdout.write(`Avg latency: ${stats.avgLatencyMs.toFixed(1)}ms\n`)
        process.stdout.write(`P95 latency: ${stats.p95LatencyMs?.toFixed(1)}ms\n`)
        process.stdout.write(`P99 latency: ${stats.p99LatencyMs?.toFixed(1)}ms\n`)
      }

      process.stdout.write(`\nToken usage:\n`)
      process.stdout.write(`  Prompt:     ${stats.tokenUsage.prompt.toLocaleString()}\n`)
      process.stdout.write(`  Completion: ${stats.tokenUsage.completion.toLocaleString()}\n`)
      process.stdout.write(`  Total:      ${stats.tokenUsage.total.toLocaleString()}\n`)
    }

    const from = args['from'] ? new Date(args['from']) : new Date()
    const to = args['to'] ? new Date(args['to']) : new Date()
    const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)))
    printNudge(stats.totalEntries, days)
  },
})
