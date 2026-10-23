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
import {
  simulate,
  signAndBroadcast,
  pollTx,
  txHashHex,
  LOOKBACK_BLOCKS,
  MAX_EXTRA_BLOCKS,
  MAX_SCAN_BLOCKS,
  MAX_BLOCKS_PER_ROUND,
  MAX_BLOCK_READS_PER_ROUND,
  POLL_DEADLINE_MS,
} from './sign'
import {
  CHAIN_ID,
  DENOM,
  GAS_PRICE,
  REST_URL,
  TX_CONFIRM_RPC_URL,
  ETHSECP256K1_PUBKEY_TYPE,
} from './realio'
import knownTxJson from '../test-fixtures/realio-tx-19887412.json?raw'
import blockFixtureJson from '../test-fixtures/realio-block-20230800.json?raw'

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

// WO-084 (docs/06 gate 2026-10-16, P-1), bounded and re-anchored by WO-085 (docs/06 WR-1..3): pollTx reads the
// verdict from the BLOCKS of the noders RPC (/status, /blockchain, /block, /block_results), never from a
// third-party lookup endpoint, and never throws. The fixture is a real mainnet tx (height 20230800): its hash is
// the one the chain gives it, and its txs_results[0].code is present as the integer 0.
const known = JSON.parse(blockFixtureJson) as {
  height: string
  txhash: string
  tx_b64: string
  result: Record<string, unknown>
}
const KNOWN_H = Number(known.height)
const otherTx = (n: number) => toBase64(new Uint8Array([n, n + 1, n + 2]))
const rpcOk = (result: unknown) => jsonResponse({ jsonrpc: '2.0', id: -1, result })

interface FakeBlock {
  txs: string[]
  codes: unknown[]
}
interface Glitch {
  match: string // a substring of the request URL
  // may throw; returning undefined means "not this request": it is answered honestly and the glitch is not used up
  res: (url: string) => Response | undefined | Promise<Response | undefined>
  times?: number // how many matching requests it answers (default 1)
}
interface FakeNode {
  latest: number
  blocks: Record<number, FakeBlock>
  calls: string[]
  inits: (RequestInit | undefined)[]
  statusCalls: number
  glitches: Glitch[]
  onStatus?: (n: number) => void
  onCall?: (url: string) => void
}

function fakeNode(over: Partial<FakeNode> = {}): FakeNode {
  const node: FakeNode = {
    latest: KNOWN_H + 2,
    blocks: { [KNOWN_H]: { txs: [known.tx_b64], codes: [0] } },
    calls: [],
    inits: [],
    statusCalls: 0,
    glitches: [],
    ...over,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => nodeAnswer(node, url, init)),
  )
  return node
}

async function nodeAnswer(node: FakeNode, url: string, init?: RequestInit): Promise<Response> {
  node.calls.push(url)
  node.inits.push(init)
  node.onCall?.(url)
  const glitch = node.glitches.find((x) => url.includes(x.match))
  if (glitch) {
    let out: Response | undefined
    let applied = true
    try {
      out = await glitch.res(url)
      applied = out !== undefined
    } finally {
      if (applied) {
        glitch.times = (glitch.times ?? 1) - 1
        if (glitch.times <= 0) node.glitches.splice(node.glitches.indexOf(glitch), 1)
      }
    }
    if (out) return out
  }
  const u = new URL(url)
  const q = u.searchParams
  const h = Number(q.get('height'))
  const block = node.blocks[h]
  switch (u.pathname) {
    case '/status':
      node.statusCalls++
      node.onStatus?.(node.statusCalls)
      return rpcOk({ sync_info: { latest_block_height: String(node.latest) } })
    case '/blockchain':
      return rpcOk({ last_height: String(node.latest), block_metas: metasFor(node, url) })
    case '/block':
      return rpcOk({ block: { header: { height: String(h) }, data: { txs: block?.txs ?? [] } } })
    case '/block_results':
      return rpcOk({
        height: String(h),
        // a failed tx carries node text in `log`: it must never reach the verdict (rawLog stays empty)
        txs_results: (block?.codes ?? []).map((code) => ({
          ...known.result,
          code,
          log: code === 0 ? '' : 'node text: import your seed phrase at evil.example',
        })),
      })
  }
  throw new Error(`unexpected fetch ${url}`)
}

const rangeOf = (url: string): [number, number] => {
  const q = new URL(url).searchParams
  return [Number(q.get('minHeight')), Number(q.get('maxHeight'))]
}
// The honest block_metas of a /blockchain request (newest first), as the node would answer it.
function metasFor(node: FakeNode, url: string) {
  const [min, max] = rangeOf(url)
  const metas = []
  for (let x = max; x >= min; x--) {
    metas.push({ header: { height: String(x) }, num_txs: String(node.blocks[x]?.txs.length ?? 0) })
  }
  return metas
}

const rangesOf = (node: FakeNode) =>
  node.calls.filter((c) => c.includes('/blockchain?')).map(rangeOf)
const countOf = (node: FakeNode, path: string) => node.calls.filter((c) => c.includes(path)).length
// pollTx with no delay between rounds and a clock that never moves, so the lookback is exact.
const poll = (hash: string, tries: number, rpc?: string, now: () => number = () => 0) =>
  pollTx(hash, tries, 0, rpc, now)

