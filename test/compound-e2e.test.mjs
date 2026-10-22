// End to end: the REAL scripts/compound.mjs, run as a child process (the way the timer runs it)
// against a stub REST node on 127.0.0.1 — no network, no real chain. It proves the safety rules on the
// actual fund-moving path, by counting broadcasts:
//   - an unknown outcome (proxy 5xx, empty reply, sdk code 19, lookup never finds it) is sent ONCE
//     and never retried;
//   - a bot-account sequence mismatch aborts the run (no per-delegator fallback);
//   - a DEFINITIVE failure (DeliverTx code != 0) still falls back per delegator — the control that
//     shows this instrument does count retries when they happen;
//   - a stale endpoint stops the run before anything is signed;
//   - what is SIGNED is decoded from the posted tx_bytes: per delegator the inner messages
//     are exactly [MsgWithdrawDelegatorReward(delegator, DEST), MsgDelegate(delegator -> DEST, amount)],
//     with the gas-reserve cap, the MIN_REWARD gates and the fail-closed balance path pinned on the
//     amount; malformed run-bound env vars exit 1 before the wallet is loaded.
// The mnemonic is the public BIP39 test vector — it holds nothing.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fromBase64 } from '@cosmjs/encoding'
import { TxRaw, TxBody } from 'cosmjs-types/cosmos/tx/v1beta1/tx.js'
import { MsgExec } from 'cosmjs-types/cosmos/authz/v1beta1/tx.js'
import { MsgDelegate } from 'cosmjs-types/cosmos/staking/v1beta1/tx.js'
import { MsgWithdrawDelegatorReward } from 'cosmjs-types/cosmos/distribution/v1beta1/tx.js'
import { txHashOf } from '../src/utils/TxConfirm.mjs'
import { TEST_MNEMONIC as MNEMONIC, realioNetwork, ethAccount } from './helpers/chain-fixtures.mjs'
import { account, valoper } from './helpers/addresses.mjs'

const BOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(BOT_DIR, 'scripts', 'compound.mjs')
const CHAIN = 'realionetwork_3301-1'
const DEST = valoper(1)
const DELEGATORS = [account(1), account(2)]
const WITHDRAW = '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward'

let server, port, scenario, posts, txBytes, sims, gets
before(async () => {
  server = http.createServer((req, res) =>
    handle(req, res).catch((e) =>
      reply(res, { status: 500, body: { code: 2, message: String(e) } }),
    ),
  )
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  port = server.address().port
})
after(() => new Promise((r) => server.close(r)))

function reply(res, { status = 200, body }) {
  const html = typeof body === 'string'
  res.writeHead(status, { 'content-type': html ? 'text/html' : 'application/json' })
  res.end(html ? body : JSON.stringify(body))
}

const ok = (body) => ({ status: 200, body })
const admitted = (hash) =>
  ok({ tx_response: { code: 0, codespace: '', txhash: hash, raw_log: '' } })
const found =
  (code, rawLog = '') =>
  (hash) =>
    ok({
      tx_response: {
        code,
        codespace: code ? 'sdk' : '',
        txhash: hash,
        height: '101',
        raw_log: rawLog,
      },
    })
const notFound = () => ({ status: 404, body: { code: 5, message: 'tx not found' } })

// Per-scenario knob: a constant, or a function of the delegator address, else the default.
const knob = (v, delegator, dflt) => (typeof v === 'function' ? v(delegator) : (v ?? dflt))

