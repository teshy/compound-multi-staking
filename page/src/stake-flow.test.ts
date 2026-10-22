// WO-049 (T-8, T-13, T-27 retry half): BUG-1 multi-stake gating and the redelegate retry step.
import { describe, expect, it } from 'vitest'
import { submitStakes, nextRedelegateAttempt } from './stake-flow'
import type { StakeEntry } from './grants'
import type { EncodeObject } from './sign'
import { DENOM, RST_DENOM, DSTRX_DENOM, TESHY_VALOPER } from './realio'

const RIO = 10n ** 18n
const LABELS: Record<string, string> = {
  [DENOM]: 'RIO',
  [RST_DENOM]: 'RST',
  [DSTRX_DENOM]: 'DSTRX',
}
const stake = (denom: string, n: bigint): StakeEntry => ({
  denom,
  valoper: TESHY_VALOPER,
  amount: n * RIO,
})
const THREE = [stake(DENOM, 3n), stake(RST_DENOM, 2n), stake(DSTRX_DENOM, 1n)]
const GRANTS: EncodeObject[] = [
  { typeUrl: '/grant/withdraw', value: 0 },
  { typeUrl: '/grant/delegate', value: 0 },
]

// A result is a confirmed txhash (string), a submitted-but-unconfirmed one ({ unconfirmed }), one the
// tx lookup REPORTED failed on-chain ({ failed, code }), or undefined (nothing landed).
type Result = string | { unconfirmed: string } | { failed: string; code: number } | undefined
function harness(results: Result[]) {
  const calls: { label: string; msgs: EncodeObject[] }[] = []
  const logs: { msg: string; kind?: string }[] = []
  const tracks: Record<string, unknown>[] = []
  let i = 0
  const deps = {
    broadcast: async (label: string, msgs: EncodeObject[]) => {
      calls.push({ label, msgs })
      const r = results[i++]
      if (r === undefined) return undefined
      if (typeof r === 'string') return { txhash: r, confirmed: true }
      if ('failed' in r) return { txhash: r.failed, confirmed: false, failedCode: r.code }
      return { txhash: r.unconfirmed, confirmed: false }
    },
    buildMsgs: (s: StakeEntry): EncodeObject[] => [
      { typeUrl: `/delegate/${s.denom}`, value: s.amount },
    ],
    label: (d: string) => LABELS[d] ?? d,
    log: (msg: string, kind?: 'info' | 'ok' | 'err') => void logs.push({ msg, kind }),
    track: (p: Record<string, unknown>) => void tracks.push(p),
  }
  return { deps, calls, logs, tracks }
}
const events = (tracks: Record<string, unknown>[], name: string) =>
  tracks.filter((t) => t.event === name)

