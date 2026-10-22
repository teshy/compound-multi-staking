// WO-057 D2 (C-8, C-11, C-13): a balance is KNOWN or it is absent — a failed read never becomes 0.
// A denom missing from the result means "unknown", and the form refuses to stake it (stakes.test.ts).
import { describe, expect, it } from 'vitest'
import { loadBalances, type BalanceDeps } from './balances'
import { DENOM, RST_DENOM, DSTRX_DENOM, TESHY_VALOPER, TESHY_DSTRX_VALOPER } from './realio'

const ADDR = 'realio10eq6w0a7fpety33uag2f55e9tewxazt4v28aem'
const RIO = 10n ** 18n
const OTHER_VALOPER = 'realiovaloper1otherxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'

const bank = (...coins: [string, string][]) => ({
  balances: coins.map(([denom, amount]) => ({ denom, amount })),
})
const deleg = (valoper: string, amount: bigint) => ({
  delegation: { delegator_address: ADDR, validator_address: valoper, shares: amount.toString() },
  balance: { denom: 'x', amount: amount.toString() },
})

interface Knobs {
  bank?: unknown | Error
  delegations?: unknown | Error
  erc20?: bigint | Error
  bondCoin?: Record<string, string | Error>
}

function deps(k: Knobs): BalanceDeps & { urls: string[] } {
  const urls: string[] = []
  const settle = <T>(v: T | Error): Promise<T> =>
    v instanceof Error ? Promise.reject(v) : Promise.resolve(v)
  return {
    urls,
    getJson: (async (url: string) => {
      urls.push(url)
      if (url.includes('/cosmos/bank/')) return settle(k.bank ?? bank())
      if (url.includes('/cosmos/staking/v1beta1/delegations/'))
        return settle(k.delegations ?? { delegation_responses: [] })
      throw new Error(`unexpected GET ${url}`)
    }) as BalanceDeps['getJson'],
    fetchErc20Balance: () => settle(k.erc20 ?? 0n),
    fetchValidatorBondCoin: (v: string) => settle(k.bondCoin?.[v] ?? DENOM),
  }
}

describe('loadBalances — happy path', () => {
  it('RIO/RST come from the bank query; an absent denom is a KNOWN zero', async () => {
    const r = await loadBalances(
      ADDR,
      deps({ bank: bank([DENOM, '7000000000000000000']), erc20: 0n }),
    )
    expect(r.failed).toEqual({ bank: false, dstrx: false })
    expect(r.balances[DENOM]).toBe(7n * RIO)
    expect(r.balances[RST_DENOM]).toBe(0n) // bank omits zero balances: known, not unknown
    expect(r.balances[DSTRX_DENOM]).toBe(0n)
  })

  it('liquid DSTRX = ERC-20 total − the delegations whose validator bonds DSTRX', async () => {
    const r = await loadBalances(
      ADDR,
      deps({
        erc20: 10n * RIO,
        delegations: {
          delegation_responses: [
            deleg(TESHY_DSTRX_VALOPER, 4n * RIO),
            deleg(TESHY_VALOPER, 3n * RIO),
          ],
        },
        bondCoin: { [TESHY_DSTRX_VALOPER]: DSTRX_DENOM, [TESHY_VALOPER]: DENOM },
      }),
    )
    expect(r.balances[DSTRX_DENOM]).toBe(6n * RIO)
  })

  it('zero-amount delegations are ignored (no bond-coin lookup for them)', async () => {
    const looked: string[] = []
    const d = deps({
      erc20: 5n * RIO,
      delegations: { delegation_responses: [deleg(OTHER_VALOPER, 0n)] },
    })
    d.fetchValidatorBondCoin = async (v) => {
      looked.push(v)
      return DENOM
    }
    const r = await loadBalances(ADDR, d)
    expect(looked).toEqual([])
    expect(r.balances[DSTRX_DENOM]).toBe(5n * RIO)
  })

  it('staked above the ERC-20 total clamps to a known 0', async () => {
    const r = await loadBalances(
      ADDR,
      deps({
        erc20: RIO,
        delegations: { delegation_responses: [deleg(TESHY_DSTRX_VALOPER, 2n * RIO)] },
        bondCoin: { [TESHY_DSTRX_VALOPER]: DSTRX_DENOM },
      }),
    )
    expect(r.balances[DSTRX_DENOM]).toBe(0n)
  })
})

describe('loadBalances — fail closed (never fail to zero)', () => {
  it('the delegations query failing makes liquid DSTRX UNKNOWN, not ERC-20 total − 0', async () => {
    const r = await loadBalances(
      ADDR,
      deps({ bank: bank([DENOM, '1']), erc20: 10n * RIO, delegations: new Error('HTTP 500') }),
    )
    expect(DSTRX_DENOM in r.balances).toBe(false)
    expect(r.failed.dstrx).toBe(true)
    // the independent bank query is unaffected
    expect(r.balances[DENOM]).toBe(1n)
    expect(r.failed.bank).toBe(false)
  })

  it('the ERC-20 total failing makes DSTRX unknown', async () => {
    const r = await loadBalances(ADDR, deps({ erc20: new Error('indexing_error') }))
    expect(DSTRX_DENOM in r.balances).toBe(false)
    expect(r.failed.dstrx).toBe(true)
  })

  it('a bond-coin lookup failing for a held delegation makes DSTRX unknown (no RIO fallback)', async () => {
    // the failed one might be a DSTRX validator: treating it as RIO would overstate liquid DSTRX
    const r = await loadBalances(
      ADDR,
      deps({
        erc20: 10n * RIO,
        delegations: {
          delegation_responses: [deleg(TESHY_DSTRX_VALOPER, 4n * RIO), deleg(OTHER_VALOPER, RIO)],
        },
        bondCoin: { [TESHY_DSTRX_VALOPER]: DSTRX_DENOM, [OTHER_VALOPER]: new Error('abci down') },
      }),
    )
    expect(DSTRX_DENOM in r.balances).toBe(false)
    expect(r.failed.dstrx).toBe(true)
  })

  it('the bank query failing makes RIO and RST unknown (keys absent), DSTRX still loads', async () => {
    const r = await loadBalances(ADDR, deps({ bank: new Error('HTTP 502'), erc20: 3n * RIO }))
    expect(DENOM in r.balances).toBe(false)
    expect(RST_DENOM in r.balances).toBe(false)
    expect(r.failed.bank).toBe(true)
    expect(r.balances[DSTRX_DENOM]).toBe(3n * RIO)
  })

  it('an unparseable bank amount counts as a bank failure, not a zero', async () => {
    const r = await loadBalances(ADDR, deps({ bank: bank([DENOM, 'not-a-number']) }))
    expect(DENOM in r.balances).toBe(false)
    expect(r.failed.bank).toBe(true)
  })

  it('both queries failing leaves NO known balance at all', async () => {
    const r = await loadBalances(ADDR, deps({ bank: new Error('x'), erc20: new Error('y') }))
    expect(r.balances).toEqual({})
    expect(r.failed).toEqual({ bank: true, dstrx: true })
  })
})
