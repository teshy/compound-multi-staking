// Which of a user's delegations the redelegate mode offers to move (WO-045).
import {
  TESHY_VALOPER,
  TESHY_RST_VALOPER,
  TESHY_DSTRX_VALOPER,
  TESHY_LEGACY_VALOPERS,
  DECIMALS,
  bondCoinLabel,
  bondCoinToTeshyValoper,
  DENOM,
  RST_DENOM,
  DSTRX_DENOM,
  fromDisplay,
  toRio,
} from './realio'
import type { RedelegateEntry } from './grants'

// Below 1 microtoken (10^12 attounits): zero-balance entries the staking endpoint lists for
// RST/DSTRX validators, and sub-microtoken residuals a shares-rounding retry leaves behind.
export const MIN_REDELEGATE_AMOUNT = 10n ** 12n

// Stake already on a CURRENT Teshy validator is not offered. The legacy (pre-v1.8.0) validators
// are deliberately NOT in this set: v1.8.0 (height 20,106,800) moved their stake on-chain except
// where the delegator had a redelegation in progress into them, so whatever is still there is
// stake the upgrade skipped, and its owner must be able to move it. A legacy validator is only
// ever a SOURCE: destinations come from bondCoinToTeshyValoper, which returns current validators.
const CURRENT_TESHY = new Set([TESHY_VALOPER, TESHY_RST_VALOPER, TESHY_DSTRX_VALOPER])
const LEGACY_TESHY = new Set(TESHY_LEGACY_VALOPERS)

export const LEGACY_TESHY_LABEL = 'old Teshy validator (jailed by v1.8.0)'

export function isLegacyTeshyValoper(valoper: string): boolean {
  return LEGACY_TESHY.has(valoper)
}

export function isRedelegateSource(valoper: string, amount: bigint): boolean {
  return !CURRENT_TESHY.has(valoper) && amount >= MIN_REDELEGATE_AMOUNT
}

// ── The loaded redelegate source list (WO-057) ───────────────────────────────

// Shape of one entry in a /cosmos/staking/v1beta1/delegations/{addr} response
// (delegation_responses[]) — used at every parse site (CH-012).
export interface DelegationResponse {
  delegation: { delegator_address: string; validator_address: string; shares: string }
  balance: { denom: string; amount: string }
}

interface DelegationBase {
  validatorAddress: string
  moniker: string
  amount: bigint
}

// A source whose bond coin was read: it can be redelegated to the Teshy validator for that coin.
interface ResolvedDelegation extends DelegationBase {
  resolved: true
  bondCoin: string // actual bond denom from the multistaking ABCI query (ario/arst/erc20:...)
  destValoper: string // Teshy validator to redelegate to
  label: string // display label (RIO/RST/DSTRX)
}

// A source that cannot be offered: its bond-coin lookup failed (WO-057 D2: the destination is
// unknowable), or it was read but is not one of the three Teshy bond coins (WO-071 D4, docs/06 gate
// 2026-10-16, I-2). The row is shown disabled. It never falls back to RIO — that would move another
// token's stake to a RIO validator.
interface UnresolvedDelegation extends DelegationBase {
  resolved: false
  reason: 'lookup-failed' | 'unsupported'
}

export type DelegationInfo = ResolvedDelegation | UnresolvedDelegation

export const UNRESOLVED_NOTE = "couldn't determine this validator's token — try again later"
export const UNSUPPORTED_NOTE = "this validator's token can't be moved to a Teshy validator here"

const TESHY_BOND_COINS = new Set([DENOM, RST_DENOM, DSTRX_DENOM])

export function toDelegationInfo(
  base: DelegationBase,
  bondCoin: string | undefined,
): DelegationInfo {
  if (bondCoin === undefined) return { ...base, resolved: false, reason: 'lookup-failed' }
  if (!TESHY_BOND_COINS.has(bondCoin)) return { ...base, resolved: false, reason: 'unsupported' }
  return {
    ...base,
    resolved: true,
    bondCoin,
    destValoper: bondCoinToTeshyValoper(bondCoin),
    label: bondCoinLabel(bondCoin),
  }
}

// One row of the redelegate list with the DOM already read out.
interface RedelegateRow {
  index: number
  checked: boolean
  amountText: string
}

// The redelegate entries for the checked rows, or the error to show (WO-057 D4: moved out of the
// click handler; the messages are the handler's, unchanged).
export function collectRedelegateEntries(
  rows: RedelegateRow[],
  delegations: DelegationInfo[],
): { entries: RedelegateEntry[] } | { error: string } {
  const entries: RedelegateEntry[] = []
  for (const row of rows) {
    if (!row.checked) continue
    const d = delegations[row.index]
    if (!d?.resolved) continue
    let amount: bigint
    try {
      amount = fromDisplay(row.amountText.trim(), DECIMALS)
    } catch (e) {
      return { error: `${d.moniker}: ${(e as Error)?.message || 'invalid amount'}` }
    }
    if (amount === 0n) continue
    if (amount > d.amount) {
      return {
        error: `${d.moniker}: amount exceeds current delegation of ${toRio(d.amount.toString())} ${d.label}`,
      }
    }
    entries.push({
      srcValoper: d.validatorAddress,
      destValoper: d.destValoper,
      amount,
      denom: d.bondCoin,
    })
  }
  if (!entries.length) return { error: 'Select at least one delegation to redelegate' }
  return { entries }
}

// Staleness guard for loadDelegations (C-9): each load takes an id before its first await and may
// apply its result only while it is still the current one. Disconnecting invalidates every load.
export function createLoadTracker() {
  let current = 0
  return {
    start: (): number => ++current,
    invalidate: (): void => {
      current++
    },
    isCurrent: (id: number): boolean => id === current,
  }
}