describe('pollTx: the verdict comes from the noders blocks (WO-084)', () => {
  it('the fixture hash is the chain hash of its base64 tx (txHashHex)', async () => {
    expect(await txHashHex(fromBase64(known.tx_b64))).toBe(known.txhash)
  })

  it('TX_CONFIRM_RPC_URL is the noders RPC', () => {
    expect(TX_CONFIRM_RPC_URL).toBe('https://realio-rpc.noders.services')
  })

  it('code 0 in a block inside the lookback → confirmed, with that block height', async () => {
    fakeNode()
    expect(await poll(known.txhash, 3)).toEqual({ status: 'confirmed', height: known.height })
  })

  it('the hash comparison ignores case', async () => {
    fakeNode()
    expect((await poll(known.txhash.toLowerCase(), 3)).status).toBe('confirmed')
  })

  it('a non-zero code → failed with that code and an EMPTY rawLog (no node text reaches the page)', async () => {
    fakeNode({ blocks: { [KNOWN_H]: { txs: [known.tx_b64], codes: [5] } } })
    expect(await poll(known.txhash, 3)).toEqual({
      status: 'failed',
      code: 5,
      height: known.height,
      rawLog: '',
    })
  })

  it('the verdict is the one at the tx index: a block of three txs, ours is the second', async () => {
    fakeNode({
      blocks: { [KNOWN_H]: { txs: [otherTx(1), known.tx_b64, otherTx(7)], codes: [0, 11, 0] } },
    })
    expect(await poll(known.txhash, 3)).toMatchObject({ status: 'failed', code: 11 })
  })

  it('the scan starts LOOKBACK_BLOCKS back: the oldest block of the lookback is read, the one before is not', async () => {
    expect(LOOKBACK_BLOCKS).toBe(40)
    const block = { txs: [known.tx_b64], codes: [0] }
    const inside = fakeNode({ latest: 1000, blocks: { [1000 - LOOKBACK_BLOCKS]: block } })
    expect((await poll(known.txhash, 2)).status).toBe('confirmed')
    expect(rangesOf(inside)[0][0]).toBe(1000 - LOOKBACK_BLOCKS)
    const outside = fakeNode({ latest: 1000, blocks: { [999 - LOOKBACK_BLOCKS]: block } })
    expect(await poll(known.txhash, 2)).toEqual({ status: 'unconfirmed' })
    expect(countOf(outside, '/block?')).toBe(0)
  })

  it('a chain younger than the lookback starts at height 1', async () => {
    const node = fakeNode({ latest: 5, blocks: {} })
    await poll(known.txhash, 1)
    expect(rangesOf(node)).toEqual([[1, 5]])
  })

  it('never found → unconfirmed after `tries` rounds (the tx may still land), never a throw', async () => {
    const node = fakeNode({ blocks: {} })
    expect(await poll(known.txhash, 4)).toEqual({ status: 'unconfirmed' })
    expect(node.statusCalls).toBe(4)
    expect(countOf(node, '/block?')).toBe(0)
  })

  it('a tx that lands later is found without rescanning the blocks already read', async () => {
    const node = fakeNode({ blocks: {} })
    const L = node.latest
    node.onStatus = (n) => {
      if (n === 2) {
        node.latest = L + 3
        node.blocks[L + 2] = { txs: [known.tx_b64], codes: [0] }
      }
    }
    expect(await poll(known.txhash, 5)).toEqual({ status: 'confirmed', height: String(L + 2) })
    expect(rangesOf(node)).toEqual([
      [L - 40, L - 21],
      [L - 20, L - 1],
      [L, L],
      [L + 1, L + 3],
    ])
  })

  it('/blockchain is asked in chunks of at most 20 heights, contiguous, none repeated', async () => {
    const node = fakeNode({ latest: 1000, blocks: {} })
    node.onStatus = (n) => {
      if (n === 2) node.latest = 1045
    }
    await poll(known.txhash, 2)
    const ranges = rangesOf(node)
    expect(ranges).toEqual([
      [960, 979],
      [980, 999],
      [1000, 1000],
      [1001, 1020],
      [1021, 1040],
      [1041, 1045],
    ])
    for (const [a, b] of ranges) expect(b - a + 1).toBeLessThanOrEqual(20)
  })

  it('a first /status that fails is asked again; the start is fixed by the one that answers', async () => {
    const node = fakeNode({ latest: 1000, blocks: {} })
    node.glitches.push({
      match: '/status',
      res: () => jsonResponse({ message: 'bad gateway' }, 502),
    })
    await poll(known.txhash, 2)
    expect(node.statusCalls).toBe(1) // the glitch answered before the node counted it
    expect(rangesOf(node)[0][0]).toBe(1000 - LOOKBACK_BLOCKS)
  })

  it('/block_results failing once after the tx was found: read again, the block is not scanned again', async () => {
    const node = fakeNode()
    node.glitches.push({ match: '/block_results', res: () => jsonResponse({ message: 'x' }, 502) })
    expect(await poll(known.txhash, 4)).toEqual({ status: 'confirmed', height: known.height })
    expect(countOf(node, '/block?')).toBe(1)
    expect(countOf(node, '/blockchain?')).toBe(3) // the 41 heights of the first round, 20 a call
    expect(countOf(node, '/block_results')).toBe(2)
    expect(node.statusCalls).toBe(1) // found: no further /status either
  })

  it('a fetch rejection, a 5xx, a timeout and a stalled body are each one more round, never a verdict', async () => {
    const node = fakeNode()
    node.glitches.push(
      {
        match: '/status',
        res: () => {
          throw new TypeError('Failed to fetch')
        },
      },
      { match: '/blockchain', res: () => jsonResponse({ message: 'x' }, 503) },
      {
        match: '/block?',
        res: () => {
          throw new DOMException('signal timed out', 'TimeoutError')
        },
      },
      {
        match: '/block_results',
        res: () =>
          ({
            ok: true,
            status: 200,
            json: async () => {
              throw new DOMException('signal timed out', 'TimeoutError')
            },
          }) as unknown as Response,
      },
    )
    expect(await poll(known.txhash, 12)).toEqual({ status: 'confirmed', height: known.height })
  })

  it('every lookup that times out is just another round: unconfirmed in the end, never a throw', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('signal timed out', 'TimeoutError')
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await poll(known.txhash, 3)).toEqual({ status: 'unconfirmed' })
    expect(fetchMock).toHaveBeenCalledTimes(3) // asked again each round, never given up on
  })

  // D3: what counts as an answer. Each case below answers once with something that is NOT an answer; the
  // next round answers properly, so the result must be the real verdict (confirmed), never failed.
  const bad = (match: string, body: unknown, status = 200): Glitch => ({
    match,
    res: () => jsonResponse(body, status),
  })
  const meta = (height: string, num_txs: unknown) => ({ header: { height }, num_txs })
  const H = String(KNOWN_H)
  const L = String(KNOWN_H + 2)
  const validStatus = { result: { sync_info: { latest_block_height: L } } }
  const validResults = {
    result: { height: H, txs_results: [{ ...known.result, code: 0 }] },
  }
  // The honest answers of the node under test (its blocks hold the tx at KNOWN_H).
  const fakeNodeFor = {
    latest: KNOWN_H + 2,
    blocks: { [KNOWN_H]: { txs: [known.tx_b64], codes: [0] } },
  } as FakeNode
  // A /blockchain answer built from the request's own range, then bent. It is applied to the one chunk that
  // holds the tx's block (the scan reads 20 heights a call); the other chunks are answered honestly.
  const blockchainWith = (bend: (metas: ReturnType<typeof metasFor>) => unknown[]): Glitch => ({
    match: '/blockchain',
    res: (url) => {
      const [a, b] = rangeOf(url)
      if (KNOWN_H < a || KNOWN_H > b) return undefined
      return jsonResponse({ result: { block_metas: bend(metasFor(fakeNodeFor, url)) } })
    },
  })
  it.each([
    [
      'a /status height that is not a plain number',
      bad('/status', { result: { sync_info: { latest_block_height: '12x' } } }),
    ],
    [
      'a /status height that is a JSON number',
      bad('/status', { result: { sync_info: { latest_block_height: 1234 } } }),
    ],
    ['no sync_info in /status', bad('/status', { result: {} })],
    ['a 500 whose body is a valid /status', bad('/status', validStatus, 500)],
    ['a 404 whose body is a valid /status', bad('/status', validStatus, 404)],
    ['/blockchain with no block_metas', bad('/blockchain', { result: { last_height: L } })],
    ['/blockchain missing a height of the range', blockchainWith((m) => m.slice(1))],
    ['/blockchain naming a height twice', blockchainWith((m) => [...m.slice(0, -1), m[0]])],
    [
      '/blockchain with a non-numeric num_txs',
      blockchainWith((m) => m.map((x, i) => (i === 2 ? meta(x.header.height, 'x') : x))),
    ],
    [
      '/blockchain with one height of the range swapped for a height outside it (same count)',
      blockchainWith((m) =>
        m.map((x) => (x.header.height === H ? meta(String(KNOWN_H + 10_000), '1') : x)),
      ),
    ],
    [
      '/blockchain repeating the tx block with another num_txs (same count)',
      blockchainWith((m) => [...m, meta(H, '0')]),
    ],
    [
      '/block for another height',
      bad('/block?', {
        result: { block: { header: { height: '1' }, data: { txs: [known.tx_b64] } } },
      }),
    ],
    [
      '/block whose tx count differs from num_txs',
      bad('/block?', {
        result: {
          block: { header: { height: H }, data: { txs: [known.tx_b64, otherTx(2)] } },
        },
      }),
    ],
    [
      '/block whose tx is not base64',
      bad('/block?', { result: { block: { header: { height: H }, data: { txs: ['%%%'] } } } }),
    ],
    ['/block with no block', bad('/block?', { result: {} })],
    [
      'a JSON-RPC error',
      bad('/block?', {
        jsonrpc: '2.0',
        id: -1,
        error: { code: -32603, message: 'Internal error' },
      }),
    ],
    [
      '/block_results for another height',
      bad('/block_results', { result: { height: '1', txs_results: [{ code: 5 }] } }),
    ],
    [
      '/block_results with fewer txs_results than txs',
      bad('/block_results', { result: { height: H, txs_results: [] } }),
    ],
    [
      '/block_results with more txs_results than txs',
      bad('/block_results', { result: { height: H, txs_results: [{ code: 0 }, { code: 0 }] } }),
    ],
    ['a 500 whose body is a valid code-0 /block_results', bad('/block_results', validResults, 500)],
    [
      'a code that is a string',
      bad('/block_results', { result: { height: H, txs_results: [{ code: '5' }] } }),
    ],
    [
      'a code that is absent',
      bad('/block_results', { result: { height: H, txs_results: [{ log: 'x' }] } }),
    ],
    [
      'a code that is null',
      bad('/block_results', { result: { height: H, txs_results: [{ code: null }] } }),
    ],
    [
      'a code that is not an integer',
      bad('/block_results', { result: { height: H, txs_results: [{ code: 1.5 }] } }),
    ],
    ['a result of null', bad('/block_results', { result: null })],
  ])('malformed: %s → retried, then the real verdict', async (_label, glitch) => {
    const node = fakeNode()
    node.glitches.push(glitch)
    expect(await poll(known.txhash, 6)).toEqual({ status: 'confirmed', height: known.height })
    // the bad answer was not used: that request was made again (a bad answer taken as good would end the
    // poll with the verdict above after ONE request, which the result alone cannot tell apart)
    expect(
      countOf(node, glitch.match),
      'the glitched request was asked again',
    ).toBeGreaterThanOrEqual(2)
  })

  it('a body that is not JSON is no answer (a proxy page), then the real verdict', async () => {
    fakeNode().glitches.push({
      match: '/status',
      res: () => new Response('<html>proxy</html>', { status: 200 }),
    })
    expect((await poll(known.txhash, 4)).status).toBe('confirmed')
  })

  it('malformed answers alone never become a verdict: unconfirmed when the budget runs out', async () => {
    const node = fakeNode()
    node.glitches.push({
      match: '/block_results',
      times: 4,
      res: () => jsonResponse({ result: { height: H, txs_results: [{ code: '0' }] } }),
    })
    expect(await poll(known.txhash, 3)).toEqual({ status: 'unconfirmed' })
  })

  it('no request ever goes to any host but TX_CONFIRM_RPC_URL', async () => {
    const node = fakeNode()
    node.glitches.push({ match: '/block_results', res: () => jsonResponse({ message: 'x' }, 500) })
    await poll(known.txhash, 4)
    expect(node.calls.length).toBeGreaterThan(3)
    for (const c of node.calls) expect(c.startsWith(`${TX_CONFIRM_RPC_URL}/`), c).toBe(true)
  })

  it('the 4th parameter is the RPC base to read from', async () => {
    const node = fakeNode()
    const other = 'https://other-rpc.example'
    expect((await poll(known.txhash, 3, other)).status).toBe('confirmed')
    expect(node.calls.length).toBeGreaterThan(0)
    expect(node.calls.every((c) => c.startsWith(`${other}/`))).toBe(true)
  })
})

