import { defineCommand } from 'citty'
import { createReader, storageArgs } from './shared.js'

export const reconstructCommand = defineCommand({
  meta: {
    name: 'reconstruct',
    description: 'Reconstruct a complete decision trace from a decision ID',
  },
  args: {
    ...storageArgs,
    'decision-id': { type: 'string', description: 'Decision ID to reconstruct', required: true },
    format: { type: 'string', description: 'Output format: json | timeline (default: json)' },
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

    const decisionId = args['decision-id']
    if (!decisionId) {
      process.stderr.write('Error: --decision-id is required\n')
      process.exit(1)
    }

    const result = await reader.reconstruct(decisionId)
    const format = args['format'] ?? 'json'

    if (format === 'json') {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    } else {
      process.stdout.write(`Decision trace: ${result.decisionId}\n`)
      process.stdout.write(`Entries: ${result.entries.length}\n`)
      process.stdout.write(`Integrity: ${result.integrity.valid ? 'VALID' : 'BROKEN'}\n\n`)

      for (const t of result.timeline) {
        process.stdout.write(`  [${t.timestamp}] ${t.summary}\n`)
      }
    }
  },
})
