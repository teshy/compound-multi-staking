// WO-057 D2/D3/D4 (C-9, C-10, C-13, C-27, C-42): the redelegate source list's decisions as pure
// functions — an unresolved bond coin is never selectable, the entries come out of the rows with
// today's exact messages, and a stale load can never be applied.
import { describe, expect, it } from 'vitest'
import {
  toDelegationInfo,
  collectRedelegateEntries,
  createLoadTracker,
  UNRESOLVED_NOTE,
  UNSUPPORTED_NOTE,
  isRedelegateSource,
  type DelegationInfo,
} from './delegations'
import {
  DENOM,
  RST_DENOM,
  DSTRX_DENOM,
  TESHY_VALOPER,
  TESHY_RST_VALOPER,
  TESHY_DSTRX_VALOPER,
} from './realio'

const RIO = 10n ** 18n
const base = (n: number, amount = 5n * RIO) => ({
  validatorAddress: `realiovaloper1src${n}`,
  moniker: `Val ${n}`,
  amount,
})

describe('toDelegationInfo', () => {
  it.each([
    [DENOM, TESHY_VALOPER, 'RIO'],
    [RST_DENOM, TESHY_RST_VALOPER, 'RST'],
    [DSTRX_DENOM, TESHY_DSTRX_VALOPER, 'DSTRX'],
  ])('a resolved %s bond coin → selectable, destination %s, label %s', (coin, dest, label) => {
    const d = toDelegationInfo(base(1), coin)
    expect(d).toMatchObject({ resolved: true, bondCoin: coin, destValoper: dest, label })
  })

  it('an UNRESOLVED bond coin (lookup failed) is not selectable and has NO destination', () => {
    const d = toDelegationInfo(base(1), undefined)
    expect(d.resolved).toBe(false)
    expect(d).not.toHaveProperty('destValoper')
    expect(d).not.toHaveProperty('bondCoin')
  })

  it('never defaults a failed lookup to the RIO validator', () => {
    const d = toDelegationInfo(base(1), undefined) as unknown as Record<string, unknown>
    expect(Object.values(d)).not.toContain(TESHY_VALOPER)
    expect(Object.values(d)).not.toContain(DENOM)
  })

  it('exposes the note text the row shows', () => {
    expect(UNRESOLVED_NOTE).toBe("couldn't determine this validator's token — try again later")
  })

  // WO-071 D4 (docs/06 gate 2026-10-16, I-2): only the three Teshy bond coins resolve.
  it('a lookup that failed is unresolved with reason lookup-failed', () => {
    expect(toDelegationInfo(base(1), undefined)).toMatchObject({
      resolved: false,
      reason: 'lookup-failed',
    })
  })

  it('an unknown but resolved bond coin is unresolved with reason unsupported, never sent to RIO', () => {
    const d = toDelegationInfo(base(1), 'erc20:0x0000000000000000000000000000000000000001')
    expect(d).toMatchObject({ resolved: false, reason: 'unsupported' })
    expect(d).not.toHaveProperty('destValoper')
    expect(d).not.toHaveProperty('bondCoin')
    expect(Object.values(d as unknown as Record<string, unknown>)).not.toContain(TESHY_VALOPER)
  })

  // WO-074 D2 (docs/06 delta gate 2026-10-19, PG-6): the bond-coin match is exact, so a near miss is
  // unsupported, never resolved to the coin it resembles.
  it.each(
    [
      ['an empty string', ''],
      ['the upper-cased RIO denom', 'ARIO'],
      ['the lower-cased DSTRX denom', DSTRX_DENOM.toLowerCase()],
      ['a coin with surrounding spaces', ` ${DENOM} `],
    ].filter(([, coin]) => coin !== DSTRX_DENOM),
  )('%s is unresolved with reason unsupported', (_label, coin) => {
    expect(toDelegationInfo(base(1), coin)).toMatchObject({
      resolved: false,
      reason: 'unsupported',
    })
  })

  it('exposes the unsupported note text the row shows', () => {
    expect(UNSUPPORTED_NOTE).toBe("this validator's token can't be moved to a Teshy validator here")
  })
})

