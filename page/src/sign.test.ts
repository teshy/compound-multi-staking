// WO-048 (T-2, T-16): pin what sign.ts puts on the wire. bodyBytes/feeCoin/pubkeyAny are not
// exported, so they are exercised through signAndBroadcast with fetch stubbed and a fake
// OfflineDirectSigner that captures the SignDoc.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfflineDirectSigner } from '@cosmjs/proto-signing'
import { fromBase64, toBase64 } from '@cosmjs/encoding'
import { AuthInfo, TxBody, TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx'
import type { SignDoc } from 'cosmjs-types/cosmos/tx/v1beta1/tx'
import { MsgDelegate } from 'cosmjs-types/cosmos/staking/v1beta1/tx'
import { PubKey } from 'cosmjs-types/cosmos/crypto/secp256k1/keys'
import { simulate, signAndBroadcast, pollTx, txHashHex } from './sign'
import {
  CHAIN_ID,
  DENOM,
  GAS_PRICE,
  REST_URL,
  ETHSECP256K1_PUBKEY_TYPE,
} from './realio'
import knownTxJson from '../test-fixtures/realio-tx-19887412.json?raw'

const ADDR = 'realio10eq6w0a7fpety33uag2f55e9tewxazt4v28aem'
const VALOPER = 'realiovaloper1fvh0yq5v8n5c2yz0cs5pkfdgx5t77x6vm3pr6y'
const PUBKEY = new Uint8Array(33).map((_, i) => (i === 0 ? 2 : i))
const ACCOUNT_URL = `${REST_URL}/cosmos/auth/v1beta1/accounts/${ADDR}`
const TXS_URL = `${REST_URL}/cosmos/tx/v1beta1/txs`
const SIM_URL = `${REST_URL}/cosmos/tx/v1beta1/simulate`

const MSG = {
  typeUrl: '/cosmos.staking.v1beta1.MsgDelegate',
  value: MsgDelegate.fromPartial({
    delegatorAddress: ADDR,
    validatorAddress: VALOPER,
    amount: { denom: DENOM, amount: '123456789012345678901' },
  }),
}

interface Captured {
  signDoc?: SignDoc
}

function fakeSigner(captured: Captured): OfflineDirectSigner {
  return {
    getAccounts: async () => [{ address: ADDR, algo: 'secp256k1' as const, pubkey: PUBKEY }],
    signDirect: async (_addr: string, signDoc: SignDoc) => {
      captured.signDoc = signDoc
      return {
        signed: signDoc,
        signature: {
          pub_key: { type: 'x', value: '' },
          signature: toBase64(new Uint8Array([9, 9])),
        },
      }
    },
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const ethAccount = {
  account: {
    '@type': '/ethermint.types.v1.EthAccount',
    base_account: { address: ADDR, account_number: '7', sequence: '3' },
    code_hash: '0x00',
  },
}
const plainAccount = { account: { address: ADDR, account_number: '11', sequence: '5' } }

interface TxBodyJson {
  tx_bytes: string
  mode?: string
}
let posted: { url: string; body: TxBodyJson }[]

// The hash a real node names in its tx_response: that of the bytes it was sent (upper-case hex).
async function postedHash(init?: RequestInit): Promise<string> {
  return txHashHex(fromBase64((JSON.parse(String(init?.body)) as TxBodyJson).tx_bytes))
}

// Routes the stubbed fetch: GET account → `account`, POST txs → code-0 response for those bytes.
function stubChain(account: unknown) {
  posted = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === ACCOUNT_URL) return jsonResponse(account)
      if (url === TXS_URL) {
        posted.push({ url, body: JSON.parse(String(init?.body)) })
        return jsonResponse({
          tx_response: { code: 0, txhash: await postedHash(init), raw_log: '' },
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('signAndBroadcast — what goes on the wire', () => {
  it('encodes the signer pubkey with the ethsecp256k1 type URL', async () => {
    stubChain(ethAccount)
    const cap: Captured = {}
    await signAndBroadcast(fakeSigner(cap), ADDR, [MSG], 200_000)
    const authInfo = AuthInfo.decode(cap.signDoc!.authInfoBytes)
    const pk = authInfo.signerInfos[0].publicKey!
    expect(pk.typeUrl).toBe(ETHSECP256K1_PUBKEY_TYPE)
    expect(PubKey.decode(pk.value).key).toEqual(PUBKEY)
  })

  it('unwraps an EthAccount: account number 7, sequence 3', async () => {
    stubChain(ethAccount)
    const cap: Captured = {}
    await signAndBroadcast(fakeSigner(cap), ADDR, [MSG], 200_000)
    expect(cap.signDoc!.accountNumber).toBe(7n)
    expect(AuthInfo.decode(cap.signDoc!.authInfoBytes).signerInfos[0].sequence).toBe(3n)
  })

  it('also accepts a plain (unwrapped) account', async () => {
    stubChain(plainAccount)
    const cap: Captured = {}
    await signAndBroadcast(fakeSigner(cap), ADDR, [MSG], 200_000)
    expect(cap.signDoc!.accountNumber).toBe(11n)
    expect(AuthInfo.decode(cap.signDoc!.authInfoBytes).signerInfos[0].sequence).toBe(5n)
  })

  it('signs for the Realio chain id', async () => {
    stubChain(ethAccount)
    const cap: Captured = {}
    await signAndBroadcast(fakeSigner(cap), ADDR, [MSG], 200_000)
    expect(cap.signDoc!.chainId).toBe(CHAIN_ID)
  })

  it('sets the fee to ceil(gas * GAS_PRICE) in ario, and the gas limit to gas', async () => {
    stubChain(ethAccount)
    const cap: Captured = {}
    await signAndBroadcast(fakeSigner(cap), ADDR, [MSG], 234_567)
    const fee = AuthInfo.decode(cap.signDoc!.authInfoBytes).fee!
    expect(fee.amount).toEqual([{ denom: DENOM, amount: String(Math.ceil(234_567 * GAS_PRICE)) }])
    expect(fee.gasLimit).toBe(234_567n)
  })

  it('round-trips the messages and memo through the TxBody', async () => {
    stubChain(ethAccount)
    const cap: Captured = {}
    await signAndBroadcast(fakeSigner(cap), ADDR, [MSG], 200_000, 'my memo')
    const body = TxBody.decode(cap.signDoc!.bodyBytes)
    expect(body.memo).toBe('my memo')
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].typeUrl).toBe(MSG.typeUrl)
    const decoded = MsgDelegate.decode(body.messages[0].value)
    expect(decoded.delegatorAddress).toBe(ADDR)
    expect(decoded.validatorAddress).toBe(VALOPER)
    expect(decoded.amount).toEqual({ denom: DENOM, amount: '123456789012345678901' })
  })

  it('broadcasts a TxRaw carrying the signed bytes and the signature, in SYNC mode', async () => {
    stubChain(ethAccount)
    const cap: Captured = {}
    const res = await signAndBroadcast(fakeSigner(cap), ADDR, [MSG], 200_000)
    expect(res).toEqual({
      code: 0,
      txhash: await txHashHex(fromBase64(posted[0].body.tx_bytes)),
      rawLog: '',
      delivery: 'accepted',
    })
    expect(posted).toHaveLength(1)
    expect(posted[0].body.mode).toBe('BROADCAST_MODE_SYNC')
    const raw = TxRaw.decode(fromBase64(posted[0].body.tx_bytes))
    expect(raw.bodyBytes).toEqual(cap.signDoc!.bodyBytes)
    expect(raw.authInfoBytes).toEqual(cap.signDoc!.authInfoBytes)
    expect(raw.signatures).toEqual([new Uint8Array([9, 9])])
  })

  it('rejects with the node message on a 400 from the broadcast endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === ACCOUNT_URL
          ? jsonResponse(ethAccount)
          : jsonResponse({ message: 'bad tx bytes' }, 400),
      ),
    )
    await expect(signAndBroadcast(fakeSigner({}), ADDR, [MSG], 200_000)).rejects.toThrow(
      'bad tx bytes',
    )
  })
})

// WO-045 item 1: if the broadcast request itself fails in transit, the node may still have
// accepted the tx. signAndBroadcast must not throw (a throw reads as "nothing was sent" and invites
// a retry, i.e. a double stake); it returns the locally computed hash so the caller can poll it.
describe('signAndBroadcast — broadcast outcome unknown', () => {
  function stubBroadcast(answer: () => Response) {
    const sent: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === ACCOUNT_URL) return jsonResponse(ethAccount)
        sent.push(JSON.parse(String(init?.body)).tx_bytes)
        return answer()
      }),
    )
    return sent
  }

  it('txHashHex matches the chain: a real mainnet tx hashes to its on-chain txhash', async () => {
    const known = JSON.parse(knownTxJson) as { txhash: string; tx_bytes_b64: string }
    expect(await txHashHex(fromBase64(known.tx_bytes_b64))).toBe(known.txhash)
  })

  it('a network error on the broadcast POST → delivery unknown + the local hash, not a throw', async () => {
    const sent = stubBroadcast(() => {
      throw new TypeError('Failed to fetch')
    })
    const res = await signAndBroadcast(fakeSigner({}), ADDR, [MSG], 200_000)
    expect(sent).toHaveLength(1)
    expect(res).toEqual({
      code: 0,
      txhash: await txHashHex(fromBase64(sent[0])),
      rawLog: '',
      delivery: 'unknown',
    })
    expect(res.txhash).toMatch(/^[0-9A-F]{64}$/)
  })

  it('a 5xx or a non-JSON answer from the broadcast endpoint → delivery unknown', async () => {
    for (const answer of [
      () => jsonResponse({ message: 'upstream timeout' }, 504),
      () => new Response('<html>bad gateway</html>', { status: 200 }),
    ]) {
      const sent = stubBroadcast(answer)
      const res = await signAndBroadcast(fakeSigner({}), ADDR, [MSG], 200_000)
      expect(res.delivery).toBe('unknown')
      expect(res.txhash).toBe(await txHashHex(fromBase64(sent[0])))
    }
  })

  it('a network error BEFORE anything is signed (account query) still throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(signAndBroadcast(fakeSigner({}), ADDR, [MSG], 200_000)).rejects.toThrow(
      'Failed to fetch',
    )
  })
})

