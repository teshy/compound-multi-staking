// docs/06 WO-046 gate (LOW, operator-approved 2026-10-08): the other broadcast tests stub axios
// itself, so a behaviour change inside axios (a version bump) on the broadcast path was invisible
// to the suite. These run the REAL SigningClient.signAndBroadcast, through the REAL axios and the
// bot's Helpers.get/post, against an HTTP stub node on 127.0.0.1. Each test pins how one kind of
// node answer is classified: success, definitive failure (TxFailedError), or unconfirmed
// (TxUnconfirmedError, which is never auto-retried).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { toBase64, fromBase64 } from '@cosmjs/encoding'
import SigningClient from '../src/utils/SigningClient.mjs'
import { TxFailedError, isUnconfirmed, txHashOf } from '../src/utils/TxConfirm.mjs'
import { ethAccount } from './helpers/chain-fixtures.mjs'

const account = { account: ethAccount('realio1bot') }

// The scenario for the current test: post(hash, req, res) answers the broadcast, lookup(n, hash,
// res) answers the n-th tx query. Every request is recorded.
let scenario
let seen
let server
let base

const json = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type })
  res.end(JSON.stringify(body))
}
const checkTx =
  (code, extra = {}) =>
  (hash, _req, res) =>
    json(res, 200, { tx_response: { txhash: hash, code, raw_log: '', ...extra } })
const foundTx = (code) => (_n, hash, res) =>
  json(res, 200, {
    tx_response: { txhash: hash, code, height: '100', raw_log: code ? 'failed' : '' },
  })
const noLookup = () => {
  throw new Error('should not poll')
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw })
      if (req.url.startsWith('/cosmos/auth/v1beta1/accounts/')) return json(res, 200, account)
      if (req.method === 'POST' && req.url === '/redirected/cosmos/tx/v1beta1/txs')
        return scenario.post(txHashOf(fromBase64(JSON.parse(raw).tx_bytes)), req, res)
      if (req.method === 'POST' && req.url === '/cosmos/tx/v1beta1/txs') {
        if (scenario.redirect) {
          res.writeHead(307, { location: base + '/redirected/cosmos/tx/v1beta1/txs' })
          return res.end()
        }
        return scenario.post(txHashOf(fromBase64(JSON.parse(raw).tx_bytes)), req, res)
      }
      if (req.method === 'GET' && req.url.startsWith('/cosmos/tx/v1beta1/txs/')) {
        scenario.lookups = (scenario.lookups || 0) + 1
        return scenario.lookup(scenario.lookups, req.url.split('/').pop(), res)
      }
      json(res, 404, { code: 5, message: 'unknown route' })
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.closeAllConnections()
  server.close()
})
beforeEach(() => {
  seen = []
})

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
const send = (s, netExtra = {}) => {
  scenario = s
  const network = {
    restUrl: base,
    gasPrice: '20000000000ario',
    gasModifier: 1.5,
    slip44: 60,
    chainId: 'realionetwork_3301-1',
    txTimeout: 2_000,
    txPollIntervalMs: 1,
    txBroadcastTimeout: 2_000,
    txQueryTimeout: 1_000,
    ...netExtra,
  }
  return SigningClient(network, signer).signAndBroadcast('realio1bot', [msg], 200000, 'm')
}
const posts = () => seen.filter((r) => r.method === 'POST')
const unconfirmed = (e) => isUnconfirmed(e) && !(e instanceof TxFailedError)

