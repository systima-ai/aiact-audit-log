/**
 * AI SDK middleware — automatic capture for Vercel AI SDK models.
 *
 * Wraps a LanguageModelV1 and automatically logs every inference call.
 * This is the primary mechanism for supporting Article 12(1)'s
 * "automatic recording" requirement for inference events.
 *
 * Usage:
 *   const model = auditMiddleware(anthropic('claude-sonnet-4-5-20250929'), { logger })
 *   const result = await generateText({ model, prompt })
 *   // ^ Inference is automatically logged
 */

import {
  wrapLanguageModel,
  type LanguageModelV1,
  type LanguageModelV1Middleware,
} from 'ai'
import type { AuditLogger } from '../../logger.js'
import { getAuditContext } from '../../context.js'
import { generateUUIDv7 } from '../../utils/uuid.js'

export interface AuditMiddlewareOptions {
  logger: AuditLogger
  captureInputs?: boolean
  captureOutputs?: boolean
  captureToolCalls?: boolean
  captureParameters?: boolean
}

export function auditMiddleware(
  model: LanguageModelV1,
  options: AuditMiddlewareOptions,
): LanguageModelV1 {
  const {
    logger,
    captureInputs = true,
    captureOutputs = true,
  } = options

  const middleware: LanguageModelV1Middleware = {
    middlewareVersion: 'v1',

    wrapGenerate: async ({ doGenerate, params }) => {
      const startTime = Date.now()
      const context = getAuditContext()
      const decisionId = context?.decisionId ?? generateUUIDv7()

      try {
        const result = await doGenerate()
        const latencyMs = Date.now() - startTime

        const responseModelId = extractModelId(result)
        const text = extractText(result)
        const usage = extractUsage(result)
        const finishReason = extractFinishReason(result)

        await logger.log({
          decisionId,
          eventType: 'inference',
          modelId: responseModelId ?? model.modelId ?? null,
          providerId: responseModelId?.split('/')[0] ?? model.provider ?? null,
          input: captureInputs
            ? { value: serialisePrompt(params.prompt) }
            : { value: '', type: 'hash' },
          output: captureOutputs
            ? { value: text, finishReason }
            : text
              ? { value: '', type: 'hash', finishReason }
              : null,
          latencyMs,
          usage,
          parameters: options.captureParameters !== false
            ? extractParams(params)
            : null,
          error: null,
          captureMethod: 'middleware',
          metadata: context?.metadata,
        })

        if (options.captureToolCalls !== false) {
          const toolCalls = extractToolCalls(result)
          for (const tc of toolCalls) {
            await logger.log({
              decisionId,
              eventType: 'tool_call',
              modelId: responseModelId ?? model.modelId ?? null,
              providerId: null,
              input: { value: JSON.stringify(tc.args) },
              output: null,
              latencyMs: null,
              usage: null,
              parameters: null,
              error: null,
              toolCall: {
                toolName: tc.toolName,
                toolArgs: tc.args,
              },
              captureMethod: 'middleware',
              metadata: context?.metadata,
            })
          }
        }

        return result
      } catch (error) {
        const latencyMs = Date.now() - startTime

        await logger.log({
          decisionId,
          eventType: 'inference',
          modelId: model.modelId ?? null,
          providerId: model.provider ?? null,
          input: captureInputs
            ? { value: serialisePrompt(params.prompt) }
            : { value: '', type: 'hash' },
          output: null,
          latencyMs,
          usage: null,
          parameters: options.captureParameters !== false
            ? extractParams(params)
            : null,
          error: {
            code: (error as Error).name ?? 'UNKNOWN',
            message: (error as Error).message ?? String(error),
          },
          captureMethod: 'middleware',
          metadata: context?.metadata,
        })

        throw error
      }
    },

    wrapStream: async ({ doStream, params }) => {
      const startTime = Date.now()
      const context = getAuditContext()
      const decisionId = context?.decisionId ?? generateUUIDv7()

      try {
        const result = await doStream()
        const { stream, ...rest } = result

        const chunks: string[] = []
        let streamUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null
        let streamFinishReason: string | undefined
        let streamModelId: string | null = null

        const loggingStream = stream.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              if (chunk.type === 'text-delta') {
                chunks.push(chunk.textDelta)
              }
              if (chunk.type === 'response-metadata') {
                const meta = chunk as Record<string, unknown>
                streamModelId = (meta.modelId as string) ?? null
              }
              if (chunk.type === 'finish') {
                const finishChunk = chunk as Record<string, unknown>
                streamUsage = normaliseUsage(finishChunk.usage as Record<string, unknown> | undefined)
                // V1: finishReason is a string; V3: finishReason is { unified, raw }
                const reason = finishChunk.finishReason
                if (typeof reason === 'string') {
                  streamFinishReason = reason
                } else if (reason && typeof reason === 'object') {
                  streamFinishReason = ((reason as Record<string, unknown>).unified as string) ?? undefined
                }
              }
              controller.enqueue(chunk)
            },
            async flush() {
              const latencyMs = Date.now() - startTime
              const fullText = chunks.join('')

              await logger.log({
                decisionId,
                eventType: 'inference',
                modelId: streamModelId ?? model.modelId ?? null,
                providerId: streamModelId?.split('/')[0] ?? model.provider ?? null,
                input: captureInputs
                  ? { value: serialisePrompt(params.prompt) }
                  : { value: '', type: 'hash' },
                output: captureOutputs
                  ? { value: fullText, finishReason: streamFinishReason }
                  : fullText
                    ? { value: '', type: 'hash', finishReason: streamFinishReason }
                    : null,
                latencyMs,
                usage: streamUsage,
                parameters: options.captureParameters !== false
                  ? extractParams(params)
                  : null,
                error: null,
                captureMethod: 'middleware',
                metadata: context?.metadata,
              })
            },
          }),
        )

        return { stream: loggingStream, ...rest }
      } catch (error) {
        const latencyMs = Date.now() - startTime

        await logger.log({
          decisionId,
          eventType: 'inference',
          modelId: model.modelId ?? null,
          providerId: model.provider ?? null,
          input: captureInputs
            ? { value: serialisePrompt(params.prompt) }
            : { value: '', type: 'hash' },
          output: null,
          latencyMs,
          usage: null,
          parameters: options.captureParameters !== false
            ? extractParams(params)
            : null,
          error: {
            code: (error as Error).name ?? 'UNKNOWN',
            message: (error as Error).message ?? String(error),
          },
          captureMethod: 'middleware',
          metadata: context?.metadata,
        })

        throw error
      }
    },
  }

  return wrapLanguageModel({ model, middleware })
}