describe('simulate', () => {
  it('returns ceil(gas_used * modifier) and posts an unsigned tx with the ethsecp256k1 pubkey', async () => {
    let simBody: TxBodyJson | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === ACCOUNT_URL) return jsonResponse(ethAccount)
        if (url === SIM_URL) {
          simBody = JSON.parse(String(init?.body))
          return jsonResponse({ gas_info: { gas_used: '100001' } })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )
    const gas = await simulate(fakeSigner({}), ADDR, [MSG], '', 1.5)
    expect(gas).toBe(Math.ceil(100_001 * 1.5))
    const raw = TxRaw.decode(fromBase64(simBody!.tx_bytes))
    expect(raw.signatures).toEqual([new Uint8Array()])
    const pk = AuthInfo.decode(raw.authInfoBytes).signerInfos[0].publicKey!
    expect(pk.typeUrl).toBe(ETHSECP256K1_PUBKEY_TYPE)
  })

  it('rejects with the node message on a 400', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === ACCOUNT_URL
          ? jsonResponse(ethAccount)
          : jsonResponse({ message: 'insufficient funds for gas' }, 400),
      ),
    )
    await expect(simulate(fakeSigner({}), ADDR, [MSG], '')).rejects.toThrow(
      'insufficient funds for gas',
    )
  })
})