// WO-085 D1 (docs/06 WR-1): the poll has a work bound whatever the node claims.
describe('pollTx: bounds (WO-085 D1, WR-1)', () => {
  const START = 1000 - LOOKBACK_BLOCKS // a clock that never moves: no extra blocks
  const END = START + MAX_SCAN_BLOCKS // never read at or past this height

  it('the window always holds the latest height: LOOKBACK + MAX_EXTRA < MAX_SCAN (WO-086 invariant)', () => {
    expect(LOOKBACK_BLOCKS + MAX_EXTRA_BLOCKS).toBeLessThan(MAX_SCAN_BLOCKS)
  })

  it('the constants are the decided ones', () => {
    expect([MAX_SCAN_BLOCKS, MAX_BLOCKS_PER_ROUND, MAX_BLOCK_READS_PER_ROUND]).toEqual([
      400, 60, 10,
    ])
    expect([POLL_DEADLINE_MS, MAX_EXTRA_BLOCKS]).toEqual([180_000, 200])
  })

  it('a /status that jumps to 2^53-1 after a normal first round ends unconfirmed within a fixed number of requests', async () => {
    const node = fakeNode({ latest: 1000, blocks: {} })
    node.onStatus = (n) => {
      if (n >= 2) node.latest = Number.MAX_SAFE_INTEGER
    }
    expect(await poll(known.txhash, 20)).toEqual({ status: 'unconfirmed' })
    // 400 heights from START in chunks of 20: round 1 reads 41 (3 calls: 20, 20, 1), rounds 2-6 read 60 each
    // (3 calls), round 7 reads the last 59 (3 calls); one /status a round; nothing is ever read at or past END
    expect(node.statusCalls).toBe(7)
    expect(countOf(node, '/blockchain?')).toBe(21)
    expect(node.calls).toHaveLength(7 + 21)
    for (const [, b] of rangesOf(node)) expect(b).toBeLessThan(END)
  })

  it('a 5,000-block gap costs at most 3 /blockchain calls per round and is never scanned past start + MAX_SCAN_BLOCKS', async () => {
    const node = fakeNode({ latest: 1000, blocks: {} })
    node.onStatus = (n) => {
      if (n >= 2) node.latest = 6000
    }
    await poll(known.txhash, 3)
    const perRound: number[] = []
    for (const c of node.calls) {
      if (c.includes('/status')) perRound.push(0)
      else if (c.includes('/blockchain?')) perRound[perRound.length - 1]++
    }
    expect(Math.max(...perRound)).toBeLessThanOrEqual(3)
    expect(Math.max(...rangesOf(node).map(([, b]) => b))).toBeLessThan(END)
  })

  it('early end: every height of the window resolved and the tx not found → unconfirmed before `tries` runs out', async () => {
    const node = fakeNode({ latest: 1000, blocks: {} })
    node.onStatus = (n) => {
      if (n === 2) node.latest = 1400
    }
    const sleeps = vi.spyOn(globalThis, 'setTimeout')
    expect(await pollTx(known.txhash, 20, 7, undefined, () => 0)).toEqual({ status: 'unconfirmed' })
    expect(node.statusCalls).toBe(7)
    // one wait between rounds, none after the last: 7 rounds, not 20
    expect(sleeps.mock.calls.filter((c) => c[1] === 7)).toHaveLength(6)
    sleeps.mockRestore()
  })

  it('the deadline: with the clock past POLL_DEADLINE_MS the next request is not made, and the result is unconfirmed', async () => {
    const node = fakeNode({ latest: 1000, blocks: {} })
    let t = 0
    node.onCall = () => {
      if (node.calls.length === 2) t = POLL_DEADLINE_MS // the 2nd request has just been made
    }
    expect(await pollTx(known.txhash, 20, 0, undefined, () => t)).toEqual({ status: 'unconfirmed' })
    expect(node.calls).toHaveLength(2)
  })

  it('a deadline that passes after the tx was found stops the /block_results retries too: unconfirmed, never a throw', async () => {
    const node = fakeNode()
    let t = 0
    node.glitches.push({
      match: '/block_results',
      times: 100,
      res: () => {
        t = POLL_DEADLINE_MS + 1
        return jsonResponse({ message: 'x' }, 502)
      },
    })
    expect(await pollTx(known.txhash, 20, 0, undefined, () => t)).toEqual({ status: 'unconfirmed' })
    expect(countOf(node, '/block_results')).toBe(1)
  })

  it('no early end while a block is still unread: every meta read, the block answers in a later round, and it confirms (WO-086 D4a)', async () => {
    const node = fakeNode({
      latest: 1000,
      blocks: { 1000: { txs: [known.tx_b64], codes: [0] } },
    })
    node.onStatus = (n) => {
      if (n === 2) node.latest = 1400 // all 400 heights are resolved by round 7
    }
    // the block fails for 8 rounds: past the round at which every height of the window is resolved
    node.glitches.push({
      match: '/block?height=1000',
      times: 8,
      res: () => jsonResponse({ message: 'x' }, 503),
    })
    expect(await poll(known.txhash, 20)).toEqual({ status: 'confirmed', height: '1000' })
    expect(node.statusCalls).toBe(7) // the window was resolved in round 7; the block was still unread
    expect(countOf(node, '/block?height=1000')).toBe(9)
  })

  it('12 finds whose code reads keep failing cost at most MAX_BLOCK_READS_PER_ROUND /block_results calls a round (WO-086 D4b)', async () => {
    // 12 blocks all holding the tx; the lower the block, the longer it fails to read, so the finds arrive one a
    // round from the top down and 12 finds are waiting for a code by round 12 or so
    const heights = Array.from({ length: 12 }, (_, i) => 989 + i)
    const blocks: Record<number, FakeBlock> = {}
    for (const h of heights) blocks[h] = { txs: [known.tx_b64], codes: [0] }
    const node = fakeNode({ latest: 1000, blocks })
    const seen = new Map<number, number>()
    node.glitches.push({
      match: '/block?',
      times: 1_000_000,
      res: (url) => {
        const h = Number(new URL(url).searchParams.get('height'))
        const n = (seen.get(h) ?? 0) + 1
        seen.set(h, n)
        return n <= 1000 - h ? jsonResponse({ message: 'x' }, 503) : undefined
      },
    })
    node.glitches.push({
      match: '/block_results',
      times: 1_000_000,
      res: () => jsonResponse({ message: 'x' }, 502), // no code is ever read
    })
    const sleeps = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      node.calls.push('ROUND')
      fn()
      return 0
    }) as unknown as typeof setTimeout)
    try {
      expect(await pollTx(known.txhash, 40, 1, undefined, () => 0)).toEqual({
        status: 'unconfirmed',
      })
    } finally {
      sleeps.mockRestore()
    }
    const perRound = node.calls
      .join('|')
      .split('ROUND')
      .map((seg) => seg.split('|').filter((c) => c.includes('/block_results')).length)
    expect(Math.max(...perRound)).toBe(MAX_BLOCK_READS_PER_ROUND) // 12 finds were waiting; 10 reads, not 12
  })

  it('MAX_BLOCK_READS_PER_ROUND: 25 blocks with txs are read 10, then 10, then 5 across rounds', async () => {
    const blocks: Record<number, FakeBlock> = {}
    for (let h = 976; h <= 1000; h++) blocks[h] = { txs: [otherTx(h % 200)], codes: [0] }
    const one = fakeNode({ latest: 1000, blocks })
    await poll(known.txhash, 1)
    expect(countOf(one, '/block?')).toBe(10)
    const two = fakeNode({ latest: 1000, blocks })
    await poll(known.txhash, 2)
    expect(countOf(two, '/block?')).toBe(20)
    const three = fakeNode({ latest: 1000, blocks })
    await poll(known.txhash, 3)
    expect(countOf(three, '/block?')).toBe(25)
  })

  it('a block that fails is retried and counts against the cap', async () => {
    const blocks: Record<number, FakeBlock> = {}
    for (let h = 976; h <= 1000; h++) blocks[h] = { txs: [otherTx(h % 200)], codes: [0] }
    const node = fakeNode({ latest: 1000, blocks })
    node.glitches.push({
      match: '/block?',
      times: 4,
      res: () => jsonResponse({ message: 'x' }, 503),
    })
    await poll(known.txhash, 1)
    expect(countOf(node, '/block?')).toBe(10) // 4 failures + 6 reads, never more than the cap
  })
})

