import { defineCommand } from 'citty'
import { createReader, storageArgs } from './shared.js'

export const verifyCommand = defineCommand({
  meta: {
    name: 'verify',
    description: 'Validate hash chain integrity',
  },
  args: {
    ...storageArgs,
    from: { type: 'string', description: 'Start date (ISO 8601)' },
    to: { type: 'string', description: 'End date (ISO 8601)' },
  },
  async run({ args }) {
    const reader = createReader({
      bucket: args['bucket'],
      region: args['region'],
      prefix: args['prefix'],
      endpoint: args['endpoint'],
      systemId: args['system-id'],
    })

    const result = await reader.verifyChain({
      from: args['from'],
      to: args['to'],
    })

    if (result.valid) {
      process.stdout.write(`Chain verified: ${result.entriesChecked.toLocaleString()} entries\n`)
      process.stdout.write('No breaks detected\n')
      process.stdout.write('Hash chain integrity: VALID\n')
    } else {
      process.stdout.write(`Chain verification FAILED\n`)
      process.stdout.write(`Entries checked: ${result.entriesChecked.toLocaleString()}\n`)
      if (result.firstBreak) {
        process.stdout.write(`First break at seq ${result.firstBreak.seq}\n`)
        process.stdout.write(`  Expected prevHash: ${result.firstBreak.expectedPrevHash}\n`)
        process.stdout.write(`  Actual prevHash:   ${result.firstBreak.actualPrevHash}\n`)
      }
      process.stdout.write('Hash chain integrity: INVALID\n')
      process.exit(1)
    }
  },
})
