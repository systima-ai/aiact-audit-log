import { randomBytes } from 'node:crypto'

/**
 * Generate a UUIDv7 (time-ordered, RFC 9562).
 *
 * UUIDv7 embeds a Unix timestamp in the most significant 48 bits,
 * making IDs naturally time-ordered and sortable without parsing
 * timestamps. The remaining bits are random for uniqueness.
 *
 * Format: tttttttt-tttt-7rrr-Rrrr-rrrrrrrrrrrr
 *   t = timestamp bits (48-bit ms since epoch)
 *   7 = version nibble
 *   R = variant bits (10xx)
 *   r = random bits
 */
export function generateUUIDv7(): string {
  const now = Date.now()
  const bytes = new Uint8Array(16)

  const randomPart = randomBytes(10)
  bytes.set(randomPart, 6)

  bytes[0] = (now / 2 ** 40) & 0xff
  bytes[1] = (now / 2 ** 32) & 0xff
  bytes[2] = (now / 2 ** 24) & 0xff
  bytes[3] = (now / 2 ** 16) & 0xff
  bytes[4] = (now / 2 ** 8) & 0xff
  bytes[5] = now & 0xff

  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  return formatUUID(bytes)
}

function formatUUID(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isValidUUIDv7(id: string): boolean {
  return UUID_PATTERN.test(id)
}

export function extractTimestampFromUUIDv7(id: string): number {
  const hex = id.replace(/-/g, '').slice(0, 12)
  return parseInt(hex, 16)
}