describe('collectRedelegateEntries', () => {
  const delegations: DelegationInfo[] = [
    toDelegationInfo(base(0), DENOM),
    toDelegationInfo(base(1, 7n * RIO), RST_DENOM),
    toDelegationInfo(base(2), undefined),
  ]
  const row = (index: number, checked: boolean, amountText: string) => ({
    index,
    checked,
    amountText,
  })

  it('builds one entry per checked row with src, the right destination, amount and bond denom', () => {
    const r = collectRedelegateEntries([row(0, true, '5'), row(1, true, '2.5')], delegations)
    expect(r).toEqual({
      entries: [
        {
          srcValoper: 'realiovaloper1src0',
          destValoper: TESHY_VALOPER,
          amount: 5n * RIO,
          denom: DENOM,
        },
        {
          srcValoper: 'realiovaloper1src1',
          destValoper: TESHY_RST_VALOPER,
          amount: 2_500000000000000000n,
          denom: RST_DENOM,
        },
      ],
    })
  })

  it('skips unchecked rows and zero amounts; trims the amount text', () => {
    const r = collectRedelegateEntries(
      [row(0, false, '5'), row(1, true, '0'), row(0, true, ' 1 ')],
      delegations,
    )
    expect(r).toEqual({
      entries: [
        { srcValoper: 'realiovaloper1src0', destValoper: TESHY_VALOPER, amount: RIO, denom: DENOM },
      ],
    })
  })

  it('an invalid amount → "<moniker>: <message>" and no entries', () => {
    expect(collectRedelegateEntries([row(0, true, 'abc')], delegations)).toEqual({
      error: 'Val 0: Invalid amount: "abc"',
    })
    expect(collectRedelegateEntries([row(0, true, '0.0000000000000000001')], delegations)).toEqual({
      error: 'Val 0: Too many decimal places (max 18)',
    })
  })

  it('an amount above the current delegation → the exact message with the label', () => {
    expect(collectRedelegateEntries([row(1, true, '7.000000000000000001')], delegations)).toEqual({
      error: 'Val 1: amount exceeds current delegation of 7 RST',
    })
  })

  it('exactly the delegation amount is allowed', () => {
    const r = collectRedelegateEntries([row(1, true, '7')], delegations)
    expect('entries' in r && r.entries[0].amount).toBe(7n * RIO)
  })

  it('nothing selected → "Select at least one delegation to redelegate"', () => {
    expect(collectRedelegateEntries([row(0, false, '5')], delegations)).toEqual({
      error: 'Select at least one delegation to redelegate',
    })
    expect(collectRedelegateEntries([], delegations)).toEqual({
      error: 'Select at least one delegation to redelegate',
    })
  })

  it('an index with no delegation is skipped (as today)', () => {
    const r = collectRedelegateEntries([row(9, true, '1'), row(0, true, '1')], delegations)
    expect('entries' in r && r.entries).toHaveLength(1)
  })

  it('an unsupported row (read, but not a Teshy bond coin) passed through is not collected (WO-074 D2)', () => {
    const unsupported = toDelegationInfo(
      base(3),
      'erc20:0x0000000000000000000000000000000000000001',
    )
    expect(unsupported).toMatchObject({ resolved: false, reason: 'unsupported' })
    expect(collectRedelegateEntries([row(0, true, '1')], [unsupported])).toEqual({
      error: 'Select at least one delegation to redelegate',
    })
    const mixed = collectRedelegateEntries(
      [row(0, true, '1'), row(1, true, '1')],
      [unsupported, ...delegations],
    )
    expect('entries' in mixed && mixed.entries.map((e) => e.srcValoper)).toEqual([
      'realiovaloper1src0',
    ])
  })

  it('an UNRESOLVED row is never turned into an entry, even if somehow checked', () => {
    expect(collectRedelegateEntries([row(2, true, '1')], delegations)).toEqual({
      error: 'Select at least one delegation to redelegate',
    })
    const mixed = collectRedelegateEntries([row(2, true, '1'), row(0, true, '1')], delegations)
    expect('entries' in mixed && mixed.entries.map((e) => e.srcValoper)).toEqual([
      'realiovaloper1src0',
    ])
  })
})

describe('createLoadTracker (C-9: a stale load is never applied)', () => {
  it('only the most recently started load is current', () => {
    const t = createLoadTracker()
    const a = t.start()
    expect(t.isCurrent(a)).toBe(true)
    const b = t.start()
    expect(t.isCurrent(a)).toBe(false)
    expect(t.isCurrent(b)).toBe(true)
  })

  it('invalidate() (disconnect) makes every in-flight load stale', () => {
    const t = createLoadTracker()
    const a = t.start()
    t.invalidate()
    expect(t.isCurrent(a)).toBe(false)
    const b = t.start()
    expect(t.isCurrent(b)).toBe(true)
  })

  it('ids are strictly increasing', () => {
    const t = createLoadTracker()
    const ids = [t.start(), t.start(), t.start()]
    expect(ids).toEqual([...ids].sort((x, y) => x - y))
    expect(new Set(ids).size).toBe(3)
  })
})

describe('isRedelegateSource (unchanged by WO-057, pinned because the list builds on it)', () => {
  it('excludes current Teshy validators and sub-microtoken amounts', () => {
    expect(isRedelegateSource(TESHY_VALOPER, 5n * RIO)).toBe(false)
    expect(isRedelegateSource('realiovaloper1src0', 10n ** 12n - 1n)).toBe(false)
    expect(isRedelegateSource('realiovaloper1src0', 10n ** 12n)).toBe(true)
  })
})