// Two delegators, both fully granted to DEST, 5 RIO pending + 10 RIO liquid each -> one batch.
// scenario.reward / scenario.liquid override those per scenario (string or fn(delegator));
// scenario.balance() replaces the whole balance reply (e.g. a 500).
async function handle(req, res) {
  const p = new URL(req.url, 'http://stub').pathname
  if (req.method === 'GET') {
    gets++
    if (p === '/cosmos/base/tendermint/v1beta1/blocks/latest') {
      return reply(
        res,
        ok({
          block: {
            header: {
              chain_id: CHAIN,
              height: '100',
              time: scenario.blockTime ?? new Date().toISOString(),
            },
          },
        }),
      )
    }
    if (p.startsWith('/cosmos/authz/v1beta1/grants/grantee/')) {
      return reply(
        res,
        ok({
          grants: DELEGATORS.flatMap((granter) => [
            {
              granter,
              authorization: {
                '@type': '/cosmos.authz.v1beta1.GenericAuthorization',
                msg: WITHDRAW,
              },
              expiration: null,
            },
            {
              granter,
              authorization: {
                '@type': '/cosmos.staking.v1beta1.StakeAuthorization',
                authorization_type: 'AUTHORIZATION_TYPE_DELEGATE',
                allow_list: { address: [DEST] },
              },
              expiration: null,
            },
          ]),
          pagination: { next_key: null },
        }),
      )
    }
    if (p === `/cosmos/staking/v1beta1/validators/${DEST}`)
      return reply(
        res,
        ok({ validator: { operator_address: DEST, status: 'BOND_STATUS_BONDED', jailed: false } }),
      )
    if (/^\/cosmos\/distribution\/v1beta1\/delegators\/[^/]+\/rewards$/.test(p)) {
      const delegator = p.split('/')[5]
      const amount = knob(scenario.reward, delegator, '5000000000000000000.000000000000000000')
      return reply(
        res,
        ok({
          rewards: [{ validator_address: DEST, reward: [{ denom: 'ario', amount }] }],
          total: [],
        }),
      )
    }
    if (/^\/cosmos\/distribution\/v1beta1\/delegators\/[^/]+\/withdraw_address$/.test(p)) {
      const delegator = p.split('/')[5]
      // WO-063 D1: scenario.withdraw(delegator) -> a reply object, or a string address; default = the delegator itself
      const w = scenario.withdraw ? scenario.withdraw(delegator) : delegator
      return reply(res, typeof w === 'string' ? ok({ withdraw_address: w }) : w)
    }
    if (p.startsWith('/cosmos/bank/v1beta1/balances/')) {
      if (scenario.balance) return reply(res, scenario.balance())
      const amount = knob(scenario.liquid, p.split('/').pop(), '10000000000000000000')
      return reply(res, ok({ balances: [{ denom: 'ario', amount }] }))
    }
    if (p.startsWith('/cosmos/auth/v1beta1/accounts/')) {
      if (scenario.accountHang?.()) return // WO-064: accept and never answer
      return reply(res, ok({ account: ethAccount(p.split('/').pop(), '3') }))
    }
    if (p.startsWith('/cosmos/tx/v1beta1/txs/'))
      return reply(res, (scenario.lookup ?? found(0))(p.split('/').pop()))
  }
  if (req.method === 'POST') {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    if (p === '/cosmos/tx/v1beta1/simulate') sims++
    if (p === '/cosmos/tx/v1beta1/simulate') {
      const r = (scenario.simulate ?? (() => ok({ gas_info: { gas_used: '100000' } })))()
      if (r.hang) return // WO-064: accept and never answer
      return reply(res, r)
    }
    if (p === '/cosmos/tx/v1beta1/txs') {
      const hash = txHashOf(fromBase64(body.tx_bytes))
      posts.push(hash)
      txBytes.push(body.tx_bytes)
      return reply(res, scenario.broadcast(hash, posts.length))
    }
  }
  reply(res, { status: 501, body: { code: 12, message: `unstubbed ${req.method} ${p}` } })
}

// Runs the real script in a scratch cwd whose src/networks.local.json points at the stub.
function runBot(s, extraEnv = {}) {
  scenario = s
  posts = []
  txBytes = []
  sims = 0
  gets = 0
  const cwd = mkdtempSync(join(tmpdir(), 'mc-e2e-'))
  mkdirSync(join(cwd, 'src'))
  copyFileSync(join(BOT_DIR, 'src', 'networks.json'), join(cwd, 'src', 'networks.json'))
  writeFileSync(
    join(cwd, 'src', 'networks.local.json'),
    JSON.stringify({
      realio: realioNetwork({
        restUrl: [`http://127.0.0.1:${port}`],
        txTimeout: 300,
        txPollIntervalMs: 5,
        operators: [],
        ...(s.networkConfig || {}),
      }),
    }),
  )
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: cwd,
        MNEMONIC,
        DRY_RUN: 'false',
        COMPOUND_TEST_SEAMS: '1',
        ...extraEnv,
      },
    })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      out += d
    })
    child.on('close', (code) =>
      resolve({ code, out, posts: [...posts], txBytes: [...txBytes], sims, gets }),
    )
  })
}

// Decode a posted batch: TxRaw -> TxBody -> the single MsgExec -> each inner Any, to plain objects.
function decodeBatch(b64) {
  const body = TxBody.decode(TxRaw.decode(fromBase64(b64)).bodyBytes)
  assert.equal(body.messages.length, 1)
  assert.equal(body.messages[0].typeUrl, '/cosmos.authz.v1beta1.MsgExec')
  return MsgExec.decode(body.messages[0].value).msgs.map((any) => {
    if (any.typeUrl === WITHDRAW) {
      const m = MsgWithdrawDelegatorReward.decode(any.value)
      return { type: 'withdraw', delegator: m.delegatorAddress, validator: m.validatorAddress }
    }
    if (any.typeUrl === '/cosmos.staking.v1beta1.MsgDelegate') {
      const m = MsgDelegate.decode(any.value)
      return {
        type: 'delegate',
        delegator: m.delegatorAddress,
        validator: m.validatorAddress,
        amount: m.amount.amount,
        denom: m.amount.denom,
      }
    }
    return { type: any.typeUrl }
  })
}
// The messages signed for one delegator, in order, across every posted tx.
const innerFor = (r, delegator) =>
  r.txBytes.flatMap(decodeBatch).filter((m) => m.delegator === delegator)
