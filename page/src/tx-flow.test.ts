// WO-057 D4 (C-6, C-15, C-18, C-27, C-42): the ONE broadcast pipeline. runTx holds exactly what
// main.ts's broadcast() did — the log lines and dataLayer events are pinned here verbatim — and
// runRedelegate is the shares-rounding retry loop over it.
import { describe, expect, it, vi } from 'vitest'
import { runTx, runRedelegate, type TxDeps } from './tx-flow'
import type { EncodeObject } from './sign'
import type { RedelegateEntry } from './grants'

const MSGS: EncodeObject[] = [{ typeUrl: '/x.Msg', value: {} }]
const ADDR = 'realio10eq6w0a7fpety33uag2f55e9tewxazt4v28aem'
const MEMO = 'https://compound.teshy.com/'

type Log = [string, string | undefined]

function harness(over: Partial<TxDeps> = {}) {
  const logs: Log[] = []
  const events: Record<string, unknown>[] = []
  const deps: TxDeps = {
    simulate: vi.fn(async () => 123456),
    signAndBroadcast: vi.fn(async () => ({
      code: 0,
      txhash: 'TXHASH',
      rawLog: '',
      delivery: 'accepted' as const,
    })),
    pollTx: vi.fn(async () => ({ status: 'confirmed' as const, height: '77' })),
    log: (m, k) => logs.push([m, k]),
    track: (p) => events.push(p),
    ...over,
  }
  return { deps, logs, events }
}
const msgs = (logs: Log[]) => logs.map((l) => l[0])

