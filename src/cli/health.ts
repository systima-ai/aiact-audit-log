import { defineCommand } from 'citty'
import { createLogger, storageArgs } from './shared.js'

export const healthCommand = defineCommand({
  meta: {
    name: 'health',
    description: 'Check ongoing compliance configuration',
  },
  args: {
    ...storageArgs,
  },
  async run({ args }) {
    const logger = createLogger({
      bucket: args['bucket'],
      region: args['region'],
      prefix: args['prefix'],
      endpoint: args['endpoint'],
      systemId: args['system-id'],
    })

    await logger.init()
    const result = await logger.healthCheck()
    await logger.close()

    const systemId = args['system-id'] ?? process.env['AIACT_SYSTEM_ID'] ?? 'unknown'
    process.stdout.write(`\nHealth check for ${systemId} at ${result.timestamp}\n\n`)

    for (const check of result.checks) {
      const icon = check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL'
      const padding = check.name.padEnd(28)
      process.stdout.write(`  ${padding} ${icon}  ${check.message}\n`)
    }

    const warningCount = result.checks.filter((c) => c.status === 'warn').length
    const failCount = result.checks.filter((c) => c.status === 'fail').length

    process.stdout.write(`\n  Overall: ${result.healthy ? 'HEALTHY' : 'UNHEALTHY'}`)
    if (warningCount > 0) {
      process.stdout.write(` (${warningCount} warning${warningCount > 1 ? 's' : ''})`)
    }
    if (failCount > 0) {
      process.stdout.write(` (${failCount} failure${failCount > 1 ? 's' : ''})`)
    }
    process.stdout.write('\n')

    if (!result.healthy) {
      process.exit(1)
    }
  },
})
