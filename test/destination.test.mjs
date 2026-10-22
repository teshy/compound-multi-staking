// WO-044: compound only into a BONDED, non-jailed destination; fail-closed on an unknown status.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { destinationVerdict, destinationChecker } from '../scripts/lib/destination.mjs'

const bonded = { status: 'BOND_STATUS_BONDED', jailed: false }

test('a bonded, non-jailed validator is an acceptable destination', () => {
  assert.deepEqual(destinationVerdict(bonded), { ok: true })
})

test('a jailed validator is refused (even if the REST status still reads BONDED)', () => {
  const v = destinationVerdict({ status: 'BOND_STATUS_BONDED', jailed: true })
  assert.equal(v.ok, false)
  assert.match(v.reason, /jailed/)
})

for (const status of ['BOND_STATUS_UNBONDING', 'BOND_STATUS_UNBONDED', undefined]) {
  test(`status ${status} is refused`, () => {
    const v = destinationVerdict({ status, jailed: false })
    assert.equal(v.ok, false)
    assert.match(v.reason, /not bonded/)
  })
}

test('a failed status query is refused (fail-closed)', () => {
  assert.equal(destinationVerdict(null).ok, false)
})

test('destinationChecker queries each validator once and fails closed on a rejected query', async () => {
  const calls = []
  const check = destinationChecker(async (v) => {
    calls.push(v)
    if (v === 'down') throw new Error('boom')
    return bonded
  })
  assert.equal((await check('a')).ok, true)
  assert.equal((await check('a')).ok, true)
  assert.equal((await check('down')).ok, false)
  assert.deepEqual(calls, ['a', 'down'])
})
