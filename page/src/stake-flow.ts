import type { StakeEntry } from './grants'
import type { EncodeObject } from './sign'
import { toRio } from './realio'

// What a broadcast came to: undefined = nothing landed (the node refused it, or it was never sent);
// otherwise the tx was submitted, and `confirmed` says whether it was seen committed with code 0.
// confirmed: false means submitted but unconfirmed (WO-045, T-6) — it may still land — or, with
// `failedCode`, that the tx lookup reported it committed with that non-zero code. That report comes
// from an endpoint we do not run (docs/06 gate 2026-10-16, P-1), so a reported failure is never treated
// as "nothing landed": the user is told to check the explorer, never to retry.
export interface TxOutcome {
  txhash: string
  confirmed: boolean
  failedCode?: number
}

interface StakeFlowDeps {
  broadcast: (label: string, msgs: EncodeObject[]) => Promise<TxOutcome | undefined>
  buildMsgs: (s: StakeEntry) => EncodeObject[]
  label: (denom: string) => string
  log: (msg: string, kind?: 'info' | 'ok' | 'err') => void
  track: (p: Record<string, unknown>) => void
}

// The stake branch of the enable handler (stakes is non-empty). Each denom gets its own tx so
// failures are isolated and each gets its own log entry. Grants are bundled with the first
// stake; the remaining stakes are sent standalone — but only if the first one completed (BUG-1:
// otherwise the user would hold delegations with no auto-compound grants). A tx that was
// submitted but not confirmed (T-6) stops the flow: it may still land, so nothing is sent on top
// of it (a resend could double-stake, and the next tx would collide on the account sequence),
// and the user is told to check the explorer, never to retry.
//
// Resolves to the denoms whose broadcast returned a TxOutcome (confirmed, unconfirmed, or reported
// failed): those may have landed, so the page clears their inputs (WO-071 D1, docs/06 gate 2026-10-16,
// P-6). A stake whose broadcast returned undefined, or that was never attempted, is not listed.
export async function submitStakes(
  stakes: StakeEntry[],
  grants: EncodeObject[],
  deps: StakeFlowDeps,
): Promise<string[]> {
  const { broadcast, buildMsgs, label, log, track } = deps
  if (stakes.length > 1)
    log(`${stakes.length} transactions — you'll be asked to approve each in your wallet.`)
  const submitted: string[] = []
  const [first, ...rest] = stakes
  const unsent = (from: number) => {
    const left = rest.slice(from)
    return `the remaining ${left.length} stake(s) (${left.map((s) => label(s.denom)).join(', ')}) were not submitted`
  }
  const firstOut = await broadcast(label(first.denom), [...buildMsgs(first), ...grants])
  if (firstOut) submitted.push(first.denom)
  if (firstOut?.confirmed) {
    track({
      event: 'stake_complete',
      token: label(first.denom),
      amount: toRio(first.amount.toString()),
    })
    track({ event: 'compound_enabled' })
  }
  if (rest.length === 0) return submitted
  if (!firstOut) {
    log(
      `The first transaction did not complete, so the remaining ${rest.length} stake(s) were not submitted — nothing further was sent. Resolve the issue (or retry) and submit again.`,
      'err',
    )
    return submitted
  }
  if (!firstOut.confirmed) {
    const h = firstOut.txhash
    log(
      firstOut.failedCode === undefined
        ? `The first transaction (${h}) was submitted but could not be confirmed, so ${unsent(0)}. Check the explorer: once ${h} shows as successful, submit the remaining stake(s) on their own — do not resubmit the first.`
        : `The first transaction (${h}) was reported as failed on-chain (code ${firstOut.failedCode}), so ${unsent(0)}. Check ${h} on the explorer before submitting anything again: if it failed, submit all the stakes again; if it succeeded, submit only the remaining ones.`,
      'err',
    )
    return submitted
  }
  for (let i = 0; i < rest.length; i++) {
    const stake = rest[i]
    const out = await broadcast(label(stake.denom), buildMsgs(stake))
    if (out) submitted.push(stake.denom)
    if (out?.confirmed) {
      track({
        event: 'stake_complete',
        token: label(stake.denom),
        amount: toRio(stake.amount.toString()),
      })
    } else if (out && out.failedCode === undefined && i < rest.length - 1) {
      // Unconfirmed: it may still land, so nothing is sent on top of it. A stake REPORTED as failed
      // (failedCode) is isolated like one that never landed: the next denom's tx is independent of it,
      // and runTx already told the user to check that one on the explorer before resubmitting it.
      log(
        `${label(stake.denom)} (${out.txhash}) was submitted but could not be confirmed, so ${unsent(i + 1)}. Check the explorer: once ${out.txhash} shows as successful, submit the remaining stake(s) on their own.`,
        'err',
      )
      return submitted
    }
  }
  return submitted
}

// Redelegate shares-rounding retry: when simulate fails with "insufficient amount" (a
// shares-to-tokens rounding edge case) and retries remain, return every entry reduced by
// reduceStep (an entry already <= the step is left as is); otherwise null (give up).
export function nextRedelegateAttempt<T extends { amount: bigint }>(
  entries: T[],
  errMsg: string,
  attempt: number,
  maxRetries: number,
  reduceStep: bigint,
): T[] | null {
  if (!(errMsg.includes('insufficient amount') && attempt < maxRetries)) return null
  return entries.map((entry) => ({
    ...entry,
    amount: entry.amount > reduceStep ? entry.amount - reduceStep : entry.amount,
  }))
}
