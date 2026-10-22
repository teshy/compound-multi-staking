import { DENOM, fromDisplay, toRio } from './realio'
import type { StakeEntry } from './grants'

// One row of the delegate form, with the DOM already read out (raw = the input's text).
export interface StakeRow {
  label: string
  raw: string
  denom: string
  valoper: string
  decimals: number
}

// Validate the delegate form. Returns the stakes to submit, or an error (and no stakes).
// `balances` holds only KNOWN balances (a denom whose read failed is absent and refused).
// `gasReserve` is only enforced on RIO (the gas denom); RST/DSTRX are not reserve-limited.
export function validateStakes(
  rows: StakeRow[],
  balances: Record<string, bigint>,
  gasReserve: bigint,
): { stakes: StakeEntry[]; error?: string } {
  const stakes: StakeEntry[] = []
  for (const row of rows) {
    const raw = row.raw.trim()
    if (!raw) continue
    let amount: bigint
    try {
      amount = fromDisplay(raw, row.decimals)
    } catch (e: any) {
      return { stakes: [], error: `${row.label}: ${e?.message || 'invalid amount'}` }
    }
    if (amount === 0n) continue
    // A denom absent from `balances` is UNKNOWN (its read failed), not zero: never stake against it.
    const available = balances[row.denom]
    if (available === undefined) {
      return { stakes: [], error: `${row.label}: balance unavailable — try again later` }
    }
    if (amount > available) {
      return { stakes: [], error: `${row.label}: amount exceeds your balance` }
    }
    if (row.denom === DENOM && available - amount < gasReserve) {
      const max = available > gasReserve ? toRio((available - gasReserve).toString()) : '0'
      return {
        stakes: [],
        error: `RIO: keep at least ${toRio(gasReserve.toString())} RIO for gas. Max stake: ${max} RIO`,
      }
    }
    stakes.push({ denom: row.denom, valoper: row.valoper, amount })
  }
  return { stakes }
}
