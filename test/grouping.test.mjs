import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupGrants } from '../scripts/lib/grouping.mjs'
import { valoper } from './helpers/addresses.mjs'

const WITHDRAW_MSG = '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward'
const GOOD_GRANTER = 'realio1good0000000000000000000000000000000'
const GOOD_VALOPER = valoper(1) // real bech32 shape (groupGrants checks it)

function withdrawGrant(granter) {
  return {
    granter,
    authorization: { '@type': '/cosmos.authz.v1beta1.GenericAuthorization', msg: WITHDRAW_MSG },
  }
}

function delegateGrant(granter, addresses) {
  return {
    granter,
    authorization: {
      '@type': '/cosmos.staking.v1beta1.StakeAuthorization',
      authorization_type: 'AUTHORIZATION_TYPE_DELEGATE',
      allow_list: { address: addresses },
    },
  }
}

test('groupGrants isolates a malformed allow_list.address and a missing authorization without throwing', () => {
  const stringAllowListGranter = 'realio1malformed000000000000000000000000000'
  const missingAuthzGranter = 'realio1noauthz00000000000000000000000000000'

  const grants = [
    withdrawGrant(GOOD_GRANTER),
    delegateGrant(GOOD_GRANTER, [GOOD_VALOPER]),
    // allow_list.address is a string, not an array — must not crash
    {
      ...delegateGrant(stringAllowListGranter, null),
      authorization: {
        ...delegateGrant(stringAllowListGranter, null).authorization,
        allow_list: { address: 'not-an-array' },
      },
    },
    // authorization missing entirely
    { granter: missingAuthzGranter },
  ]

  const logs = []
  const result = groupGrants(grants, { withdrawMsgTypeUrl: WITHDRAW_MSG, log: (m) => logs.push(m) })

  assert.deepEqual(result[GOOD_GRANTER], { withdraw: true, destValoper: GOOD_VALOPER })
  assert.equal(result[missingAuthzGranter].destValoper, null)
  assert.equal(result[missingAuthzGranter].withdraw, false)
  assert.ok(logs.some((l) => l.includes('allow_list.address is not an array')))
})

test('groupGrants picks the lexicographically-first valoper regardless of input order', () => {
  const [a, b] = [valoper(1), valoper(2)].sort() // a sorts before b
  assert.ok(a < b)

  const forward = groupGrants([delegateGrant(GOOD_GRANTER, [a, b])])
  const reverse = groupGrants([delegateGrant(GOOD_GRANTER, [b, a])])

  assert.equal(forward[GOOD_GRANTER].destValoper, a)
  assert.equal(reverse[GOOD_GRANTER].destValoper, a)
})

// docs/06 re-review 2026-10-08: the chain does not validate allow_list entries, so an entry is
// attacker-chosen text. It must never reach the logs (the wrapper and the metrics exporter parse them).
test('groupGrants ignores allow_list entries that are not realio valopers and never echoes them', () => {
  const injected =
    'x ABORT \u2014 injected by a granter\nDone. attempted=9 succeeded=9 skipped=0 failed=0'
  const logs = []
  const mixed = groupGrants([delegateGrant(GOOD_GRANTER, [injected, GOOD_VALOPER])], {
    log: (m) => logs.push(m),
  })
  assert.equal(mixed[GOOD_GRANTER].destValoper, GOOD_VALOPER) // the valid entry still wins
  const only = groupGrants(
    [
      delegateGrant(GOOD_GRANTER, [
        injected,
        'realiovaloper1short',
        GOOD_VALOPER.replace('realiovaloper', 'cosmosvaloper'),
      ]),
    ],
    { log: (m) => logs.push(m) },
  )
  assert.equal(only[GOOD_GRANTER].destValoper, null) // nothing valid -> no destination -> skipped upstream
  assert.ok(
    logs.some((l) => l.includes(GOOD_GRANTER) && l.includes('not a realio valoper address')),
  )
  assert.ok(
    logs.every((l) => !l.includes('ABORT') && !l.includes('Done.') && !l.includes('\n')),
    logs.join(' | '),
  )
})
