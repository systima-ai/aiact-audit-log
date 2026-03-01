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

/**
 * Mock model that mirrors the real AI SDK LanguageModelV1 result shapes.
 *
 * Key differences from prior mocks:
 * - usage has NO totalTokens (matches @ai-sdk/provider spec)
 * - tool call args is a string (stringified JSON), not an object
 * - streaming finish chunk has no response property
 * - response-metadata is a separate stream chunk
 * - finishReason is a plain string
 */
function createMockModel(response?: Partial<{
  text: string | undefined
  usage: { promptTokens: number; completionTokens: number }
  finishReason: string
  modelId: string
  toolCalls: Array<{ toolCallType: string; toolCallId: string; toolName: string; args: string }>
  shouldError: boolean
}>): LanguageModelV1 {
  const opts = {
    text: 'Mock response' as string | undefined,
    usage: { promptTokens: 10, completionTokens: 20 },
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

      const text = opts.text ?? ''
      const readableStream = new ReadableStream({
        start(controller) {
          for (const char of text) {
            controller.enqueue({
              type: 'text-delta',
              textDelta: char,
            })
          }
          controller.enqueue({
            type: 'response-metadata',
            id: 'resp_1',
            timestamp: new Date(),
            modelId: opts.modelId,
          })
          controller.enqueue({
            type: 'finish',
            finishReason: opts.finishReason,
            usage: opts.usage,
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

/**
 * Mock model that mirrors AI SDK V3 (LanguageModelV3) result shapes,
 * as used by AI SDK v5/v6 and Mastra.
 *
 * Key differences from V1 mocks:
 * - result.content is an array of content parts (no top-level result.text)
 * - usage has nested { inputTokens: { total }, outputTokens: { total } }
 * - finishReason is { unified: string, raw: string | undefined }
 * - tool calls are in content array as { type: 'tool-call', toolName, input }
 * - no rawCall property
 */
function createV3MockModel(response?: Partial<{
  content: Array<Record<string, unknown>>
  usage: { inputTokens: { total: number }; outputTokens: { total: number } }
  finishReason: { unified: string; raw: string | undefined }
  modelId: string
  shouldError: boolean
}>): LanguageModelV1 {
  const defaultContent: Array<Record<string, unknown>> = [
    { type: 'text', text: 'V3 mock response' },
  ]

  const opts = {
    content: defaultContent,
    usage: {
      inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 50, text: undefined, reasoning: undefined },
    },
    finishReason: { unified: 'stop', raw: undefined } as { unified: string; raw: string | undefined },
    modelId: 'test-provider/test-model-v3',
    shouldError: false,
    ...response,
  }

  return {
    specificationVersion: 'v3',
    provider: 'test-provider',
    modelId: 'test-model-v3',
    defaultObjectGenerationMode: undefined,

    doGenerate: async () => {
      if (opts.shouldError) {
        throw new Error('V3 model error')
      }
      return {
        content: opts.content,
        usage: opts.usage,
        finishReason: opts.finishReason,
        warnings: [],
        response: {
          id: 'resp_v3_1',
          timestamp: new Date(),
          modelId: opts.modelId,
        },
      }
    },

    doStream: async () => {
      if (opts.shouldError) {
        throw new Error('V3 stream error')
      }

      // Extract text from content parts for streaming
      const textParts = opts.content
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
      const fullText = textParts.join('')

      const readableStream = new ReadableStream({
        start(controller) {
          for (const char of fullText) {
            controller.enqueue({
              type: 'text-delta',
              textDelta: char,
            })
          }
          controller.enqueue({
            type: 'response-metadata',
            id: 'resp_v3_1',
            timestamp: new Date(),
            modelId: opts.modelId,
          })
          controller.enqueue({
            type: 'finish',
            finishReason: opts.finishReason,
            usage: opts.usage,
          })
          controller.close()
        },
      })

      return {
        stream: readableStream,
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

  it('computes totalTokens from promptTokens + completionTokens', async () => {
    const setup = createTestLogger()
    logger = setup.logger
    storage = setup.storage

    const model = createMockModel({ usage: { promptTokens: 100, completionTokens: 50 } })
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

    expect(entry.usage.promptTokens).toBe(100)
    expect(entry.usage.completionTokens).toBe(50)
    expect(entry.usage.totalTokens).toBe(150)
  })

  it('captures output text from regular generateText calls', async () => {
    const setup = createTestLogger()
    logger = setup.logger
    storage = setup.storage

    const model = createMockModel({ text: 'The answer is 42' })
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

    expect(entry.output.value).toBe('The answer is 42')
  })

  it('captures output from tool-mode structured output when text is absent', async () => {
    const setup = createTestLogger()
    logger = setup.logger
    storage = setup.storage

    const structuredJson = '{"name":"test","risk":"high"}'
    const model = createMockModel({
      text: undefined,
      toolCalls: [
        { toolCallType: 'function', toolCallId: 'tc_1', toolName: 'json', args: structuredJson },
      ],
    })
    const wrapped = auditMiddleware(model, { logger })

    await wrapped.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Analyse' }] }],
    })

    await logger.flush()

    const allFiles = await storage.list('')
    const jsonlFiles = allFiles.filter((k) => k.endsWith('.jsonl'))
    const data = await storage.read(jsonlFiles[0])
    const entry = JSON.parse(data.toString('utf-8').trim().split('\n')[0])

    expect(entry.output.value).toBe(structuredJson)
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

  it('logs tool calls with parsed args from doGenerate', async () => {
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
    expect(toolEntry.toolCall.toolArgs).toEqual({ query: 'test' })
  })

  it('logs streaming responses with correct usage and modelId', async () => {
    const setup = createTestLogger()
    logger = setup.logger
    storage = setup.storage

    const model = createMockModel({
      text: 'Streamed response',
      usage: { promptTokens: 15, completionTokens: 25 },
    })
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
    expect(entry.modelId).toBe('test-provider/test-model')
    expect(entry.usage.promptTokens).toBe(15)
    expect(entry.usage.completionTokens).toBe(25)
    expect(entry.usage.totalTokens).toBe(40)
  })
})

// ── V3 format tests (AI SDK v5/v6, Mastra) ─────────────────

describe('auditMiddleware (V3 result format)', () => {
  let logger: AuditLogger
  let storage: MemoryStorage

  /** Helper to get the first logged entry */
  async function getFirstEntry(store: MemoryStorage): Promise<Record<string, unknown>> {
    const allFiles = await store.list('')
    const jsonlFiles = allFiles.filter((k) => k.endsWith('.jsonl'))
    const data = await store.read(jsonlFiles[jsonlFiles.length - 1])
    const lines = data.toString('utf-8').trim().split('\n')
    return JSON.parse(lines[0])
  }

  afterEach(async () => {
    await logger.close()
  })

  it('extracts text from V3 content array', async () => {
    const setup = createTestLogger()
    logger = setup.logger
    storage = setup.storage

    const model = createV3MockModel({
      content: [
        { type: 'text', text: 'First part. ' },
        { type: 'text', text: 'Second part.' },
      ],
    })
    const wrapped = auditMiddleware(model, { logger })

    await wrapped.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    })

    await logger.flush()
    const entry = await getFirstEntry(storage)

    expect(entry.output).toBeDefined()
    expect((entry.output as Record<string, unknown>).value).toBe('First part. Second part.')
  })

  it('extracts usage from V3 nested inputTokens/outputTokens', async () => {
    const setup = createTestLogger()
    logger = setup.logger
    storage = setup.storage

    const model = createV3MockModel({
      usage: {
        inputTokens: { total: 200 },
        outputTokens: { total: 80 },
      },
    })
    const wrapped = auditMiddleware(model, { logger })

    await wrapped.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    })

    await logger.flush()
    const entry = await getFirstEntry(storage)
    const usage = entry.usage as Record<string, number>

    expect(usage.promptTokens).toBe(200)
    expect(usage.completionTokens).toBe(80)
    expect(usage.totalTokens).toBe(280)
  })

  it('extracts finishReason from V3 { unified, raw } object', async () => {
    const setup = createTestLogger()
    logger = setup.logger
    storage = setup.storage

    const model = createV3MockModel({
      finishReason: { unified: 'length', raw: 'max_tokens' },
    })
    const wrapped = auditMiddleware(model, { logger })

    await wrapped.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    })

    await logger.flush()
    const entry = await getFirstEntry(storage)
    const output = entry.output as Record<string, unknown>

    expect(output.finishReason).toBe('length')
  })

  it('extracts tool calls from V3 content array', async () => {
    const setup = createTestLogger()
    logger = setup.logger
    storage = setup.storage

    const model = createV3MockModel({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'tc_v3_1',
          toolName: 'search',
          input: '{"query":"UK contract law"}',
        },
      ],
    })
    const wrapped = auditMiddleware(model, { logger })

    await withAuditContext({ decisionId: 'dec_v3_tools' }, async () => {
      await wrapped.doGenerate({
        inputFormat: 'prompt',
        mode: { type: 'regular' },
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Search' }] }],
      })
    })

    await logger.flush()

    const allFiles = await storage.list('')
    const jsonlFiles = allFiles.filter((k) => k.endsWith('.jsonl'))
    const data = await storage.read(jsonlFiles[jsonlFiles.length - 1])
    const lines = data.toString('utf-8').trim().split('\n')

    // Should have inference event + tool_call event
    expect(lines.length).toBe(2)

    const toolEntry = JSON.parse(lines[1])
    expect(toolEntry.eventType).toBe('tool_call')
    expect(toolEntry.toolCall.toolName).toBe('search')
    expect(toolEntry.toolCall.toolArgs).toEqual({ query: 'UK contract law' })
  })

  it('falls back to tool-call input for text when no text parts exist', async () => {
    const setup = createTestLogger()
    logger = setup.logger
    storage = setup.storage

    const structuredJson = '{"risk":"high","clause":"liability"}'
    const model = createV3MockModel({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'tc_v3_2',
          toolName: 'json',
          input: structuredJson,
        },
      ],
    })
    const wrapped = auditMiddleware(model, { logger })

    await wrapped.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Analyse' }] }],
    })

    await logger.flush()
    const entry = await getFirstEntry(storage)
    const output = entry.output as Record<string, unknown>

    expect(output.value).toBe(structuredJson)
  })

  it('handles V3 streaming with nested usage and object finishReason', async () => {
    const setup = createTestLogger()
    logger = setup.logger
    storage = setup.storage

    const model = createV3MockModel({
      content: [{ type: 'text', text: 'V3 streamed' }],
      usage: {
        inputTokens: { total: 50 },
        outputTokens: { total: 30 },
      },
      finishReason: { unified: 'stop', raw: 'end_turn' },
    })
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
    const entry = await getFirstEntry(storage)

    expect(entry.eventType).toBe('inference')
    expect((entry.output as Record<string, unknown>).value).toBe('V3 streamed')
    expect((entry.output as Record<string, unknown>).finishReason).toBe('stop')

    const usage = entry.usage as Record<string, number>
    expect(usage.promptTokens).toBe(50)
    expect(usage.completionTokens).toBe(30)
    expect(usage.totalTokens).toBe(80)
  })

  it('logs errors from V3 model', async () => {
    const setup = createTestLogger()
    logger = setup.logger
    storage = setup.storage

    const model = createV3MockModel({ shouldError: true })
    const wrapped = auditMiddleware(model, { logger })

    await expect(
      wrapped.doGenerate({
        inputFormat: 'prompt',
        mode: { type: 'regular' },
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      }),
    ).rejects.toThrow('V3 model error')

    await logger.flush()
    const entry = await getFirstEntry(storage)

    expect(entry.eventType).toBe('inference')
    expect(entry.error).not.toBeNull()
    expect((entry.error as Record<string, unknown>).message).toBe('V3 model error')
  })
})
