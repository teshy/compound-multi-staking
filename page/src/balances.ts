// Reads the account's stakeable balances (WO-057 D2: C-8, C-11, C-13). Every balance is KNOWN or
// ABSENT from the result — a failed read is never turned into 0, because a zero (or a stale cached
// value) would let the form validate a stake against a balance the page never saw.
import { getJson } from './http'
import {
  fetchErc20Balance,
  fetchValidatorBondCoin,
  REST_URL,
  DENOM,
  RST_DENOM,
  DSTRX_DENOM,
} from './realio'
import type { DelegationResponse } from './delegations'

export interface BalanceDeps {
  getJson: <T>(url: string) => Promise<T>
  fetchErc20Balance: (contractAddress: string, bech32Addr: string) => Promise<bigint>
  fetchValidatorBondCoin: (valoper: string) => Promise<string>
}

const defaultDeps: BalanceDeps = { getJson, fetchErc20Balance, fetchValidatorBondCoin }

interface LoadedBalances {
  // Only the denoms that were read. RIO/RST are a known 0n when the bank omits them (it omits zero
  // balances); DSTRX is present only if the ERC-20 total AND every delegation's bond coin were read.
  balances: Record<string, bigint>
  failed: { bank: boolean; dstrx: boolean }
}

async function loadBank(address: string, deps: BalanceDeps): Promise<Record<string, bigint>> {
  const json = await deps.getJson<{ balances?: { denom: string; amount: string }[] }>(
    `${REST_URL}/cosmos/bank/v1beta1/balances/${address}?pagination.limit=100`,
  )
  const out: Record<string, bigint> = { [DENOM]: 0n, [RST_DENOM]: 0n }
  for (const c of json?.balances ?? []) out[c.denom] = BigInt(c.amount)
  return out
}

// DSTRX is an ERC-20 held in EVM state. The subgraph returns the total ERC-20 balance including
// staked tokens (MsgDelegateEVM does not reduce the ERC-20 record), so
// liquid = subgraph total − the sum of all DSTRX-bonding delegations. If any of the inputs cannot be
// read the liquid amount is unknown: a missing delegation or an unresolved bond coin would
// understate what is staked and overstate what the user may stake.
async function loadLiquidDstrx(address: string, deps: BalanceDeps): Promise<bigint> {
  const [total, delegRes] = await Promise.all([
    deps.fetchErc20Balance(DSTRX_DENOM.replace('erc20:', ''), address),
    deps.getJson<{ delegation_responses?: DelegationResponse[] }>(
      `${REST_URL}/cosmos/staking/v1beta1/delegations/${address}?pagination.limit=100`,
    ),
  ])
  const delegations = (delegRes?.delegation_responses ?? []).filter(
    (d) => BigInt(d.balance.amount) > 0n,
  )
  const bondCoins = await Promise.all(
    delegations.map((d) => deps.fetchValidatorBondCoin(d.delegation.validator_address)),
  )
  const staked = delegations.reduce(
    (sum, d, i) => (bondCoins[i] === DSTRX_DENOM ? sum + BigInt(d.balance.amount) : sum),
    0n,
  )
  return total > staked ? total - staked : 0n
}

export async function loadBalances(
  address: string,
  deps: BalanceDeps = defaultDeps,
): Promise<LoadedBalances> {
  const balances: Record<string, bigint> = {}
  const failed = { bank: false, dstrx: false }
  const [bank, dstrx] = await Promise.allSettled([
    loadBank(address, deps),
    loadLiquidDstrx(address, deps),
  ])
  if (bank.status === 'fulfilled') Object.assign(balances, bank.value)
  else failed.bank = true
  if (dstrx.status === 'fulfilled') balances[DSTRX_DENOM] = dstrx.value
  else {
    failed.dstrx = true
    delete balances[DSTRX_DENOM] // whatever the bank listed under that denom is not the liquid ERC-20
  }
  return { balances, failed }
}
