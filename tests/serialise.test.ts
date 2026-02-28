import { describe, it, expect } from 'vitest'
import { deterministicStringify } from '../src/utils/serialise.js'

describe('deterministicStringify', () => {
  it('produces identical output regardless of key insertion order', () => {
    const a = { zebra: 1, apple: 2, mango: 3 }
    const b = { apple: 2, mango: 3, zebra: 1 }

    expect(deterministicStringify(a)).toBe(deterministicStringify(b))
  })

  it('sorts keys alphabetically', () => {
    const obj = { c: 3, a: 1, b: 2 }
    const result = deterministicStringify(obj)

    expect(result).toBe('{"a":1,"b":2,"c":3}')
  })

  it('handles nested objects with deterministic key order', () => {
    const a = { outer: { z: 1, a: 2 }, first: true }
    const b = { first: true, outer: { a: 2, z: 1 } }

    expect(deterministicStringify(a)).toBe(deterministicStringify(b))
  })

  it('preserves array order (arrays are not sorted)', () => {
    const obj = { items: [3, 1, 2] }
    const result = deterministicStringify(obj)

    expect(result).toBe('{"items":[3,1,2]}')
  })

  it('handles null values', () => {
    const obj = { a: null, b: 1 }
    const result = deterministicStringify(obj)

    expect(result).toBe('{"a":null,"b":1}')
  })

  it('handles undefined values (excluded by JSON.stringify)', () => {
    const obj = { a: undefined, b: 1 }
    const result = deterministicStringify(obj)

    expect(result).toBe('{"b":1}')
  })

  it('handles empty objects', () => {
    expect(deterministicStringify({})).toBe('{}')
  })

  it('handles strings', () => {
    expect(deterministicStringify('hello')).toBe('"hello"')
  })

  it('handles numbers', () => {
    expect(deterministicStringify(42)).toBe('42')
  })

  it('handles booleans', () => {
    expect(deterministicStringify(true)).toBe('true')
  })

  it('handles arrays at root level', () => {
    expect(deterministicStringify([1, 2, 3])).toBe('[1,2,3]')
  })

  it('handles deeply nested objects deterministically', () => {
    const a = {
      level1: {
        z: { deep: true, alpha: 'first' },
        a: { deep: false, alpha: 'second' },
      },
    }
    const b = {
      level1: {
        a: { alpha: 'second', deep: false },
        z: { alpha: 'first', deep: true },
      },
    }

    expect(deterministicStringify(a)).toBe(deterministicStringify(b))
  })
})
