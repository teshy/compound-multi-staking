import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simulateWithFeeCap, simulateAndBroadcast } from '../scripts/lib/broadcast.mjs'
import { TxFailedError, TxUnconfirmedError } from '../src/utils/TxConfirm.mjs'

// WO-058: SigningClient.signAndBroadcast RESOLVES only on DeliverTx code 0 and THROWS TxFailedError /
// TxUnconfirmedError otherwise (WO-040), so this mock never resolves a non-zero code. `fail` makes it
// throw what the real client throws.
function mockSigningClient({
  gas = 100000,
  fail,
  signedPrice = 1_000_000_000n,
  denom = 'ario',
} = {}) {
  const calls = { simulate: 0, signAndBroadcast: 0 }
  return {
    calls,
    // what the real SigningClient.getFee returns: one coin, amount a decimal string, at the SIGNING price
    getFee: (g) => ({
      amount: [{ denom, amount: String(BigInt(Math.ceil(g)) * signedPrice) }],
      gas: String(g),
    }),
    simulate: async () => {
      calls.simulate++
      return gas
    },
    signAndBroadcast: async () => {
      calls.signAndBroadcast++
      if (fail) throw fail
      return { code: 0, transactionHash: 'ABC123', rawLog: '' }
    },
  }
}

// Runs fn with console.log captured; returns { result, lines }.
async function capture(fn) {
  const lines = []
  const orig = console.log
  console.log = (...a) => lines.push(a.join(' '))
  try {
    return { result: await fn(), lines }
  } finally {
    console.log = orig
  }
}

test('simulateWithFeeCap reports withinCap=true when the fee is under the cap', async () => {
  const client = mockSigningClient({ gas: 100000 })
  const result = await simulateWithFeeCap(client, 'bot1', [{}], 'memo', {
    feeCapArio: 10_000_000_000_000_000n,
    gasPriceNum: 1_000_000_000n,
  })
  assert.equal(result.gas, 100000)
  assert.equal(result.feeArio, 100_000_000_000_000n)
  assert.equal(result.withinCap, true)
})

test('simulateWithFeeCap reports withinCap=false when the fee exceeds the cap, without throwing', async () => {
  const client = mockSigningClient({ gas: 100_000_000 })
  const result = await simulateWithFeeCap(client, 'bot1', [{}], 'memo', {
    feeCapArio: 10_000_000_000_000_000n,
    gasPriceNum: 1_000_000_000n,
  })
  assert.equal(result.withinCap, false)
  assert.equal(result.feeArio, 100_000_000_000_000_000n)
})

// WO-075 D5 (BT-6): the cap sees the fee that is SIGNED (getFee), not gas x a separately parsed price.
test("BT-6: with the signing price drifted from the caller's gasPriceNum the fee and the cap follow the signed price", async () => {
  const client = mockSigningClient({ gas: 100000, signedPrice: 3_000_000_000n })
  const r = await simulateWithFeeCap(client, 'bot1', [{}], 'memo', {
    feeCapArio: 200_000_000_000_000n,
    gasPriceNum: 1_000_000_000n,
  })
  assert.equal(r.feeArio, 300_000_000_000_000n, 'the signed fee, not 1e9 x gas')
  assert.equal(
    r.withinCap,
    false,
    'the real fee is over the 2e14 cap even though gas x gasPriceNum (1e14) would pass',
  )
})

test('BT-6: gasPriceNum is not needed any more', async () => {
  const r = await simulateWithFeeCap(mockSigningClient({ gas: 100000 }), 'bot1', [{}], 'memo', {
    feeCapArio: 10n ** 16n,
  })
  assert.equal(r.feeArio, 100_000_000_000_000n)
})

test('BT-6: a fractional simulated gas is priced exactly as getFee prices it (ceil)', async () => {
  const r = await simulateWithFeeCap(mockSigningClient({ gas: 1234.5 }), 'bot1', [{}], 'memo', {
    feeCapArio: 10n ** 16n,
  })
  assert.equal(r.feeArio, 1235n * 1_000_000_000n)
})

test('BT-6: feeDenom: a fee in another denom throws; the right one passes; omitted is not checked', async () => {
  const other = mockSigningClient({ denom: 'uatom' })
  await assert.rejects(
    simulateWithFeeCap(other, 'bot1', [{}], 'memo', { feeCapArio: 10n ** 16n, feeDenom: 'ario' }),
    /fee in uatom, expected ario/,
  )
  const ok = await simulateWithFeeCap(mockSigningClient(), 'bot1', [{}], 'memo', {
    feeCapArio: 10n ** 16n,
    feeDenom: 'ario',
  })
  assert.equal(ok.withinCap, true)
  await assert.doesNotReject(
    simulateWithFeeCap(other, 'bot1', [{}], 'memo', { feeCapArio: 10n ** 16n }),
  )
})

