// Ethermint-aware sign + broadcast, ported from restake's SigningClient.mjs (which
// works against Realio server-side). The two things stock cosmjs gets wrong on an
// EVM chain and we fix here:
//   1. the account query returns an /ethermint.types.v1.EthAccount wrapper, and
//   2. the signer pubkey must be encoded as /ethermint.crypto.v1.ethsecp256k1.PubKey
//      (NOT the cosmos secp256k1 type), or on-chain signature verification fails.
// Keplr produces the correct eth/keccak signature itself when the chain is registered
// with the eth-* features (see realio.ts); we only have to encode the pubkey type and
// build the tx manually rather than via SigningStargateClient.
import type { OfflineDirectSigner } from '@cosmjs/proto-signing'
import { makeAuthInfoBytes, makeSignDoc } from '@cosmjs/proto-signing'
import { TxRaw, TxBody } from 'cosmjs-types/cosmos/tx/v1beta1/tx'
import { SignMode } from 'cosmjs-types/cosmos/tx/signing/v1beta1/signing'
import { PubKey } from 'cosmjs-types/cosmos/crypto/secp256k1/keys'
import { fromBase64, toBase64, toHex } from '@cosmjs/encoding'
import { registry } from './registry'
import { HttpError, READ_TIMEOUT_MS, requestJson, withTimeout } from './http'
import {
  CHAIN_ID,
  DENOM,
  GAS_PRICE,
  REST_URL,
  TX_CONFIRM_RPC_URL,
  ETHSECP256K1_PUBKEY_TYPE,
} from './realio'

export interface EncodeObject {
  typeUrl: string
  value: unknown
}

interface AccountInfo {
  accountNumber: bigint
  sequence: number
}

// POST bodies go as text/plain so the request is a CORS "simple request": noders answers the
// preflight (OPTIONS) with 501, so an application/json POST never leaves the browser (the
// 2026-10-15 outage). The node parses the JSON body the same either way (WO-045).
// The status is checked before the body is parsed (http.ts); an HttpError's `status` lets the
// broadcast path tell a refusal (4xx) from a failure in transit. Every call is bounded (http.ts, P-4).
function rest<T>(path: string, body?: unknown, timeoutMs = READ_TIMEOUT_MS): Promise<T> {
  return requestJson<T>(
    REST_URL + path,
    {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'text/plain;charset=UTF-8' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    },
    timeoutMs,
  )
}

// Request budgets (docs/06 gate 2026-10-16, P-4), the same as the bot's SigningClient. A simulate that
// times out has signed nothing (an error, as before). A broadcast that times out may still have reached
// the node, so it is 'unknown' and polled by its own hash. A lookup that times out is one more round.
const SIMULATE_TIMEOUT_MS = 20_000
const BROADCAST_TIMEOUT_MS = 30_000
const LOOKUP_TIMEOUT_MS = 10_000

interface AccountJson {
  account_number?: string
  sequence?: string
  base_account?: AccountJson
}

// Reads account_number/sequence, unwrapping the EthAccount.base_account if present. A missing
// field is an error, never a default of 0: signing with the wrong number would burn the user's
// approval on a tx the chain rejects (WO-057 D5). Internal to sign.ts (not exported).
async function getAccount(address: string): Promise<AccountInfo> {
  const { account } = await rest<{ account?: AccountJson }>(
    `/cosmos/auth/v1beta1/accounts/${address}`,
  )
  const base = account?.base_account ?? account
  const number = base?.account_number
  const sequence = base?.sequence
  if (
    number === undefined ||
    number === null ||
    number === '' ||
    sequence === undefined ||
    sequence === null ||
    sequence === ''
  ) {
    throw new Error(`account ${address} not found or unreadable`)
  }
  return { accountNumber: BigInt(number), sequence: Number(sequence) }
}

function pubkeyAny(pubkey: Uint8Array) {
  // Same wire format as cosmos secp256k1 (bytes key = 1); only the type URL differs.
  return {
    typeUrl: ETHSECP256K1_PUBKEY_TYPE,
    value: PubKey.encode(PubKey.fromPartial({ key: pubkey })).finish(),
  }
}

function bodyBytes(messages: EncodeObject[], memo: string): Uint8Array {
  return TxBody.encode(
    TxBody.fromPartial({
      messages: messages.map((m) => registry.encodeAsAny(m as any)),
      memo,
    }),
  ).finish()
}

