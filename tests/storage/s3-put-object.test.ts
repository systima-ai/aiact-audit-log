/**
 * Tests that the S3 write path actually constructs the Object Lock parameters.
 *
 * This is the layer where the configuration was previously dropped: objectLock
 * was stored on the logger and serialised into _meta/config.json, but the
 * PutObject call carried only Bucket, Key, Body and ContentType.
 */

import { describe, it, expect } from 'vitest'
import { buildPutObjectInput } from '../../src/storage/s3.js'

const BUCKET = 'audit-bucket'
const DATA = Buffer.from('{}\n')

describe('buildPutObjectInput', () => {
  it('sets no lock parameters when no options are given', () => {
    const input = buildPutObjectInput(BUCKET, 'aiact-logs/sys/2026/01/01/000000.jsonl', DATA)

    expect(input.ObjectLockMode).toBeUndefined()
    expect(input.ObjectLockRetainUntilDate).toBeUndefined()
  })

  it('sets no lock parameters when options carry no objectLock', () => {
    const input = buildPutObjectInput(BUCKET, 'aiact-logs/sys/head.json', DATA, {})

    expect(input.ObjectLockMode).toBeUndefined()
    expect(input.ObjectLockRetainUntilDate).toBeUndefined()
  })

  it('sets COMPLIANCE mode and the retain-until date', () => {
    const retainUntil = new Date('2027-01-01T00:00:00.000Z')
    const input = buildPutObjectInput(BUCKET, 'aiact-logs/sys/a.jsonl', DATA, {
      objectLock: { mode: 'COMPLIANCE', retainUntil },
    })

    expect(input.ObjectLockMode).toBe('COMPLIANCE')
    expect(input.ObjectLockRetainUntilDate).toBe(retainUntil)
  })

  it('sets GOVERNANCE mode when requested', () => {
    const input = buildPutObjectInput(BUCKET, 'aiact-logs/sys/a.jsonl', DATA, {
      objectLock: { mode: 'GOVERNANCE', retainUntil: new Date() },
    })

    expect(input.ObjectLockMode).toBe('GOVERNANCE')
  })

  it('preserves bucket, key and body', () => {
    const input = buildPutObjectInput(BUCKET, 'aiact-logs/sys/a.jsonl', DATA)

    expect(input.Bucket).toBe(BUCKET)
    expect(input.Key).toBe('aiact-logs/sys/a.jsonl')
    expect(input.Body).toBe(DATA)
  })

  it('types entry files as newline-delimited JSON and metadata as JSON', () => {
    expect(
      buildPutObjectInput(BUCKET, 'aiact-logs/sys/a.jsonl', DATA).ContentType,
    ).toBe('application/x-ndjson')
    expect(
      buildPutObjectInput(BUCKET, 'aiact-logs/sys/_chain/head.json', DATA).ContentType,
    ).toBe('application/json')
  })
})
