// WO-072 D1 (docs/06 gate 2026-10-16, B-4): axios `timeout` is an IDLE timer, so a server that trickles
// one byte every 200 ms keeps a request open for as long as it likes. Helpers.get/post now also pass
// `signal: AbortSignal.timeout(t)` (a caller's own signal wins), which is a hard deadline. Tested with the
// REAL axios against a localhost slow-drip stub — nothing is mocked. A guard timer turns "never
// rejects" into a fast failure instead of a hung suite.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import SigningClient from '../src/utils/SigningClient.mjs'
import { TxUnconfirmedError } from '../src/utils/TxConfirm.mjs'
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

let server, base
const drips = new Set()
before(async () => {
  server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.url.startsWith('/cosmos/auth/v1beta1/accounts/')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ account: ethAccount('realio1a') }))
      }
      // everything else: answer 200 and then drip one byte every 200 ms, forever
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write(' ')
      const t = setInterval(() => res.write(' '), 200)
      drips.add(t)
      res.on('close', () => {
        clearInterval(t)
        drips.delete(t)
      })
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(
  () =>
    new Promise((r) => {
      for (const t of drips) clearInterval(t)
      server.closeAllConnections()
      server.close(r)
    }),
)

// Resolves with how the promise ended and how long it took; gives up after `guardMs` (the old behaviour).
async function timed(p, guardMs = 4000) {
  const t0 = Date.now()
  let timer
  const guard = new Promise((r) => {
    timer = setTimeout(() => r({ outcome: 'still pending', ms: Date.now() - t0 }), guardMs)
  })
  const done = p.then(
    (v) => ({ outcome: 'resolved', ms: Date.now() - t0, v }),
    (e) => ({ outcome: 'rejected', ms: Date.now() - t0, e }),
  )
  const r = await Promise.race([done, guard])
  clearTimeout(timer)
  return r
}

test('B-4: with no timeout given the default 30 s deadline is installed (a fast answer is unaffected)', async () => {
  const res = await get(base + '/cosmos/auth/v1beta1/accounts/realio1a')
  assert.equal(res.status, 200)
})

// The slow-drip cases run side by side (each waits out a 1 s deadline), so the file costs ~1 s, not ~4 s.
describe('B-4: hard deadline against a slow-drip server', { concurrency: true }, () => {
  test('B-4: a slow-drip server through the REAL get({ timeout: 1000 }) rejects in under 2 s', async () => {
    const r = await timed(get(base + '/slow', { timeout: 1000 }))
    assert.equal(r.outcome, 'rejected', `the request ended as: ${r.outcome} after ${r.ms} ms`)
    assert.ok(r.ms < 2000, `${r.ms} ms`)
  })

  test('B-4: the same through post({ timeout: 1000 })', async () => {
    const r = await timed(post(base + '/slow', {}, { timeout: 1000 }))
    assert.equal(r.outcome, 'rejected', `the request ended as: ${r.outcome} after ${r.ms} ms`)
    assert.ok(r.ms < 2000, `${r.ms} ms`)
  })

  test("B-4: a caller's own signal wins over the timeout deadline", async () => {
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 300)
    const r = await timed(get(base + '/slow', { timeout: 60_000, signal: ctl.signal }))
    assert.equal(r.outcome, 'rejected')
    assert.ok(r.ms < 1500, `${r.ms} ms: aborted by the caller's signal, not the 60 s deadline`)
  })

  test('B-4: a slow-drip BROADCAST POST through SigningClient throws TxUnconfirmedError in under 2 s', async () => {
    const client = SigningClient(
      {
        restUrl: base,
        gasPrice: '1000000000ario',
        gasModifier: 1.5,
        slip44: 60,
        chainId: 'realionetwork_3301-1',
        txTimeout: 1000,
        txBroadcastTimeout: 1000,
      },
      signer,
    )
    const r = await timed(client.signAndBroadcast('realio1a', [MSG], 100000, 'm'))
    assert.equal(r.outcome, 'rejected', `the broadcast ended as: ${r.outcome} after ${r.ms} ms`)
    assert.ok(r.e instanceof TxUnconfirmedError, String(r.e))
    assert.ok(r.ms < 2000, `${r.ms} ms`)
  })
})