function feeCoin(gas: number) {
  const amount = Math.ceil(gas * GAS_PRICE).toString()
  return [{ denom: DENOM, amount }]
}

// Estimate gas via the REST simulate endpoint (unsigned, like restake).
export async function simulate(
  signer: OfflineDirectSigner,
  address: string,
  messages: EncodeObject[],
  memo: string,
  modifier = 1.5,
): Promise<number> {
  const [{ pubkey }] = await signer.getAccounts()
  const { sequence } = await getAccount(address)
  const authInfoBytes = makeAuthInfoBytes(
    [{ pubkey: pubkeyAny(pubkey), sequence }],
    feeCoin(100_000),
    100_000,
    undefined,
    undefined,
    SignMode.SIGN_MODE_UNSPECIFIED,
  )
  const txRaw = TxRaw.fromPartial({
    bodyBytes: bodyBytes(messages, memo),
    authInfoBytes,
    signatures: [new Uint8Array()],
  })
  const sim = await rest<{ gas_info: { gas_used: string } }>(
    '/cosmos/tx/v1beta1/simulate',
    { tx_bytes: toBase64(TxRaw.encode(txRaw).finish()) },
    SIMULATE_TIMEOUT_MS,
  )
  return Math.ceil(Number(sim.gas_info.gas_used) * modifier)
}

// delivery 'accepted': the node answered the SYNC broadcast with a verdict about these bytes (code =
// CheckTx result).
// delivery 'unknown': the request failed in transit (network error, timeout, 5xx, an unreadable or
// malformed answer, one naming another tx), so the node may or may not have the tx; code is 0 only so
// the caller goes on to poll it. Never treat 'unknown' as "nothing was sent" (WO-045 item 1: a resend
// could double-stake).
// txhash is always the locally computed hash of the signed bytes, never one echoed by the node (P-2).
export interface BroadcastResult {
  code: number
  txhash: string
  rawLog: string
  delivery: 'accepted' | 'unknown'
  // CheckTx code 19: the node already holds this exact tx in its mempool cache, so it WAS submitted
  // (WO-057 D5). Reported as code 0 so the caller polls it; the flag only selects the log line.
  alreadyInMempool?: true
}

// ABCI code for "tx already in mempool cache" (sdk ErrTxInMempoolCache). Codes are scoped per
// codespace, so 19 only means this when the codespace is sdk; any other 19 is a plain rejection.
const CODE_TX_IN_MEMPOOL_CACHE = 19
const CODESPACE_SDK = 'sdk'

// The Cosmos txhash: upper-case hex SHA-256 of the raw TxRaw bytes (pinned against a real mainnet
// tx in sign.test.ts).
export async function txHashHex(txBytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(txBytes))
  return toHex(new Uint8Array(digest)).toUpperCase()
}

export async function signAndBroadcast(
  signer: OfflineDirectSigner,
  address: string,
  messages: EncodeObject[],
  gas: number,
  memo = '',
): Promise<BroadcastResult> {
  const [{ pubkey }] = await signer.getAccounts()
  const { accountNumber, sequence } = await getAccount(address)

  const authInfoBytes = makeAuthInfoBytes(
    [{ pubkey: pubkeyAny(pubkey), sequence }],
    feeCoin(gas),
    gas,
    undefined,
    undefined,
    SignMode.SIGN_MODE_DIRECT,
  )
  const signDoc = makeSignDoc(
    bodyBytes(messages, memo),
    authInfoBytes,
    CHAIN_ID,
    Number(accountNumber),
  )

  const { signed, signature } = await signer.signDirect(address, signDoc)

  const txRaw = TxRaw.fromPartial({
    bodyBytes: signed.bodyBytes,
    authInfoBytes: signed.authInfoBytes,
    signatures: [fromBase64(signature.signature)],
  })

  const txBytes = TxRaw.encode(txRaw).finish()
  // The hash of exactly these bytes, computed BEFORE anything is sent: it is the hash every outcome
  // carries and the one that gets polled, whatever the node answers (docs/06 gate 2026-10-16, P-2).
  const txhash = await txHashHex(txBytes)
  const unknown = (): BroadcastResult => ({ code: 0, txhash, rawLog: '', delivery: 'unknown' })
  let out: {
    tx_response?: { code?: unknown; codespace?: string; txhash?: unknown; raw_log: string }
  }
  try {
    out = await rest(
      '/cosmos/tx/v1beta1/txs',
      { tx_bytes: toBase64(txBytes), mode: 'BROADCAST_MODE_SYNC' },
      BROADCAST_TIMEOUT_MS,
    )
  } catch (e) {
    // A 4xx is the node refusing the request outright: nothing entered the mempool. A 5xx, a 2xx
    // whose body could not be read, a timeout or a network error is a failure in transit: the node
    // may have the tx.
    if (e instanceof HttpError && e.status >= 400 && e.status < 500) throw e
    return unknown()
  }
  // Only a well-formed CheckTx verdict about THESE bytes counts, as in the bot's TxConfirm.submitTx.
  // A missing or non-numeric code (P-5) is no verdict: reading it as a rejection would invite a resend
  // of a tx the node may hold. An answer naming another tx's hash (P-2) is no verdict either: polling
  // that hash could report some other committed tx as this one. Both leave the outcome unknown.
  const r = out?.tx_response
  if (
    !r ||
    typeof r.code !== 'number' ||
    !Number.isInteger(r.code) ||
    typeof r.txhash !== 'string' ||
    r.txhash.toUpperCase() !== txhash
  )
    return unknown()
  if (r.code === CODE_TX_IN_MEMPOOL_CACHE && r.codespace === CODESPACE_SDK) {
    return { code: 0, txhash, rawLog: r.raw_log, delivery: 'accepted', alreadyInMempool: true }
  }
  return { code: r.code, txhash, rawLog: r.raw_log, delivery: 'accepted' }
}