// WO-045 (T-6): pollTx returns confirmed | failed | unconfirmed and never throws. noders answers
// HTTP 500 "transaction indexing is disabled" for every hash; an endpoint that does that (or any
// 5xx) is dropped at once, and when no endpoint is left the result is `unconfirmed`, never "retry".
const A = 'https://a.example'
const B = 'https://b.example'
const txUrl = (base: string, hash = 'HASH1') => `${base}/cosmos/tx/v1beta1/txs/${hash}`
const found = (code: number, extra: Record<string, unknown> = {}) =>
  jsonResponse({ tx_response: { txhash: 'HASH1', code, height: '123', raw_log: 'log', ...extra } })
const indexingDisabled = () =>
  jsonResponse({ code: 2, message: 'transaction indexing is disabled', details: [] }, 500)

describe('pollTx', () => {
  it('confirmed: a code-0 tx found after two 404s', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toBe(txUrl(A))
        calls++
        if (calls <= 2) return jsonResponse({ message: 'tx not found' }, 404)
        return found(0)
      }),
    )
    expect(await pollTx('HASH1', 3, 0, [A])).toEqual({ status: 'confirmed', height: '123' })
    expect(calls).toBe(3)
  })

  it('failed: a committed tx with a non-zero code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => found(5, { raw_log: 'insufficient funds' })),
    )
    expect(await pollTx('HASH1', 3, 0, [A])).toEqual({
      status: 'failed',
      code: 5,
      height: '123',
      rawLog: 'insufficient funds',
    })
  })

  it('indexing disabled → unconfirmed after ONE request, not a throw and not 20 polls', async () => {
    const fetchMock = vi.fn(async () => indexingDisabled())
    vi.stubGlobal('fetch', fetchMock)
    const r = await pollTx('HASH1', 20, 0, [A])
    expect(r.status).toBe('unconfirmed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('any 5xx drops that endpoint and falls through to the next one in the same round', async () => {
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url)
        return url.startsWith(A) ? jsonResponse({ message: 'bad gateway' }, 502) : found(0)
      }),
    )
    expect(await pollTx('HASH1', 3, 0, [A, B])).toEqual({ status: 'confirmed', height: '123' })
    expect(seen).toEqual([txUrl(A), txUrl(B)])
  })

  it('a dropped endpoint is not asked again on later rounds', async () => {
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url)
        if (url.startsWith(A)) return indexingDisabled()
        return seen.length < 4 ? jsonResponse({ message: 'tx not found' }, 404) : found(0)
      }),
    )
    expect((await pollTx('HASH1', 5, 0, [A, B])).status).toBe('confirmed')
    expect(seen.filter((u) => u.startsWith(A))).toHaveLength(1)
  })

  it('a fetch rejection mid-poll is caught and polling continues', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        if (calls === 1) return jsonResponse({ message: 'tx not found' }, 404)
        if (calls === 2) throw new TypeError('Failed to fetch')
        return found(0)
      }),
    )
    expect(await pollTx('HASH1', 5, 0, [A])).toEqual({ status: 'confirmed', height: '123' })
    expect(calls).toBe(3)
  })

  it('a response for a different hash is not accepted as this tx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => found(0, { txhash: 'OTHER' })),
    )
    expect((await pollTx('HASH1', 3, 0, [A])).status).toBe('unconfirmed')
  })

  it('the hash comparison ignores case (the REST API returns upper-case hex)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => found(0, { txhash: 'ABCDEF' })),
    )
    expect((await pollTx('abcdef', 3, 0, [A])).status).toBe('confirmed')
  })

  it('`tries` not-founds → unconfirmed (the tx may still land), never a throw', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'tx not found' }, 404))
    vi.stubGlobal('fetch', fetchMock)
    expect((await pollTx('HASH1', 3, 0, [A])).status).toBe('unconfirmed')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

