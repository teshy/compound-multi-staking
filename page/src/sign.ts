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
import { HttpError, READ_TIMEOUT_MS, isAbortError, requestJson, withTimeout } from './http'
import {
  CHAIN_ID,
  DENOM,
  GAS_PRICE,
  REST_URL,
  TX_LOOKUP_URLS,
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

// SYNC broadcast only confirms the tx entered the mempool (passed CheckTx). Poll the tx by hash
// until it's committed in a block to get the real execution result. Never throws (WO-045, T-6):
//   - a 200 for this hash → confirmed (code 0) or failed (any other code); a 200 with no usable
//     code counts as "this endpoint can't answer" (below);
//   - a 404 is "not indexed yet" → ask again next round;
//   - any 5xx (noders: "transaction indexing is disabled"), or a 200 for some other hash, means
//     that endpoint cannot answer → dropped for the rest of the poll;
//   - a fetch rejection is a network blip → ask again next round; so is a lookup that does not
//     answer within LOOKUP_TIMEOUT_MS, headers or body (P-4: a hung socket must not hold the flow
//     forever; re-review R-2: a body that stalls is retried, not dropped);
//   - a 200 whose height is not a plain block number is malformed → dropped (re-review R-1: the height
//     is printed in the success line, so it must never carry text);
//   - no endpoint left, or `tries` rounds used up → unconfirmed. The tx may still land, so the
//     caller must not treat it as failed or advise a retry.
// Trust (docs/06 gate 2026-10-16, P-1): the verdict comes from a lookup endpoint we do not run, and a
// hash-echoing answer proves nothing about its honesty. It decides only what the page TELLS the user and
// whether a multi-stake flow sends its next stake (stake-flow.ts); it never changes what is signed, and
// the caller shows neither its raw_log text nor retry wording for a reported failure (tx-flow.ts).
export async function pollTx(
  txhash: string,
  tries = 20,
  delayMs = 3000,
  urls: readonly string[] = TX_LOOKUP_URLS,
): Promise<TxStatus> {
  const live = [...urls]
  for (let i = 0; i < tries && live.length > 0; i++) {
    for (const base of [...live]) {
      let res: Response
      try {
        res = await fetch(
          `${base}/cosmos/tx/v1beta1/txs/${txhash}`,
          withTimeout(undefined, LOOKUP_TIMEOUT_MS),
        )
      } catch {
        continue
      }
      if (res.ok) {
        let r: { txhash?: string; code?: unknown; height?: unknown; raw_log: string } | undefined
        try {
          r = ((await res.json()) as { tx_response?: typeof r })?.tx_response
        } catch (e) {
          // A body that stalls past the budget is no answer THIS round: ask again (R-2). A body that
          // is not JSON is an endpoint that cannot answer: dropped below.
          if (isAbortError(e)) continue
          r = undefined
        }
        if (!r || String(r.txhash).toUpperCase() !== txhash.toUpperCase()) {
          live.splice(live.indexOf(base), 1)
          continue
        }
        // A tx_response with no usable code is no answer at all (a proxy page, a half-formed body):
        // drop the endpoint, as for a foreign hash. Never report it as failed with code NaN.
        const code =
          typeof r.code === 'number'
            ? r.code
            : typeof r.code === 'string' && r.code.trim() !== ''
              ? Number(r.code)
              : NaN
        if (!Number.isFinite(code)) {
          live.splice(live.indexOf(base), 1)
          continue
        }
        // The height reaches the page's success line, so only a plain block number is an answer (R-1):
        // anything else is malformed and the endpoint is dropped, like a foreign hash.
        if (typeof r.height !== 'string' || !/^\d{1,20}$/.test(r.height)) {
          live.splice(live.indexOf(base), 1)
          continue
        }
        return code === 0
          ? { status: 'confirmed', height: r.height }
          : { status: 'failed', code, height: r.height, rawLog: r.raw_log }
      }
      if (res.status >= 500) live.splice(live.indexOf(base), 1)
    }
    if (live.length > 0 && i < tries - 1)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return { status: 'unconfirmed' }
}
