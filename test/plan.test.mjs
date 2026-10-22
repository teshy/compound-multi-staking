// WO-050 (T-1, T-21): the compound bot's delegate-amount decision and strict env bounds, pinned
// as pure functions. Defaults: minReward 1 RIO, gasReserve 2 RIO.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeDelegateAmount, parseBoundedInt, parseBoundedBigInt } from '../scripts/lib/plan.mjs'

const RIO = 10n ** 18n
const MIN = 1n * RIO
const RESERVE = 2n * RIO
const plan = (liquid, total) =>
  computeDelegateAmount({ total, liquid, gasReserve: RESERVE, minReward: MIN })

test('liquid 10, total 5 -> delegates all 5, not capped', () => {
  assert.deepEqual(plan(10n * RIO, 5n * RIO), { amount: 5n * RIO, capped: false, skip: false })
})

test('liquid 0, total 5 -> capped to 3 (reserve 2 stays liquid)', () => {
  assert.deepEqual(plan(0n, 5n * RIO), { amount: 3n * RIO, capped: true, skip: false })
})

test('liquid 0, total 2.5 -> 0.5 after the reserve -> skip', () => {
  const total = 2n * RIO + RIO / 2n
  assert.deepEqual(plan(0n, total), { amount: RIO / 2n, capped: true, skip: true })
})

test('liquid exactly 2 (== reserve), total 5 -> the full 5, not capped', () => {
  assert.deepEqual(plan(2n * RIO, 5n * RIO), { amount: 5n * RIO, capped: false, skip: false })
})

test('liquid 0, total 3 -> 1, NOT skipped (boundary amount == minReward)', () => {
  assert.deepEqual(plan(0n, 3n * RIO), { amount: RIO, capped: true, skip: false })
})

test('liquid 0, total exactly 2 (== reserve) -> 0, skip (maxDelegate is not positive)', () => {
  assert.deepEqual(plan(0n, 2n * RIO), { amount: 0n, capped: true, skip: true })
})

test('liquid 0, total below the reserve -> clamps to 0, never negative', () => {
  const r = plan(0n, RIO)
  assert.equal(r.amount, 0n)
  assert.equal(r.skip, true)
})

test('boundary maxDelegate == total (liquid == reserve): the full amount, not capped', () => {
  const r = plan(RESERVE, 7n * RIO)
  assert.equal(r.amount, 7n * RIO)
  assert.equal(r.capped, false)
})

test('21-digit totals stay exact (no float64 round-trip)', () => {
  const total = 123456789012345678901n
  assert.equal(plan(10n ** 21n, total).amount, total)
  const capped = plan(0n, total)
  assert.equal(capped.amount, total - RESERVE)
  assert.equal(capped.capped, true)
  assert.equal(capped.amount, 123456789012345678901n - 2000000000000000000n)
})

test('parseBoundedInt: undefined and empty give the fallback', () => {
  const b = { min: 1, max: 100000 }
  assert.equal(parseBoundedInt('MAX_DELEGATORS', undefined, 500, b), 500)
  assert.equal(parseBoundedInt('MAX_DELEGATORS', '', 500, b), 500)
})

test('parseBoundedInt: a plain integer in range is returned as a Number', () => {
  const v = parseBoundedInt('MAX_DELEGATORS', '750', 500, { min: 1, max: 100000 })
  assert.equal(v, 750)
  assert.equal(typeof v, 'number')
  assert.equal(parseBoundedInt('X', '1', 5, { min: 1, max: 9 }), 1) // inclusive min
  assert.equal(parseBoundedInt('X', '9', 5, { min: 1, max: 9 }), 9) // inclusive max
})

test('parseBoundedInt: garbage, decimals, negatives, out-of-range all throw, naming the variable', () => {
  const b = { min: 1, max: 100000 }
  for (const raw of [
    'abc',
    '1.5',
    '5.0',
    '1.',
    '.5',
    '-1',
    '0',
    '100001',
    ' 5',
    '5 ',
    '1e3',
    '0x10',
    '+5',
    '99999999999999999999999',
  ]) {
    assert.throws(
      () => parseBoundedInt('MAX_DELEGATORS', raw, 500, b),
      /MAX_DELEGATORS/,
      `raw=${JSON.stringify(raw)}`,
    )
  }
})

test('parseBoundedInt: a throw is an Error whose message states the allowed range', () => {
  assert.throws(
    () => parseBoundedInt('RUN_BUDGET_MS', '900000', 600000, { min: 1000, max: 899000 }),
    (e) =>
      e instanceof Error &&
      /RUN_BUDGET_MS/.test(e.message) &&
      /1000/.test(e.message) &&
      /899000/.test(e.message),
  )
})

// ---- WO-059 D2 (C-50): money env vars are BigInt, strictly parsed ----
const B = { min: 1n, max: 10n ** 18n }

test('parseBoundedBigInt: unset or empty -> the fallback (a bigint), untouched', () => {
  assert.equal(parseBoundedBigInt('MAX_FEE', undefined, 7n, B), 7n)
  assert.equal(parseBoundedBigInt('MAX_FEE', '', 7n, B), 7n)
})

test('parseBoundedBigInt: digits only, parsed EXACTLY above 2^53, returned as a bigint', () => {
  assert.equal(parseBoundedBigInt('X', '123456789012345678', 1n, B), 123456789012345678n)
  assert.equal(typeof parseBoundedBigInt('X', '5', 1n, B), 'bigint')
})

test('parseBoundedBigInt: both bounds are inclusive', () => {
  assert.equal(parseBoundedBigInt('X', '1', 5n, B), 1n)
  assert.equal(parseBoundedBigInt('X', String(10n ** 18n), 5n, B), 10n ** 18n)
  assert.throws(() => parseBoundedBigInt('X', '0', 5n, B), /X/)
  assert.throws(() => parseBoundedBigInt('X', String(10n ** 18n + 1n), 5n, B), /X/)
  assert.equal(parseBoundedBigInt('X', '0', 5n, { min: 0n, max: 9n }), 0n)
})

for (const raw of ['abc', '-1', '1.5', '1e18', ' 5', '5 ', '0x10', '+5', '1,000', '१२३', '5\n']) {
  test(`parseBoundedBigInt rejects ${JSON.stringify(raw)} with an error naming the variable`, () => {
    assert.throws(() => parseBoundedBigInt('GAS_RESERVE', raw, 1n, B), /GAS_RESERVE/)
  })
}
