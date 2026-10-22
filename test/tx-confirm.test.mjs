// WO-040: a submitted tx whose outcome can't be confirmed must surface as TxUnconfirmedError —
// never as a resolved result with `code: undefined` (which callers read as "failed" and retried).
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import axios from 'axios'
import { toBase64, fromBase64 } from '@cosmjs/encoding'
import SigningClient from '../src/utils/SigningClient.mjs'
import {
  TxUnconfirmedError,
  TxFailedError,
  isUnconfirmed,
  isTxFailed,
  isSequenceMismatch,
  txHashOf,
  waitForTx,
  submitTx,
} from '../src/utils/TxConfirm.mjs'
import { simulateAndBroadcast } from '../scripts/lib/broadcast.mjs'
import { ethAccount, httpError as rawHttpError } from './helpers/chain-fixtures.mjs'

const realGet = axios.get
const realPost = axios.post
afterEach(() => {
  axios.get = realGet
  axios.post = realPost
})

const noSleep = async () => {}
const httpError = (status, message) => rawHttpError(status, { code: 2, message })

// --- TxConfirm helpers ------------------------------------------------------------------------

test('txHashOf is the uppercase hex SHA-256 of the tx bytes', () => {
  assert.equal(
    txHashOf(new Uint8Array()),
    'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855',
  )
})

test('waitForTx resolves once the tx is found after a pending 404', async () => {
  let calls = 0
  const fetchTx = async () => {
    calls++
    if (calls === 1) throw httpError(404, 'tx not found')
    return { code: 0 }
  }
  const res = await waitForTx(fetchTx, 'ABC', { sleep: noSleep })
  assert.deepEqual(res, { code: 0 })
  assert.equal(calls, 2)
})

test('waitForTx bails immediately with TxUnconfirmedError when the endpoint has indexing disabled', async () => {
  let calls = 0
  const fetchTx = async () => {
    calls++
    throw httpError(400, 'transaction indexing is disabled')
  }
  await assert.rejects(waitForTx(fetchTx, 'ABC', { sleep: noSleep, timeoutMs: 60_000 }), (e) => {
    assert.ok(e instanceof TxUnconfirmedError)
    assert.equal(e.transactionHash, 'ABC')
    return true
  })
  assert.equal(calls, 1)
})

test('waitForTx throws TxUnconfirmedError (never returns it) once the deadline passes', async () => {
  let t = 0
  const fetchTx = async () => {
    t += 1000
    throw httpError(404, 'tx not found')
  }
  await assert.rejects(
    waitForTx(fetchTx, 'ABC', { sleep: noSleep, timeoutMs: 5000, now: () => t }),
    isUnconfirmed,
  )
})

test('submitTx: a transport failure with no HTTP response is unconfirmed and named by the local hash', async () => {
  const bytes = new Uint8Array([1, 2, 3])
  await assert.rejects(
    submitTx(async () => {
      throw new Error('socket hang up')
    }, bytes),
    (e) => {
      assert.ok(isUnconfirmed(e))
      assert.equal(e.transactionHash, txHashOf(bytes))
      return true
    },
  )
})

// Only the node's own tx_response is a verdict. An HTTP error can come from a reverse proxy
// AFTER the node admitted the tx (a public endpoint sits behind nginx), so it is unconfirmed.
for (const [label, err] of [
  [
    'a proxy 502 with an HTML body',
    Object.assign(new Error('Request failed with status code 502'), {
      response: { status: 502, data: '<html><center>502 Bad Gateway</center></html>' },
    }),
  ],
  [
    'a proxy 504',
    Object.assign(new Error('Request failed with status code 504'), {
      response: { status: 504, data: '' },
    }),
  ],
  ['a gateway 500 with a JSON error', httpError(500, 'boom')],
]) {
  test(`submitTx: ${label} is unconfirmed, never a definitive failure`, async () => {
    const bytes = new Uint8Array([4, 5, 6])
    await assert.rejects(
      submitTx(async () => {
        throw err
      }, bytes),
      (e) => {
        assert.ok(isUnconfirmed(e), `expected TxUnconfirmedError, got ${e?.name}`)
        assert.equal(e.transactionHash, txHashOf(bytes))
        assert.match(e.message, /HTTP \d{3}/)
        return true
      },
    )
  })
}