describe('runTx — outcomes', () => {
  it('confirmed → { txhash, confirmed: true }, the exact log lines, NO dataLayer event', async () => {
    const { deps, logs, events } = harness()
    const out = await runTx(deps, 'Enable auto-compound', MSGS, MEMO)
    expect(out).toEqual({ txhash: 'TXHASH', confirmed: true })
    expect(logs).toEqual([
      ['Enable auto-compound: checking grant & estimating fee…', undefined],
      ['Estimated gas 123456 — approve the transaction in your wallet…', undefined],
      ['Submitted TXHASH — waiting for on-chain confirmation…', undefined],
      ['Enable auto-compound completed — confirmed in block 77', 'ok'],
      ['tx TXHASH', undefined],
    ])
    expect(events).toEqual([])
  })

  it('passes the messages, the gas and the memo through to simulate and signAndBroadcast', async () => {
    const { deps } = harness()
    await runTx(deps, 'L', MSGS, 'my memo')
    expect(deps.simulate).toHaveBeenCalledWith(MSGS, 'my memo')
    expect(deps.signAndBroadcast).toHaveBeenCalledWith(MSGS, 123456, 'my memo')
    expect(deps.pollTx).toHaveBeenCalledWith('TXHASH')
  })

  it('rejected by the node (code ≠ 0) → undefined, error log, transaction_error with the scrubbed rawLog, never polled', async () => {
    const { deps, logs, events } = harness({
      signAndBroadcast: vi.fn(async () => ({
        code: 5,
        txhash: 'T',
        rawLog: `insufficient funds for ${ADDR}`,
        delivery: 'accepted' as const,
      })),
    })
    expect(await runTx(deps, 'Stake', MSGS, MEMO)).toBeUndefined()
    expect(logs.at(-1)).toEqual([
      `Stake rejected by the node (code 5): insufficient funds for ${ADDR}`,
      'err',
    ])
    expect(events).toEqual([
      {
        event: 'transaction_error',
        error_label: 'Stake',
        error_message: 'insufficient funds for [addr]',
      },
    ])
    expect(deps.pollTx).not.toHaveBeenCalled()
  })

  // docs/06 gate 2026-10-16 (P-1): the failure verdict comes from a tx-lookup endpoint we do not run.
  // So the outcome is "reported failed" (never "nothing landed"), the endpoint's raw_log text is never
  // shown (it could carry any message, e.g. seed-phrase "advice"), and there is no retry wording.
  it('reported failed on-chain → { txhash, confirmed: false, failedCode }, code-only log + event, no raw_log, no retry', async () => {
    const PHISH = 'Your wallet is compromised: import your seed phrase at evil.example'
    const { deps, logs, events } = harness({
      pollTx: vi.fn(async () => ({
        status: 'failed' as const,
        code: 11,
        height: '9',
        rawLog: `out of gas for ${ADDR}. ${PHISH}`,
      })),
    })
    expect(await runTx(deps, 'Stake', MSGS, MEMO)).toEqual({
      txhash: 'TXHASH',
      confirmed: false,
      failedCode: 11,
    })
    expect(logs.at(-1)).toEqual([
      'Stake: TXHASH was reported as failed on-chain (code 11). Check it on the explorer before resubmitting.',
      'err',
    ])
    expect(events).toEqual([
      { event: 'transaction_error', error_label: 'Stake', error_message: 'code 11' },
    ])
    const all = msgs(logs).join('\n')
    expect(all).not.toContain(PHISH)
    expect(all).not.toContain('out of gas')
    expect(all).not.toMatch(/retry|try again/i)
  })

  it('unconfirmed → { txhash, confirmed: false }, the explorer advice, transaction_unconfirmed, NEVER a success event', async () => {
    const { deps, logs, events } = harness({
      pollTx: vi.fn(async () => ({ status: 'unconfirmed' as const })),
    })
    expect(await runTx(deps, 'Stake', MSGS, MEMO)).toEqual({ txhash: 'TXHASH', confirmed: false })
    expect(logs.at(-1)).toEqual([
      'Stake: submitted TXHASH; confirmation unavailable. Check the explorer before resubmitting.',
      'err',
    ])
    expect(events).toEqual([{ event: 'transaction_unconfirmed', error_label: 'Stake' }])
    expect(
      events.some((e) => e.event === 'transaction_error' || e.event === 'compound_enabled'),
    ).toBe(false)
    expect(msgs(logs).join('\n')).not.toMatch(/retry|try again/i)
  })

  it('a throw (here: signAndBroadcast) → undefined, "<label> error: <msg>", transaction_error with the SCRUBBED message', async () => {
    const { deps, logs, events } = harness({
      signAndBroadcast: vi.fn(async () => {
        throw new Error(`account ${ADDR} not found or unreadable`)
      }),
    })
    expect(await runTx(deps, 'Stake', MSGS, MEMO)).toBeUndefined()
    expect(logs.at(-1)).toEqual([`Stake error: account ${ADDR} not found or unreadable`, 'err'])
    expect(events).toEqual([
      {
        event: 'transaction_error',
        error_label: 'Stake',
        error_message: 'account [addr] not found or unreadable',
      },
    ])
  })

  it('a throw with no message is stringified', async () => {
    const { deps, logs } = harness({
      pollTx: vi.fn(async () => {
        throw 'boom'
      }),
    })
    expect(await runTx(deps, 'L', MSGS, MEMO)).toBeUndefined()
    expect(logs.at(-1)).toEqual(['L error: boom', 'err'])
  })

  it('delivery unknown → the "did not answer" polling line, and the tx is still polled by its local hash', async () => {
    const { deps, logs } = harness({
      signAndBroadcast: vi.fn(async () => ({
        code: 0,
        txhash: 'LOCALHASH',
        rawLog: '',
        delivery: 'unknown' as const,
      })),
    })
    const out = await runTx(deps, 'Stake', MSGS, MEMO)
    expect(out).toEqual({ txhash: 'LOCALHASH', confirmed: true })
    expect(msgs(logs)).toContain(
      'The node did not answer the broadcast; checking whether LOCALHASH landed on-chain…',
    )
    expect(deps.pollTx).toHaveBeenCalledWith('LOCALHASH')
  })

  it('already in the mempool (code 19, WO-057 D5) → its own line, then polled like an accepted tx', async () => {
    const { deps, logs } = harness({
      signAndBroadcast: vi.fn(async () => ({
        code: 0,
        txhash: 'DUP',
        rawLog: 'tx already in mempool cache',
        delivery: 'accepted' as const,
        alreadyInMempool: true as const,
      })),
    })
    const out = await runTx(deps, 'Stake', MSGS, MEMO)
    expect(out).toEqual({ txhash: 'DUP', confirmed: true })
    expect(msgs(logs)).toContain('already in the mempool — checking it landed…')
    expect(msgs(logs)).not.toContain('Submitted DUP — waiting for on-chain confirmation…')
    expect(deps.pollTx).toHaveBeenCalledWith('DUP')
  })
})

