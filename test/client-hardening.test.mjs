// WO-064 (Security S-12/S-32, S-31, S-30): the bot's REST client hardening.
//   D1 request timeouts on SigningClient's account read and simulate POST, and a defensive default on
//      Helpers.get/post;
//   D2 a malformed gas_used is an error, never a silent 200000-gas fee;
//   D3 getAllPages has a page cap and a repeated-key guard.
// Timeouts are tested with the REAL axios against a localhost node that accepts and never answers (small
// timeouts through the network config hook — nothing sleeps 20 s). The mnemonic-free fake signer holds nothing.
import { test, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import axios from 'axios'
import SigningClient from '../src/utils/SigningClient.mjs'
import QueryClient from '../src/utils/QueryClient.mjs'
import { get, post } from '../src/utils/Helpers.mjs'
import { ethAccount } from './helpers/chain-fixtures.mjs'

const MSG = {
  typeUrl: '/cosmos.staking.v1beta1.MsgDelegate',
  value: {
    delegatorAddress: 'realio1a',
    validatorAddress: 'realiovaloper1b',
    amount: { denom: 'ario', amount: '1' },
  },
}
const signer = {
  getAccounts: async () => [{ pubkey: new Uint8Array(33).fill(2) }],
  signDirect: async (_a, doc) => ({
    signed: doc,
    signature: { signature: Buffer.from([1, 2]).toString('base64') },
  }),
}

let server, base, behaviour, seen
before(async () => {
  server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`)
      const json = (body) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.url.startsWith('/cosmos/auth/v1beta1/accounts/')) {
        if (behaviour.hangAccount) return // accept, never answer
        return json({ account: ethAccount('realio1a') })
      }
      if (req.url === '/cosmos/tx/v1beta1/simulate') {
        if (behaviour.hangSimulate) return
        if (behaviour.noGasInfo) return json({})
        return json({
          gas_info: { gas_used: 'gasUsed' in behaviour ? behaviour.gasUsed : '100000' },
        })
      }
      if (req.url === '/cosmos/tx/v1beta1/txs') {
        seen.push('BROADCAST')
        return json({ tx_response: { code: 0, txhash: 'X', raw_log: '' } })
      }
      res.writeHead(404)
      res.end('{}')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(
  () =>
    new Promise((r) => {
      server.closeAllConnections()
      server.close(r)
    }),
)
afterEach(() => {
  behaviour = {}
  seen = []
})
behaviour = {}
seen = []

const network = (extra = {}) => ({
  restUrl: base,
  gasPrice: '1000000000ario',
  gasModifier: 1.5,
  slip44: 60,
  chainId: 'realionetwork_3301-1',
  ...extra,
})
const client = (extra) => SigningClient(network(extra), signer)

// ---- D1: timeouts ----
test('S-12: a hung ACCOUNT read rejects within accountTimeout (before anything is signed)', async () => {
  behaviour = { hangAccount: true }
  const t0 = Date.now()
  await assert.rejects(
    client({ accountTimeout: 150 }).simulate('realio1a', [MSG], 'm'),
    /timeout of 150ms exceeded/,
  )
  assert.ok(Date.now() - t0 < 3000)
  assert.ok(!seen.includes('BROADCAST'))
})

test('S-12: a hung SIMULATE POST rejects within simulateTimeout', async () => {
  behaviour = { hangSimulate: true }
  const t0 = Date.now()
  await assert.rejects(
    client({ simulateTimeout: 150 }).simulate('realio1a', [MSG], 'm'),
    /timeout of 150ms exceeded/,
  )
  assert.ok(Date.now() - t0 < 3000)
})

test('S-12: signAndBroadcast with a hung account read rejects and never broadcasts', async () => {
  behaviour = { hangAccount: true }
  await assert.rejects(
    client({ accountTimeout: 150 }).signAndBroadcast('realio1a', [MSG], 100000, 'm'),
    /timeout of 150ms exceeded/,
  )
  assert.ok(!seen.includes('BROADCAST'))
})

test('S-12: a timeout is a plain error, NOT an unconfirmed-tx error (nothing was signed or sent)', async () => {
  behaviour = { hangSimulate: true }
  try {
    await client({ simulateTimeout: 100 }).simulate('realio1a', [MSG], 'm')
    assert.fail('expected a rejection')
  } catch (e) {
    assert.notEqual(e.unconfirmed, true)
    assert.notEqual(e.name, 'TxUnconfirmedError')
  }
})

test('S-12: without config the literals are 10 s (account) and 20 s (simulate) — read from the source, not slept', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/utils/SigningClient.mjs', import.meta.url), 'utf8')
  assert.match(src, /network\.accountTimeout \|\| 10_?000/)
  assert.match(src, /network\.simulateTimeout \|\| 20_?000/)
})

test('S-32: Helpers.get / post default to a 30 s timeout when the caller passes none; an explicit one wins', async () => {
  const realGet = axios.get,
    realPost = axios.post
  const seenCfg = []
  axios.get = async (_u, cfg) => {
    seenCfg.push(['get', cfg.timeout])
    return { data: {} }
  }
  axios.post = async (_u, _b, cfg) => {
    seenCfg.push(['post', cfg.timeout])
    return { data: {} }
  }
  try {
    await get('http://x/a')
    await post('http://x/b', {})
    await get('http://x/c', { timeout: 5 })
    await post('http://x/d', {}, { timeout: 7 })
    await get('http://x/e', { headers: { A: 'b' } })
  } finally {
    axios.get = realGet
    axios.post = realPost
  }
  assert.deepEqual(seenCfg, [
    ['get', 30000],
    ['post', 30000],
    ['get', 5],
    ['post', 7],
    ['get', 30000],
  ])
})

// ---- D2: gas ----
for (const bad of ['', 'abc', '0', '-5', '1.5', '1e6', ' 12', '012', 'NaN', 'Infinity']) {
  test(`S-31: simulate rejects gas_used=${JSON.stringify(bad)} ("simulate returned no usable gas_used")`, async () => {
    behaviour = { gasUsed: bad }
    await assert.rejects(
      client().simulate('realio1a', [MSG], 'm'),
      /simulate returned no usable gas_used/,
    )
  })
}

test('S-31: a null gas_used and a missing gas_info are rejected the same way', async () => {
  behaviour = { gasUsed: null }
  await assert.rejects(
    client().simulate('realio1a', [MSG], 'm'),
    /simulate returned no usable gas_used/,
  )
  behaviour = { noGasInfo: true }
  await assert.rejects(
    client().simulate('realio1a', [MSG], 'm'),
    /simulate returned no usable gas_used/,
  )
})

test('S-31: a good gas_used is scaled by the modifier and truncated (unchanged behaviour)', async () => {
  behaviour = { gasUsed: '100001' }
  assert.equal(await client().simulate('realio1a', [MSG], 'm', 1.5), 150001)
  assert.equal(await client().simulate('realio1a', [MSG], 'm'), 150001) // the network gasModifier
})

test('S-31: signAndBroadcast with NO gas uses the simulate path, and a bad gas_used stops it before any broadcast', async () => {
  behaviour = { gasUsed: 'abc' }
  await assert.rejects(
    client().signAndBroadcast('realio1a', [MSG], undefined, 'm'),
    /simulate returned no usable gas_used/,
  )
  assert.ok(!seen.includes('BROADCAST'))
})

test('S-31: getFee throws for a non-positive or non-finite gas instead of defaulting to 200000', () => {
  const c = client()
  for (const bad of [0, -1, NaN, Infinity, -Infinity, undefined, null, '', 'abc']) {
    assert.throws(() => c.getFee(bad), /gas/, String(bad))
  }
  assert.equal(c.getFee(200000).gas, '200000')
  assert.equal(c.getFee(1).amount[0].amount, '1000000000')
})

test('S-31: signAndBroadcast with a negative or non-numeric gas throws before any request', async () => {
  for (const bad of [-5, 'abc', Infinity]) {
    await assert.rejects(client().signAndBroadcast('realio1a', [MSG], bad, 'm'), /gas/, String(bad))
  }
  assert.deepEqual(seen, [])
})

// ---- D3: pagination ----
const CHAIN = 'realionetwork_3301-1'
const realGet = axios.get
afterEach(() => {
  axios.get = realGet
})
const blockReply = {
  data: { block: { header: { chain_id: CHAIN, time: new Date().toISOString() } } },
}

async function grantsClient(pageFor) {
  const keys = []
  axios.get = async (url) => {
    if (url.includes('/blocks/latest')) return blockReply
    const key = new URL(url).searchParams.get('pagination.key')
    keys.push(key)
    return { data: pageFor(keys.length, key) }
  }
  const qc = await QueryClient(CHAIN, ['http://stub.invalid'], { connectTimeout: 1000 })
  return { qc, keys }
}

test('S-30: a normal 3-page result is flattened in order', async () => {
  const { qc } = await grantsClient((n) => ({
    grants: [{ granter: `g${n}` }],
    pagination: { next_key: n < 3 ? `k${n}` : null },
  }))
  assert.deepEqual(
    (await qc.getGranteeGrants('bot', {})).map((g) => g.granter),
    ['g1', 'g2', 'g3'],
  )
})

test('S-30: an endless run of distinct keys rejects "pagination exceeded maxPages" at opts.maxPages', async () => {
  const { qc, keys } = await grantsClient((n) => ({
    grants: [],
    pagination: { next_key: `k${n}` },
  }))
  await assert.rejects(qc.getGranteeGrants('bot', { maxPages: 5 }), /pagination exceeded maxPages/)
  assert.equal(keys.length, 5)
})

test('S-30: a next_key that REPEATS rejects "pagination repeated next_key" (after the repeat is seen)', async () => {
  const { qc, keys } = await grantsClient((n) => ({
    grants: [],
    pagination: { next_key: n === 1 ? 'a' : 'a' },
  }))
  await assert.rejects(qc.getGranteeGrants('bot', {}), /pagination repeated next_key/)
  assert.ok(keys.length <= 3)
})

test('S-30: the default cap is 1000 pages: 1000 pages are fine, a 1001st is rejected', async () => {
  const ok = await grantsClient((n) => ({
    grants: [{ granter: 'g' }],
    pagination: { next_key: n < 1000 ? `k${n}` : null },
  }))
  assert.equal((await ok.qc.getGranteeGrants('bot', {})).length, 1000)
  const over = await grantsClient((n) => ({
    grants: [],
    pagination: { next_key: n < 1001 ? `k${n}` : null },
  }))
  await assert.rejects(over.qc.getGranteeGrants('bot', {}), /pagination exceeded maxPages/)
})

test('S-30: every paginated query shares the guard (validators here)', async () => {
  const { qc } = await grantsClient((n) => ({ validators: [], pagination: { next_key: `k${n}` } }))
  await assert.rejects(qc.getAllValidators(10, { maxPages: 3 }), /pagination exceeded maxPages/)
})
