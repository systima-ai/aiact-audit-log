/**
 * Local filesystem storage backend.
 *
 * Implements the StorageBackend interface using Node.js fs module.
 * Useful for local development, testing, and CLI inspection of logs
 * without requiring S3 or MinIO.
 *
 * Not recommended for production high-risk AI systems where
 * tamper-evidence and durability guarantees require S3 Object Lock.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { StorageBackend, ObjectMetadata } from './interface.js'

export interface FileSystemStorageConfig {
  type: 'filesystem'
  directory: string
  prefix?: string
}

export class FileSystemStorage implements StorageBackend {
  private readonly baseDir: string

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir)
  }

  private resolvePath(key: string): string {
    return path.join(this.baseDir, ...key.split('/'))
  }

  async write(key: string, data: Buffer): Promise<void> {
    const filePath = this.resolvePath(key)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, data)
  }

  async read(key: string): Promise<Buffer> {
    const filePath = this.resolvePath(key)
    return fs.readFile(filePath)
  }

  async list(prefix: string): Promise<string[]> {
    const dirPath = this.resolvePath(prefix)
    const keys: string[] = []

    try {
      await this.listRecursive(dirPath, prefix, keys)
    } catch {
      // Directory does not exist yet; return empty list
    }

    return keys.sort()
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolvePath(key))
      return true
    } catch {
      return false
    }
  }

  async getObjectMetadata(key: string): Promise<ObjectMetadata> {
    const filePath = this.resolvePath(key)
    const stat = await fs.stat(filePath)
    return {
      lastModified: stat.mtime,
      size: stat.size,
    }
  }

  private async listRecursive(
    dirPath: string,
    prefix: string,
    keys: string[],
  ): Promise<void> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      const entryKey = prefix ? `${prefix}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        await this.listRecursive(
          path.join(dirPath, entry.name),
          entryKey,
          keys,
        )
      } else {
        keys.push(entryKey)
      }
    }
  }
}