const expectedInner = (delegator, amount) => [
  { type: 'withdraw', delegator, validator: DEST },
  { type: 'delegate', delegator, validator: DEST, amount, denom: 'ario' },
]

const summary = (out) =>
  out
    .match(/Done\. attempted=\d+ succeeded=(\d+) skipped=\d+ failed=(\d+) unconfirmed=(\d+)/)
    ?.slice(1)
    .map(Number)

test('control: a clean run sends one batch, confirms it, exits 0', async () => {
  const r = await runBot({ broadcast: admitted })
  assert.equal(r.posts.length, 1, r.out)
  assert.deepEqual(summary(r.out), [2, 0, 0])
  assert.equal(r.code, 0)
  // what was actually signed: 5 RIO pending, 10 RIO liquid -> the full 5 RIO to DEST, per delegator
  for (const d of DELEGATORS)
    assert.deepEqual(innerFor(r, d), expectedInner(d, '5000000000000000000'), r.out)
  assert.equal(decodeBatch(r.txBytes[0]).length, 4) // 2 delegators x [withdraw, delegate], nothing else
})

test('control: a DEFINITIVE batch failure (DeliverTx code 5) still falls back to one tx per delegator', async () => {
  let batchHash
  const r = await runBot({
    broadcast: (hash, n) => {
      if (n === 1) batchHash = hash
      return admitted(hash)
    },
    lookup: (hash) => (hash === batchHash ? found(5, 'insufficient funds') : found(0))(hash),
  })
  assert.equal(r.posts.length, 3, r.out) // batch + 2 individual
  assert.match(r.out, /retrying 2 delegators individually/)
  assert.deepEqual(summary(r.out), [2, 0, 0])
})

// ---- WO-058 D2: a definite failure is a THROWN TxFailedError and has its own FAIL lines ----
// (Before: the batch catch printed the generic `ERROR Error when broadcasting tx … Code: 5; Raw log: …`;
// the `FAIL code N` branch below it was unreachable because signAndBroadcast no longer resolves a
// non-zero code.)

test('WO-058: a DeliverTx failure of the batch prints "FAIL code 5: <rawLog>" (not the generic ERROR) and retries individually', async () => {
  let batchHash
  const r = await runBot({
    broadcast: (hash, n) => {
      if (n === 1) batchHash = hash
      return admitted(hash)
    },
    lookup: (hash) => (hash === batchHash ? found(5, 'insufficient funds') : found(0))(hash),
  })
  assert.match(r.out, /\[batch→\w+ ×2\] FAIL code 5: insufficient funds/, r.out)
  assert.doesNotMatch(r.out, /\] ERROR /, r.out)
  assert.match(r.out, /retrying 2 delegators individually so one bad grant can't starve the batch/)
  assert.equal(r.posts.length, 3, r.out)
  assert.deepEqual(summary(r.out), [2, 0, 0])
  assert.equal(r.code, 0)
})

test('WO-058: a CheckTx rejection (code 5, not a sequence clash) of the batch is the same FAIL line + individual retry', async () => {
  const r = await runBot({
    broadcast: (hash, n) =>
      n === 1
        ? ok({
            tx_response: { code: 5, codespace: 'sdk', txhash: hash, raw_log: 'insufficient fee' },
          })
        : admitted(hash),
  })
  assert.match(r.out, /\[batch→\w+ ×2\] FAIL code 5: insufficient fee/, r.out)
  assert.match(r.out, /retrying 2 delegators individually so one bad grant can't starve the batch/)
  assert.equal(r.posts.length, 3, r.out)
  assert.deepEqual(summary(r.out), [2, 0, 0])
})

test('WO-058: an individual retry that fails DeliverTx prints "FAIL (retry) code N" and counts failed; the other still goes', async () => {
  const bad = new Set()
  const r = await runBot({
    broadcast: (hash, n) => {
      if (n <= 2) bad.add(hash)
      return admitted(hash)
    }, // batch + the FIRST retry will fail
    lookup: (hash) => (bad.has(hash) ? found(5, 'delegation failed') : found(0))(hash),
  })
  assert.equal(r.posts.length, 3, r.out)
  assert.match(
    r.out,
    /\[batch→\w+ ×2\] \[realio1\w+\] FAIL \(retry\) code 5: delegation failed/,
    r.out,
  )
  assert.match(r.out, /\] OK \(retry\) /)
  assert.deepEqual(summary(r.out), [1, 1, 0])
  assert.equal(r.code, 1)
})