// WO-045 (page outage 2026-10-15): noders answers the CORS preflight (OPTIONS) with 501, so a
// POST that needs one never leaves the browser. A text/plain body makes it a "simple request".
describe('POST bodies are sent as text/plain (no CORS preflight)', () => {
  function captureInits() {
    const inits: RequestInit[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === ACCOUNT_URL) return jsonResponse(ethAccount)
        inits.push(init ?? {})
        if (url === SIM_URL) return jsonResponse({ gas_info: { gas_used: '1000' } })
        return jsonResponse({ tx_response: { code: 0, txhash: 'HASH1', raw_log: '' } })
      }),
    )
    return inits
  }
  const contentType = (init: RequestInit) =>
    new Headers(init.headers).get('content-type')?.toLowerCase() ?? null

  it('simulate and broadcast POSTs carry no application/json content-type', async () => {
    const inits = captureInits()
    await simulate(fakeSigner({}), ADDR, [MSG], '')
    await signAndBroadcast(fakeSigner({}), ADDR, [MSG], 1000)
    expect(inits).toHaveLength(2)
    for (const init of inits) {
      expect(init.method).toBe('POST')
      const ct = contentType(init)
      expect(ct === null || ct.startsWith('text/plain')).toBe(true)
      expect(typeof init.body).toBe('string')
    }
  })
})