// ── Extraction helpers ──────────────────────────────────────

function serialisePrompt(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt
  try {
    return JSON.stringify(prompt)
  } catch {
    return String(prompt)
  }
}

function extractModelId(result: Record<string, unknown>): string | null {
  const response = result.response as Record<string, unknown> | undefined
  return (response?.modelId as string) ?? null
}

/**
 * Extract output text from the result.
 *
 * Handles two AI SDK result formats:
 *
 * **V1 format** (AI SDK v4; LanguageModelV1):
 *   - result.text is a string
 *   - result.toolCalls is an array with { toolName, args }
 *
 * **V3 format** (AI SDK v5/v6; LanguageModelV3GenerateResult):
 *   - result.content is an array of content parts
 *   - Text parts: { type: 'text', text: string }
 *   - Tool calls: { type: 'tool-call', toolName, input: string }
 *
 * Falls back to stringified tool call args when text is absent.
 */
function extractText(result: Record<string, unknown>): string {
  // V1 path: result.text is a string (AI SDK v4)
  if (typeof result.text === 'string' && result.text.length > 0) {
    return result.text
  }

  // V3 path: result.content is an array of content parts (AI SDK v5/v6)
  const content = result.content as Array<Record<string, unknown>> | undefined
  if (content && Array.isArray(content)) {
    // Collect all text parts
    const textParts = content
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)

    if (textParts.length > 0) {
      return textParts.join('')
    }

    // Fall back to tool-call input (structured output in V3)
    const toolCallPart = content.find((part) => part.type === 'tool-call')
    if (toolCallPart) {
      const input = toolCallPart.input
      if (typeof input === 'string') return input
      if (input && typeof input === 'object') {
        try { return JSON.stringify(input) } catch { /* fall through */ }
      }
    }
  }

  // V1 fallback: result.toolCalls array (AI SDK v4 tool-mode structured output)
  const toolCalls = result.toolCalls as Array<Record<string, unknown>> | undefined
  if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
    const args = toolCalls[0].args
    if (typeof args === 'string') return args
    if (args && typeof args === 'object') {
      try { return JSON.stringify(args) } catch { /* fall through */ }
    }
  }

  return ''
}

/**
 * Extract finish reason from the result.
 *
 * - V1 (AI SDK v4): result.finishReason is a plain string ('stop', 'length', etc.)
 * - V3 (AI SDK v5/v6): result.finishReason is { unified: string, raw: string | undefined }
 */
