import { describe, it, expect } from 'vitest'
import { generateUUIDv7, isValidUUIDv7, extractTimestampFromUUIDv7 } from '../src/utils/uuid.js'

describe('generateUUIDv7', () => {
  it('generates a valid UUIDv7 string', () => {
    const id = generateUUIDv7()

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('has version 7 in the correct position', () => {
    const id = generateUUIDv7()
    const versionChar = id.charAt(14)

    expect(versionChar).toBe('7')
  })

  it('has correct variant bits (10xx)', () => {
    const id = generateUUIDv7()
    const variantChar = id.charAt(19)

    expect(['8', '9', 'a', 'b']).toContain(variantChar)
  })

  it('generates unique IDs', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      ids.add(generateUUIDv7())
    }

    expect(ids.size).toBe(1000)
  })

  it('generates time-ordered IDs across different milliseconds', async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(generateUUIDv7())
      await new Promise((resolve) => setTimeout(resolve, 2))
    }

    const sorted = [...ids].sort()
    expect(ids).toEqual(sorted)
  })

  it('embeds a timestamp close to Date.now()', () => {
    const before = Date.now()
    const id = generateUUIDv7()
    const after = Date.now()

    const embedded = extractTimestampFromUUIDv7(id)

    expect(embedded).toBeGreaterThanOrEqual(before)
    expect(embedded).toBeLessThanOrEqual(after)
  })
})

describe('isValidUUIDv7', () => {
  it('returns true for valid UUIDv7', () => {
    const id = generateUUIDv7()
    expect(isValidUUIDv7(id)).toBe(true)
  })

  it('returns false for UUIDv4', () => {
    expect(isValidUUIDv7('550e8400-e29b-41d4-a716-446655440000')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isValidUUIDv7('')).toBe(false)
  })

  it('returns false for random string', () => {
    expect(isValidUUIDv7('not-a-uuid')).toBe(false)
  })

  it('returns false for wrong length', () => {
    expect(isValidUUIDv7('550e8400-e29b-7')).toBe(false)
  })
})

describe('extractTimestampFromUUIDv7', () => {
  it('extracts a valid timestamp', () => {
    const now = Date.now()
    const id = generateUUIDv7()
    const ts = extractTimestampFromUUIDv7(id)

    expect(Math.abs(ts - now)).toBeLessThan(100)
  })
})
