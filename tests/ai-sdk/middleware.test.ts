import { describe, it, expect, afterEach } from 'vitest'
import { auditMiddleware } from '../../src/ai-sdk/middleware/index.js'
import { AuditLogger } from '../../src/logger.js'
import { MemoryStorage } from '../../src/storage/memory.js'
import { withAuditContext } from '../../src/context.js'
import type { LanguageModelV1 } from 'ai'

function createTestLogger(): { logger: AuditLogger; storage: MemoryStorage } {
  const storage = new MemoryStorage()
  const logger = AuditLogger.createWithStorage(
    {
      systemId: 'test-system',
      storage: { type: 's3', bucket: 'test', region: 'eu-west-1' },
      retention: { minimumDays: 180 },
      batching: { maxSize: 1000, maxDelayMs: 60000 },
    },
    storage,
  )
  return { logger, storage }
}

function createMockModel(response?: Partial<{
  text: string
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }
  finishReason: string
  modelId: string
  toolCalls: Array<{ toolCallType: string; toolCallId: string; toolName: string; args: string }>
  shouldError: boolean
}>): LanguageModelV1 {
  const opts = {
    text: 'Mock response',
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    finishReason: 'stop',
    modelId: 'test-provider/test-model',
    toolCalls: [] as Array<{ toolCallType: string; toolCallId: string; toolName: string; args: string }>,
    shouldError: false,
    ...response,
  }

  return {
    specificationVersion: 'v1',
    provider: 'test-provider',
    modelId: 'test-model',
    defaultObjectGenerationMode: undefined,

    doGenerate: async () => {
      if (opts.shouldError) {
        throw new Error('Model error')
      }
      return {
        text: opts.text,
        usage: opts.usage,
        finishReason: opts.finishReason,
        rawCall: { rawPrompt: '', rawSettings: {} },
        toolCalls: opts.toolCalls,
        response: {
          id: 'resp_1',
          timestamp: new Date(),
          modelId: opts.modelId,
        },
      }
    },

    doStream: async () => {
      if (opts.shouldError) {
        throw new Error('Stream error')
      }

      const encoder = new TextEncoder()
      const text = opts.text
      const readableStream = new ReadableStream({
        start(controller) {
          for (const char of text) {
            controller.enqueue({
              type: 'text-delta',
              textDelta: char,
            })
          }
          controller.enqueue({
            type: 'finish',
            finishReason: opts.finishReason,
            usage: opts.usage,
            response: {
              id: 'resp_1',
              timestamp: new Date(),
              modelId: opts.modelId,
            },
          })
          controller.close()
        },
      })

      return {
        stream: readableStream,
        rawCall: { rawPrompt: '', rawSettings: {} },
      }
    },
  } as unknown as LanguageModelV1
}

