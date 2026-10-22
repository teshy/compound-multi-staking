// WO-049 (T-11, T-15 consumer half): the delegate-form validation, incl. the 2-RIO gas reserve.
import { describe, expect, it } from 'vitest'
import { validateStakes, type StakeRow } from './stakes'
import { DENOM, RST_DENOM, DSTRX_DENOM, TESHY_VALOPER, TESHY_RST_VALOPER } from './realio'

const RIO = 10n ** 18n
const GAS_RESERVE = 2n * RIO

const row = (over: Partial<StakeRow>): StakeRow => ({
  label: 'RIO',
  raw: '',
  denom: DENOM,
  valoper: TESHY_VALOPER,
  decimals: 18,
  ...over,
})
const rst = (raw: string) =>
  row({ label: 'RST', raw, denom: RST_DENOM, valoper: TESHY_RST_VALOPER })

describe('validateStakes', () => {
  it('turns valid rows into stake entries in order', () => {
    const r = validateStakes(
      [row({ raw: '3.5' }), rst('1')],
      { [DENOM]: 10n * RIO, [RST_DENOM]: 5n * RIO },
      GAS_RESERVE,
    )
    expect(r.error).toBeUndefined()
    expect(r.stakes).toEqual([
      { denom: DENOM, valoper: TESHY_VALOPER, amount: 3_500000000000000000n },
      { denom: RST_DENOM, valoper: TESHY_RST_VALOPER, amount: RIO },
    ])
  })

  it('skips blank and zero rows', () => {
    const r = validateStakes(
      [row({ raw: '   ' }), rst('0'), rst('0.0')],
      { [DENOM]: 10n * RIO, [RST_DENOM]: 5n * RIO },
      GAS_RESERVE,
    )
    expect(r).toEqual({ stakes: [] })
  })

  it('amount above the balance → the exact error, no stakes', () => {
    const r = validateStakes([row({ raw: '11' })], { [DENOM]: 10n * RIO }, GAS_RESERVE)
    expect(r).toEqual({ stakes: [], error: 'RIO: amount exceeds your balance' })
  })

  it('an UNKNOWN balance (denom absent) refuses that denom with its own message — never "counts as 0" (WO-057 D2)', () => {
    const r = validateStakes([rst('1')], {}, GAS_RESERVE)
    expect(r).toEqual({
      stakes: [],
      error: 'RST: balance unavailable — try again later',
    })
  })

  it('an unknown balance only blocks the denom being staked; blank rows of unknown denoms are fine', () => {
    const r = validateStakes([row({ raw: '1' }), rst('')], { [DENOM]: 10n * RIO }, GAS_RESERVE)
    expect(r.error).toBeUndefined()
    expect(r.stakes).toHaveLength(1)
  })

  it('a KNOWN zero balance still reads as "amount exceeds your balance"', () => {
    expect(validateStakes([rst('1')], { [RST_DENOM]: 0n }, GAS_RESERVE).error).toBe(
      'RST: amount exceeds your balance',
    )
  })

  it('the gas-reserve message uses the reserve parameter, not a hardcoded 2 (C-39/C-65)', () => {
    const r = validateStakes([row({ raw: '9' })], { [DENOM]: 10n * RIO }, 3n * RIO)
    expect(r.error).toBe('RIO: keep at least 3 RIO for gas. Max stake: 7 RIO')
  })

  it('RIO leaving less than 2 RIO → the exact gas-reserve error with the max stake', () => {
    const r = validateStakes([row({ raw: '9' })], { [DENOM]: 10n * RIO }, GAS_RESERVE)
    expect(r).toEqual({
      stakes: [],
      error: 'RIO: keep at least 2 RIO for gas. Max stake: 8 RIO',
    })
  })

  it('leaving EXACTLY 2 RIO is allowed (the boundary is strict <)', () => {
    const r = validateStakes([row({ raw: '8' })], { [DENOM]: 10n * RIO }, GAS_RESERVE)
    expect(r.error).toBeUndefined()
    expect(r.stakes).toHaveLength(1)
    expect(r.stakes[0].amount).toBe(8n * RIO)
  })

  it('balance at or below the reserve → "Max stake: 0 RIO"', () => {
    for (const bal of [2n * RIO, RIO]) {
      const r = validateStakes([row({ raw: '1' })], { [DENOM]: bal }, GAS_RESERVE)
      expect(r).toEqual({
        stakes: [],
        error: 'RIO: keep at least 2 RIO for gas. Max stake: 0 RIO',
      })
    }
  })

  it('a non-RIO row ignores the reserve (stake the whole RST / DSTRX balance)', () => {
    const r = validateStakes(
      [rst('5'), row({ label: 'DSTRX', raw: '7', denom: DSTRX_DENOM, valoper: TESHY_VALOPER })],
      { [RST_DENOM]: 5n * RIO, [DSTRX_DENOM]: 7n * RIO },
      GAS_RESERVE,
    )
    expect(r.error).toBeUndefined()
    expect(r.stakes.map((s) => s.amount)).toEqual([5n * RIO, 7n * RIO])
  })

  it('an invalid amount → "<label>: <message>"', () => {
    expect(validateStakes([rst('abc')], { [RST_DENOM]: RIO }, GAS_RESERVE)).toEqual({
      stakes: [],
      error: 'RST: Invalid amount: "abc"',
    })
    const tooPrecise = validateStakes([rst('0.0000000000000000001')], {}, GAS_RESERVE)
    expect(tooPrecise.error).toBe('RST: Too many decimal places (max 18)')
  })

  it('the first failing row wins and discards the valid rows before it', () => {
    const r = validateStakes(
      [row({ raw: '1' }), rst('99')],
      { [DENOM]: 10n * RIO, [RST_DENOM]: RIO },
      GAS_RESERVE,
    )
    expect(r).toEqual({ stakes: [], error: 'RST: amount exceeds your balance' })
  })
})
