// Exact-integer coin() replacement for tx-amount encoding (BUG-2, TEST-QA-FINDINGS.md).
//
// `bot/src/utils/Helpers.mjs`'s coin() routes the amount through mathjs
// floor()/format() in float64, which silently re-rounds any integer beyond
// 2^53 (~0.009 RIO — i.e. essentially every real compound amount). All bot
// amounts here already arrive as exact BigInt/decimal-integer strings, so no
// float path is needed or safe: validate the string is a bare non-negative
// integer and pass it through unchanged.
import { coin as _coin } from '@cosmjs/stargate'

export function exactCoin(amount, denom) {
  const str = String(amount)
  if (!/^[0-9]+$/.test(str)) {
    throw new Error(`exactCoin: amount must be a non-negative integer string, got ${JSON.stringify(str)}`)
  }
  return _coin(str, denom)
}

// Floors a DecCoin amount string (e.g. '1234.000000000000000000', or a plain integer
// string) to a bigint ario amount by truncating at the decimal point (CH-008) — the
// same hand-rolled `BigInt(String(x).split('.')[0])` idiom that was duplicated across
// multi-compound.mjs, claim-rewards.mjs, and a since-deleted one-shot script. Throws (rather than
// silently mis-parsing) on negative amounts, exponent notation, or any other shape
// that isn't a bare non-negative decimal/integer string.
export function floorDecCoinAmount(amount) {
  const str = String(amount)
  if (!/^[0-9]+(\.[0-9]+)?$/.test(str)) {
    throw new Error(`floorDecCoinAmount: amount must be a non-negative decimal or integer string, got ${JSON.stringify(str)}`)
  }
  return BigInt(str.split('.')[0])
}