describe('runTx — the simulate-error hook (redelegate retry)', () => {
  const simFails = (msg: string) =>
    harness({
      simulate: vi.fn(async () => {
        throw new Error(msg)
      }),
    })

  it('hook returns true → resolves "retry" with NO error log, NO event, and nothing signed', async () => {
    const { deps, logs, events } = simFails('insufficient amount')
    const hook = vi.fn(() => true)
    expect(await runTx(deps, 'Redelegate', MSGS, MEMO, hook)).toBe('retry')
    expect(hook).toHaveBeenCalledWith('insufficient amount')
    expect(logs.some((l) => l[1] === 'err')).toBe(false)
    expect(events).toEqual([])
    expect(deps.signAndBroadcast).not.toHaveBeenCalled()
  })

  it('hook returns false → the normal error path (log + scrubbed transaction_error)', async () => {
    const { deps, logs, events } = simFails(`bad ${ADDR}`)
    expect(await runTx(deps, 'Redelegate', MSGS, MEMO, () => false)).toBeUndefined()
    expect(logs.at(-1)).toEqual([`Redelegate error: bad ${ADDR}`, 'err'])
    expect(events).toEqual([
      { event: 'transaction_error', error_label: 'Redelegate', error_message: 'bad [addr]' },
    ])
  })

  it('no hook given → a simulate error is just an error', async () => {
    const { deps } = simFails('insufficient amount')
    expect(await runTx(deps, 'L', MSGS, MEMO)).toBeUndefined()
  })

  it('the hook is for SIMULATE errors only: a signAndBroadcast error never reaches it', async () => {
    const { deps } = harness({
      signAndBroadcast: vi.fn(async () => {
        throw new Error('insufficient amount')
      }),
    })
    const hook = vi.fn(() => true)
    expect(await runTx(deps, 'L', MSGS, MEMO, hook)).toBeUndefined()
    expect(hook).not.toHaveBeenCalled()
  })
})

