/**
 * AI SDK middleware — automatic capture for Vercel AI SDK models.
 *
 * Wraps a LanguageModelV1 and automatically logs every inference call.
 * This is the primary mechanism for satisfying Article 12(1)'s
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
                streamFinishReason = finishChunk.finishReason as string | undefined
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
 * - For regular generateText calls: result.text is a string.
 * - For structured output (JSON mode): result.text contains the JSON string.
 * - For tool-mode structured output (generateObject with tool mode):
 *   result.text may be undefined; the JSON lives in toolCalls[0].args.
 *
 * Falls back to stringified tool call args when text is absent.
 */
function extractText(result: Record<string, unknown>): string {
  if (typeof result.text === 'string' && result.text.length > 0) {
    return result.text
  }

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

function extractFinishReason(result: Record<string, unknown>): string | undefined {
  const reason = result.finishReason
  if (typeof reason === 'string') return reason
  return undefined
}

/**
 * Normalise a usage object into the shape expected by the audit schema.
 *
 * The AI SDK's LanguageModelV1 provides { promptTokens, completionTokens }
 * without totalTokens. Some providers may include totalTokens. This helper
 * handles both cases and computes totalTokens when absent.
 */
function normaliseUsage(usage: Record<string, unknown> | undefined): {
  promptTokens: number
  completionTokens: number
  totalTokens: number
} | null {
  if (!usage) return null
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
 * The AI SDK's LanguageModelV1FunctionToolCall defines args as a stringified
 * JSON string. We parse it into an object for structured logging. If parsing
 * fails, the raw string is wrapped in a { _raw: ... } object.
 */
function extractToolCalls(result: Record<string, unknown>): Array<{
  toolName: string
  args: Record<string, unknown>
}> {
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