// WO-057 D5 (C-45, C-48) + D1 (C-46): hardening of the hand-rolled poll/broadcast/account paths.
describe('pollTx — a 200 whose code is missing is not an answer (WO-057 D5)', () => {
  const noCode = (code: unknown) =>
    jsonResponse({ tx_response: { txhash: 'HASH1', code, height: '123', raw_log: 'log' } })

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a non-numeric string', 'oops'],
    ['an empty string', ''],
  ])(
    'code %s → that endpoint is dropped, result unconfirmed (never failed with code NaN)',
    async (_l, code) => {
      const fetchMock = vi.fn(async () => noCode(code))
      vi.stubGlobal('fetch', fetchMock)
      expect(await pollTx('HASH1', 3, 0, [A])).toEqual({ status: 'unconfirmed' })
      expect(fetchMock).toHaveBeenCalledTimes(1) // dropped after the first answer
    },
  )

  it('drops the bad endpoint and falls through to the next one for the real answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url === txUrl(A) ? noCode(undefined) : found(0))),
    )
    expect(await pollTx('HASH1', 3, 0, [A, B])).toEqual({ status: 'confirmed', height: '123' })
  })

  it('a numeric-string code is still read (failed with that code)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => noCode('11')),
    )
    expect(await pollTx('HASH1', 3, 0, [A])).toMatchObject({ status: 'failed', code: 11 })
  })
})

describe('signAndBroadcast — CheckTx code 19 means the tx is already in the mempool (WO-057 D5)', () => {
  let sentHash: string
  function stubCode(code: number, codespace?: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === ACCOUNT_URL) return jsonResponse(ethAccount)
        sentHash = await postedHash(init)
        return jsonResponse({
          tx_response: {
            code,
            ...(codespace === undefined ? {} : { codespace }),
            txhash: sentHash,
            raw_log: 'tx already in mempool cache',
          },
        })
      }),
    )
  }

  it('sdk code 19 → treated as accepted with code 0 so it gets polled, flagged as already in the mempool', async () => {
    stubCode(19, 'sdk')
    const res = await signAndBroadcast(fakeSigner({}), ADDR, [MSG], 200_000)
    expect(res).toMatchObject({
      code: 0,
      txhash: sentHash,
      delivery: 'accepted',
      alreadyInMempool: true,
    })
  })

  // ABCI codes are scoped per codespace: only sdk's 19 is ErrTxInMempoolCache. A module error that
  // happens to be code 19 was never accepted, so polling it would end in a false "submitted" (WO-057).
  it.each([
    ['a module codespace (staking)', 'staking'],
    ['no codespace at all', undefined],
  ])(
    'code 19 with %s → a plain rejection: returned as code 19, never alreadyInMempool',
    async (_l, codespace) => {
      stubCode(19, codespace)
      const res = await signAndBroadcast(fakeSigner({}), ADDR, [MSG], 200_000)
      expect(res).toMatchObject({ code: 19, txhash: sentHash, delivery: 'accepted' })
      expect(res.alreadyInMempool).toBeUndefined()
    },
  )

  it('any other non-zero code is still reported as that code (a rejection)', async () => {
    stubCode(5)
    const res = await signAndBroadcast(fakeSigner({}), ADDR, [MSG], 200_000)
    expect(res).toMatchObject({ code: 5, delivery: 'accepted' })
    expect(res.alreadyInMempool).toBeUndefined()
  })

  it('code 0 carries no alreadyInMempool flag', async () => {
    stubCode(0)
    const res = await signAndBroadcast(fakeSigner({}), ADDR, [MSG], 200_000)
    expect(res.alreadyInMempool).toBeUndefined()
  })
})

