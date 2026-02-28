/**
 * AI SDK helper — logFromAISDKResult
 *
 * Extracts fields from a Vercel AI SDK result object and logs them.
 * This is a post-call helper for developers who prefer explicit control
 * over what is logged, rather than using the middleware.
 *
 * Sets captureMethod: 'manual' on all entries.
 */

import type { AuditLogger } from '../logger.js'
import type { AuditLogEntryExtended, LogEntryInput } from '../schema.js'

export interface AISDKLogOptions {
  decisionId: string
  prompt: string | Array<{ role: string; content: string }>
  result: AISDKResult
  metadata?: Record<string, string | number | boolean>
}

export interface AISDKResult {
  text?: string
  finishReason?: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  toolCalls?: Array<{
    toolName: string
    args: Record<string, unknown>
  }>
  toolResults?: Array<{
    toolName: string
    result: unknown
  }>
  response?: {
    modelId?: string
    timestamp?: string
  }
}

export async function logFromAISDKResult(
  logger: AuditLogger,
  options: AISDKLogOptions,
): Promise<AuditLogEntryExtended[]> {
  const { decisionId, prompt, result, metadata } = options
  const entries: AuditLogEntryExtended[] = []

  const inputText = typeof prompt === 'string'
    ? prompt
    : JSON.stringify(prompt)

  const inferenceEntry = await logger.log({
    decisionId,
    eventType: 'inference',
    modelId: result.response?.modelId ?? null,
    providerId: result.response?.modelId?.split('/')[0] ?? null,
    input: { value: inputText },
    output: result.text !== undefined
      ? { value: result.text, finishReason: result.finishReason }
      : null,
    latencyMs: result.response?.timestamp
      ? Date.now() - new Date(result.response.timestamp).getTime()
      : null,
    usage: result.usage
      ? {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
        }
      : null,
    parameters: null,
    error: null,
    captureMethod: 'manual',
    metadata: metadata ?? undefined,
  })
  entries.push(inferenceEntry)

  if (result.toolCalls && result.toolCalls.length > 0) {
    for (const toolCall of result.toolCalls) {
      const toolEntry = await logger.log({
        decisionId,
        eventType: 'tool_call',
        modelId: result.response?.modelId ?? null,
        providerId: null,
        input: { value: JSON.stringify(toolCall.args) },
        output: null,
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
        toolCall: {
          toolName: toolCall.toolName,
          toolArgs: toolCall.args,
        },
        captureMethod: 'manual',
        metadata: metadata ?? undefined,
      })
      entries.push(toolEntry)
    }
  }

  if (result.toolResults && result.toolResults.length > 0) {
    for (const toolResult of result.toolResults) {
      const resultEntry = await logger.log({
        decisionId,
        eventType: 'tool_result',
        modelId: null,
        providerId: null,
        input: { value: '' },
        output: { value: JSON.stringify(toolResult.result) },
        latencyMs: null,
        usage: null,
        parameters: null,
        error: null,
        toolCall: {
          toolName: toolResult.toolName,
          toolArgs: {},
          toolResult: JSON.stringify(toolResult.result),
        },
        captureMethod: 'manual',
        metadata: metadata ?? undefined,
      })
      entries.push(resultEntry)
    }
  }

  return entries
}
