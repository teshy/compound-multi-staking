// findAvailableUrl picks by PRIORITY ORDER (first healthy), not by race: the operator's own
// indexing node must win over a faster-answering backup without tx indexing (WO-040 follow-on).
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import axios from 'axios'
import QueryClient from '../src/utils/QueryClient.mjs'

const CHAIN = 'realionetwork_3301-1'
const LOCAL = 'http://203.0.113.7:1317' // 203.0.113.0/24 is the documentation range (RFC 5737)
const BACKUP = 'https://api.example.org'
const realGet = axios.get
afterEach(() => {
  axios.get = realGet
})

// A fresh block unless told otherwise: findAvailableUrl also skips a node whose latest block is
// older than maxBlockAgeMs (120 s) — syncing or halted (docs/06 audit 2026-10-08).
const block = (chainId, time = new Date().toISOString()) => ({
  data: { block: { header: { chain_id: chainId, time } } },
})
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// behaviour: { [baseUrl]: { ms, fail, chainId, time } }
function stub(behaviour) {
  const hits = []
  axios.get = async (url) => {
    const base = Object.keys(behaviour).find((b) => url.startsWith(b))
    hits.push(base)
    const b = behaviour[base]
    await delay(b.ms || 0)
    if (b.fail) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    return block(b.chainId || CHAIN, 'time' in b ? b.time : undefined)
  }
  return hits
}

test('the first URL wins when healthy, even if a backup answers faster', async () => {
  stub({ [LOCAL]: { ms: 40 }, [BACKUP]: { ms: 0 } })
  const qc = await QueryClient(CHAIN, [LOCAL, BACKUP], { connectTimeout: 1000 })
  assert.equal(qc.restUrl, LOCAL)
  assert.equal(qc.connected, true)
})

test('falls back to the next URL when the first is down', async () => {
  const hits = stub({ [LOCAL]: { fail: true }, [BACKUP]: {} })
  const qc = await QueryClient(CHAIN, [LOCAL, BACKUP], { connectTimeout: 1000 })
  assert.equal(qc.restUrl, BACKUP)
  assert.deepEqual(hits, [LOCAL, BACKUP])
})

test('a URL serving the wrong chain is skipped, never chosen', async () => {
  stub({ [LOCAL]: { chainId: 'some-other-chain' }, [BACKUP]: {} })
  const qc = await QueryClient(CHAIN, [LOCAL, BACKUP], { connectTimeout: 1000 })
  assert.equal(qc.restUrl, BACKUP)
})

const STALE = new Date(Date.now() - 10 * 60 * 1000).toISOString() // 10 min old

test('a reachable but STALE local node (catching up or halted) is skipped for the backup', async () => {
  const hits = stub({ [LOCAL]: { time: STALE }, [BACKUP]: {} })
  const qc = await QueryClient(CHAIN, [LOCAL, BACKUP], { connectTimeout: 1000 })
  assert.equal(qc.restUrl, BACKUP)
  assert.deepEqual(hits, [LOCAL, BACKUP])
})

test('a block with no time at all counts as stale (fail closed)', async () => {
  stub({ [LOCAL]: { time: null }, [BACKUP]: {} })
  const qc = await QueryClient(CHAIN, [LOCAL, BACKUP], { connectTimeout: 1000 })
  assert.equal(qc.restUrl, BACKUP)
})

test('when every endpoint is stale (e.g. the chain halted) it rejects instead of serving old state', async () => {
  stub({ [LOCAL]: { time: STALE }, [BACKUP]: { time: STALE } })
  await assert.rejects(QueryClient(CHAIN, [LOCAL, BACKUP], { connectTimeout: 1000 }), (e) => {
    assert.ok(e instanceof AggregateError)
    assert.match(e.errors.map((x) => x.message).join(' | '), /stale endpoint/)
    return true
  })
})

test('rejects (never resolves undefined) when every URL fails', async () => {
  stub({ [LOCAL]: { fail: true }, [BACKUP]: { fail: true } })
  await assert.rejects(QueryClient(CHAIN, [LOCAL, BACKUP], { connectTimeout: 1000 }))
})

// WO-061 review (Expert): NetworkRunner passes { timeout } to getWithdrawAddress, which used to
// drop it, so the restake withdraw-address query had no timeout (same class as C-3).
test('getWithdrawAddress forwards its opts (the timeout) to the HTTP get', async () => {
  let seen
  axios.get = async (url, opts) => {
    if (url.includes('/blocks/latest')) return block(CHAIN)
    assert.match(url, /\/cosmos\/distribution\/v1beta1\/delegators\/realio1d\/withdraw_address$/)
    seen = opts
    return { data: { withdraw_address: 'realio1w' } }
  }
  const qc = await QueryClient(CHAIN, [LOCAL], { connectTimeout: 1000 })
  assert.equal(await qc.getWithdrawAddress('realio1d', { timeout: 4321 }), 'realio1w')
  assert.equal(seen?.timeout, 4321)
})

test('getValidator returns the validator record from staking/validators/{addr}', async () => {
  axios.get = async (url) => {
    if (url.includes('/blocks/latest')) return block(CHAIN)
    assert.match(url, /\/cosmos\/staking\/v1beta1\/validators\/realiovaloper1x$/)
    return {
      data: {
        validator: {
          operator_address: 'realiovaloper1x',
          status: 'BOND_STATUS_BONDED',
          jailed: false,
        },
      },
    }
  }
  const qc = await QueryClient(CHAIN, [LOCAL], { connectTimeout: 1000 })
  const v = await qc.getValidator('realiovaloper1x')
  assert.equal(v.status, 'BOND_STATUS_BONDED')
})
