import { test } from 'node:test'
import assert from 'node:assert/strict'
import { format, floor } from 'mathjs'
import { exactCoin, floorDecCoinAmount } from '../scripts/lib/amount.mjs'

test('exactCoin passes a 21-digit BigInt through exactly', () => {
  const amount = 123456789012345678901n
  const result = exactCoin(amount, 'ario')
  assert.equal(result.amount, '123456789012345678901')
  assert.equal(result.denom, 'ario')
})

test('exactCoin throws on a decimal amount', () => {
  assert.throws(() => exactCoin('1.5', 'ario'))
})

test('exactCoin throws on a decimal with trailing zeros', () => {
  assert.throws(() => exactCoin('12345678901234567890.000', 'ario'))
})

test('exactCoin throws on an empty string', () => {
  assert.throws(() => exactCoin('', 'ario'))
})

// Documents WHY exactCoin exists (BUG-2, TEST-QA-FINDINGS.md): the old coin()
// helper routed amounts through mathjs floor()/format() in float64, which
// silently re-rounds any integer beyond 2^53 — this is a live repro of that
// corruption, not a test of exactCoin itself.
test('the old mathjs float64 path corrupts a 21-digit amount (regression evidence for BUG-2)', () => {
  const exact = '123456789012345678901'
  const corrupted = format(floor(exact), { notation: 'fixed' })
  assert.notEqual(corrupted, exact)
})

test('floorDecCoinAmount truncates a DecCoin decimal string to bigint', () => {
  assert.equal(floorDecCoinAmount('1234.999999999999999999'), 1234n)
})

test('floorDecCoinAmount passes a plain integer string through as bigint', () => {
  assert.equal(floorDecCoinAmount('1000'), 1000n)
})

test('floorDecCoinAmount floors a 21-digit DecCoin amount exactly (no float64 path)', () => {
  assert.equal(floorDecCoinAmount('123456789012345678901.500'), 123456789012345678901n)
})

test('floorDecCoinAmount throws on a negative amount', () => {
  assert.throws(() => floorDecCoinAmount('-1.0'))
})

test('floorDecCoinAmount throws on exponent notation', () => {
  assert.throws(() => floorDecCoinAmount('1e10'))
})

test('floorDecCoinAmount throws on an empty string', () => {
  assert.throws(() => floorDecCoinAmount(''))
})

test('floorDecCoinAmount throws on a non-numeric string', () => {
  assert.throws(() => floorDecCoinAmount('abc'))
})