function extractFinishReason(result: Record<string, unknown>): string | undefined {
  const reason = result.finishReason
  if (typeof reason === 'string') return reason
  if (reason && typeof reason === 'object') {
    const unified = (reason as Record<string, unknown>).unified
    if (typeof unified === 'string') return unified
  }
  return undefined
}

/**
 * Normalise a usage object into the shape expected by the audit schema.
 *
 * Handles two AI SDK usage formats:
 *
 * **V1 format** (AI SDK v4):
 *   { promptTokens: number, completionTokens: number }
 *   No totalTokens; computed as prompt + completion.
 *
 * **V3 format** (AI SDK v5/v6; LanguageModelV3Usage):
 *   { inputTokens: { total, noCache, cacheRead, cacheWrite },
 *     outputTokens: { total, text, reasoning } }
 */
function normaliseUsage(usage: Record<string, unknown> | undefined): {
  promptTokens: number
  completionTokens: number
  totalTokens: number
} | null {
  if (!usage) return null

  // V3 path: nested { inputTokens: { total }, outputTokens: { total } }
  const inputTokens = usage.inputTokens as Record<string, unknown> | undefined
  const outputTokens = usage.outputTokens as Record<string, unknown> | undefined

  if (inputTokens && typeof inputTokens === 'object') {
    const prompt = (typeof inputTokens.total === 'number') ? inputTokens.total : 0
    const completion = (outputTokens && typeof outputTokens.total === 'number') ? outputTokens.total : 0
    return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion }
  }

  // V1 path: flat { promptTokens, completionTokens }
  const prompt = (typeof usage.promptTokens === 'number') ? usage.promptTokens : 0
  const completion = (typeof usage.completionTokens === 'number') ? usage.completionTokens : 0
  const total = (typeof usage.totalTokens === 'number') ? usage.totalTokens : (prompt + completion)
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total }
}

function extractUsage(result: Record<string, unknown>): {
  promptTokens: number
  completionTokens: number
  totalTokens: number
} | null {
  return normaliseUsage(result.usage as Record<string, unknown> | undefined)
}

/**
 * Extract tool calls from the result.
 *
 * Handles two AI SDK result formats:
 *
 * **V1 format** (AI SDK v4):
 *   result.toolCalls is an array of { toolName, args: string (stringified JSON) }
 *
 * **V3 format** (AI SDK v5/v6):
 *   result.content is an array; tool calls are { type: 'tool-call', toolName, input: string }
 *
 * In both cases, args/input are parsed into objects for structured logging.
 */
function extractToolCalls(result: Record<string, unknown>): Array<{
  toolName: string
  args: Record<string, unknown>
}> {
  // V3 path: tool calls live inside result.content array
  const content = result.content as Array<Record<string, unknown>> | undefined
  if (content && Array.isArray(content)) {
    const toolCallParts = content.filter((part) => part.type === 'tool-call')
    if (toolCallParts.length > 0) {
      return toolCallParts.map((tc) => ({
        toolName: (tc.toolName as string) ?? 'unknown',
        args: parseToolArgs(tc.input),
      }))
    }
  }

  // V1 path: result.toolCalls array
  const toolCalls = result.toolCalls as Array<Record<string, unknown>> | undefined
  if (!toolCalls || !Array.isArray(toolCalls)) return []

  return toolCalls.map((tc) => ({
    toolName: (tc.toolName as string) ?? 'unknown',
    args: parseToolArgs(tc.args),
  }))
}

function parseToolArgs(args: unknown): Record<string, unknown> {
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      return { _raw: args }
    } catch {
      return { _raw: args }
    }
  }
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>
  }
  return {}
}

function extractParams(params: Record<string, unknown>): Record<string, unknown> {
  const extracted: Record<string, unknown> = {}
  if (params.temperature !== undefined) extracted['temperature'] = params.temperature
  if (params.maxTokens !== undefined) extracted['maxTokens'] = params.maxTokens
  if (params.topP !== undefined) extracted['topP'] = params.topP
  if (params.topK !== undefined) extracted['topK'] = params.topK
  if (params.frequencyPenalty !== undefined) extracted['frequencyPenalty'] = params.frequencyPenalty
  if (params.presencePenalty !== undefined) extracted['presencePenalty'] = params.presencePenalty
  if (params.seed !== undefined) extracted['seed'] = params.seed
  return Object.keys(extracted).length > 0 ? extracted : {}
}