export type TxStatus =
  | { status: 'confirmed'; height: string }
  | { status: 'failed'; code: number; height: string; rawLog: string }
  | { status: 'unconfirmed' }

// SYNC broadcast only confirms the tx entered the mempool (passed CheckTx). pollTx reads the real execution
// result from the BLOCKS of the noders RPC (same provider as the REST endpoint the page broadcasts through; same
// node id on 2026-10-23) (WO-084, docs/06 gate 2026-10-16 P-1): noders has tx indexing disabled, and a
// third-party lookup endpoint's answer proved nothing about its honesty. It never throws.
//   - Start (WO-085 D2): the first /status that answers gives the latest height L. The scan starts at
//     max(1, L - LOOKBACK_BLOCKS - min(MAX_EXTRA_BLOCKS, ceil(elapsed seconds since pollTx began))): one extra block
//     per second spent before that /status answered, an upper bound for any block time of 1 s or more, so a
//     /status that keeps timing out cannot push the start past a tx that committed early. A wider window cannot
//     cause a false match: the hash is of freshly signed, sequence-bound bytes.
//   - Bounds (WO-085 D1, docs/06 WR-1): heights at or past start + MAX_SCAN_BLOCKS are never scanned, whatever
//     /status claims; a round reads num_txs for at most MAX_BLOCKS_PER_ROUND new heights (3 /blockchain calls, 20
//     heights each) and makes at most MAX_BLOCK_READS_PER_ROUND /block calls, retries included; before every
//     request, past POLL_DEADLINE_MS from entry the result is unconfirmed. Once every height of the window is
//     resolved and the tx was not found, the result is unconfirmed straight away.
//   - Per-height state (WR-3): `metaNext` is the first height whose num_txs is unknown; it advances only through
//     answered /blockchain chunks. `unread` holds the heights known to hold txs whose /block is not read yet; a
//     block that gives no answer stays there and does not stop the others; reads go to never-tried heights first,
//     then lowest first (WR-15).
//   - Found at index i of block h: /block_results?height=h, txs_results[i].code is the verdict, retried in later
//     rounds if it gives no answer. The first code 0 read is confirmed at once, from any block. A non-zero code is
//     failed only once every found block has its code and no height below the lowest found is still unread; until then the earlier blocks
//     keep being read (one holding the tx with code 0 wins), and if they are unresolved at the deadline or after
//     `tries` the result is unconfirmed, never failed. Once the tx is found, metas past it are no longer read.
//   - An answer must be well formed to count (heights are plain block numbers, /block's height is the one
//     asked for, its tx count equals /blockchain's num_txs, txs_results is as long as the block's txs, the
//     code is an integer). Anything else, a rejection, a timeout (LOOKUP_TIMEOUT_MS, headers and body) or a
//     non-2xx is no answer this round and is retried next round: never a verdict, never "failed".
//   - `tries` rounds used up → unconfirmed. The tx may still land, so the caller must not treat it as failed
//     or advise a retry. Retention of /block_results is undocumented and can change: on 2026-10-23 noders served
//     /block from 20230001 and /block_results from 20230740 (results below it vanished between about 17:53 and
//     18:09 UTC, most likely a node restart). A tab that sleeps long after sending may find the tx but get no
//     verdict, and ends unconfirmed: the safe outcome.
// The verdict decides only what the page TELLS the user and whether a multi-stake flow sends its next stake
// (stake-flow.ts); it never changes what is signed, and the caller shows no node text (tx-flow.ts).
// LOOKBACK_BLOCKS + MAX_EXTRA_BLOCKS (240) must stay below MAX_SCAN_BLOCKS (400): then the window always holds the
// latest height, even if POLL_DEADLINE_MS is raised later (tested).
export const LOOKBACK_BLOCKS = 40
export const MAX_EXTRA_BLOCKS = 200
export const MAX_SCAN_BLOCKS = 400
export const MAX_BLOCKS_PER_ROUND = 60
export const MAX_BLOCK_READS_PER_ROUND = 10
export const POLL_DEADLINE_MS = 180_000
const BLOCKCHAIN_CHUNK = 20

