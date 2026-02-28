import { describe, it, expect } from 'vitest'
import {
  withAuditContext,
  getAuditContext,
  MissingDecisionIdError,
} from '../src/context.js'

describe('withAuditContext', () => {
  it('makes context available inside the callback', async () => {
    let captured: ReturnType<typeof getAuditContext>

    await withAuditContext({ decisionId: 'dec_1' }, async () => {
      captured = getAuditContext()
    })

    expect(captured!).toBeDefined()
    expect(captured!.decisionId).toBe('dec_1')
  })

  it('provides metadata through context', async () => {
    let captured: ReturnType<typeof getAuditContext>

    await withAuditContext(
      { decisionId: 'dec_1', metadata: { key: 'value' } },
      async () => {
        captured = getAuditContext()
      },
    )

    expect(captured!.metadata).toEqual({ key: 'value' })
  })

  it('provides parentDecisionId through context', async () => {
    let captured: ReturnType<typeof getAuditContext>

    await withAuditContext(
      { decisionId: 'dec_child', parentDecisionId: 'dec_parent' },
      async () => {
        captured = getAuditContext()
      },
    )

    expect(captured!.parentDecisionId).toBe('dec_parent')
  })

  it('returns undefined outside any context', () => {
    const ctx = getAuditContext()
    expect(ctx).toBeUndefined()
  })

  it('inner context overrides outer context', async () => {
    let outerCapture: ReturnType<typeof getAuditContext>
    let innerCapture: ReturnType<typeof getAuditContext>

    await withAuditContext({ decisionId: 'outer' }, async () => {
      outerCapture = getAuditContext()

      await withAuditContext({ decisionId: 'inner' }, async () => {
        innerCapture = getAuditContext()
      })
    })

    expect(outerCapture!.decisionId).toBe('outer')
    expect(innerCapture!.decisionId).toBe('inner')
  })

  it('restores outer context after inner context completes', async () => {
    let afterInner: ReturnType<typeof getAuditContext>

    await withAuditContext({ decisionId: 'outer' }, async () => {
      await withAuditContext({ decisionId: 'inner' }, async () => {
        // inner
      })

      afterInner = getAuditContext()
    })

    expect(afterInner!.decisionId).toBe('outer')
  })

  it('isolates context across concurrent async operations', async () => {
    const results: string[] = []

    await Promise.all([
      withAuditContext({ decisionId: 'op-1' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        const ctx = getAuditContext()
        results.push(ctx!.decisionId)
      }),
      withAuditContext({ decisionId: 'op-2' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        const ctx = getAuditContext()
        results.push(ctx!.decisionId)
      }),
    ])

    expect(results).toContain('op-1')
    expect(results).toContain('op-2')
    expect(results.length).toBe(2)
  })

  it('works with synchronous callbacks', () => {
    const result = withAuditContext({ decisionId: 'sync' }, () => {
      const ctx = getAuditContext()
      return ctx!.decisionId
    })

    expect(result).toBe('sync')
  })

  it('propagates through setTimeout', async () => {
    let captured: ReturnType<typeof getAuditContext>

    await withAuditContext({ decisionId: 'timer' }, async () => {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          captured = getAuditContext()
          resolve()
        }, 1)
      })
    })

    expect(captured!.decisionId).toBe('timer')
  })
})

describe('MissingDecisionIdError', () => {
  it('has the correct name', () => {
    const error = new MissingDecisionIdError()
    expect(error.name).toBe('MissingDecisionIdError')
  })

  it('includes guidance in the message', () => {
    const error = new MissingDecisionIdError()
    expect(error.message).toContain('decisionId')
    expect(error.message).toContain('withAuditContext')
  })
})