describe('auditMiddleware', () => {
  let logger: AuditLogger
  let storage: MemoryStorage

  afterEach(async () => {
    await logger.close()
  })

  it('wraps a model and returns a LanguageModelV1', () => {
    const setup = createTestLogger()
    logger = setup.logger

    const model = createMockModel()
    const wrapped = auditMiddleware(model, { logger })

    expect(wrapped).toBeDefined()
    expect(wrapped.doGenerate).toBeDefined()
    expect(wrapped.doStream).toBeDefined()
  })

  it('logs an inference event on doGenerate', async () => {
    const setup = createTestLogger()
    logger = setup.logger
    storage = setup.storage

    const model = createMockModel()
    const wrapped = auditMiddleware(model, { logger })

    await wrapped.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    })

    await logger.flush()

    const allFiles = await storage.list('')
    const jsonlFiles = allFiles.filter((k) => k.endsWith('.jsonl'))
    expect(jsonlFiles.length).toBeGreaterThan(0)

    const data = await storage.read(jsonlFiles[0])
    const lines = data.toString('utf-8').trim().split('\n')
    const entry = JSON.parse(lines[0])

    expect(entry.eventType).toBe('inference')
    expect(entry.captureMethod).toBe('middleware')
    expect(entry.modelId).toBe('test-provider/test-model')
    expect(entry.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('logs errors on doGenerate failure', async () => {
    const setup = createTestLogger()
    logger = setup.logger
    storage = setup.storage

    const model = createMockModel({ shouldError: true })
    const wrapped = auditMiddleware(model, { logger })

    await expect(
      wrapped.doGenerate({
        inputFormat: 'prompt',
        mode: { type: 'regular' },
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      }),
    ).rejects.toThrow('Model error')

    await logger.flush()

    const allFiles = await storage.list('')
    const jsonlFiles = allFiles.filter((k) => k.endsWith('.jsonl'))
    const data = await storage.read(jsonlFiles[0])
    const entry = JSON.parse(data.toString('utf-8').trim().split('\n')[0])

    expect(entry.eventType).toBe('inference')
    expect(entry.error).not.toBeNull()
    expect(entry.error.message).toBe('Model error')
  })

  it('inherits decisionId from context', async () => {
    const setup = createTestLogger()
    logger = setup.logger
    storage = setup.storage

    const model = createMockModel()
    const wrapped = auditMiddleware(model, { logger })

    await withAuditContext({ decisionId: 'ctx_dec' }, async () => {
      await wrapped.doGenerate({
        inputFormat: 'prompt',
        mode: { type: 'regular' },
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      })
    })

    await logger.flush()

    const allFiles = await storage.list('')
    const jsonlFiles = allFiles.filter((k) => k.endsWith('.jsonl'))
    const data = await storage.read(jsonlFiles[0])
    const entry = JSON.parse(data.toString('utf-8').trim().split('\n')[0])

    expect(entry.decisionId).toBe('ctx_dec')
  })

  it('auto-generates decisionId without context', async () => {
    const setup = createTestLogger()
    logger = setup.logger
    storage = setup.storage

    const model = createMockModel()
    const wrapped = auditMiddleware(model, { logger })

    await wrapped.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    })

    await logger.flush()

    const allFiles = await storage.list('')
    const jsonlFiles = allFiles.filter((k) => k.endsWith('.jsonl'))
    const data = await storage.read(jsonlFiles[0])
    const entry = JSON.parse(data.toString('utf-8').trim().split('\n')[0])

    expect(entry.decisionId).toBeTruthy()
    expect(entry.decisionId.length).toBeGreaterThan(0)
  })

  it('logs tool calls from doGenerate', async () => {
    const setup = createTestLogger()
    logger = setup.logger
    storage = setup.storage

    const model = createMockModel({
      toolCalls: [
        { toolCallType: 'function', toolCallId: 'tc_1', toolName: 'search', args: '{"query":"test"}' },
      ],
    })
    const wrapped = auditMiddleware(model, { logger })

    await withAuditContext({ decisionId: 'dec_tools' }, async () => {
      await wrapped.doGenerate({
        inputFormat: 'prompt',
        mode: { type: 'regular' },
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Search' }] }],
      })
    })

    await logger.flush()

    const allFiles = await storage.list('')
    const jsonlFiles = allFiles.filter((k) => k.endsWith('.jsonl'))
    const data = await storage.read(jsonlFiles[0])
    const lines = data.toString('utf-8').trim().split('\n')

    expect(lines.length).toBe(2)
    const toolEntry = JSON.parse(lines[1])
    expect(toolEntry.eventType).toBe('tool_call')
    expect(toolEntry.toolCall.toolName).toBe('search')
  })

  it('logs streaming responses on stream completion', async () => {
    const setup = createTestLogger()
    logger = setup.logger
    storage = setup.storage

    const model = createMockModel({ text: 'Streamed response' })
    const wrapped = auditMiddleware(model, { logger })

    const { stream } = await wrapped.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    })

    const reader = stream.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }

    await logger.flush()

    const allFiles = await storage.list('')
    const jsonlFiles = allFiles.filter((k) => k.endsWith('.jsonl'))
    expect(jsonlFiles.length).toBeGreaterThan(0)

    const data = await storage.read(jsonlFiles[0])
    const entry = JSON.parse(data.toString('utf-8').trim().split('\n')[0])

    expect(entry.eventType).toBe('inference')
    expect(entry.captureMethod).toBe('middleware')
    expect(entry.output.value).toBe('Streamed response')
  })
})
