/**
 * S3 lifecycle policy management for retention enforcement.
 *
 * Article 19(1) requires logs be kept at least six months.
 * This module creates and verifies the S3 lifecycle rule that
 * expires objects at the end of the configured retention period.
 *
 * These helpers are driven by S3Storage, which owns the S3 client.
 * They are exported so an operator can manage the policy out of band,
 * for example from a deployment script using a credential that holds
 * s3:PutLifecycleConfiguration while the runtime credential does not.
 */

import {
  PutBucketLifecycleConfigurationCommand,
  GetBucketLifecycleConfigurationCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import type { RetentionPolicyStatus } from '../storage/interface.js'

export function retentionRuleId(prefix: string): string {
  return `aiact-audit-log-retention-${prefix.replace(/\//g, '-')}`
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
            ID: retentionRuleId(prefix),
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
): Promise<RetentionPolicyStatus> {
  try {
    const response = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
    )

    if (!response.Rules) {
      return { policyExists: false, configuredDays: null }
    }

    const matchingRule = response.Rules.find(
      (rule) =>
        rule.Status === 'Enabled' &&
        rule.Filter?.Prefix?.startsWith(prefix) &&
        rule.Expiration?.Days !== undefined,
    )

    if (!matchingRule) {
      return { policyExists: false, configuredDays: null }
    }

    return {
      policyExists: true,
      configuredDays: matchingRule.Expiration?.Days ?? null,
    }
  } catch (error) {
    const errorName = (error as { name?: string }).name
    if (errorName === 'NoSuchLifecycleConfiguration') {
      return { policyExists: false, configuredDays: null }
    }
    throw error
  }
}