describe('submitStakes', () => {
  it('(a) BUG-1: first tx fails → exactly one broadcast, the gate message, no stake_complete', async () => {
    const h = harness([undefined, 'H2', 'H3'])
    await submitStakes(THREE, GRANTS, h.deps)
    expect(h.calls).toHaveLength(1)
    expect(h.logs.at(-1)).toEqual({
      msg: 'The first transaction did not complete, so the remaining 2 stake(s) were not submitted — nothing further was sent. Resolve the issue (or retry) and submit again.',
      kind: 'err',
    })
    expect(events(h.tracks, 'stake_complete')).toHaveLength(0)
    expect(events(h.tracks, 'compound_enabled')).toHaveLength(0)
  })

  it('(b) all succeed → 3 broadcasts, grants only in the first, 3 stake_complete + 1 compound_enabled', async () => {
    const h = harness(['H1', 'H2', 'H3'])
    await submitStakes(THREE, GRANTS, h.deps)
    expect(h.calls.map((c) => c.label)).toEqual(['RIO', 'RST', 'DSTRX'])
    expect(h.calls[0].msgs.map((m) => m.typeUrl)).toEqual([
      '/delegate/ario',
      '/grant/withdraw',
      '/grant/delegate',
    ])
    for (const c of h.calls.slice(1)) {
      expect(c.msgs.map((m) => m.typeUrl).some((t) => t.startsWith('/grant/'))).toBe(false)
    }
    expect(events(h.tracks, 'stake_complete')).toEqual([
      { event: 'stake_complete', token: 'RIO', amount: '3' },
      { event: 'stake_complete', token: 'RST', amount: '2' },
      { event: 'stake_complete', token: 'DSTRX', amount: '1' },
    ])
    expect(events(h.tracks, 'compound_enabled')).toEqual([{ event: 'compound_enabled' }])
    // the compound_enabled event follows the first stake_complete
    expect(h.tracks.map((t) => t.event)).toEqual([
      'stake_complete',
      'compound_enabled',
      'stake_complete',
      'stake_complete',
    ])
  })

  it('(c) the second fails → the third is still attempted (today’s behavior)', async () => {
    const h = harness(['H1', undefined, 'H3'])
    await submitStakes(THREE, GRANTS, h.deps)
    expect(h.calls).toHaveLength(3)
    expect(events(h.tracks, 'stake_complete').map((t) => t.token)).toEqual(['RIO', 'DSTRX'])
    expect(events(h.tracks, 'compound_enabled')).toHaveLength(1)
  })

  it('tells the user how many approvals to expect when there is more than one stake', async () => {
    const h = harness(['H1', 'H2', 'H3'])
    await submitStakes(THREE, GRANTS, h.deps)
    expect(h.logs[0].msg).toBe("3 transactions — you'll be asked to approve each in your wallet.")
    const single = harness(['H1'])
    await submitStakes([stake(DENOM, 3n)], GRANTS, single.deps)
    expect(single.logs).toHaveLength(0)
  })

  it('a single failing stake logs no BUG-1 message (there is nothing left to skip)', async () => {
    const h = harness([undefined])
    await submitStakes([stake(DENOM, 3n)], GRANTS, h.deps)
    expect(h.calls).toHaveLength(1)
    expect(h.logs).toHaveLength(0)
    expect(h.tracks).toHaveLength(0)
  })

  it('a single stake still carries the grants', async () => {
    const h = harness(['H1'])
    await submitStakes([stake(RST_DENOM, 2n)], GRANTS, h.deps)
    expect(h.calls[0].msgs.map((m) => m.typeUrl)).toEqual([
      '/delegate/arst',
      '/grant/withdraw',
      '/grant/delegate',
    ])
  })
})

// WO-045 (T-6): a tx that was submitted but could not be confirmed may still land. The page must
// not send anything more on top of it (the next tx could double-stake or collide on the account
// sequence), must not call it a success, and must never tell the user to retry it.
describe('submitStakes — submitted but unconfirmed', () => {
  const noRetry = (logs: { msg: string }[]) => logs.every((l) => !/retry|try again/i.test(l.msg))

  it('first tx unconfirmed → the rest are NOT sent, no success events, no retry wording', async () => {
    const h = harness([{ unconfirmed: 'H1' }, 'H2', 'H3'])
    await submitStakes(THREE, GRANTS, h.deps)
    expect(h.calls).toHaveLength(1)
    expect(events(h.tracks, 'stake_complete')).toHaveLength(0)
    expect(events(h.tracks, 'compound_enabled')).toHaveLength(0)
    expect(noRetry(h.logs)).toBe(true)
    expect(h.logs.at(-1)).toEqual({
      msg: 'The first transaction (H1) was submitted but could not be confirmed, so the remaining 2 stake(s) (RST, DSTRX) were not submitted. Check the explorer: once H1 shows as successful, submit the remaining stake(s) on their own — do not resubmit the first.',
      kind: 'err',
    })
  })

  it('a later tx unconfirmed → the ones after it are NOT sent; earlier confirmed ones still count', async () => {
    const h = harness(['H1', { unconfirmed: 'H2' }, 'H3'])
    await submitStakes(THREE, GRANTS, h.deps)
    expect(h.calls.map((c) => c.label)).toEqual(['RIO', 'RST'])
    expect(events(h.tracks, 'stake_complete').map((t) => t.token)).toEqual(['RIO'])
    expect(events(h.tracks, 'compound_enabled')).toHaveLength(1)
    expect(noRetry(h.logs)).toBe(true)
    expect(h.logs.at(-1)).toEqual({
      msg: 'RST (H2) was submitted but could not be confirmed, so the remaining 1 stake(s) (DSTRX) were not submitted. Check the explorer: once H2 shows as successful, submit the remaining stake(s) on their own.',
      kind: 'err',
    })
  })

  it('the last tx unconfirmed → nothing is left to skip, so no skip message', async () => {
    const h = harness(['H1', 'H2', { unconfirmed: 'H3' }])
    await submitStakes(THREE, GRANTS, h.deps)
    expect(h.calls).toHaveLength(3)
    expect(events(h.tracks, 'stake_complete').map((t) => t.token)).toEqual(['RIO', 'RST'])
    expect(h.logs.filter((l) => l.kind === 'err')).toHaveLength(0)
  })

  it('a single unconfirmed stake fires no success events', async () => {
    const h = harness([{ unconfirmed: 'H1' }])
    await submitStakes([stake(DENOM, 3n)], GRANTS, h.deps)
    expect(h.calls).toHaveLength(1)
    expect(h.tracks).toHaveLength(0)
  })
})

