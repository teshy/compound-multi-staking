// Pure helpers for scripts/multi-compound.mjs — BigInt only, no I/O — so what gets signed is
// pinned by unit tests instead of living inline in the script.

// How much of a delegator's rewards to delegate, keeping `gasReserve` liquid afterwards.
// After the tx: liquid = current_liquid + total(withdrawn) - amount >= gasReserve
// => amount <= liquid + total - gasReserve. The full reward is always withdrawn; any uncapped
// portion stays liquid. Returns { amount, capped, skip }:
//   capped - the gas-reserve cap bound the amount below the rewards
//   skip   - the (capped) amount is below minReward, so nothing should be sent
// NOTE: the pre-cap `total < minReward` anti-spam gate (H1, docs/12) is NOT here; it stays inline
// in multi-compound.mjs, before any balance query or simulate.
export function computeDelegateAmount({ total, liquid, gasReserve, minReward }) {
  const maxDelegate = liquid + total - gasReserve
  const amount = maxDelegate >= total ? total : (maxDelegate > 0n ? maxDelegate : 0n)
  return { amount, capped: amount < total, skip: amount < minReward }
}

// Strict BigInt env var for money amounts (ario): same contract as parseBoundedInt, but exact above
// 2^53 and returned as a bigint. undefined/'' -> fallback (untouched); otherwise digits only and within
// [min, max] (bigints, inclusive), else throw an Error naming the variable. A raw BigInt(env) would
// accept '-5', '0x10' and ' 5 ', and name nothing when it throws (WO-059, C-50).
export function parseBoundedBigInt(name, raw, fallback, { min, max }) {
  if (raw === undefined || raw === '') return fallback
  const bad = () => new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`)
  if (!/^\d+$/.test(raw)) throw bad()
  const n = BigInt(raw)
  if (n < min || n > max) throw bad()
  return n
}

// Strict integer env var: undefined/'' -> fallback; otherwise it must be digits only and within
// [min, max], else throw an Error naming the variable (the caller exits before anything is signed).
export function parseBoundedInt(name, raw, fallback, { min, max }) {
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`)
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`)
  }
  return n
}
