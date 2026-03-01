import { defineCommand } from 'citty'
import { createReader, storageArgs } from './shared.js'

export const queryCommand = defineCommand({
  meta: {
    name: 'query',
    description: 'Search logs by time range and filters',
  },
  args: {
    ...storageArgs,
    from: { type: 'string', description: 'Start date (ISO 8601)' },
    to: { type: 'string', description: 'End date (ISO 8601)' },
    'event-type': { type: 'string', description: 'Filter by event type' },
    'decision-id': { type: 'string', description: 'Filter by decision ID' },
    limit: { type: 'string', description: 'Maximum entries to return' },
    format: { type: 'string', description: 'Output format: json | csv | table (default: json)' },
  },
  async run({ args }) {
    const reader = createReader({
      dir: args['dir'],
      bucket: args['bucket'],
      region: args['region'],
      prefix: args['prefix'],
      endpoint: args['endpoint'],
      systemId: args['system-id'],
    })

    const entries = await reader.query({
      from: args['from'],
      to: args['to'],
      eventType: args['event-type'] as 'inference' | undefined,
      decisionId: args['decision-id'],
      limit: args['limit'] ? parseInt(args['limit'], 10) : undefined,
    })

    const format = args['format'] ?? 'json'

    if (format === 'json') {
      process.stdout.write(JSON.stringify(entries, null, 2) + '\n')
    } else if (format === 'csv') {
      if (entries.length > 0) {
        const headers = ['entryId', 'decisionId', 'timestamp', 'eventType', 'modelId', 'latencyMs', 'captureMethod']
        process.stdout.write(headers.join(',') + '\n')
        for (const e of entries) {
          process.stdout.write(
            [e.entryId, e.decisionId, e.timestamp, e.eventType, e.modelId ?? '', e.latencyMs ?? '', e.captureMethod].join(',') + '\n',
          )
        }
      }
    } else {
      if (entries.length === 0) {
        process.stdout.write('No entries found.\n')
      } else {
        process.stdout.write(`Found ${entries.length} entries:\n\n`)
        for (const e of entries) {
          process.stdout.write(`  [${e.timestamp}] ${e.eventType} — ${e.decisionId} (${e.modelId ?? 'no model'})\n`)
        }
      }
    }
  },
})
