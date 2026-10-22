// WO-044: the grant page targets the v1.8.0 replacement validators; the pre-v1.8.0 ones must never
// be a grant or redelegate destination. WO-045: after v1.8.0 (height 20,106,800) any stake still on
// a legacy validator is one the upgrade skipped, so it is offered as a redelegation SOURCE.
// (The decoded grant allow-list itself is pinned in grants.test.ts.)
import { describe, expect, it } from 'vitest'
import {
  TESHY_VALOPER,
  TESHY_RST_VALOPER,
  TESHY_DSTRX_VALOPER,
  TESHY_LEGACY_VALOPERS,
  DENOM,
  RST_DENOM,
  DSTRX_DENOM,
  bondCoinToTeshyValoper,
} from './realio'
import { isRedelegateSource, isLegacyTeshyValoper, MIN_REDELEGATE_AMOUNT } from './delegations'

const OTHER = 'realiovaloper1qqqsyqcyq5rqwzqfpg9scrgwpugpzysn4rxsd0'
const ONE = 10n ** 18n

describe('Teshy validator targets (v1.8.0 rotation)', () => {
  it('points RIO and RST at the replacement validators', () => {
    expect(TESHY_VALOPER).toBe('realiovaloper1fvh0yq5v8n5c2yz0cs5pkfdgx5t77x6vm3pr6y')
    expect(TESHY_RST_VALOPER).toBe('realiovaloper1dlsleh9f0gsf7tl2kvyra7pmy3z8w7nek4u780')
  })

  it('keeps legacy validators disjoint from every active target', () => {
    for (const v of [TESHY_VALOPER, TESHY_RST_VALOPER, TESHY_DSTRX_VALOPER]) {
      expect(TESHY_LEGACY_VALOPERS).not.toContain(v)
    }
  })
})

describe('legacy validators are a redelegation source, never a destination (WO-045)', () => {
  // The grant allow-list ("exactly [TESHY_VALOPER], no legacy") is decoded and pinned in
  // grants.test.ts ('grant 1 is a StakeAuthorization ...').
  it('bondCoinToTeshyValoper never returns a legacy validator, for any bond coin', () => {
    for (const denom of [DENOM, RST_DENOM, DSTRX_DENOM, 'unknown-denom', '']) {
      expect(TESHY_LEGACY_VALOPERS).not.toContain(bondCoinToTeshyValoper(denom))
    }
  })

  it('a delegation on a legacy validator is offered as a redelegation source', () => {
    for (const legacy of TESHY_LEGACY_VALOPERS) {
      expect(isRedelegateSource(legacy, ONE)).toBe(true)
      expect(isLegacyTeshyValoper(legacy)).toBe(true)
    }
  })

  it('a delegation already on a current Teshy validator is not offered', () => {
    for (const v of [TESHY_VALOPER, TESHY_RST_VALOPER, TESHY_DSTRX_VALOPER]) {
      expect(isRedelegateSource(v, ONE)).toBe(false)
      expect(isLegacyTeshyValoper(v)).toBe(false)
    }
  })

  it('any other validator is offered, and nothing below the 1-microtoken floor is', () => {
    expect(isRedelegateSource(OTHER, ONE)).toBe(true)
    expect(isLegacyTeshyValoper(OTHER)).toBe(false)
    expect(MIN_REDELEGATE_AMOUNT).toBe(10n ** 12n)
    expect(isRedelegateSource(OTHER, MIN_REDELEGATE_AMOUNT)).toBe(true)
    expect(isRedelegateSource(OTHER, MIN_REDELEGATE_AMOUNT - 1n)).toBe(false)
    expect(isRedelegateSource(TESHY_LEGACY_VALOPERS[0], MIN_REDELEGATE_AMOUNT - 1n)).toBe(false)
  })
})
