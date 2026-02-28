/**
 * S3 lifecycle policy management for retention enforcement.
 *
 * Article 19(1) requires logs be kept at least six months.
 * This module creates and verifies S3 lifecycle rules that
 * enforce the configured retention period.
 */

import {
  PutBucketLifecycleConfigurationCommand,
  GetBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { S3StorageConfig } from '../storage/interface.js'

export interface RetentionConfig {
  minimumDays: number
  acknowledgeSubMinimum?: boolean
  autoConfigureLifecycle?: boolean
}

export interface RetentionCheckResult {
  policyExists: boolean
  configuredDays: number | null
  meetsMinimum: boolean
}

export function createS3ClientFromConfig(config: S3StorageConfig): S3Client {
  return new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.forcePathStyle ? { forcePathStyle: config.forcePathStyle } : {}),
    ...(config.credentials
      ? {
          credentials: {
            accessKeyId: config.credentials.accessKeyId,
            secretAccessKey: config.credentials.secretAccessKey,
            ...(config.credentials.sessionToken
              ? { sessionToken: config.credentials.sessionToken }
              : {}),
          },
        }
      : {}),
  })
}

export async function configureRetentionPolicy(
  client: S3Client,
  bucket: string,
  prefix: string,
  retentionDays: number,
): Promise<void> {
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: `aiact-audit-log-retention-${prefix.replace(/\//g, '-')}`,
            Status: 'Enabled',
            Filter: {
              Prefix: prefix + '/',
            },
            Expiration: {
              Days: retentionDays,
            },
          },
        ],
      },
    }),
  )
}

export async function checkRetentionPolicy(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<RetentionCheckResult> {
  try {
    const response = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
    )

    if (!response.Rules) {
      return { policyExists: false, configuredDays: null, meetsMinimum: false }
    }

    const matchingRule = response.Rules.find(
      (rule) =>
        rule.Status === 'Enabled' &&
        rule.Filter?.Prefix?.startsWith(prefix) &&
        rule.Expiration?.Days,
    )

    if (!matchingRule) {
      return { policyExists: false, configuredDays: null, meetsMinimum: false }
    }

    const days = matchingRule.Expiration?.Days ?? 0
    return {
      policyExists: true,
      configuredDays: days,
      meetsMinimum: days >= 180,
    }
  } catch (error) {
    const errorName = (error as { name?: string }).name
    if (errorName === 'NoSuchLifecycleConfiguration') {
      return { policyExists: false, configuredDays: null, meetsMinimum: false }
    }
    throw error
  }
}