test('submitTx: a 2xx body without a tx_response is unconfirmed', async () => {
  await assert.rejects(
    submitTx(async () => ({ data: {} }), new Uint8Array([7])),
    isUnconfirmed,
  )
})

test('submitTx: a tx_response naming a different tx is unconfirmed', async () => {
  const other = { data: { tx_response: { code: 0, txhash: 'F'.repeat(64) } } }
  await assert.rejects(
    submitTx(async () => other, new Uint8Array([8])),
    isUnconfirmed,
  )
})

test('submitTx: sdk code 19 (tx already in the mempool cache) is unconfirmed — an identical tx may commit', async () => {
  const bytes = new Uint8Array([9])
  const cached = {
    data: {
      tx_response: {
        code: 19,
        codespace: 'sdk',
        txhash: txHashOf(bytes),
        raw_log: 'tx already exists in cache',
      },
    },
  }
  await assert.rejects(
    submitTx(async () => cached, bytes),
    isUnconfirmed,
  )
})

test('submitTx: a well-formed verdict for these bytes is returned as-is (the hash compare ignores case)', async () => {
  const bytes = new Uint8Array([10])
  const verdict = {
    code: 13,
    codespace: 'sdk',
    txhash: txHashOf(bytes).toLowerCase(),
    raw_log: 'insufficient fee',
  }
  assert.deepEqual(await submitTx(async () => ({ data: { tx_response: verdict } }), bytes), verdict)
})

test('isSequenceMismatch: CheckTx sdk/32 and the simulate error text both count; nothing else does', () => {
  assert.equal(
    isSequenceMismatch(
      new TxFailedError(
        { code: 32, codespace: 'sdk', transactionHash: 'H', rawLog: 'x' },
        'checktx',
      ),
    ),
    true,
  )
  assert.equal(
    isSequenceMismatch(
      new Error('account sequence mismatch, expected 13, got 12: incorrect account sequence'),
    ),
    true,
  )
  assert.equal(
    isSequenceMismatch(
      new TxFailedError(
        { code: 32, codespace: 'wasm', transactionHash: 'H', rawLog: 'x' },
        'checktx',
      ),
    ),
    false,
  )
  assert.equal(isSequenceMismatch(new Error('insufficient funds')), false)
  assert.equal(isSequenceMismatch(undefined), false)
})

// --- SigningClient.signAndBroadcast, end to end through its real entry point (axios stubbed) ----

const network = {
  restUrl: 'http://rest.invalid',
  gasPrice: '20000000000ario',
  gasModifier: 1.5,
  slip44: 60,
  chainId: 'realionetwork_3301-1',
  txTimeout: 5_000,
  txPollIntervalMs: 1,
}
const signer = {
  getAccounts: async () => [
    { address: 'realio1bot', pubkey: new Uint8Array(33), algo: 'eth_secp256k1' },
  ],
  signDirect: async (_addr, signDoc) => ({
    signed: signDoc,
    signature: { signature: toBase64(new Uint8Array(65)) },
  }),
}
const msg = {
  typeUrl: '/cosmos.bank.v1beta1.MsgSend',
  value: { fromAddress: 'realio1bot', toAddress: 'realio1bot', amount: [] },
}
const accountResponse = { data: { account: ethAccount('realio1bot') } }

// The stub node echoes the REAL hash of the posted bytes (submitTx now checks it), records each
// request's axios options, and answers lookups through txLookup(callNo, hashFromUrl).
function stubChain({ checkTx = { code: 0, raw_log: '' }, postError, postData, txLookup }) {
  const calls = { txGet: 0, hashes: [], postOpts: [], getOpts: [] }
  axios.post = async (_url, body, opts) => {
    const hash = txHashOf(fromBase64(body.tx_bytes))
    calls.hashes.push(hash)
    calls.postOpts.push(opts)
    if (postError) throw postError
    if (postData) return { data: postData(hash) }
    return { data: { tx_response: { txhash: hash, ...checkTx } } }
  }
  axios.get = async (url, opts) => {
    if (url.includes('/cosmos/auth/v1beta1/accounts/')) return accountResponse
    calls.txGet++
    calls.getOpts.push(opts)
    return txLookup(calls.txGet, url.split('/').pop())
  }
  return calls
}
const send = () => SigningClient(network, signer).signAndBroadcast('realio1bot', [msg], 200000, 'm')
const found =
  (code, rawLog = '') =>
  (_n, hash) => ({ data: { tx_response: { code, txhash: hash, height: '100', raw_log: rawLog } } })