test('WO-058: a sequence-mismatch CheckTx rejection is STILL an abort, not a FAIL + retry (the order of the branches matters)', async () => {
  const r = await runBot({
    broadcast: (hash) =>
      ok({
        tx_response: {
          code: 32,
          codespace: 'sdk',
          txhash: hash,
          raw_log: 'account sequence mismatch, expected 4, got 3: incorrect account sequence',
        },
      }),
  })
  assert.equal(r.posts.length, 1, r.out)
  assert.match(r.out, /ABORT — /)
  assert.doesNotMatch(r.out, /FAIL code 32/)
  assert.doesNotMatch(r.out, /retrying \d+ delegators individually/)
  assert.equal(r.code, 3)
})

// ---- WO-058 D4: ONLY_DELEGATOR (the replacement for the deleted single-delegator one-shot) ----

test("WO-058 ONLY_DELEGATOR=<B>: only B's messages are signed, the log says 2 of 4 grants kept, every other gate still applies", async () => {
  const r = await runBot({ broadcast: admitted }, { ONLY_DELEGATOR: DELEGATORS[1] })
  assert.equal(r.posts.length, 1, r.out)
  assert.deepEqual(
    innerFor(r, DELEGATORS[1]),
    expectedInner(DELEGATORS[1], '5000000000000000000'),
    r.out,
  )
  assert.deepEqual(innerFor(r, DELEGATORS[0]), [], r.out)
  assert.equal(decodeBatch(r.txBytes[0]).length, 2) // [withdraw, delegate] for B only
  assert.match(r.out, /ONLY_DELEGATOR set: 2 of 4 grants kept/)
  assert.deepEqual(summary(r.out), [1, 0, 0])
  assert.equal(r.code, 0)
})

test('WO-058 ONLY_DELEGATOR=<B>: B still goes through the MIN_REWARD gate (0.5 RIO pending -> SKIP, nothing signed)', async () => {
  const r = await runBot(
    { broadcast: admitted, reward: '500000000000000000.000000000000000000' },
    { ONLY_DELEGATOR: DELEGATORS[1] },
  )
  assert.equal(r.posts.length, 0, r.out)
  assert.equal(r.sims, 0, r.out)
  assert.ok(
    r.out.includes(`[${DELEGATORS[1]}] SKIP — pending 500000000000000000 ario below MIN_REWARD`),
    r.out,
  )
  assert.ok(!r.out.includes(`[${DELEGATORS[0]}]`), 'the other delegator is never even looked at')
})

test('WO-058 ONLY_DELEGATOR with no matching grant: exit 1 before ANY simulate or signing (0 sims, 0 posts)', async () => {
  const nobody = 'realio1nobodyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
  const r = await runBot({ broadcast: admitted }, { ONLY_DELEGATOR: nobody })
  assert.equal(r.code, 1, r.out)
  assert.equal(r.posts.length, 0, r.out)
  assert.equal(r.sims, 0, r.out)
  assert.ok(
    r.out.includes(`ONLY_DELEGATOR ${nobody} has no grant to the bot — nothing to do`),
    r.out,
  )
  assert.doesNotMatch(r.out, /Found \d+ granter/)
  assert.doesNotMatch(r.out, /Done\./)
})

test('WO-058 ONLY_DELEGATOR unset or empty: unchanged (both delegators, one batch, no ONLY_DELEGATOR line)', async () => {
  for (const extra of [{}, { ONLY_DELEGATOR: '' }]) {
    const r = await runBot({ broadcast: admitted }, extra)
    assert.equal(r.posts.length, 1, r.out)
    assert.equal(decodeBatch(r.txBytes[0]).length, 4)
    assert.doesNotMatch(r.out, /ONLY_DELEGATOR/)
    assert.deepEqual(summary(r.out), [2, 0, 0])
  }
})

test('WO-058: a ONE-delegator batch that fails DeliverTx prints FAIL code 5, counts failed=1 and has nothing to retry', async () => {
  let batchHash
  const r = await runBot(
    {
      broadcast: (hash, n) => {
        if (n === 1) batchHash = hash
        return admitted(hash)
      },
      lookup: (hash) => (hash === batchHash ? found(5, 'insufficient funds') : found(0))(hash),
    },
    { ONLY_DELEGATOR: DELEGATORS[0] },
  )
  assert.equal(r.posts.length, 1, r.out)
  assert.match(r.out, /\[batch→\w+ ×1\] FAIL code 5: insufficient funds/, r.out)
  assert.doesNotMatch(r.out, /retrying/)
  assert.deepEqual(summary(r.out), [0, 1, 0])
  assert.equal(r.code, 1)
})