describe('runRedelegate', () => {
  const entries: RedelegateEntry[] = [
    {
      srcValoper: 'realiovaloper1a',
      destValoper: 'realiovaloper1d',
      amount: 5_000_000_000n,
      denom: 'ario',
    },
    { srcValoper: 'realiovaloper1b', destValoper: 'realiovaloper1d', amount: 100n, denom: 'ario' },
  ]
  const step = 10n ** 9n

  type Outcome = { txhash: string; confirmed: boolean; failedCode?: number }
  function run(outcomes: (string | Outcome | undefined)[]) {
    const attempts: RedelegateEntry[][] = []
    const logs: Log[] = []
    const events: Record<string, unknown>[] = []
    let i = 0
    return {
      attempts,
      logs,
      events,
      go: () =>
        runRedelegate({
          entries,
          buildMessages: (current) => {
            attempts.push(current)
            return [{ typeUrl: '/m', value: current.length }]
          },
          run: async (_messages, onSimulateError) => {
            const o = outcomes[i++]
            if (o === 'retry-needed')
              return onSimulateError('insufficient amount') ? 'retry' : undefined
            return o as Outcome | undefined
          },
          log: (m, k) => logs.push([m, k]),
          track: (p) => events.push(p),
        }),
    }
  }

  it('confirmed first try → redelegate_complete + compound_enabled with the entry count, one attempt', async () => {
    const r = run([{ txhash: 'H', confirmed: true }])
    await r.go()
    expect(r.attempts).toEqual([entries])
    expect(r.events).toEqual([
      { event: 'redelegate_complete', entry_count: 2 },
      { event: 'compound_enabled' },
    ])
  })

  it('"insufficient amount" retry: every entry is reduced by 1e9, the adjustment is logged, then it succeeds', async () => {
    const r = run(['retry-needed', { txhash: 'H', confirmed: true }])
    await r.go()
    expect(r.attempts).toHaveLength(2)
    expect(r.attempts[1][0].amount).toBe(5_000_000_000n - step)
    expect(r.attempts[1][1].amount).toBe(100n) // already ≤ the step: left as is
    expect(r.logs).toEqual([
      [
        'Shares-rounding adjustment — please approve the corrected transaction in your wallet.',
        undefined,
      ],
    ])
    // entry_count is the ORIGINAL selection
    expect(r.events[0]).toEqual({ event: 'redelegate_complete', entry_count: 2 })
  })

  it('stops after MAX_RETRIES (3) reductions: 4 attempts, then the last "retry" is not acted on', async () => {
    const r = run(['retry-needed', 'retry-needed', 'retry-needed', 'retry-needed'])
    await r.go()
    expect(r.attempts).toHaveLength(4)
    expect(r.attempts[3][0].amount).toBe(5_000_000_000n - 3n * step)
    expect(r.events).toEqual([])
  })

  it('unconfirmed → no success events (the tx may still land), no retry', async () => {
    const r = run([{ txhash: 'H', confirmed: false }])
    await r.go()
    expect(r.attempts).toHaveLength(1)
    expect(r.events).toEqual([])
  })

  it('reported failed on-chain (failedCode, docs/06 gate 2026-10-16 P-1) → no events, no retry', async () => {
    const r = run([{ txhash: 'H', confirmed: false, failedCode: 5 }])
    await r.go()
    expect(r.attempts).toHaveLength(1)
    expect(r.events).toEqual([])
    expect(r.logs).toEqual([])
  })

  it('failure (undefined) → no events, no retry', async () => {
    const r = run([undefined])
    await r.go()
    expect(r.attempts).toHaveLength(1)
    expect(r.events).toEqual([])
  })
})

// WO-071 D2 (docs/06 gate 2026-10-16, P-6): runRedelegate resolves to the last run result that was not
// 'retry', so the page can reload the delegation list once a redelegate was submitted.
describe('runRedelegate — returns the outcome (WO-071 D2)', () => {
  const entries: RedelegateEntry[] = [
    {
      srcValoper: 'realiovaloper1a',
      destValoper: 'realiovaloper1d',
      amount: 5n * 10n ** 9n,
      denom: 'ario',
    },
  ]
  const go = (
    outcomes: (string | { txhash: string; confirmed: boolean; failedCode?: number } | undefined)[],
  ) => {
    let i = 0
    return runRedelegate({
      entries,
      buildMessages: () => [{ typeUrl: '/m', value: 1 }],
      run: async (_m, onSimulateError) => {
        const o = outcomes[i++]
        if (o === 'retry-needed')
          return onSimulateError('insufficient amount') ? 'retry' : undefined
        return o as { txhash: string; confirmed: boolean } | undefined
      },
      log: () => {},
      track: () => {},
    })
  }

  it('confirmed → that outcome', async () => {
    expect(await go([{ txhash: 'H', confirmed: true }])).toEqual({ txhash: 'H', confirmed: true })
  })

  it('unconfirmed and reported-failed outcomes are returned too (they may have landed)', async () => {
    expect(await go([{ txhash: 'H', confirmed: false }])).toEqual({ txhash: 'H', confirmed: false })
    expect(await go([{ txhash: 'H', confirmed: false, failedCode: 5 }])).toEqual({
      txhash: 'H',
      confirmed: false,
      failedCode: 5,
    })
  })

  it('nothing landed → undefined', async () => {
    expect(await go([undefined])).toBeUndefined()
  })

  it('a retry then a confirmed outcome → the confirmed one, never "retry"', async () => {
    expect(await go(['retry-needed', { txhash: 'H2', confirmed: true }])).toEqual({
      txhash: 'H2',
      confirmed: true,
    })
  })

  it('a retry then nothing landed → undefined', async () => {
    expect(await go(['retry-needed', undefined])).toBeUndefined()
  })
})
