import { describe, it, expect, afterEach } from 'vitest'
import { logFromAISDKResult } from '../../src/ai-sdk/index.js'
import { AuditLogger } from '../../src/logger.js'
import { MemoryStorage } from '../../src/storage/memory.js'

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

describe('logFromAISDKResult', () => {
  let logger: AuditLogger

  afterEach(async () => {
    await logger.close()
  })

  it('logs an inference event from a result', async () => {
    const setup = createTestLogger()
    logger = setup.logger

    const entries = await logFromAISDKResult(logger, {
      decisionId: 'dec_1',
      prompt: 'What is AI?',
      result: {
        text: 'AI is artificial intelligence.',
        finishReason: 'stop',
        usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
        response: { modelId: 'anthropic/claude-sonnet-4-5-20250929' },
      },
    })

    expect(entries.length).toBe(1)
    expect(entries[0].eventType).toBe('inference')
    expect(entries[0].decisionId).toBe('dec_1')
    expect(entries[0].modelId).toBe('anthropic/claude-sonnet-4-5-20250929')
    expect(entries[0].input.value).toBe('What is AI?')
    expect(entries[0].output?.value).toBe('AI is artificial intelligence.')
    expect(entries[0].captureMethod).toBe('manual')
  })

  it('logs tool calls from a result', async () => {
    const setup = createTestLogger()
    logger = setup.logger

    const entries = await logFromAISDKResult(logger, {
      decisionId: 'dec_1',
      prompt: 'Search for something',
      result: {
        text: 'Here are the results',
        finishReason: 'stop',
        toolCalls: [
          { toolName: 'search', args: { query: 'test' } },
          { toolName: 'fetch', args: { url: 'https://example.com' } },
        ],
        response: { modelId: 'test-model' },
      },
    })

    expect(entries.length).toBe(3)
    expect(entries[0].eventType).toBe('inference')
    expect(entries[1].eventType).toBe('tool_call')
    expect(entries[1].toolCall?.toolName).toBe('search')
    expect(entries[2].eventType).toBe('tool_call')
    expect(entries[2].toolCall?.toolName).toBe('fetch')
  })

  it('logs tool results from a result', async () => {
    const setup = createTestLogger()
    logger = setup.logger

    const entries = await logFromAISDKResult(logger, {
      decisionId: 'dec_1',
      prompt: 'Search',
      result: {
        text: 'Done',
        finishReason: 'stop',
        toolResults: [
          { toolName: 'search', result: { items: ['a', 'b'] } },
        ],
        response: { modelId: 'test-model' },
      },
    })

    expect(entries.length).toBe(2)
    expect(entries[1].eventType).toBe('tool_result')
    expect(entries[1].toolCall?.toolName).toBe('search')
  })

  it('handles array prompt (messages format)', async () => {
    const setup = createTestLogger()
    logger = setup.logger

    const messages = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
    ]

    const entries = await logFromAISDKResult(logger, {
      decisionId: 'dec_1',
      prompt: messages,
      result: {
        text: 'Hi!',
        finishReason: 'stop',
        response: { modelId: 'test-model' },
      },
    })

    expect(entries[0].input.value).toBe(JSON.stringify(messages))
  })

  it('passes metadata through', async () => {
    const setup = createTestLogger()
    logger = setup.logger

    const entries = await logFromAISDKResult(logger, {
      decisionId: 'dec_1',
      prompt: 'Test',
      result: {
        text: 'Response',
        finishReason: 'stop',
        response: { modelId: 'test-model' },
      },
      metadata: { endpoint: '/api/chat', userId: 'user_1' },
    })

    expect(entries[0].metadata).toEqual({ endpoint: '/api/chat', userId: 'user_1' })
  })
})