describe('getAccount (through signAndBroadcast) refuses an unreadable account (WO-057 D5)', () => {
  const accountResp = (account: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ account })),
    )

  it.each([
    ['missing account_number', { address: ADDR, sequence: '5' }],
    ['missing sequence', { address: ADDR, account_number: '11' }],
    ['both missing', { address: ADDR }],
    ['an EthAccount wrapper with an empty base_account', { base_account: {} }],
  ])(
    '%s → throws "account … not found or unreadable" (never signs with 0)',
    async (_l, account) => {
      accountResp(account)
      await expect(signAndBroadcast(fakeSigner({}), ADDR, [MSG], 200_000)).rejects.toThrow(
        `account ${ADDR} not found or unreadable`,
      )
    },
  )

  it('no account object at all → the same error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({})),
    )
    await expect(simulate(fakeSigner({}), ADDR, [MSG], '')).rejects.toThrow(
      'not found or unreadable',
    )
  })

  it('a genuine "0" account number / sequence is accepted (fresh account)', async () => {
    const cap: { signDoc?: SignDoc } = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === ACCOUNT_URL
          ? jsonResponse({ account: { address: ADDR, account_number: '0', sequence: '0' } })
          : jsonResponse({ tx_response: { code: 0, txhash: 'H', raw_log: '' } }),
      ),
    )
    await signAndBroadcast(fakeSigner(cap), ADDR, [MSG], 200_000)
    expect(cap.signDoc!.accountNumber).toBe(0n)
  })
})

describe('rest(): status first, then body (WO-057 D1, C-46)', () => {
  it('a NON-JSON 502 on simulate throws with the HTTP status in the message, not a SyntaxError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === ACCOUNT_URL
          ? jsonResponse(ethAccount)
          : new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
      ),
    )
    await expect(simulate(fakeSigner({}), ADDR, [MSG], '')).rejects.toThrow('502 Bad Gateway')
  })

  it('a broadcast 4xx still throws (nothing entered the mempool); a non-JSON 200 is still "unknown"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === ACCOUNT_URL
          ? jsonResponse(ethAccount)
          : jsonResponse({ message: 'tx parse error' }, 400),
      ),
    )
    await expect(signAndBroadcast(fakeSigner({}), ADDR, [MSG], 200_000)).rejects.toThrow(
      'tx parse error',
    )

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === ACCOUNT_URL ? jsonResponse(ethAccount) : new Response('not json', { status: 200 }),
      ),
    )
    const res = await signAndBroadcast(fakeSigner({}), ADDR, [MSG], 200_000)
    expect(res.delivery).toBe('unknown')
  })
})