// ---- WO-075 D4 (delta gate 2026-10-19): the deadline always holds ----
describe(
  'BT-4: a timeout that is not a positive safe integer of at most 2^31-1 falls back to the 30 s default',
  { concurrency: true },
  () => {
    // /cosmos/auth/... answers at once, so a request that is NOT aborted resolves 200; the old code aborted a
    // 0 timeout immediately and threw on a string or a float before sending anything.
    for (const [label, timeout] of [
      ['0', 0],
      ['a string', '5'],
      ['a float', 1.5],
      ['NaN', NaN],
      ['a negative', -1],
      ['Infinity', Infinity],
      ['null', null],
      ['over the 2^31-1 timer limit', 2_147_483_648],
      ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
    ]) {
      test(`BT-4: get with timeout ${label} is answered normally, not aborted or thrown`, async () => {
        const res = await get(base + '/cosmos/auth/v1beta1/accounts/realio1a', { timeout })
        assert.equal(res.status, 200)
      })
      test(`BT-4: post with timeout ${label} is sent normally`, async () => {
        const res = await post(base + '/cosmos/auth/v1beta1/accounts/realio1a', {}, { timeout })
        assert.equal(res.status, 200)
      })
    }

    test('BT-4: the axios timeout that is sent is the normalised one (a 0 does not become "no timeout")', async () => {
      let seen
      const axios = (await import('axios')).default
      const real = axios.get
      axios.get = async (_url, o) => {
        seen = o
        return { status: 200 }
      }
      try {
        await get('http://x.invalid/a', { timeout: 0 })
        assert.equal(seen.timeout, 30_000)
        await get('http://x.invalid/a', { timeout: 750 })
        assert.equal(seen.timeout, 750)
        // WO-077 D9 (BR-7): a timer longer than 2^31-1 ms overflows and fires at once, so it falls back too;
        // the limit itself is a valid value.
        await get('http://x.invalid/a', { timeout: 2_147_483_647 })
        assert.equal(seen.timeout, 2_147_483_647)
        await get('http://x.invalid/a', { timeout: 2_147_483_648 })
        assert.equal(seen.timeout, 30_000)
      } finally {
        axios.get = real
      }
    })
  },
)

describe(
  "BT-5: a caller's own signal does not disable the hard deadline",
  { concurrency: true },
  () => {
    test('BT-5: a signal that never aborts + timeout 1000 against a slow-drip server rejects in under 2 s with the timeout wording', async () => {
      const r = await timed(
        get(base + '/slow', { timeout: 1000, signal: new AbortController().signal }),
      )
      assert.equal(r.outcome, 'rejected', `the request ended as: ${r.outcome} after ${r.ms} ms`)
      assert.ok(r.ms < 2000, `${r.ms} ms`)
      assert.equal(r.e.code, 'ECONNABORTED')
      assert.match(r.e.message, /timeout of 1000ms exceeded/)
    })

    test('BT-5: the same through post', async () => {
      const r = await timed(
        post(base + '/slow', {}, { timeout: 1000, signal: new AbortController().signal }),
      )
      assert.equal(r.outcome, 'rejected', `the request ended as: ${r.outcome} after ${r.ms} ms`)
      assert.match(r.e.message, /timeout of 1000ms exceeded/)
    })

    test("BT-5: the CALLER aborting first stays the caller's cancellation (not translated to a timeout error)", async () => {
      const ctl = new AbortController()
      setTimeout(() => ctl.abort(), 200)
      const r = await timed(get(base + '/slow', { timeout: 60_000, signal: ctl.signal }))
      assert.equal(r.outcome, 'rejected')
      assert.ok(r.ms < 1500, `${r.ms} ms`)
      assert.notEqual(r.e.code, 'ECONNABORTED')
      assert.doesNotMatch(r.e.message, /timeout of/)
    })

    test("BT-5: an already-aborted caller signal rejects at once, as the caller's cancellation", async () => {
      const ctl = new AbortController()
      ctl.abort()
      const r = await timed(
        get(base + '/cosmos/auth/v1beta1/accounts/realio1a', { timeout: 5000, signal: ctl.signal }),
      )
      assert.equal(r.outcome, 'rejected')
      assert.doesNotMatch(r.e.message, /timeout of/)
    })
  },
)
