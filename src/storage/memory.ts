/**
 * In-memory storage backend for testing.
 *
 * Not for production use. This backend stores everything in memory
 * and is used by the test suite to avoid requiring an S3 endpoint.
 */

import type { StorageBackend, ObjectMetadata } from './interface.js'

export class MemoryStorage implements StorageBackend {
  private readonly store = new Map<string, { data: Buffer; lastModified: Date }>()

  async write(key: string, data: Buffer): Promise<void> {
    this.store.set(key, { data: Buffer.from(data), lastModified: new Date() })
  }

  async read(key: string): Promise<Buffer> {
    const entry = this.store.get(key)
    if (!entry) {
      throw new Error(`Key not found: ${key}`)
    }
    return Buffer.from(entry.data)
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = []
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        keys.push(key)
      }
    }
    return keys.sort()
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key)
  }

  async getObjectMetadata(key: string): Promise<ObjectMetadata> {
    const entry = this.store.get(key)
    if (!entry) {
      throw new Error(`Key not found: ${key}`)
    }
    return {
      lastModified: entry.lastModified,
      size: entry.data.length,
    }
  }

  clear(): void {
    this.store.clear()
  }

  getAll(): Map<string, Buffer> {
    const result = new Map<string, Buffer>()
    for (const [key, entry] of this.store) {
      result.set(key, entry.data)
    }
    return result
  }
}
