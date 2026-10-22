// WO-063 D1 (S-1): the withdraw-address verdict. multi-compound sizes each delegate as if the
// withdrawn rewards land in the delegator's own account; if the delegator redirected its rewards
// elsewhere, that account would not receive them and the delegate would spend its principal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withdrawVerdict, withdrawChecker } from '../scripts/lib/withdraw.mjs'
import { account } from './helpers/addresses.mjs'

const A = account(1)
const B = account(2)

test("equal: the rewards land in the delegator's own account -> ok", () => {
  assert.deepEqual(withdrawVerdict(A, A), { ok: true })
})

test('different: the rewards go elsewhere -> not ok, reason "differs"', () => {
  assert.deepEqual(withdrawVerdict(A, B), { ok: false, reason: 'differs' })
})

// docs/06 gate 2026-10-16 (B-5): the chain's query always names an address (the delegator's own when
// none was set), so an empty answer is malformed. It used to read as "self" (WO-063 D1): fail open.
test('empty or missing is a malformed answer -> not ok, reason "empty" (fail closed)', () => {
  for (const w of ['', undefined, null])
    assert.deepEqual(withdrawVerdict(A, w), { ok: false, reason: 'empty' }, String(w))
})

test('a non-string answer is unreadable -> not ok (fail closed)', () => {
  for (const w of [{}, [], 5, true]) assert.equal(withdrawVerdict(A, w).ok, false)
  assert.equal(withdrawVerdict(A, {}).reason, 'unreadable')
})

test('the comparison is exact (case and whitespace are not forgiven)', () => {
  assert.equal(withdrawVerdict(A, A.toUpperCase()).ok, false)
  assert.equal(withdrawVerdict(A, ` ${A}`).ok, false)
})

test('withdrawChecker: asks for THIS delegator, and returns the verdict', async () => {
  const asked = []
  const check = withdrawChecker(async (d) => {
    asked.push(d)
    return d === A ? A : B
  })
  assert.deepEqual(await check(A), { ok: true })
  assert.deepEqual(await check(B), { ok: true })
  assert.deepEqual(asked, [A, B])
  const other = withdrawChecker(async () => B)
  assert.deepEqual(await other(A), { ok: false, reason: 'differs' })
})

test('withdrawChecker: a FAILED query is not ok, fail closed, carrying the message', async () => {
  const check = withdrawChecker(async () => {
    throw new Error('HTTP 502')
  })
  assert.deepEqual(await check(A), { ok: false, reason: 'query-failed', message: 'HTTP 502' })
  const noMsg = withdrawChecker(async () => {
    throw 'boom'
  })
  assert.equal((await noMsg(A)).message, 'boom')
})

test('withdrawChecker: an empty answer is a skip too (B-5)', async () => {
  assert.deepEqual(await withdrawChecker(async () => '')(A), { ok: false, reason: 'empty' })
  assert.deepEqual(await withdrawChecker(async () => undefined)(A), { ok: false, reason: 'empty' })
})
