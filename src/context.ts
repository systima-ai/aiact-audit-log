/**
 * AsyncLocalStorage-based context propagation for audit logging.
 *
 * Allows decision IDs and metadata to flow through async call chains
 * without manual threading. This reduces the integration burden that
 * leads to coverage gaps.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface AuditContext {
  decisionId: string
  parentDecisionId?: string
  metadata?: Record<string, string | number | boolean>
}

const auditStorage = new AsyncLocalStorage<AuditContext>()

export function withAuditContext<T>(
  context: AuditContext,
  callback: () => T | Promise<T>,
): T | Promise<T> {
  return auditStorage.run(context, callback)
}

export function getAuditContext(): AuditContext | undefined {
  return auditStorage.getStore()
}

export class MissingDecisionIdError extends Error {
  constructor() {
    super(
      'decisionId is required. Either provide it explicitly in the log entry, ' +
      'or wrap the call in withAuditContext({ decisionId: "..." }, callback).',
    )
    this.name = 'MissingDecisionIdError'
  }
}