type Json = Record<string, unknown>
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

// The `result` of one JSON-RPC GET, or undefined for anything that is not an answer: a rejection, a
// timeout (headers or body), a non-2xx, a body that is not JSON, a JSON-RPC error.
async function rpcResult(rpc: string, path: string): Promise<Json | undefined> {
  try {
    const res = await fetch(`${rpc}${path}`, withTimeout(undefined, LOOKUP_TIMEOUT_MS))
    if (!res.ok) return undefined
    const body: unknown = await res.json()
    return isRecord(body) && isRecord(body.result) ? body.result : undefined
  } catch {
    return undefined
  }
}

// A plain block number: a string of digits only (the node sends heights and counts as strings), safe to
// count with.
function plainHeight(v: unknown): number | undefined {
  if (typeof v !== 'string' || !/^\d{1,20}$/.test(v)) return undefined
  const n = Number(v)
  return Number.isSafeInteger(n) ? n : undefined
}

// The tx count a /blockchain meta states for each height in [a, b], or undefined unless it states exactly
// one count for every one of them.
function txCounts(result: Json, a: number, b: number): Map<number, number> | undefined {
  const metas = result.block_metas
  if (!Array.isArray(metas)) return undefined
  const counts = new Map<number, number>()
  for (const m of metas) {
    const header = isRecord(m) && isRecord(m.header) ? m.header : undefined
    const h = plainHeight(header?.height)
    const n = plainHeight(isRecord(m) ? m.num_txs : undefined)
    if (h === undefined || n === undefined || h < a || h > b || counts.has(h)) return undefined
    counts.set(h, n)
  }
  return counts.size === b - a + 1 ? counts : undefined
}

interface Found {
  height: number
  index: number
  txCount: number
  code?: number // from /block_results, once it has answered
}

// Thrown inside pollTx only, and caught there: the poll deadline passed before a request.
class PollDeadline extends Error {}

