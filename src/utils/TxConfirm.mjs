// Delta over upstream (WO-040): post-broadcast confirmation that never mistakes "outcome unknown" for
// "failed".
//
// Upstream eco-stake's SigningClient.broadcast() polled GET /cosmos/tx/v1beta1/txs/{hash} for
// 60s and, on timeout, RETURNED the Error instead of throwing it. Callers then read
// `res.code === undefined` and logged `FAIL code undefined: undefined` for a tx that had passed
// CheckTx and, in practice, committed. From 2026-08-20 a public REST endpoint answered every
// tx lookup with "transaction indexing is disabled", so EVERY broadcast took that path:
// the compound batch committed (code 0, verified on-chain via an indexing provider) yet was
// reported failed, and its retry path re-sent each delegator's withdraw+delegate. The retry's
// delegate re-spends rewards the batch already staked — it failed `insufficient funds` only
// because the delegators' liquid balances happened to be smaller than the amount; a delegator
// with enough liquid balance would have had principal staked. Never auto-retry an unknown outcome.
import { sha256 } from '@cosmjs/crypto'
import { toHex } from '@cosmjs/encoding'

export class TxUnconfirmedError extends Error {
  constructor(transactionHash, reason) {
    super(`Transaction ${transactionHash} was submitted but its outcome could not be confirmed (${reason}). It may still commit — check the chain before re-sending.`)
    this.name = 'TxUnconfirmedError'
    this.unconfirmed = true
    this.transactionHash = transactionHash
  }
}

export function isUnconfirmed(e) {
  return !!(e && e.unconfirmed === true)
}

// Tests the error's NAME, like a duck type, so it holds across module instances (WO-058).
// A sequence-mismatch CheckTx rejection IS a TxFailedError too: callers test isSequenceMismatch FIRST.
export function isTxFailed(e) {
  return !!(e && e.name === 'TxFailedError')
}

// A definitive failure: the node itself returned a verdict with a non-zero code. phase 'checktx' —
// rejected before the mempool, never broadcast; phase 'delivertx' — included and reverted
// atomically. Either way nothing moved, so a retry is safe. The message keeps cosmjs's
// assertIsDeliverTxSuccess format ("Code: N; Raw log: …") that existing log greps rely on.
export class TxFailedError extends Error {
  constructor(result, phase) {
    super(`Error when broadcasting tx ${result.transactionHash} at height ${result.height}. Code: ${result.code}; Raw log: ${result.rawLog}`)
    this.name = 'TxFailedError'
    this.phase = phase
    this.code = result.code
    this.codespace = result.codespace
    this.transactionHash = result.transactionHash
    this.rawLog = result.rawLog
  }
}

// The bot account's sequence is not the one this tx (or simulation) was built for: another tx from
// the bot is pending, or another run is active. Retrying would race that tx — whose rewards may
// already be staked — so callers stop instead (docs/06 audit 2026-10-08).
const SEQUENCE_MISMATCH = /account sequence mismatch/i
export function isSequenceMismatch(e) {
  if (!e) return false
  if (e.codespace === 'sdk' && Number(e.code) === 32) return true
  return SEQUENCE_MISMATCH.test(e.message || '')
}

// result: a parsed tx_response. Code 0 resolves; a missing code is UNKNOWN (never read as either
// success or failure); any other code is a definitive TxFailedError.
export function assertTxSuccess(result, phase, transactionHash) {
  if (typeof result?.code !== 'number') {
    throw new TxUnconfirmedError(transactionHash, `the ${phase} result carried no code`)
  }
  if (result.code !== 0) throw new TxFailedError(result, phase)
  return result
}

// The hash a node assigns a tx: uppercase hex SHA-256 of the raw TxRaw bytes. Computed locally so
// an unconfirmed error can name the tx even when the broadcast POST itself never answered.
export function txHashOf(txBytes) {
  return toHex(sha256(txBytes)).toUpperCase()
}

const INDEXING_DISABLED = /indexing is disabled/i

function errorText(e) {
  return e?.response?.data?.message || e?.message || ''
}

// Poll fetchTx(hash) until it resolves (the tx is in a block) or the deadline passes. A rejection
// means "not found yet" (404 while pending, a flaky endpoint) and is retried — except an endpoint
// that has tx indexing disabled, which can never find it, so that bails immediately instead of
// burning the whole timeout. Either way the outcome is unknown, so it throws TxUnconfirmedError.
export async function waitForTx(fetchTx, transactionHash, { timeoutMs = 60_000, pollIntervalMs = 3_000, sleep, now = Date.now } = {}) {
  const deadline = now() + timeoutMs
  for (;;) {
    await sleep(pollIntervalMs)
    try {
      return await fetchTx(transactionHash)
    } catch (e) {
      if (INDEXING_DISABLED.test(errorText(e))) {
        throw new TxUnconfirmedError(transactionHash, 'the REST endpoint has transaction indexing disabled')
      }
    }
    if (now() >= deadline) {
      throw new TxUnconfirmedError(transactionHash, `not found on chain within ${timeoutMs / 1000}s`)
    }
  }
}

// Submit the tx bytes and return the node's CheckTx verdict (its raw tx_response). Only a
// well-formed verdict about THESE bytes is definitive. Anything else leaves the outcome unknown and
// throws TxUnconfirmedError, which callers never retry (docs/06 audit 2026-10-08):
//  - no HTTP response (timeout, reset) after the bytes went out — the node may have admitted it;
//  - any HTTP error status — a reverse proxy's 502/504 can arrive AFTER the node admitted the tx
//    (a public endpoint sits behind a proxy), so only the node's own tx_response counts as its verdict;
//  - a body without a tx_response, or one naming a different tx hash;
//  - sdk code 19 (tx already in the mempool cache): an identical tx is pending and may commit.
export async function submitTx(postTx, txBytes) {
  const hash = txHashOf(txBytes)
  let res
  try {
    res = await postTx(txBytes)
  } catch (e) {
    const status = e?.response?.status
    throw new TxUnconfirmedError(hash, status
      ? `broadcast answered HTTP ${status} instead of a CheckTx result: ${errorText(e)}`
      : `broadcast request failed without a response: ${errorText(e)}`)
  }
  const txResponse = res?.data?.tx_response
  if (!txResponse || typeof txResponse !== 'object') {
    throw new TxUnconfirmedError(hash, 'the broadcast response carried no tx_response')
  }
  if (String(txResponse.txhash || '').toUpperCase() !== hash) {
    throw new TxUnconfirmedError(hash, `the broadcast response names tx ${txResponse.txhash || '(none)'}, not this one`)
  }
  if (Number(txResponse.code) === 19 && (txResponse.codespace === 'sdk' || !txResponse.codespace)) {
    throw new TxUnconfirmedError(hash, 'an identical tx is already in the mempool cache (sdk code 19)')
  }
  return txResponse
}