// docs/06 gate 2026-10-16 (P-1): a failure verdict comes from a tx-lookup endpoint we do not run, so it
// could be wrong in either direction. A reported failure is never read as "nothing landed": for the
// FIRST tx (it carries the grants) the rest are held back with check-the-explorer advice and no retry
// wording; a LATER one is isolated like before (the next denom's tx is independent of it).
describe('submitStakes — a failure reported by the tx lookup', () => {
  const noRetry = (logs: { msg: string }[]) => logs.every((l) => !/retry|try again/i.test(l.msg))

  it('first tx reported failed → the rest are NOT sent, explorer advice, no retry wording, no events', async () => {
    const h = harness([{ failed: 'H1', code: 5 }, 'H2', 'H3'])
    await submitStakes(THREE, GRANTS, h.deps)
    expect(h.calls).toHaveLength(1)
    expect(h.tracks).toHaveLength(0)
    expect(noRetry(h.logs)).toBe(true)
    expect(h.logs.at(-1)).toEqual({
      msg: 'The first transaction (H1) was reported as failed on-chain (code 5), so the remaining 2 stake(s) (RST, DSTRX) were not submitted. Check H1 on the explorer before submitting anything again: if it failed, submit all the stakes again; if it succeeded, submit only the remaining ones.',
      kind: 'err',
    })
  })

  it('a later tx reported failed → the next one is still attempted (isolated, as before)', async () => {
    const h = harness(['H1', { failed: 'H2', code: 5 }, 'H3'])
    await submitStakes(THREE, GRANTS, h.deps)
    expect(h.calls.map((c) => c.label)).toEqual(['RIO', 'RST', 'DSTRX'])
    expect(events(h.tracks, 'stake_complete').map((t) => t.token)).toEqual(['RIO', 'DSTRX'])
    expect(h.logs.filter((l) => l.kind === 'err')).toHaveLength(0) // runTx already logged that one
  })

  it('a single stake reported failed → nothing left to hold back, no events', async () => {
    const h = harness([{ failed: 'H1', code: 5 }])
    await submitStakes([stake(DENOM, 3n)], GRANTS, h.deps)
    expect(h.calls).toHaveLength(1)
    expect(h.logs).toHaveLength(0)
    expect(h.tracks).toHaveLength(0)
  })
})

