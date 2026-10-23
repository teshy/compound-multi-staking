// The page's one broadcast pipeline (WO-057 D4: C-6, C-15, C-18, C-27, C-42). main.ts used to carry
// this twice — broadcast() and the redelegate loop. runTx holds the whole simulate → sign → submit →
// confirm flow and maps every result to its log lines and dataLayer events; it takes everything it
// touches as `deps`, so the outcome mapping is tested without a DOM or a wallet.
import type { EncodeObject, BroadcastResult, TxStatus } from './sign'
import type { RedelegateEntry } from './grants'
import type { TxOutcome } from './stake-flow'
import { nextRedelegateAttempt } from './stake-flow'
import { scrubAddr } from './scrub'

type LogKind = 'info' | 'ok' | 'err'

export interface TxDeps {
  simulate: (messages: EncodeObject[], memo: string) => Promise<number>
  signAndBroadcast: (
    messages: EncodeObject[],
    gas: number,
    memo: string,
  ) => Promise<BroadcastResult>
  pollTx: (txhash: string) => Promise<TxStatus>
  log: (msg: string, kind?: LogKind) => void
  track: (payload: Record<string, unknown>) => void
}

const errMsg = (e: unknown): string => (e as { message?: string })?.message || String(e)

// label: shown in the on-page log; memo: written into the tx body (separate so the URL doesn't
// clutter every log line). Resolves to undefined when nothing landed (the node rejected it, or it
// threw before anything was sent), else { txhash, confirmed }. confirmed: false = submitted but
// unconfirmed (T-6), or REPORTED failed on-chain (failedCode): either way callers fire no success
// event and never advise a retry.
//
// onSimulateError (optional): called with the message when SIMULATE throws. Returning true means
// "the caller will retry with different messages": runTx resolves 'retry', logging and tracking
// nothing. Nothing has been signed at that point.
export function runTx(
  deps: TxDeps,
  label: string,
  messages: EncodeObject[],
  memo: string,
): Promise<TxOutcome | undefined>
export function runTx(
  deps: TxDeps,
  label: string,
  messages: EncodeObject[],
  memo: string,
  onSimulateError: (msg: string) => boolean,
): Promise<TxOutcome | undefined | 'retry'>
export async function runTx(
  deps: TxDeps,
  label: string,
  messages: EncodeObject[],
  memo: string,
  onSimulateError?: (msg: string) => boolean,
): Promise<TxOutcome | undefined | 'retry'> {
  const { log, track } = deps
  const trackError = (message: string) =>
    track({ event: 'transaction_error', error_label: label, error_message: scrubAddr(message) })
  try {
    log(`${label}: checking grant & estimating fee…`)
    let gas: number
    try {
      gas = await deps.simulate(messages, memo)
    } catch (e) {
      if (onSimulateError?.(errMsg(e))) return 'retry'
      throw e
    }
    log(`Estimated gas ${gas} — approve the transaction in your wallet…`)
    const res = await deps.signAndBroadcast(messages, gas, memo)
    if (res.code !== 0) {
      log(`${label} rejected by the node (code ${res.code}): ${res.rawLog}`, 'err')
      trackError(res.rawLog ?? `code ${res.code}`)
      return
    }
    logSubmitted(log, res)
    const conf = await deps.pollTx(res.txhash)
    if (conf.status === 'confirmed') {
      log(`${label} completed — confirmed in block ${conf.height}`, 'ok')
      log(`tx ${res.txhash}`)
      return { txhash: res.txhash, confirmed: true }
    }
    if (conf.status === 'unconfirmed') {
      // T-6: the node accepted the tx into its mempool but no block verdict could be read. It may
      // still land, so the copy never says "retry". transaction_unconfirmed is a plain dataLayer
      // event; forward it with a built-in GA4 event tag only (CLAUDE.md GTM rule: no Custom HTML).
      log(
        `${label}: submitted ${res.txhash}; confirmation unavailable. Check the explorer before resubmitting.`,
        'err',
      )
      track({ event: 'transaction_unconfirmed', error_label: label })
      return { txhash: res.txhash, confirmed: false }
    }
    // pollTx read the tx committed with a non-zero code from the blocks of the noders RPC (same provider as
    // the REST endpoint the page broadcasts through; same node id on 2026-10-23; WO-084, docs/06 gate
    // 2026-10-16, P-1), a service we do not run, so: the page shows only
    // the code and the hash, never node text (pollTx returns none); there is no retry wording; and the
    // outcome is "reported failed", not "nothing landed", so no caller treats the tx as one that can
    // simply be sent again.
    log(
      `${label}: ${res.txhash} was reported as failed on-chain (code ${conf.code}). Check it on the explorer before resubmitting.`,
      'err',
    )
    trackError(`code ${conf.code}`)
    return { txhash: res.txhash, confirmed: false, failedCode: conf.code }
  } catch (e) {
    log(`${label} error: ${errMsg(e)}`, 'err')
    trackError(errMsg(e))
  }
}

// WO-045 item 1: a broadcast whose answer was lost (delivery 'unknown') may still have reached the
// node, so it is polled by its locally computed hash exactly like an accepted one. WO-057 D5:
// CheckTx code 19 means the node already holds this exact tx, so it is polled too.
function logSubmitted(log: TxDeps['log'], res: BroadcastResult) {
  if (res.alreadyInMempool) return log('already in the mempool — checking it landed…')
  log(
    res.delivery === 'accepted'
      ? `Submitted ${res.txhash} — waiting for on-chain confirmation…`
      : `The node did not answer the broadcast; checking whether ${res.txhash} landed on-chain…`,
  )
}

export const REDELEGATE_LABEL = 'Redelegate + enable auto-compound'
const REDUCE_STEP = 10n ** 9n // 1 nanotoken per retry
const MAX_RETRIES = 3

// Redelegate with automatic shares-rounding retry. Tries the full amounts first; if simulate fails
// with "insufficient amount" (a shares-to-tokens rounding edge case), reduces every entry by
// REDUCE_STEP (logged; the user approves the corrected tx) and retries up to MAX_RETRIES times.
// Leaves at most MAX_RETRIES * REDUCE_STEP attounits behind per validator — well below the 10^12
// filter threshold so they won't reappear.
//
// Resolves to the last run result that was not 'retry' (WO-071 D2, docs/06 gate 2026-10-16, P-6): a
// defined outcome means a tx was submitted, so the page reloads the delegation list; undefined means
// nothing landed.
export async function runRedelegate(opts: {
  entries: RedelegateEntry[]
  buildMessages: (entries: RedelegateEntry[]) => EncodeObject[]
  run: (
    messages: EncodeObject[],
    onSimulateError: (msg: string) => boolean,
  ) => Promise<TxOutcome | undefined | 'retry'>
  log: TxDeps['log']
  track: TxDeps['track']
}): Promise<TxOutcome | undefined> {
  const { entries, buildMessages, run, log, track } = opts
  let current = entries
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let next: RedelegateEntry[] | null = null
    const out = await run(buildMessages(current), (msg) => {
      next = nextRedelegateAttempt(current, msg, attempt, MAX_RETRIES, REDUCE_STEP)
      return next !== null
    })
    if (out === 'retry' && next) {
      log('Shares-rounding adjustment — please approve the corrected transaction in your wallet.')
      current = next
      continue
    }
    if (out && out !== 'retry' && out.confirmed) {
      track({ event: 'redelegate_complete', entry_count: entries.length })
      track({ event: 'compound_enabled' })
    }
    return out === 'retry' ? undefined : out
  }
}