for (const [label, s] of [
  [
    'an nginx 502 (HTML) answers the batch POST',
    { broadcast: () => ({ status: 502, body: '<html><center>502 Bad Gateway</center></html>' }) },
  ],
  [
    'a 504 answers the batch POST',
    { broadcast: () => ({ status: 504, body: '<html>504 Gateway Time-out</html>' }) },
  ],
  ['the batch POST returns 200 with no tx_response', { broadcast: () => ok({}) }],
  [
    'CheckTx says sdk code 19 (already in the mempool cache)',
    {
      broadcast: (hash) =>
        ok({
          tx_response: {
            code: 19,
            codespace: 'sdk',
            txhash: hash,
            raw_log: 'tx already exists in cache',
          },
        }),
    },
  ],
  [
    'the admitted batch is never found before the poll deadline',
    { broadcast: admitted, lookup: notFound },
  ],
  [
    'the lookup answers code 5 for some OTHER tx hash',
    {
      broadcast: admitted,
      lookup: () =>
        ok({
          tx_response: {
            code: 5,
            codespace: 'sdk',
            txhash: 'B'.repeat(64),
            height: '101',
            raw_log: 'not ours',
          },
        }),
    },
  ],
]) {
  test(`UNCONFIRMED, sent once, never retried: ${label}`, async () => {
    const r = await runBot(s)
    assert.equal(r.posts.length, 1, r.out)
    assert.match(r.out, /UNCONFIRMED .*NOT retrying/)
    assert.doesNotMatch(r.out, /retrying \d+ delegators individually/)
    assert.deepEqual(summary(r.out), [0, 0, 2])
    assert.equal(r.code, 1)
  })
}

test('ABORT, no fallback: CheckTx says the bot account sequence moved (sdk 32)', async () => {
  const r = await runBot({
    broadcast: (hash) =>
      ok({
        tx_response: {
          code: 32,
          codespace: 'sdk',
          txhash: hash,
          raw_log: 'account sequence mismatch, expected 4, got 3: incorrect account sequence',
        },
      }),
  })
  assert.equal(r.posts.length, 1, r.out)
  assert.match(r.out, /ABORT — another tx from the bot account is pending or another run is active/)
  assert.doesNotMatch(r.out, /retrying \d+ delegators individually/)
  assert.equal(r.code, 3) // exit 3 = aborted: the wrapper then skips the commission step
})

test('ABORT inside the per-delegator fallback: the first retry hits sdk 32, the second is never sent', async () => {
  let batchHash
  const r = await runBot({
    broadcast: (hash, n) => {
      if (n === 1) {
        batchHash = hash
        return admitted(hash)
      } // the batch is admitted, then fails at DeliverTx
      return ok({
        tx_response: {
          code: 32,
          codespace: 'sdk',
          txhash: hash,
          raw_log: 'account sequence mismatch, expected 5, got 4: incorrect account sequence',
        },
      })
    },
    lookup: (hash) => (hash === batchHash ? found(5, 'insufficient funds') : found(0))(hash),
  })
  assert.equal(r.posts.length, 2, r.out) // batch + first retry only
  assert.match(r.out, /ABORT \(retry\)/)
  assert.match(r.out, /NOT SENT \(retry\) — run aborted/)
  assert.equal(r.code, 3)
})

test('ABORT before any broadcast: a Phase-1 simulate reports an account sequence mismatch', async () => {
  // Only the FIRST simulate clashes (another bot tx just landed), so the pre-fix code still batched the
  // second delegator and sent 1 tx; the fix sends nothing.
  let sims = 0
  const r = await runBot({
    broadcast: admitted,
    simulate: () =>
      ++sims === 1
        ? {
            status: 500,
            body: {
              code: 2,
              message: 'account sequence mismatch, expected 4, got 3: incorrect account sequence',
            },
          }
        : ok({ gas_info: { gas_used: '100000' } }),
  })
  assert.equal(r.posts.length, 0, r.out)
  assert.match(
    r.out,
    /ABORT — another tx from the bot account is pending or another run is active; nothing will be broadcast/,
  )
  assert.equal(r.code, 3)
})

test('a stale endpoint (latest block 10 min old) stops the run before anything is signed', async () => {
  const r = await runBot({
    broadcast: admitted,
    blockTime: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  })
  assert.equal(r.posts.length, 0, r.out)
  assert.match(r.out, /No healthy REST endpoint/)
  assert.equal(r.code, 1)
})

// ---- WO-050: the amount decision, decoded from what was signed ----
const RIO = 10n ** 18n
const ZERO_LIQUID = { balance: undefined, liquid: '0' }

test('(a) liquid 0, 5 RIO pending -> the delegate amount is EXACTLY 3 RIO (2 RIO gas reserve stays liquid)', async () => {
  const r = await runBot({ broadcast: admitted, ...ZERO_LIQUID })
  assert.equal(r.posts.length, 1, r.out)
  for (const d of DELEGATORS)
    assert.deepEqual(innerFor(r, d), expectedInner(d, '3000000000000000000'), r.out)
  assert.match(
    r.out,
    /GAS RESERVE CAP — delegating 3000000000000000000 ario of 5000000000000000000 ario rewards \(liquid=0, reserve=2000000000000000000\)/,
  )
  assert.deepEqual(summary(r.out), [2, 0, 0])
})