export async function pollTx(
  txhash: string,
  tries = 20,
  delayMs = 3000,
  rpc: string = TX_CONFIRM_RPC_URL,
  now: () => number = () => performance.now(), // monotonic: a wall-clock step cannot move the start (WR-16)
): Promise<TxStatus> {
  const want = txhash.toUpperCase()
  const t0 = now()
  const deadline = t0 + POLL_DEADLINE_MS
  let end = 0 // one past the last height the scan may read; set with the start by the first /status that answers
  let metaNext = 0 // the first height whose num_txs is not known yet
  let started = false
  const unread = new Map<number, number>() // height -> tx count, for heights known to hold txs, /block not read
  const attempts = new Map<number, number>() // height -> /block reads tried so far (WR-15: reads are fair across heights)
  const finds: Found[] = []

  const ask = async (path: string): Promise<Json | undefined> => {
    if (now() >= deadline) throw new PollDeadline()
    return rpcResult(rpc, path)
  }

  // Scans one block that holds txs. 'none' = not in it, 'noanswer' = retry the block next round.
  async function scanBlock(height: number, txCount: number): Promise<Found | 'none' | 'noanswer'> {
    const r = await ask(`/block?height=${height}`)
    const block = isRecord(r?.block) ? r.block : undefined
    const header = isRecord(block?.header) ? block.header : undefined
    const data = isRecord(block?.data) ? block.data : undefined
    const txs = data?.txs
    if (plainHeight(header?.height) !== height || !Array.isArray(txs) || txs.length !== txCount)
      return 'noanswer'
    try {
      for (let i = 0; i < txs.length; i++) {
        if (typeof txs[i] !== 'string') return 'noanswer'
        if ((await txHashHex(fromBase64(txs[i] as string))) === want)
          return { height, index: i, txCount }
      }
    } catch {
      return 'noanswer' // not base64
    }
    return 'none'
  }

  // The code of a found tx from /block_results, or undefined when that gives no answer.
  async function readCode(f: Found): Promise<number | undefined> {
    const r = await ask(`/block_results?height=${f.height}`)
    const results = r?.txs_results
    if (
      plainHeight(r?.height) !== f.height ||
      !Array.isArray(results) ||
      results.length !== f.txCount
    )
      return undefined
    const entry: unknown = results[f.index]
    const code = isRecord(entry) ? entry.code : undefined
    return typeof code === 'number' && Number.isInteger(code) ? code : undefined
  }

  const lowestFound = () => finds.reduce((m, f) => Math.min(m, f.height), Infinity)

  try {
    for (let round = 0; round < tries; round++) {
      // 1. New metas, unless the tx is already found (heights past it no longer matter).
      if (finds.length === 0 && (!started || metaNext < end)) {
        const st = await ask('/status')
        const sync = isRecord(st?.sync_info) ? st.sync_info : undefined
        const latest = plainHeight(sync?.latest_block_height)
        if (latest !== undefined) {
          if (!started) {
            const elapsed = Math.max(0, Math.ceil((now() - t0) / 1000))
            const first = Math.max(
              1,
              latest - LOOKBACK_BLOCKS - Math.min(MAX_EXTRA_BLOCKS, elapsed),
            )
            started = true
            metaNext = first
            end = first + MAX_SCAN_BLOCKS
          }
          const stop = Math.min(latest, end - 1, metaNext + MAX_BLOCKS_PER_ROUND - 1)
          for (let a = metaNext; a <= stop; a += BLOCKCHAIN_CHUNK) {
            const b = Math.min(a + BLOCKCHAIN_CHUNK - 1, stop)
            const meta = await ask(`/blockchain?minHeight=${a}&maxHeight=${b}`)
            const counts = meta ? txCounts(meta, a, b) : undefined
            if (!counts) break
            for (const [h, n] of counts) if (n > 0) unread.set(h, n)
            metaNext = b + 1
          }
        }
      }

      // 2. Read the blocks that hold txs: never-tried heights before retries, then lowest height first, so a run of
      // unreadable blocks cannot starve the rest (WR-15). A block that gives no answer stays queued; no height
      // above the lowest find is read.
      let reads = 0
      const order = [...unread.keys()].sort(
        (x, y) => (attempts.get(x) ?? 0) - (attempts.get(y) ?? 0) || x - y,
      )
      for (const h of order) {
        if (reads >= MAX_BLOCK_READS_PER_ROUND) break
        if (h > lowestFound()) continue
        reads++
        attempts.set(h, (attempts.get(h) ?? 0) + 1)
        const s = await scanBlock(h, unread.get(h) as number)
        if (s === 'noanswer') continue
        unread.delete(h)
        // a find's code is read before any further block (WR-19): lower blocks matter only for a non-zero code,
        // and retrying slow ones first could spend the deadline before a code 0 is read
        if (s !== 'none') {
          finds.push(s)
          break
        }
      }

      // 3. The code of each found tx (one /block_results each, retried in later rounds).
      finds.sort((x, y) => x.height - y.height)
      let codeReads = 0
      for (const f of finds) {
        if (f.code !== undefined) continue
        if (codeReads++ >= MAX_BLOCK_READS_PER_ROUND) break
        f.code = await readCode(f)
        // the first code 0 read is the answer, before any further request (WR-17: the deadline cannot discard it)
        if (f.code === 0) return { status: 'confirmed', height: String(f.height) }
      }

      // 4. The verdict.
      const first = finds[0]
      if (
        first &&
        finds.every((f) => f.code !== undefined) &&
        ![...unread.keys()].some((h) => h < first.height)
      )
        return {
          status: 'failed',
          code: first.code as number,
          height: String(first.height),
          rawLog: '',
        }
      if (finds.length === 0 && started && metaNext >= end && unread.size === 0)
        return { status: 'unconfirmed' } // every height of the window is resolved and the tx is not in it

      if (round < tries - 1) await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  } catch {
    // the deadline (PollDeadline) or anything unforeseen: no verdict, never a throw
  }
  return { status: 'unconfirmed' }
}