describe('nextRedelegateAttempt', () => {
  const STEP = 10n ** 9n
  const entries = [
    { amount: 5n * RIO, id: 'a' },
    { amount: 7n * RIO, id: 'b' },
  ]

  it('"insufficient amount" reduces each entry by exactly reduceStep, keeping other fields', () => {
    const next = nextRedelegateAttempt(entries, 'rpc error: insufficient amount', 0, 3, STEP)
    expect(next).toEqual([
      { amount: 5n * RIO - STEP, id: 'a' },
      { amount: 7n * RIO - STEP, id: 'b' },
    ])
    expect(entries[0].amount).toBe(5n * RIO) // input not mutated
  })

  it('an entry at or below the step is left unchanged', () => {
    const next = nextRedelegateAttempt(
      [{ amount: STEP }, { amount: STEP - 1n }, { amount: STEP + 1n }],
      'insufficient amount',
      0,
      3,
      STEP,
    )
    expect(next!.map((e) => e.amount)).toEqual([STEP, STEP - 1n, 1n])
  })

  it('returns null once attempt === maxRetries (and for any later attempt)', () => {
    expect(nextRedelegateAttempt(entries, 'insufficient amount', 2, 3, STEP)).not.toBeNull()
    expect(nextRedelegateAttempt(entries, 'insufficient amount', 3, 3, STEP)).toBeNull()
    expect(nextRedelegateAttempt(entries, 'insufficient amount', 4, 3, STEP)).toBeNull()
  })

  it('returns null for any other error', () => {
    for (const m of ['out of gas', 'unauthorized', '', 'Insufficient Amount']) {
      expect(nextRedelegateAttempt(entries, m, 0, 3, STEP)).toBeNull()
    }
  })

  it('a loop driven by it terminates after maxRetries reductions', () => {
    let current: typeof entries | null = entries
    let attempts = 0
    for (let attempt = 0; attempt <= 3; attempt++) {
      attempts++
      current = nextRedelegateAttempt(current!, 'insufficient amount', attempt, 3, STEP)
      if (!current) break
    }
    expect(attempts).toBe(4)
    expect(current).toBeNull()
  })
})

// WO-071 D1 (docs/06 gate 2026-10-16, P-6): submitStakes reports which denoms' broadcasts returned an
// outcome (confirmed, unconfirmed or reported failed — any of them may have landed), so the page can
// clear exactly those inputs. A stake that returned undefined, or was never attempted, is not listed.
describe('submitStakes — returns the denoms that may have landed (WO-071 D1)', () => {
  it('all confirmed → every denom, in order', async () => {
    const h = harness(['H1', 'H2', 'H3'])
    expect(await submitStakes(THREE, GRANTS, h.deps)).toEqual([DENOM, RST_DENOM, DSTRX_DENOM])
  })

  it('first returns undefined → nothing landed, nothing held back is listed', async () => {
    const h = harness([undefined, 'H2', 'H3'])
    expect(await submitStakes(THREE, GRANTS, h.deps)).toEqual([])
  })

  it('first unconfirmed → only the first (it may land); the held-back ones are not listed', async () => {
    const h = harness([{ unconfirmed: 'H1' }, 'H2', 'H3'])
    expect(await submitStakes(THREE, GRANTS, h.deps)).toEqual([DENOM])
  })

  it('first reported failed → listed (a reported failure is never treated as nothing landed)', async () => {
    const h = harness([{ failed: 'H1', code: 5 }, 'H2', 'H3'])
    expect(await submitStakes(THREE, GRANTS, h.deps)).toEqual([DENOM])
  })

  it('the second returns undefined → the third is still attempted and listed, the second is not', async () => {
    const h = harness(['H1', undefined, 'H3'])
    expect(await submitStakes(THREE, GRANTS, h.deps)).toEqual([DENOM, DSTRX_DENOM])
  })

  it('a later tx unconfirmed → it is listed, the ones after it (not attempted) are not', async () => {
    const h = harness(['H1', { unconfirmed: 'H2' }, 'H3'])
    expect(await submitStakes(THREE, GRANTS, h.deps)).toEqual([DENOM, RST_DENOM])
  })

  it('a later stake reported failed (failedCode) → it is listed and the next stake is still attempted (WO-074 D2)', async () => {
    const h = harness(['H1', { failed: 'H2', code: 5 }, 'H3'])
    const submitted = await submitStakes(THREE, GRANTS, h.deps)
    expect(submitted).toEqual([DENOM, RST_DENOM, DSTRX_DENOM])
    expect(h.calls.map((c) => c.label)).toEqual(['RIO', 'RST', 'DSTRX'])
  })

  it('a single stake: confirmed → listed; undefined → not', async () => {
    expect(await submitStakes([THREE[0]], GRANTS, harness(['H1']).deps)).toEqual([DENOM])
    expect(await submitStakes([THREE[0]], GRANTS, harness([undefined]).deps)).toEqual([])
  })
})