// docs/06 gate 2026-10-16 (P-2, P-5): only a well-formed CheckTx verdict about THESE bytes counts, as
// in the bot's TxConfirm.submitTx. Anything else leaves the outcome unknown, so the tx is polled by the
// hash computed here and never reported as rejected (an invitation to resend) or confirmed under the
// hash of some other committed tx.
describe('signAndBroadcast — only a verdict about these bytes counts (docs/06 gate 2026-10-16)', () => {
  function stubAnswer(txResponse: (hash: string) => unknown) {
    const sent: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === ACCOUNT_URL) return jsonResponse(ethAccount)
        const hash = await postedHash(init)
        sent.push(hash)
        return jsonResponse({ tx_response: txResponse(hash) })
      }),
    )
    return sent
  }
  const OTHER = 'F'.repeat(64)

  it('P-2: an answer naming ANOTHER tx hash is no verdict → unknown, polled by the local hash', async () => {
    const sent = stubAnswer(() => ({ code: 0, txhash: OTHER, raw_log: '' }))
    const res = await signAndBroadcast(fakeSigner({}), ADDR, [MSG], 200_000)
    expect(res).toEqual({ code: 0, txhash: sent[0], rawLog: '', delivery: 'unknown' })
    expect(res.txhash).not.toBe(OTHER)
  })

  it('P-2: a rejection naming another hash is not reported as a rejection either', async () => {
    const sent = stubAnswer(() => ({ code: 5, txhash: OTHER, raw_log: 'insufficient funds' }))
    const res = await signAndBroadcast(fakeSigner({}), ADDR, [MSG], 200_000)
    expect(res).toEqual({ code: 0, txhash: sent[0], rawLog: '', delivery: 'unknown' })
  })

  it('P-2: the node naming the same hash in lower case is still this tx', async () => {
    const sent = stubAnswer((h) => ({ code: 0, txhash: h.toLowerCase(), raw_log: '' }))
    const res = await signAndBroadcast(fakeSigner({}), ADDR, [MSG], 200_000)
    expect(res).toEqual({ code: 0, txhash: sent[0], rawLog: '', delivery: 'accepted' })
  })

  it.each([
    ['absent', undefined],
    ['null', null],
    ['the string "0"', '0'],
    ['the string "5"', '5'],
    ['a fraction', 0.5],
  ])('P-5: code %s → unknown (polled), never read as a rejection', async (_l, code) => {
    const sent = stubAnswer((h) => ({ code, txhash: h, raw_log: 'x' }))
    const res = await signAndBroadcast(fakeSigner({}), ADDR, [MSG], 200_000)
    expect(res).toEqual({ code: 0, txhash: sent[0], rawLog: '', delivery: 'unknown' })
  })

  it('a tx_response with no txhash at all → unknown with the local hash', async () => {
    const sent = stubAnswer(() => ({ code: 0, raw_log: '' }))
    const res = await signAndBroadcast(fakeSigner({}), ADDR, [MSG], 200_000)
    expect(res).toEqual({ code: 0, txhash: sent[0], rawLog: '', delivery: 'unknown' })
  })
})

// docs/06 gate 2026-10-16 (P-4): every request is bounded. A hung socket must not leave a flow
// waiting forever, because the natural recovery (reload and resubmit) could stake twice.
describe('every page request carries a timeout (docs/06 gate 2026-10-16, P-4)', () => {
  it('account read 15 s, simulate 20 s, broadcast 30 s, each tx lookup 10 s', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const inits: (RequestInit | undefined)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        inits.push(init)
        if (url === ACCOUNT_URL) return jsonResponse(ethAccount)
        if (url === SIM_URL) return jsonResponse({ gas_info: { gas_used: '1000' } })
        if (url === TXS_URL) {
          return jsonResponse({
            tx_response: { code: 0, txhash: await postedHash(init), raw_log: '' },
          })
        }
        return found(0)
      }),
    )
    await simulate(fakeSigner({}), ADDR, [MSG], '')
    await signAndBroadcast(fakeSigner({}), ADDR, [MSG], 1000)
    await pollTx('HASH1', 1, 0, [A])
    expect(inits).toHaveLength(5)
    for (const init of inits) expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(timeout.mock.calls.map((c) => c[0])).toEqual([15_000, 20_000, 15_000, 30_000, 10_000])
    timeout.mockRestore()
  })

  it('a lookup that times out is just another round: unconfirmed in the end, never a throw', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('signal timed out', 'TimeoutError')
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await pollTx('HASH1', 3, 0, [A])).toEqual({ status: 'unconfirmed' })
    expect(fetchMock).toHaveBeenCalledTimes(3) // asked again each round, never dropped
  })

  it('a broadcast that times out is unknown (polled by its local hash), never "nothing sent"', async () => {
    const sent: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === ACCOUNT_URL) return jsonResponse(ethAccount)
        sent.push(await postedHash(init))
        throw new DOMException('signal timed out', 'TimeoutError')
      }),
    )
    const res = await signAndBroadcast(fakeSigner({}), ADDR, [MSG], 200_000)
    expect(res).toEqual({ code: 0, txhash: sent[0], rawLog: '', delivery: 'unknown' })
  })

  it('a simulate that times out throws (nothing was signed)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === ACCOUNT_URL) return jsonResponse(ethAccount)
        throw new DOMException('signal timed out', 'TimeoutError')
      }),
    )
    await expect(simulate(fakeSigner({}), ADDR, [MSG], '')).rejects.toThrow('signal timed out')
  })
})