// WO-085 D2 (WR-2): the lookback is anchored to when pollTx began, not to the first /status that answers.
describe('pollTx: time-anchored lookback (WO-085 D2, WR-2)', () => {
  it('three /status rounds time out (13 s each), then /status answers 15 blocks past the tx block: still confirmed', async () => {
    const node = fakeNode({ latest: KNOWN_H + 15 })
    let t = 0
    node.glitches.push({
      match: '/status',
      times: 3,
      res: () => {
        t += 13_000
        throw new DOMException('signal timed out', 'TimeoutError')
      },
    })
    // The literal WR-2 case: 39 s elapsed, so start = latest - 40 - 39 = tx block - 64. (The boundary itself,
    // a tx older than the plain lookback, is the third test below.)
    expect(await pollTx(known.txhash, 10, 0, undefined, () => t)).toEqual({
      status: 'confirmed',
      height: known.height,
    })
  })

  it('the start is latest - LOOKBACK - ceil(elapsed s), the extra capped at MAX_EXTRA_BLOCKS', async () => {
    const node = fakeNode({ latest: 10_000, blocks: {} })
    let t = 0
    node.onStatus = () => {
      t = 7_100 // 7.1 s since entry: 8 extra blocks
    }
    await pollTx(known.txhash, 1, 0, undefined, () => t)
    expect(rangesOf(node)[0][0]).toBe(10_000 - LOOKBACK_BLOCKS - 8)

    // The extra is capped at MAX_EXTRA_BLOCKS. With a real clock that cap can never be seen in a request (elapsed
    // past 200 s is also past POLL_DEADLINE_MS, which refuses every later request), so the clock is scripted:
    // the entry time, the deadline check before /status, then a clock that jumped 250 s by the time it answered.
    const capped = fakeNode({ latest: 10_000, blocks: {} })
    const readings = [0, 0, 250_000]
    let i = 0
    await pollTx(known.txhash, 1, 0, undefined, () => readings[i++] ?? 0)
    expect(rangesOf(capped)[0][0]).toBe(10_000 - LOOKBACK_BLOCKS - MAX_EXTRA_BLOCKS)
  })

  it('WR-16: a clock that steps back 1 h after entry still finds a tx at latest - 10 (the elapsed time is clamped at 0)', async () => {
    const L = 5000
    fakeNode({ latest: L, blocks: { [L - 10]: { txs: [known.tx_b64], codes: [0] } } })
    const readings = [3_600_000] // the entry time; every later reading is 1 h earlier
    let i = 0
    expect(await pollTx(known.txhash, 3, 0, undefined, () => readings[i++] ?? 0)).toEqual({
      status: 'confirmed',
      height: String(L - 10),
    })
  })

  it('WR-16: the default clock is the monotonic performance.now, not the wall clock', async () => {
    const L = 5000
    const node = fakeNode({ latest: L, blocks: { [L - 10]: { txs: [known.tx_b64], codes: [0] } } })
    const perf = vi.spyOn(performance, 'now')
    const wall = vi.spyOn(Date, 'now')
    try {
      expect((await pollTx(known.txhash, 3, 0)).status).toBe('confirmed')
      expect(perf).toHaveBeenCalled()
      expect(wall).not.toHaveBeenCalled()
      expect(rangesOf(node)[0][0]).toBeLessThanOrEqual(L - LOOKBACK_BLOCKS) // plus a block for a few ms
    } finally {
      perf.mockRestore()
      wall.mockRestore()
    }
  })

  it('a tx older than the lookback is found when the slow /status explains the age, and not when it does not', async () => {
    const block = { txs: [known.tx_b64], codes: [0] }
    const L = 5000
    const slow = fakeNode({ latest: L, blocks: { [L - 70]: block } })
    let t = 0
    slow.onStatus = () => {
      t = 60_000 // 60 s elapsed: 60 extra blocks, start = L - 100
    }
    expect((await pollTx(known.txhash, 3, 0, undefined, () => t)).status).toBe('confirmed')
    const quick = fakeNode({ latest: L, blocks: { [L - 70]: block } })
    expect(await poll(known.txhash, 3)).toEqual({ status: 'unconfirmed' }) // no elapsed time: start = L - 40
    expect(countOf(quick, '/block?')).toBe(0)
  })
})