test('(b) liquid 0, 2.5 RIO pending -> 0.5 RIO after the reserve: SKIP line, nothing posted', async () => {
  const r = await runBot({
    broadcast: admitted,
    liquid: '0',
    reward: '2500000000000000000.000000000000000000',
  })
  assert.equal(r.posts.length, 0, r.out)
  for (const d of DELEGATORS) {
    assert.ok(
      r.out.includes(
        `[${d}] SKIP — delegate amount 500000000000000000 ario after 2000000000000000000 ario gas reserve below MIN_REWARD (liquid=0)`,
      ),
      r.out,
    )
  }
  assert.equal(r.code, 0)
})

test('(c) liquid exactly 2 RIO (== the reserve), 5 RIO pending -> the full 5 RIO, no cap line', async () => {
  const r = await runBot({ broadcast: admitted, liquid: String(2n * RIO) })
  assert.equal(r.posts.length, 1, r.out)
  for (const d of DELEGATORS)
    assert.deepEqual(innerFor(r, d), expectedInner(d, '5000000000000000000'), r.out)
  assert.doesNotMatch(r.out, /GAS RESERVE CAP/)
})

test('(d) balance endpoint 500, 2.5 RIO pending -> fail-closed: liquid treated as 0, SKIP, nothing posted (BUG-4)', async () => {
  const r = await runBot({
    broadcast: admitted,
    reward: '2500000000000000000.000000000000000000',
    balance: () => ({ status: 500, body: { code: 2, message: 'internal error' } }),
  })
  assert.equal(r.posts.length, 0, r.out)
  assert.match(
    r.out,
    /WARN could not fetch liquid balance: .*fail-closed: treating liquid balance as 0n/,
  )
  for (const d of DELEGATORS) {
    assert.ok(
      r.out.includes(
        `[${d}] SKIP — delegate amount 500000000000000000 ario after 2000000000000000000 ario gas reserve below MIN_REWARD (liquid=0)`,
      ),
      r.out,
    )
  }
})

test('(d2) balance endpoint 500, 5 RIO pending -> fail-closed means the reserve CAP binds: exactly 3 RIO, never the full 5', async () => {
  const r = await runBot({
    broadcast: admitted,
    balance: () => ({ status: 500, body: { code: 2, message: 'internal error' } }),
  })
  assert.equal(r.posts.length, 1, r.out)
  assert.match(r.out, /WARN could not fetch liquid balance/)
  for (const d of DELEGATORS)
    assert.deepEqual(innerFor(r, d), expectedInner(d, '3000000000000000000'), r.out)
})

test('(e) 0.5 RIO pending -> the MIN_REWARD gate stops it before ANY balance query or simulate: 0 simulates, 0 posts', async () => {
  const r = await runBot({ broadcast: admitted, reward: '500000000000000000.000000000000000000' })
  assert.equal(r.sims, 0, r.out)
  assert.equal(r.posts.length, 0, r.out)
  for (const d of DELEGATORS)
    assert.ok(
      r.out.includes(
        `[${d}] SKIP — pending 500000000000000000 ario below MIN_REWARD 1000000000000000000`,
      ),
      r.out,
    )
  assert.doesNotMatch(r.out, /liquid balance/)
})

test('control for (e): a delegator above MIN_REWARD DOES simulate (the simulate counter counts)', async () => {
  const r = await runBot({ broadcast: admitted })
  assert.equal(r.sims, 3, r.out) // Phase-1 simulate per delegator (2) + the batch's own simulate (1)
  assert.equal(r.posts.length, 1)
})

test('startup: MAX_DELEGATORS=abc exits 1 naming the variable, before the wallet is loaded (0 requests, 0 posts)', async () => {
  const r = await runBot({ broadcast: admitted }, { MAX_DELEGATORS: 'abc' })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /MAX_DELEGATORS/)
  assert.equal(r.posts.length, 0)
  assert.equal(r.gets, 0, 'nothing may be queried before the env check')
  assert.equal(r.sims, 0)
})

test('startup: RUN_BUDGET_MS above the unit-timeout bound (900000) exits 1 naming the variable', async () => {
  const r = await runBot({ broadcast: admitted }, { RUN_BUDGET_MS: '900000' })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /RUN_BUDGET_MS/)
  assert.equal(r.gets, 0)
  assert.equal(r.posts.length, 0)
})