test('ok: CheckTx 0, a 404 while pending, then DeliverTx 0 resolves; the request has the expected shape', async () => {
  const res = await send({
    post: checkTx(0),
    lookup: (n, hash, r) =>
      n < 2 ? json(r, 404, { code: 5, message: 'tx not found' }) : foundTx(0)(n, hash, r),
  })
  assert.equal(res.code, 0)
  const [p] = posts()
  assert.equal(posts().length, 1)
  assert.match(p.headers['content-type'], /^application\/json/)
  assert.equal(p.headers['user-agent'], 'teshy-compound')
  assert.deepEqual(Object.keys(JSON.parse(p.body)).sort(), ['mode', 'tx_bytes'])
  assert.equal(JSON.parse(p.body).mode, 'BROADCAST_MODE_SYNC')
  assert.equal(res.transactionHash, txHashOf(fromBase64(JSON.parse(p.body).tx_bytes)))
})

test('CheckTx code 5 is a definitive TxFailedError (checktx) and nothing is polled', async () => {
  await assert.rejects(
    send({ post: checkTx(5, { codespace: 'sdk' }), lookup: noLookup }),
    (e) => e instanceof TxFailedError && e.phase === 'checktx' && !isUnconfirmed(e),
  )
})

test('CheckTx code 19 (already in mempool) is unconfirmed', async () => {
  await assert.rejects(
    send({ post: checkTx(19, { codespace: 'sdk' }), lookup: noLookup }),
    unconfirmed,
  )
})

test('a CheckTx reply for another hash is unconfirmed', async () => {
  await assert.rejects(
    send({
      post: (_h, _q, r) => json(r, 200, { tx_response: { txhash: 'A'.repeat(64), code: 0 } }),
      lookup: noLookup,
    }),
    unconfirmed,
  )
})

test('an nginx 502 HTML page is unconfirmed', async () => {
  await assert.rejects(
    send({
      post: (_h, _q, r) => {
        r.writeHead(502, { 'content-type': 'text/html' })
        r.end('<html><body>502 Bad Gateway</body></html>')
      },
      lookup: noLookup,
    }),
    unconfirmed,
  )
})

test('a JSON 500 from the broadcast is unconfirmed', async () => {
  await assert.rejects(
    send({
      post: (_h, _q, r) => json(r, 500, { code: 13, message: 'internal' }),
      lookup: noLookup,
    }),
    unconfirmed,
  )
})

test('a non-JSON 200 (no tx_response) is unconfirmed', async () => {
  await assert.rejects(
    send({
      post: (_h, _q, r) => {
        r.writeHead(200, { 'content-type': 'text/plain' })
        r.end('ok')
      },
      lookup: noLookup,
    }),
    unconfirmed,
  )
})

test('a hung broadcast socket times out as unconfirmed', async () => {
  await assert.rejects(
    send({ post: () => {}, lookup: noLookup }, { txBroadcastTimeout: 300 }),
    unconfirmed,
  )
})

test('valid JSON labelled text/plain is still parsed (and the tx confirms)', async () => {
  const res = await send({
    post: (hash, _q, r) => json(r, 200, { tx_response: { txhash: hash, code: 0 } }, 'text/plain'),
    lookup: foundTx(0),
  })
  assert.equal(res.code, 0)
})

test('a 307 on the broadcast is followed with the same POST body', async () => {
  const res = await send({ redirect: true, post: checkTx(0), lookup: foundTx(0) })
  assert.equal(res.code, 0)
  const p = posts()
  assert.equal(p.length, 2)
  assert.equal(p[1].url, '/redirected/cosmos/tx/v1beta1/txs')
  assert.equal(p[1].body, p[0].body)
})

test('DeliverTx code 5 is a definitive TxFailedError (delivertx)', async () => {
  await assert.rejects(
    send({ post: checkTx(0), lookup: foundTx(5) }),
    (e) => e instanceof TxFailedError && e.phase === 'delivertx' && !isUnconfirmed(e),
  )
})

test('a lookup answering "indexing is disabled" (HTTP 500) is unconfirmed after one query', async () => {
  const s = {
    post: checkTx(0),
    lookup: (_n, _h, r) => json(r, 500, { code: 2, message: 'transaction indexing is disabled' }),
  }
  await assert.rejects(send(s), unconfirmed)
  assert.equal(s.lookups, 1)
})
