import { defineCommand } from 'citty'
import { createReader, storageArgs, printNudge } from './shared.js'
import { analyseCoverage } from '../coverage.js'
import { createHash } from 'node:crypto'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const exportCommand = defineCommand({
  meta: {
    name: 'export',
    description: 'Export logs as a compliance evidence package',
  },
  args: {
    ...storageArgs,
    from: { type: 'string', description: 'Start date (ISO 8601)' },
    to: { type: 'string', description: 'End date (ISO 8601)' },
    output: { type: 'string', description: 'Output directory', required: true },
    'include-verification': { type: 'boolean', description: 'Include chain verification result' },
    'include-coverage': { type: 'boolean', description: 'Include coverage diagnostic' },
  },
  async run({ args }) {
    const reader = createReader({
      bucket: args['bucket'],
      region: args['region'],
      prefix: args['prefix'],
      endpoint: args['endpoint'],
      systemId: args['system-id'],
    })

    const outputDir = args['output']
    if (!outputDir) {
      process.stderr.write('Error: --output is required\n')
      process.exit(1)
    }

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }

    process.stdout.write('Exporting audit logs...\n')

    const entries = await reader.query({
      from: args['from'],
      to: args['to'],
    })

    const manifest: Record<string, string> = {}

    const entriesContent = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
    const entriesPath = join(outputDir, 'entries.jsonl')
    writeFileSync(entriesPath, entriesContent)
    manifest['entries.jsonl'] = sha256File(entriesContent)
    process.stdout.write(`  entries.jsonl: ${entries.length} entries\n`)

    const stats = await reader.stats({
      from: args['from'],
      to: args['to'],
    })
    const statsContent = JSON.stringify(stats, null, 2)
    const statsPath = join(outputDir, 'stats.json')
    writeFileSync(statsPath, statsContent)
    manifest['stats.json'] = sha256File(statsContent)
    process.stdout.write(`  stats.json: aggregate statistics\n`)

    if (args['include-verification']) {
      const verification = await reader.verifyChain({
        from: args['from'],
        to: args['to'],
      })
      const verificationContent = JSON.stringify(verification, null, 2)
      const verificationPath = join(outputDir, 'chain-verification.json')
      writeFileSync(verificationPath, verificationContent)
      manifest['chain-verification.json'] = sha256File(verificationContent)
      process.stdout.write(`  chain-verification.json: ${verification.valid ? 'VALID' : 'INVALID'}\n`)
    }

    if (args['include-coverage']) {
      const report = analyseCoverage(entries, {
        from: args['from'],
        to: args['to'],
      })
      const coverageContent = JSON.stringify(report, null, 2)
      const coveragePath = join(outputDir, 'coverage-report.json')
      writeFileSync(coveragePath, coverageContent)
      manifest['coverage-report.json'] = sha256File(coverageContent)
      process.stdout.write(`  coverage-report.json: ${report.warnings.length} warnings\n`)
    }

    const manifestContent = JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        systemId: args['system-id'] ?? process.env['AIACT_SYSTEM_ID'],
        period: { from: args['from'] ?? null, to: args['to'] ?? null },
        files: manifest,
      },
      null,
      2,
    )
    const manifestPath = join(outputDir, 'manifest.json')
    writeFileSync(manifestPath, manifestContent)
    process.stdout.write(`  manifest.json: export metadata\n`)

    const from = args['from'] ? new Date(args['from']) : new Date()
    const to = args['to'] ? new Date(args['to']) : new Date()
    const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)))
    printNudge(entries.length, days)
  },
})

function sha256File(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}