// ---- WO-059 D2 (C-50): money env vars are strictly parsed; a bad value exits 1 before the wallet loads ----
for (const [name, value, why] of [
  ['MAX_FEE', 'abc', 'not a number'],
  ['MAX_FEE', '0', 'below the minimum (1)'],
  [
    'MAX_FEE',
    '1e16',
    'exponent notation (BigInt would throw a nameless SyntaxError or, for "1_0", mis-parse)',
  ],
  ['MAX_FEE', String(10n ** 18n + 1n), 'above the maximum'],
  ['MIN_REWARD', '-1', 'negative'],
  ['MIN_REWARD', '1.5', 'a decimal'],
  ['MIN_REWARD', String(10n ** 24n + 1n), 'above the maximum'],
  [
    'GAS_RESERVE',
    '-5',
    'negative (a negative reserve would let the cap hand out MORE than the rewards)',
  ],
  ['GAS_RESERVE', String(10n ** 21n + 1n), 'above the maximum'],
]) {
  test(`WO-059 startup: ${name}=${value} (${why}) exits 1 naming the variable, before the wallet is loaded`, async () => {
    const r = await runBot({ broadcast: admitted }, { [name]: value })
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes(name), r.out)
    assert.equal(r.gets, 0, 'nothing may be queried before the env check')
    assert.equal(r.posts.length, 0)
    assert.equal(r.sims, 0)
  })
}

test('WO-059: MIN_REWARD=0 is valid (the documented "show every delegator" dry run) and still runs', async () => {
  const r = await runBot(
    { broadcast: admitted, reward: '500000000000000000.000000000000000000' },
    { MIN_REWARD: '0' },
  )
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('MIN_REWARD 0 ario'), r.out)
})

test("WO-059: unset money vars keep today's defaults (header line)", async () => {
  const r = await runBot({ broadcast: admitted })
  assert.ok(
    r.out.includes(
      'MIN_REWARD 1000000000000000000 ario | GAS_RESERVE 2000000000000000000 ario | MAX_FEE 10000000000000000 ario',
    ),
    r.out,
  )
})

// ---- WO-063 D1 (S-1): a delegator whose withdraw address is not itself is skipped ----
const OTHER = 'realio1otherxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'

test('WO-063 S-1: withdraw address != delegator -> SKIP, no message for that delegator is simulated or broadcast', async () => {
  const r = await runBot({
    broadcast: admitted,
    withdraw: (d) => (d === DELEGATORS[0] ? OTHER : d),
  })
  assert.ok(
    r.out.includes(
      `[${DELEGATORS[0]}] SKIP — withdraw address differs from delegator; rewards would not land in the delegated account`,
    ),
    r.out,
  )
  assert.equal(r.posts.length, 1, r.out)
  assert.deepEqual(
    innerFor(r, DELEGATORS[0]),
    [],
    'nothing may be signed for the redirected delegator',
  )
  assert.deepEqual(
    innerFor(r, DELEGATORS[1]),
    expectedInner(DELEGATORS[1], '5000000000000000000'),
    r.out,
  )
  assert.equal(r.sims, 2, r.out) // one Phase-1 simulate (the other delegator) + the batch
  assert.deepEqual(summary(r.out), [1, 0, 0])
  assert.equal(r.code, 0)
})

test('WO-063 S-1: the withdraw check runs BEFORE the rewards query (a redirected delegator costs no rewards read)', async () => {
  const seen = []
  const r = await runBot({
    broadcast: admitted,
    withdraw: (d) => {
      seen.push(d)
      return OTHER
    },
  })
  assert.equal(r.posts.length, 0, r.out)
  assert.equal(r.sims, 0, r.out)
  assert.deepEqual(summary(r.out), [0, 0, 0])
  assert.equal(seen.length, 2)
  assert.doesNotMatch(r.out, /source\(s\)/, 'no delegator may reach the planning line')
})

test('WO-063 S-1: the withdraw query FAILING is a SKIP too (fail closed), with its own line', async () => {
  const r = await runBot({
    broadcast: admitted,
    withdraw: (d) =>
      d === DELEGATORS[0] ? { status: 500, body: { code: 2, message: 'internal error' } } : d,
  })
  assert.match(
    r.out,
    new RegExp(
      `\\[${DELEGATORS[0]}\\] SKIP — could not verify withdraw address \\(.*\\): fail-closed`,
    ),
    r.out,
  )
  assert.deepEqual(innerFor(r, DELEGATORS[0]), [])
  assert.equal(r.posts.length, 1, r.out)
  assert.deepEqual(summary(r.out), [1, 0, 0])
})

// docs/06 gate 2026-10-16 (B-5): the chain always names an address (the delegator's own when none was
// set), so an EMPTY answer is malformed. It used to read as "self" (WO-063 D1); now it is a SKIP.
test('B-5: an EMPTY withdraw address is a malformed answer: SKIP (fail closed), nothing simulated or broadcast', async () => {
  const r = await runBot({ broadcast: admitted, withdraw: () => '' })
  assert.equal(r.posts.length, 0, r.out)
  for (const d of DELEGATORS) {
    assert.ok(
      r.out.includes(`[${d}] SKIP — could not verify withdraw address (empty): fail-closed`),
      r.out,
    )
  }
})