const noPoll = () => {
  throw new Error('should not poll')
}

test('signAndBroadcast REJECTS with TxUnconfirmedError when indexing is disabled (was: resolved Error, code undefined)', async () => {
  const calls = stubChain({
    txLookup: () => {
      throw httpError(500, 'transaction indexing is disabled')
    },
  })
  await assert.rejects(send(), (e) => {
    assert.ok(isUnconfirmed(e), `expected TxUnconfirmedError, got ${e?.name}`)
    assert.equal(e.transactionHash, calls.hashes[0])
    return true
  })
  assert.equal(calls.txGet, 1)
})

test('signAndBroadcast resolves with code 0 once the committed tx is found, polling by the local hash with timeouts', async () => {
  const calls = stubChain({
    txLookup: (n, hash) => {
      if (n < 2) throw httpError(404, 'not found')
      return found(0)(n, hash)
    },
  })
  const res = await send()
  assert.equal(res.code, 0)
  assert.equal(res.transactionHash, calls.hashes[0])
  assert.equal(calls.postOpts[0]?.timeout, 30000) // a hung broadcast becomes a no-response = unconfirmed
  assert.equal(calls.getOpts[0]?.timeout, 10000) // a hung lookup is just another "not found yet"
})

test('signAndBroadcast: DeliverTx code != 0 is a definitive (retryable) TxFailedError, not unconfirmed', async () => {
  stubChain({ txLookup: found(5, 'insufficient funds') })
  await assert.rejects(
    send(),
    (e) =>
      e instanceof TxFailedError &&
      e.phase === 'delivertx' &&
      !isUnconfirmed(e) &&
      /Code: 5/.test(e.message),
  )
})

test('signAndBroadcast: a DeliverTx result with no code is unconfirmed, never success', async () => {
  stubChain({ txLookup: (_n, hash) => ({ data: { tx_response: { txhash: hash, raw_log: '' } } }) })
  await assert.rejects(send(), isUnconfirmed)
})

test('signAndBroadcast: a lookup that answers for ANOTHER tx is not a verdict — it ends unconfirmed, never TxFailedError', async () => {
  stubChain({
    txLookup: () => ({
      data: {
        tx_response: { code: 5, txhash: 'B'.repeat(64), height: '100', raw_log: 'someone else' },
      },
    }),
  })
  const shortNet = { ...network, txTimeout: 30 }
  await assert.rejects(
    SigningClient(shortNet, signer).signAndBroadcast('realio1bot', [msg], 200000, 'm'),
    (e) => isUnconfirmed(e) && !(e instanceof TxFailedError),
  )
})

test('signAndBroadcast: CheckTx reject is a definitive TxFailedError and never polls', async () => {
  const calls = stubChain({
    checkTx: { code: 13, codespace: 'sdk', raw_log: 'insufficient fee' },
    txLookup: noPoll,
  })
  await assert.rejects(
    send(),
    (e) =>
      e instanceof TxFailedError &&
      e.phase === 'checktx' &&
      !isUnconfirmed(e) &&
      !isSequenceMismatch(e),
  )
  assert.equal(calls.txGet, 0)
})

test('signAndBroadcast: CheckTx sequence mismatch (sdk 32) is definitive AND flagged so callers stop, never poll', async () => {
  const calls = stubChain({
    checkTx: {
      code: 32,
      codespace: 'sdk',
      raw_log: 'account sequence mismatch, expected 4, got 3: incorrect account sequence',
    },
    txLookup: noPoll,
  })
  await assert.rejects(
    send(),
    (e) => e instanceof TxFailedError && isSequenceMismatch(e) && !isUnconfirmed(e),
  )
  assert.equal(calls.txGet, 0)
})