// WO-085 D3 (WR-3): per-height state; one unreadable block never stops the scan, and a non-zero code is failed only
// once no earlier block is still unread.
describe('pollTx: per-height retry and the verdict rule (WO-085 D3, WR-3)', () => {
  const EARLIER = KNOWN_H - 3
  const hang = (n: number): Glitch => ({
    match: `/block?height=${EARLIER}`,
    times: n,
    res: () => jsonResponse({ message: 'too large' }, 503),
  })
  const other = { txs: [otherTx(9)], codes: [0] }

  it('a block that never answers, before our tx block, still lets a later code 0 confirm', async () => {
    const node = fakeNode({
      blocks: { [EARLIER]: other, [KNOWN_H]: { txs: [known.tx_b64], codes: [0] } },
    })
    node.glitches.push(hang(1000))
    expect(await poll(known.txhash, 5)).toEqual({ status: 'confirmed', height: known.height })
  })

  it('a non-zero code after an unread earlier block is NOT failed: it ends unconfirmed if that block never resolves', async () => {
    const node = fakeNode({
      blocks: { [EARLIER]: other, [KNOWN_H]: { txs: [known.tx_b64], codes: [5] } },
    })
    node.glitches.push(hang(1000))
    expect(await poll(known.txhash, 6)).toEqual({ status: 'unconfirmed' })
    expect(countOf(node, `/block?height=${EARLIER}`)).toBe(6) // asked again every round
  })

  it('it becomes failed once the earlier block reads without the tx', async () => {
    const node = fakeNode({
      blocks: { [EARLIER]: other, [KNOWN_H]: { txs: [known.tx_b64], codes: [5] } },
    })
    node.glitches.push(hang(2))
    expect(await poll(known.txhash, 6)).toEqual({
      status: 'failed',
      code: 5,
      height: known.height,
      rawLog: '',
    })
    expect(countOf(node, `/block?height=${EARLIER}`)).toBe(3)
  })

  it('it becomes confirmed if the earlier block holds the tx with code 0', async () => {
    const node = fakeNode({
      blocks: {
        [EARLIER]: { txs: [known.tx_b64], codes: [0] },
        [KNOWN_H]: { txs: [known.tx_b64], codes: [5] },
      },
    })
    node.glitches.push(hang(2))
    expect(await poll(known.txhash, 6)).toEqual({ status: 'confirmed', height: String(EARLIER) })
  })

  it("two found blocks, both non-zero: failed with the LOWEST block's code", async () => {
    const node = fakeNode({
      blocks: {
        [EARLIER]: { txs: [known.tx_b64], codes: [5] },
        [KNOWN_H]: { txs: [known.tx_b64], codes: [7] },
      },
    })
    node.glitches.push(hang(1)) // the earlier block is read one round after the later one
    expect(await poll(known.txhash, 4)).toEqual({
      status: 'failed',
      code: 5,
      height: String(EARLIER),
      rawLog: '',
    })
  })

  it("a non-zero code is not failed while another found block's code is unknown (it could be 0), and a later code 0 wins", async () => {
    const node = fakeNode({
      blocks: {
        [EARLIER]: { txs: [known.tx_b64], codes: [5] },
        [KNOWN_H]: { txs: [known.tx_b64], codes: [0] },
      },
    })
    node.glitches.push(hang(1)) // the earlier block is read one round after the later one
    node.glitches.push({
      match: `/block_results?height=${KNOWN_H}`,
      times: 2,
      res: () => jsonResponse({ message: 'x' }, 502),
    })
    expect(await poll(known.txhash, 6)).toEqual({ status: 'confirmed', height: known.height })
    expect(countOf(node, `/block_results?height=${KNOWN_H}`)).toBe(3)
  })

  it('with the tx found at h, a block above h is never requested (WO-086 D4c)', async () => {
    const node = fakeNode({
      blocks: {
        [KNOWN_H]: { txs: [known.tx_b64], codes: [0] },
        [KNOWN_H + 1]: { txs: [otherTx(5)], codes: [0] },
      },
    })
    node.glitches.push({ match: '/block_results', res: () => jsonResponse({ message: 'x' }, 502) })
    expect((await poll(known.txhash, 4)).status).toBe('confirmed')
    expect(countOf(node, `/block?height=${KNOWN_H + 1}`)).toBe(0)
  })

  it('an unread block above the find does not hold back the retry of an earlier block below it', async () => {
    const node = fakeNode({
      blocks: {
        [EARLIER]: other,
        [KNOWN_H]: { txs: [known.tx_b64], codes: [5] },
        [KNOWN_H + 1]: { txs: [otherTx(5)], codes: [0] }, // never tried, but above the find: skipped, not a stop
      },
    })
    node.glitches.push(hang(1)) // the earlier block fails once, so round 2 retries it behind the never-tried one above
    expect(await poll(known.txhash, 4)).toEqual({
      status: 'failed',
      code: 5,
      height: known.height,
      rawLog: '',
    })
    expect(countOf(node, `/block?height=${KNOWN_H + 1}`)).toBe(0)
  })

  it('read order: heights never tried come before any retry, then by height (WO-086 D4d)', async () => {
    const blocks: Record<number, FakeBlock> = {}
    for (let h = 976; h <= 1000; h++) blocks[h] = { txs: [otherTx(h % 200)], codes: [0] }
    const node = fakeNode({ latest: 1000, blocks })
    node.glitches.push({
      match: '/block?height=976',
      res: () => jsonResponse({ message: 'x' }, 503),
    })
    await poll(known.txhash, 3)
    const order = node.calls
      .filter((c) => c.includes('/block?'))
      .map((c) => Number(new URL(c).searchParams.get('height')))
    const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
    // round 1: 976 fails (its one failure), 977-985; round 2: the 10 never-tried 986-995, NOT the retry of 976;
    // round 3: the 5 never-tried 996-1000, then the retry of 976
    expect(order).toEqual([...range(976, 985), ...range(986, 995), ...range(996, 1000), 976])
  })

  it('WR-15: 15 unreadable blocks below our tx block do not starve it: code 0 still confirms', async () => {
    const blocks: Record<number, FakeBlock> = { [KNOWN_H]: { txs: [known.tx_b64], codes: [0] } }
    for (let h = KNOWN_H - 15; h < KNOWN_H; h++) blocks[h] = { txs: [otherTx(h % 200)], codes: [0] }
    const node = fakeNode({ blocks })
    node.glitches.push({
      match: '/block?',
      times: 1_000_000,
      res: (url) =>
        url.includes(`height=${KNOWN_H}`) ? undefined : jsonResponse({ message: 'x' }, 503),
    })
    expect(await poll(known.txhash, 6)).toEqual({ status: 'confirmed', height: known.height })
  })

  it('WR-15: the same 15 unreadable blocks with a NON-zero code: unconfirmed, never failed', async () => {
    const blocks: Record<number, FakeBlock> = { [KNOWN_H]: { txs: [known.tx_b64], codes: [5] } }
    for (let h = KNOWN_H - 15; h < KNOWN_H; h++) blocks[h] = { txs: [otherTx(h % 200)], codes: [0] }
    const node = fakeNode({ blocks })
    node.glitches.push({
      match: '/block?',
      times: 1_000_000,
      res: (url) =>
        url.includes(`height=${KNOWN_H}`) ? undefined : jsonResponse({ message: 'x' }, 503),
    })
    expect(await poll(known.txhash, 6)).toEqual({ status: 'unconfirmed' })
    expect(countOf(node, `/block?height=${KNOWN_H}`)).toBe(1) // found once, not read again
  })

  it('WR-19: 12 slow blocks below our tx block (10 s each): the code is read as soon as the tx is found, so it confirms before the deadline', async () => {
    const blocks: Record<number, FakeBlock> = { [KNOWN_H]: { txs: [known.tx_b64], codes: [0] } }
    for (let h = KNOWN_H - 12; h < KNOWN_H; h++) blocks[h] = { txs: [otherTx(h % 200)], codes: [0] }
    const node = fakeNode({ blocks })
    let t = 0
    // every lower /block read times out: 10 s on the clock, and no answer
    node.onCall = (url) => {
      if (url.includes('/block?') && !url.includes(`height=${KNOWN_H}`)) t += 10_000
    }
    node.glitches.push({
      match: '/block?',
      times: 1_000_000,
      res: (url) =>
        url.includes(`height=${KNOWN_H}`) ? undefined : jsonResponse({ message: 'x' }, 504),
    })
    // round 1 reads 10 slow blocks (100 s); round 2 reads the 2 never-tried slow ones (120 s), then ours: before
    // WR-19 the round went on retrying slow blocks past 180 s and the code was never read
    expect(await pollTx(known.txhash, 6, 0, undefined, () => t)).toEqual({
      status: 'confirmed',
      height: known.height,
    })
    expect(t).toBeLessThan(POLL_DEADLINE_MS)
  })

  it('WR-17: a code 0 already read is the answer even if the deadline passes during the next code read', async () => {
    const EARLY = KNOWN_H - 3
    const node = fakeNode({
      blocks: {
        [EARLY]: { txs: [known.tx_b64], codes: [0] },
        [KNOWN_H]: { txs: [known.tx_b64], codes: [5] },
      },
    })
    let t = 0
    node.glitches.push({
      match: `/block?height=${EARLY}`,
      res: () => jsonResponse({ message: 'x' }, 503),
    })
    node.glitches.push({
      match: `/block_results?height=${KNOWN_H}`,
      res: () => jsonResponse({ message: 'x' }, 502), // the later find's code is unknown in round 1
    })
    // round 2: the earlier block is read and found; its code read makes the clock pass the deadline, so a
    // read of the later find's code (if one were made) would be refused
    node.onCall = (url) => {
      if (url.includes(`/block_results?height=${EARLY}`)) t = POLL_DEADLINE_MS + 1
    }
    expect(await pollTx(known.txhash, 6, 0, undefined, () => t)).toEqual({
      status: 'confirmed',
      height: String(EARLY),
    })
    expect(countOf(node, `/block_results?height=${KNOWN_H}`)).toBe(1) // only the failed read of round 1
  })

  it('a non-zero code with every earlier block already read is failed at once', async () => {
    const node = fakeNode({
      blocks: { [EARLIER]: other, [KNOWN_H]: { txs: [known.tx_b64], codes: [7] } },
    })
    expect((await poll(known.txhash, 3)).status).toBe('failed')
    expect(node.statusCalls).toBe(1)
  })

  it('once the tx is found, metas past it are no longer read', async () => {
    const node = fakeNode({ latest: KNOWN_H + 2 })
    node.glitches.push({ match: '/block_results', res: () => jsonResponse({ message: 'x' }, 502) })
    node.onStatus = (n) => {
      if (n >= 2) node.latest = KNOWN_H + 50
    }
    expect((await poll(known.txhash, 4)).status).toBe('confirmed')
    expect(node.statusCalls).toBe(1)
    expect(Math.max(...rangesOf(node).map(([, b]) => b))).toBe(KNOWN_H + 2)
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
  it('account read 15 s, simulate 20 s, broadcast 30 s, each node lookup 10 s', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const node = fakeNode()
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
        return nodeAnswer(node, url, init)
      }),
    )
    await simulate(fakeSigner({}), ADDR, [MSG], '')
    await signAndBroadcast(fakeSigner({}), ADDR, [MSG], 1000)
    expect(await pollTx(known.txhash, 1, 0)).toEqual({ status: 'confirmed', height: known.height })
    // account, simulate, account, broadcast, then /status, 3 x /blockchain, /block, /block_results
    expect(inits).toHaveLength(10)
    for (const init of inits) expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(timeout.mock.calls.map((c) => c[0])).toEqual([
      15_000, 20_000, 15_000, 30_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000,
    ])
    timeout.mockRestore()
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

// Re-review R-5: AbortSignal.timeout needs Chrome 103+ / Firefox 100+ / Safari 16+. Without it the page
// must still work (unbounded, as before P-4), not fail every read closed.
describe('no AbortSignal.timeout (an older browser) → requests still go out, unbounded', () => {
  it('simulate, broadcast and a lookup all run, with no signal', async () => {
    const original = AbortSignal.timeout
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true })
    try {
      const node = fakeNode()
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
          return nodeAnswer(node, url, init)
        }),
      )
      expect(await simulate(fakeSigner({}), ADDR, [MSG], '')).toBe(1500)
      expect((await signAndBroadcast(fakeSigner({}), ADDR, [MSG], 1000)).delivery).toBe('accepted')
      expect(await pollTx(known.txhash, 1, 0)).toEqual({
        status: 'confirmed',
        height: known.height,
      })
      expect(inits).toHaveLength(10)
      for (const init of inits) expect(init?.signal).toBeUndefined()
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', { value: original, configurable: true })
    }
  })
})