test('BT-6: no fee coin, two fee coins or a non-integer amount throws (never a silent 0 or NaN)', async () => {
  const mk = (amount) => ({ simulate: async () => 1, getFee: () => ({ amount }) })
  for (const amount of [
    [],
    undefined,
    [
      { denom: 'ario', amount: '1' },
      { denom: 'ario', amount: '1' },
    ],
  ]) {
    await assert.rejects(
      simulateWithFeeCap(mk(amount), 'bot1', [{}], 'memo', { feeCapArio: 1n }),
      /fee coin/,
    )
  }
  await assert.rejects(
    simulateWithFeeCap(mk([{ denom: 'ario', amount: '1.5' }]), 'bot1', [{}], 'memo', {
      feeCapArio: 1n,
    }),
  )
})

test('simulateAndBroadcast exits before broadcasting when dryRun is true', async () => {
  const client = mockSigningClient()
  const result = await simulateAndBroadcast(client, 'bot1', [{}], 'memo', { dryRun: true })
  assert.equal(result.broadcast, false)
  assert.equal(client.calls.signAndBroadcast, 0)
})

test('simulateAndBroadcast broadcasts and reports ok=true on a resolved broadcast (code 0), printing OK <hash>', async () => {
  const client = mockSigningClient()
  const { result, lines } = await capture(() =>
    simulateAndBroadcast(client, 'bot1', [{}], 'memo', { dryRun: false }),
  )
  assert.equal(result.broadcast, true)
  assert.equal(result.ok, true)
  assert.equal(result.res.transactionHash, 'ABC123')
  assert.equal(client.calls.signAndBroadcast, 1)
  assert.ok(lines.includes('OK ABC123'), lines.join('\n'))
})

// WO-058 D1 (C-19/C-28/C-37/C-43/C-51): a definite failure is a THROWN TxFailedError. It used to escape
// simulateAndBroadcast as an unhandled rejection in claim-rewards / stake-rio / stake-dstrx; it is now
// the same ok:false + FAIL line the (unreachable) resolved-non-zero branch printed.
for (const phase of ['delivertx', 'checktx']) {
  test(`simulateAndBroadcast turns a TxFailedError (${phase}) into ok=false, failed=true with the code and hash`, async () => {
    const fail = new TxFailedError({ code: 5, rawLog: 'x', transactionHash: 'H', height: 1 }, phase)
    const client = mockSigningClient({ fail })
    const { result, lines } = await capture(() =>
      simulateAndBroadcast(client, 'bot1', [{}], 'memo', {
        dryRun: false,
        gasPriceNum: 1_000_000_000n,
      }),
    )
    assert.equal(result.broadcast, true)
    assert.equal(result.ok, false)
    assert.equal(result.failed, true)
    assert.equal(result.code, 5)
    assert.equal(result.transactionHash, 'H')
    assert.equal(result.gas, 100000)
    assert.equal(result.feeArio, 100_000n * 1_000_000_000n)
    assert.ok(lines.includes('FAIL code 5: x'), lines.join('\n'))
    assert.equal(client.calls.signAndBroadcast, 1)
  })
}

test('simulateAndBroadcast prefixes the FAIL line with the label like every other line', async () => {
  const fail = new TxFailedError(
    { code: 11, rawLog: 'out of gas', transactionHash: 'H', height: 1 },
    'delivertx',
  )
  const { lines } = await capture(() =>
    simulateAndBroadcast(mockSigningClient({ fail }), 'bot1', [{}], 'memo', {
      dryRun: false,
      label: '[claim] ',
    }),
  )
  assert.ok(lines.includes('[claim] FAIL code 11: out of gas'), lines.join('\n'))
})

test('simulateAndBroadcast recognises a TxFailedError by name (cross-module-instance safe)', async () => {
  const fail = Object.assign(new Error('x'), {
    name: 'TxFailedError',
    code: 7,
    rawLog: 'r',
    transactionHash: 'H2',
  })
  const { result } = await capture(() =>
    simulateAndBroadcast(mockSigningClient({ fail }), 'bot1', [{}], 'memo', { dryRun: false }),
  )
  assert.equal(result.failed, true)
  assert.equal(result.code, 7)
})

test('simulateAndBroadcast still reports an unconfirmed tx as ok=false + unconfirmed, NOT failed', async () => {
  const fail = new TxUnconfirmedError('UNC', 'timeout')
  const { result } = await capture(() =>
    simulateAndBroadcast(mockSigningClient({ fail }), 'bot1', [{}], 'memo', { dryRun: false }),
  )
  assert.equal(result.ok, false)
  assert.equal(result.unconfirmed, true)
  assert.equal(result.failed, undefined)
  assert.equal(result.transactionHash, 'UNC')
})

test('simulateAndBroadcast re-throws anything that is neither a TxFailedError nor unconfirmed', async () => {
  const client = mockSigningClient({ fail: new Error('boom') })
  await assert.rejects(
    capture(() => simulateAndBroadcast(client, 'bot1', [{}], 'memo', { dryRun: false })),
    /boom/,
  )
})

test('simulateAndBroadcast omits the fee line (feeArio undefined) when gasPriceNum is not passed', async () => {
  const client = mockSigningClient()
  const result = await simulateAndBroadcast(client, 'bot1', [{}], 'memo', { dryRun: true })
  assert.equal(result.feeArio, undefined)
})