test('WO-063 S-1 control: withdraw address == delegator is unchanged (both compound, no withdraw line)', async () => {
  const r = await runBot({ broadcast: admitted })
  assert.equal(r.posts.length, 1, r.out)
  assert.doesNotMatch(r.out, /withdraw address/)
  assert.deepEqual(summary(r.out), [2, 0, 0])
})

// ---- COMPOUND_LOCAL_ONLY: only the URLs of COMPOUND_NODE_HOST are used; none configured fails before any request ----
test('COMPOUND_LOCAL_ONLY=1 with COMPOUND_NODE_HOST naming a host the config does not list exits 1 before any request (no fallback to the stub)', async () => {
  const r = await runBot(
    { broadcast: admitted },
    { COMPOUND_LOCAL_ONLY: '1', COMPOUND_NODE_HOST: 'node.example' },
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /COMPOUND_LOCAL_ONLY=1 but no local node URL \(node\.example\)/, r.out)
  assert.equal(r.gets, 0, 'the non-matching stub must never be queried')
  assert.equal(r.posts.length, 0)
  assert.equal(r.sims, 0)
})

test('COMPOUND_LOCAL_ONLY=1 without COMPOUND_NODE_HOST exits 1 before any request (it never trusts "whatever is configured")', async () => {
  const r = await runBot({ broadcast: admitted }, { COMPOUND_LOCAL_ONLY: '1' })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /COMPOUND_LOCAL_ONLY=1 but COMPOUND_NODE_HOST is not set/, r.out)
  assert.equal(r.gets, 0)
  assert.equal(r.posts.length, 0)
})

test("control: COMPOUND_LOCAL_ONLY=1 with COMPOUND_NODE_HOST naming the stub's host keeps it, and the run goes through", async () => {
  // both lists must name the host: the filter keeps only its URLs in restUrl AND rpcUrl, and fails if either is empty
  const r = await runBot(
    {
      broadcast: admitted,
      networkConfig: { rpcUrl: [`http://127.0.0.1:${port}`, 'https://rpc.example.org'] },
    },
    { COMPOUND_LOCAL_ONLY: '1', COMPOUND_NODE_HOST: '127.0.0.1' },
  )
  assert.equal(r.code, 0, r.out)
  assert.equal(r.posts.length, 1)
  assert.deepEqual(summary(r.out), [2, 0, 0])
})

// ---- WO-064 D1 (S-12): a hung account read or simulate is a plain per-delegator ERROR, never "unconfirmed" ----
test('WO-064 S-12: a HUNG simulate for one delegator times out into a plain ERROR; the other delegator still compounds', async () => {
  let n = 0
  const r = await runBot({
    broadcast: admitted,
    simulate: () => (++n === 1 ? { hang: true } : ok({ gas_info: { gas_used: '100000' } })),
    networkConfig: { simulateTimeout: 300 },
  })
  assert.match(r.out, new RegExp(`\\[${DELEGATORS[0]}\\] ERROR timeout of 300ms exceeded`), r.out)
  assert.doesNotMatch(r.out, /UNCONFIRMED/)
  assert.equal(r.posts.length, 1, r.out)
  assert.deepEqual(innerFor(r, DELEGATORS[0]), [])
  assert.deepEqual(
    innerFor(r, DELEGATORS[1]),
    expectedInner(DELEGATORS[1], '5000000000000000000'),
    r.out,
  )
  assert.deepEqual(summary(r.out), [1, 1, 0])
  assert.equal(r.code, 1)
})

test('WO-064 S-12: a HUNG account read for one delegator times out into a plain ERROR too', async () => {
  let n = 0
  const r = await runBot({
    broadcast: admitted,
    accountHang: () => ++n === 1,
    networkConfig: { accountTimeout: 300 },
  })
  assert.match(r.out, new RegExp(`\\[${DELEGATORS[0]}\\] ERROR timeout of 300ms exceeded`), r.out)
  assert.doesNotMatch(r.out, /UNCONFIRMED/)
  assert.deepEqual(innerFor(r, DELEGATORS[0]), [])
  assert.deepEqual(summary(r.out), [1, 1, 0])
})

// WO-076 D8 (WO-075 carry-over): simulateWithFeeCap is given the network denom, so a getFee in any other denom
// fails closed: no delegator is batched, nothing is broadcast.
test('WO-076 D8: a getFee in another denom (uatom) fails every delegator closed: nothing is broadcast, exit 1', async () => {
  const r = await runBot({
    broadcast: admitted,
    networkConfig: { gasPrice: '1000000000uatom', gasPricePrefer: '1000000000uatom' },
  })
  assert.equal(r.posts.length, 0, r.out)
  assert.equal(
    (r.out.match(/ERROR getFee returned a fee in uatom, expected ario/g) || []).length,
    2,
    r.out,
  )
  assert.deepEqual(summary(r.out), [0, 2, 0], r.out)
  assert.equal(r.code, 1)
})