// docs/06 gate re-review 2026-10-16: the lookup answer's height reaches the success line, so it must be a
// plain block number (R-1); a body that stalls past the budget is retried next round, not dropped (R-2).
describe('pollTx — the height is a block number, and a stalled body is retried (re-review R-1, R-2)', () => {
  it.each([
    [
      'a phishing sentence',
      '123. Your wallet is compromised: import your seed phrase at evil.example',
    ],
    ['a number, not a string', 123],
    ['missing', undefined],
    ['an empty string', ''],
    ['a negative number string', '-5'],
  ])('height %s → that endpoint is dropped, never printed: unconfirmed', async (_l, height) => {
    const fetchMock = vi.fn(async () => found(0, { height }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await pollTx('HASH1', 3, 0, [A])).toEqual({ status: 'unconfirmed' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a bad height on one endpoint falls through to the next one for the real answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url === txUrl(A) ? found(0, { height: 'x' }) : found(0))),
    )
    expect(await pollTx('HASH1', 3, 0, [A, B])).toEqual({ status: 'confirmed', height: '123' })
  })

  it('a failed verdict needs a plain height too (its height is shown in no log, but the rule is one)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => found(5, { height: 'nope' })),
    )
    expect(await pollTx('HASH1', 2, 0, [A])).toEqual({ status: 'unconfirmed' })
  })

  it('a body that stalls past the budget keeps the endpoint: asked again next round', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        if (calls === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => {
              throw new DOMException('signal timed out', 'TimeoutError')
            },
          } as unknown as Response
        }
        return found(0)
      }),
    )
    expect(await pollTx('HASH1', 3, 0, [A])).toEqual({ status: 'confirmed', height: '123' })
    expect(calls).toBe(2)
  })

  it('a body that is not JSON (not a timeout) still drops the endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response('<html>proxy</html>', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await pollTx('HASH1', 3, 0, [A])).toEqual({ status: 'unconfirmed' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// Re-review R-5: AbortSignal.timeout needs Chrome 103+ / Firefox 100+ / Safari 16+. Without it the page
// must still work (unbounded, as before P-4), not fail every read closed.
describe('no AbortSignal.timeout (an older browser) → requests still go out, unbounded', () => {
  it('simulate, broadcast and a lookup all run, with no signal', async () => {
    const original = AbortSignal.timeout
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true })
    try {
      const inits: (RequestInit | undefined)[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          inits.push(init)
          if (url === ACCOUNT_URL) return jsonResponse(ethAccount)
          if (url === SIM_URL) return jsonResponse({ gas_info: { gas_used: '1000' } })
          if (url === TXS_URL) {
            return jsonResponse({
              tx_response: { code: 0, txhash: await postedHash(init), raw_log: '' },
            })
          }
          return found(0)
        }),
      )
      expect(await simulate(fakeSigner({}), ADDR, [MSG], '')).toBe(1500)
      expect((await signAndBroadcast(fakeSigner({}), ADDR, [MSG], 1000)).delivery).toBe('accepted')
      expect(await pollTx('HASH1', 1, 0, [A])).toEqual({ status: 'confirmed', height: '123' })
      expect(inits).toHaveLength(5)
      for (const init of inits) expect(init?.signal).toBeUndefined()
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', { value: original, configurable: true })
    }
  })
})