test('signAndBroadcast: a broadcast POST that dies without a response is unconfirmed', async () => {
  const calls = stubChain({ postError: new Error('ETIMEDOUT'), txLookup: noPoll })
  await assert.rejects(
    send(),
    (e) =>
      isUnconfirmed(e) &&
      e.transactionHash === calls.hashes[0] &&
      /^[0-9A-F]{64}$/.test(e.transactionHash),
  )
})

// docs/06 audit 2026-10-08 — the replies that used to be read as definitive and so retried.
for (const [label, opts] of [
  [
    'an nginx 502 after the node admitted the tx',
    {
      postError: Object.assign(new Error('Request failed with status code 502'), {
        response: { status: 502, data: '<html>502 Bad Gateway</html>' },
      }),
    },
  ],
  [
    'a 504 gateway timeout',
    {
      postError: Object.assign(new Error('Request failed with status code 504'), {
        response: { status: 504, data: '' },
      }),
    },
  ],
  ['a 2xx body with no tx_response', { postData: () => ({}) }],
  [
    'a tx_response for some other tx',
    { postData: () => ({ tx_response: { code: 0, txhash: 'A'.repeat(64) } }) },
  ],
  [
    'sdk code 19 (already in the mempool cache)',
    { checkTx: { code: 19, codespace: 'sdk', raw_log: 'tx already exists in cache' } },
  ],
]) {
  test(`signAndBroadcast: ${label} is unconfirmed and never polled`, async () => {
    const calls = stubChain({ ...opts, txLookup: noPoll })
    await assert.rejects(send(), (e) => isUnconfirmed(e) && e.transactionHash === calls.hashes[0])
    assert.equal(calls.txGet, 0)
  })
}

// --- simulateAndBroadcast (claim-rewards / stake-rio / stake-dstrx tail) ------------------------

test('simulateAndBroadcast reports an unconfirmed tx as ok=false + unconfirmed, naming the hash', async () => {
  const client = {
    simulate: async () => 100000,
    signAndBroadcast: async () => {
      throw new TxUnconfirmedError('ABC', 'test')
    },
  }
  const result = await simulateAndBroadcast(client, 'bot1', [{}], 'memo', { dryRun: false })
  assert.equal(result.broadcast, true)
  assert.equal(result.ok, false)
  assert.equal(result.unconfirmed, true)
  assert.equal(result.transactionHash, 'ABC')
})

test('simulateAndBroadcast still re-throws an error that is neither TxFailedError nor unconfirmed', async () => {
  const client = {
    simulate: async () => 100000,
    signAndBroadcast: async () => {
      throw new Error('Code: 5')
    },
  }
  await assert.rejects(
    simulateAndBroadcast(client, 'bot1', [{}], 'memo', { dryRun: false }),
    /Code: 5/,
  )
})

// WO-058 D1: isTxFailed, the sibling of isUnconfirmed. It tests the error's NAME so it works across
// module instances, and it is true for a sequence-mismatch CheckTx rejection too (that IS a TxFailedError:
// callers must test isSequenceMismatch FIRST).
test('isTxFailed: true for a TxFailedError (either phase) and anything named TxFailedError; false otherwise', () => {
  const r = { code: 5, rawLog: 'x', transactionHash: 'H', height: 1 }
  assert.equal(isTxFailed(new TxFailedError(r, 'delivertx')), true)
  assert.equal(isTxFailed(new TxFailedError(r, 'checktx')), true)
  assert.equal(isTxFailed(Object.assign(new Error('x'), { name: 'TxFailedError' })), true)
  assert.equal(isTxFailed(new Error('Code: 5')), false)
  assert.equal(isTxFailed(new TxUnconfirmedError('H', 'why')), false)
  assert.equal(isTxFailed(null), false)
  assert.equal(isTxFailed(undefined), false)
  assert.equal(isTxFailed('TxFailedError'), false)
})

test('a sequence-mismatch CheckTx rejection is BOTH a TxFailedError and a sequence mismatch (so check the mismatch first)', () => {
  const e = new TxFailedError(
    {
      code: 32,
      codespace: 'sdk',
      rawLog: 'account sequence mismatch',
      transactionHash: 'H',
      height: 0,
    },
    'checktx',
  )
  assert.equal(isTxFailed(e), true)
  assert.equal(isSequenceMismatch(e), true)
})
