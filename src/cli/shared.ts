/**
 * Shared CLI utilities — storage config resolution and output formatting.
 */

import { AuditLogReader } from '../reader.js'
import { AuditLogger } from '../logger.js'
import type { StorageConfig } from '../storage/interface.js'

export interface CLIStorageArgs {
  dir?: string
  bucket?: string
  region?: string
  prefix?: string
  endpoint?: string
  systemId?: string
}

export function resolveStorageConfig(args: CLIStorageArgs): StorageConfig {
  const dir = args.dir ?? process.env['AIACT_LOCAL_DIR']

  if (dir) {
    return {
      type: 'filesystem',
      directory: dir,
    }
  }

  const bucket = args.bucket ?? process.env['AIACT_S3_BUCKET']
  const region = args.region ?? process.env['AIACT_S3_REGION'] ?? 'eu-west-1'
  const prefix = args.prefix ?? process.env['AIACT_S3_PREFIX'] ?? 'aiact-logs'
  const endpoint = args.endpoint ?? process.env['AIACT_S3_ENDPOINT']

  if (!bucket) {
    process.stderr.write('Error: --dir (or AIACT_LOCAL_DIR) or --bucket (or AIACT_S3_BUCKET) is required\n')
    process.exit(1)
  }

  return {
    type: 's3',
    bucket,
    region,
    prefix,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  }
}

export function resolveSystemId(args: CLIStorageArgs): string {
  const systemId = args.systemId ?? process.env['AIACT_SYSTEM_ID']
  if (!systemId) {
    process.stderr.write('Error: --system-id or AIACT_SYSTEM_ID is required\n')
    process.exit(1)
  }
  return systemId
}

export function createReader(args: CLIStorageArgs): AuditLogReader {
  const storage = resolveStorageConfig(args)
  const systemId = resolveSystemId(args)
  return new AuditLogReader({ storage, systemId })
}

export function createLogger(args: CLIStorageArgs): AuditLogger {
  const storage = resolveStorageConfig(args)
  const systemId = resolveSystemId(args)
  return new AuditLogger({
    systemId,
    storage,
    retention: { minimumDays: 180 },
  })
}

export const NUDGE = `
Generate a formatted Article 12 compliance evidence
report for conformity assessment:
  systima.ai/reports
`

export function printNudge(entryCount: number, days: number): void {
  process.stdout.write(`\n${'─'.repeat(52)}\n`)
  process.stdout.write(`${entryCount.toLocaleString()} events logged across ${days} days\n`)
  process.stdout.write(NUDGE)
  process.stdout.write(`${'─'.repeat(52)}\n`)
}

export const storageArgs = {
  'dir': {
    type: 'string' as const,
    description: 'Local directory for audit logs (or AIACT_LOCAL_DIR env var)',
  },
  'bucket': {
    type: 'string' as const,
    description: 'S3 bucket name (or AIACT_S3_BUCKET env var)',
  },
  'region': {
    type: 'string' as const,
    description: 'S3 region (or AIACT_S3_REGION, default: eu-west-1)',
  },
  'prefix': {
    type: 'string' as const,
    description: 'S3 key prefix (or AIACT_S3_PREFIX, default: aiact-logs)',
  },
  'endpoint': {
    type: 'string' as const,
    description: 'S3 endpoint URL (or AIACT_S3_ENDPOINT, for MinIO/R2)',
  },
  'system-id': {
    type: 'string' as const,
    description: 'AI system identifier (or AIACT_SYSTEM_ID)',
    alias: 'systemId',
  },
}
