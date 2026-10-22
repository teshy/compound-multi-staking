// Shared simulate/broadcast tails for the bot's signing scripts (CH-005/009).
// Two independent pieces, mirroring lib/wallet.mjs's extraction style:
//   - simulateWithFeeCap: multi-compound's per-delegator/per-batch fee-cap gate — simulate,
//     compute the ario fee, and report whether it's within the caller's cap. Never throws
//     or skips on its own; the caller decides what "over cap" means for it (skip one
//     delegator vs fail a whole batch), so behavior at each of the 3 call sites is unchanged.
//   - simulateAndBroadcast: the simulate -> gas/fee log -> DRY_RUN exit -> broadcast tail
//     shared by claim-rewards.mjs, stake-rio.mjs, and stake-dstrx.mjs. signAndBroadcast resolves
//     only on DeliverTx code 0 and THROWS on every other outcome (WO-040), so the tail maps the
//     two thrown outcomes (definite failure, unconfirmed) to a status and lets anything else rise.
// Neither calls process.exit — callers decide the exit code from the returned status, so
// this stays unit-testable with a mocked signingClient (no real network/process needed).
import { isUnconfirmed, isTxFailed } from '../../src/utils/TxConfirm.mjs'

// WO-075 D5 (docs/06 delta gate 2026-10-19, BT-6): the fee the cap is checked against is the fee the client
// will SIGN: `signingClient.getFee(gas)`, the very call signAndBroadcast makes (price = gasPricePrefer, else
// gasPrice). It used to be gas x a separately parsed `gasPriceNum`, which could drift from the signed price.
// A `gasPriceNum` option is ignored (no caller passes one since WO-076 D8). Every caller passes `feeDenom` (the
// network's fee denom), and a fee in any other denom throws; so does anything but exactly one coin with an integer
// amount. Over-cap is still the caller's decision (this never skips or exits).
export async function simulateWithFeeCap(
  signingClient,
  botAddress,
  msgs,
  memo,
  { gasMultiplier = 1.1, feeCapArio, feeDenom } = {},
) {
  const gas = await signingClient.simulate(botAddress, msgs, memo, gasMultiplier)
  const fee = signingClient.getFee(gas)
  const coins = fee?.amount
  if (!Array.isArray(coins) || coins.length !== 1) throw new Error(`getFee returned ${coins?.length ?? 'no'} fee coin(s), expected exactly one`)
  if (feeDenom !== undefined && coins[0].denom !== feeDenom) throw new Error(`getFee returned a fee in ${coins[0].denom}, expected ${feeDenom}`)
  const feeArio = BigInt(coins[0].amount)
  return { gas, feeArio, withinCap: feeArio <= feeCapArio }
}

// gasPriceNum is optional: stake-dstrx.mjs doesn't fetch it (no fee-cap logic there) and
// its tail only ever logged bare gas, never a fee line — passing it through as `undefined`
// preserves that script's exact (shorter) log output rather than forcing a fee line onto it.
export async function simulateAndBroadcast(
  signingClient,
  botAddress,
  msgs,
  memo,
  { gasMultiplier = 1.2, gasPriceNum, dryRun, label = '' } = {},
) {
  console.log(`${label}\nSimulating…`)
  const gas = await signingClient.simulate(botAddress, msgs, memo, gasMultiplier)
  let feeArio
  if (gasPriceNum !== undefined) {
    feeArio = BigInt(Math.ceil(gas)) * gasPriceNum
    console.log(`${label}Simulated gas: ${gas} | fee ~${feeArio} ario (${Number(feeArio) / 1e18} RIO)`)
  } else {
    console.log(`${label}Simulated gas: ${gas}`)
  }

  if (dryRun) {
    console.log(`${label}DRY — simulation passed. Set DRY_RUN=false to broadcast.`)
    return { broadcast: false, gas, feeArio }
  }

  console.log(`${label}Broadcasting…`)
  let res
  try {
    res = await signingClient.signAndBroadcast(botAddress, msgs, gas, memo)
  } catch (e) {
    // WO-040: submitted but unconfirmed is not "failed" — name the tx so it can be checked on-chain
    // before anyone re-runs. ok:false keeps every caller's nonzero exit (nothing auto-retries).
    if (isUnconfirmed(e)) {
      console.log(`${label}UNCONFIRMED ${e.transactionHash} — ${e.message}`)
      return { broadcast: true, ok: false, unconfirmed: true, transactionHash: e.transactionHash, gas, feeArio }
    }
    // WO-058: a definite failure (CheckTx or DeliverTx code != 0) is a thrown TxFailedError. Report it
    // here — callers print nothing of their own and exit nonzero on ok:false — instead of letting it
    // escape as an unhandled rejection.
    if (isTxFailed(e)) {
      console.log(`${label}FAIL code ${e.code}: ${e.rawLog}`)
      return { broadcast: true, ok: false, failed: true, code: e.code, transactionHash: e.transactionHash, gas, feeArio }
    }
    throw e
  }
  // Resolving means DeliverTx code 0.
  console.log(`${label}OK ${res.transactionHash}`)
  return { broadcast: true, ok: true, res, gas, feeArio }
}
