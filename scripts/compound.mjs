// Multi-delegator Phase-3a compound bot for Realio (RIO).
// Stateless: discovers opted-in delegators by querying GranteeGrants (all authz grants
// where grantee == the bot). For each delegator that granted BOTH
//   - GenericAuthorization(/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward)
//   - StakeAuthorization(DELEGATE, allow_list=[<their chosen RIO valoper>])
// it broadcasts one authz exec:
//   [ MsgWithdrawDelegatorReward(delegator, src) for each reward source,
//     MsgDelegate(delegator -> their chosen valoper, amount = summed floored ario reward) ]
// Withdraw credits spendable first (Realio multistaking does NOT auto-withdraw on delegate),
// then the delegate self-funds. The destination is taken from the delegator's OWN grant
// allow_list — never hardcoded — so we honor whichever RIO validator they chose.
//
// Env (money/bound vars are strictly parsed: a malformed or out-of-range value exits 1 before the
// wallet is loaded, so nothing is signed):
//   MNEMONIC   - bot mnemonic (from .env via dotenv; never printed)
//   MIN_REWARD - skip delegators below this ario threshold (default 1e18 = 1 RIO; 0 .. 1e24)
//   GAS_RESERVE - ario always left liquid in a delegator's account (default 2e18 = 2 RIO; 0 .. 1e21)
//   MAX_FEE    - skip a tx whose simulated fee exceeds this ario (default 1e16 = 0.01 RIO; 1 .. 1e18)
//   MAX_DELEGATORS - most delegators processed per run (default 500; 1 .. 100000) — H1 grant-spam bound
//   RUN_BUDGET_MS - wall-clock budget; stops cleanly between delegators (default 600000; 1000 .. 899000,
//                under the unit's 900 s TimeoutStartSec). MAX_DELEGATORS and RUN_BUDGET_MS are pinned in
//                the tracked systemd unit, not in .env (docs/03)
//   DRY_RUN    - "false" to broadcast; anything else (default) = plan + simulate only
//   ONLY_DELEGATOR - optional (empty/unset = everyone): a delegator address. Keeps only that
//                granter's grants after discovery, so just that delegator is compounded; every other
//                gate (destination check, MIN_REWARD, MAX_FEE, MAX_DELEGATORS, run budget) still
//                applies. If it has no grant to the bot the run exits 1 before any simulate or signing.
//
// Run a live run through the wrapper from the install root:  ./run-compound.sh
import { loadDotenv } from './lib/env.mjs'
import { pathToString } from '@cosmjs/crypto'
import { MsgExec } from 'cosmjs-types/cosmos/authz/v1beta1/tx.js'
import { MsgDelegate } from 'cosmjs-types/cosmos/staking/v1beta1/tx.js'
import { MsgWithdrawDelegatorReward } from 'cosmjs-types/cosmos/distribution/v1beta1/tx.js'
import { exactCoin, floorDecCoinAmount } from './lib/amount.mjs'
import { groupGrants } from './lib/grouping.mjs'
import { loadBotWallet } from './lib/wallet.mjs'
import { simulateWithFeeCap } from './lib/broadcast.mjs'
import { isUnconfirmed, isTxFailed, isSequenceMismatch } from '../src/utils/TxConfirm.mjs'
import { destinationChecker } from './lib/destination.mjs'
import { withdrawChecker } from './lib/withdraw.mjs'
import { computeDelegateAmount, parseBoundedInt, parseBoundedBigInt } from './lib/plan.mjs'
// Loaded here, after the imports and before the first read of process.env (refuses any .env key but MNEMONIC).
loadDotenv()
const WITHDRAW_MSG = '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward'
const DELEGATE_MSG = '/cosmos.staking.v1beta1.MsgDelegate'
const DRY_RUN = process.env.DRY_RUN !== 'false'
const ONLY_DELEGATOR = process.env.ONLY_DELEGATOR || ''
// H1 (docs/12): grants are permissionless and now cheap to script via the authz
// EVM precompile, so the bot must not let a flood of grants blow the run and starve
// real delegators. MAX_DELEGATORS bounds per-run work; RUN_BUDGET_MS stops cleanly
// before the systemd TimeoutStartSec (900s) kills the run mid-list. Both env-tunable.
// Strict bounds (T-20): a malformed value exits 1 before the wallet is loaded, so nothing is signed.
let MIN_REWARD, GAS_RESERVE, MAX_FEE, MAX_DELEGATORS, RUN_BUDGET_MS
try {
  // Money vars (WO-059 D2): exact bigints, digits only, bounded — a raw BigInt() accepted negatives and hex.
  MIN_REWARD = parseBoundedBigInt('MIN_REWARD', process.env.MIN_REWARD, 10n ** 18n, { min: 0n, max: 10n ** 24n }) // 1 RIO
  GAS_RESERVE = parseBoundedBigInt('GAS_RESERVE', process.env.GAS_RESERVE, 2n * 10n ** 18n, { min: 0n, max: 10n ** 21n }) // 2 RIO — always left liquid
  MAX_FEE = parseBoundedBigInt('MAX_FEE', process.env.MAX_FEE, 10n ** 16n, { min: 1n, max: 10n ** 18n }) // 0.01 RIO — skip tx if estimated fee exceeds this
  MAX_DELEGATORS = parseBoundedInt('MAX_DELEGATORS', process.env.MAX_DELEGATORS, 500, { min: 1, max: 100000 })
  RUN_BUDGET_MS = parseBoundedInt('RUN_BUDGET_MS', process.env.RUN_BUDGET_MS, 600000, { min: 1000, max: 899000 }) // 10 min < 900s unit timeout
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
// Every REST read below has this timeout (WO-059 D1): one hung socket must not stall the run past
// RUN_BUDGET_MS (overBudget() is only checked between delegators) until systemd's 900 s kills it.
const REST_TIMEOUT_MS = 15000
const startedAt = Date.now()
const overBudget = () => Date.now() - startedAt > RUN_BUDGET_MS
// ---- network + signer via the shared bootstrap (slip44 60 eth_secp256k1; see lib/wallet.mjs) ----
// Endpoint: networks.local.json's ordered list (first healthy wins, QueryClient.findAvailableUrl); a live
// run keeps only the URLs of the node COMPOUND_NODE_HOST names (lib/local-only.mjs). Confirmation needs a
// node with tx indexing (WO-040).
const { network, botAddress, signingClient, denom, hdPath } = await loadBotWallet()
signingClient.registry.register('/cosmos.authz.v1beta1.MsgExec', MsgExec)
console.log(`Bot ${botAddress} | HD ${pathToString(hdPath)} | denom ${denom}`)
console.log(`MIN_REWARD ${MIN_REWARD} ario | GAS_RESERVE ${GAS_RESERVE} ario | MAX_FEE ${MAX_FEE} ario | DRY_RUN ${DRY_RUN}`)
console.log(`REST ${network.restUrl}`)
// ---- discover opted-in delegators via GranteeGrants ----
// QueryClient follows pagination.next_key to the end and rejects on any non-2xx page, so a failed
// page aborts the run rather than yielding a partial list.
const allGrants = await network.queryClient.getGranteeGrants(botAddress, { timeout: REST_TIMEOUT_MS })
// ONLY_DELEGATOR (replaces the deleted single-delegator one-shot script): keep only that granter's grants, before any
// planning. It narrows, never widens: no gate below is bypassed, and an address with no grant exits 1
// before the first simulate (the wallet is already loaded — discovery needs its address and the network).
let grants = allGrants
if (ONLY_DELEGATOR) {
  grants = allGrants.filter((g) => g.granter === ONLY_DELEGATOR)
  if (grants.length === 0) {
    console.log(`ONLY_DELEGATOR ${ONLY_DELEGATOR} has no grant to the bot — nothing to do`)
    process.exit(1)
  }
  console.log(`ONLY_DELEGATOR set: ${grants.length} of ${allGrants.length} grants kept`)
}
// group per granter -> { withdraw: bool, destValoper: string|null }; a malformed/adversarial
// grant is logged and skipped by groupGrants, never crashes the whole run (TQA-010).
const byDelegator = groupGrants(grants, { withdrawMsgTypeUrl: WITHDRAW_MSG, log: console.log })
const allGranters = Object.keys(byDelegator)
// unconfirmed = submitted but outcome unknown (WO-040): counted apart from failed, never retried.
let attempted = 0, succeeded = 0, skipped = 0, failed = 0, unconfirmed = 0
// aborted = the bot account's sequence moved under this run (simulate or CheckTx "account
// sequence mismatch"): another tx from the bot is pending or another run is active. Nothing more
// is sent this run — a retry could re-send rewards that tx already staked (docs/06 audit 2026-10-08).
let aborted = false
const ABORT_REASON = 'another tx from the bot account is pending or another run is active'
// Granters missing either required grant cost nothing (no reward query) — skip up front.
const eligible = allGranters.filter(d => byDelegator[d].withdraw && byDelegator[d].destValoper)
const missing = allGranters.length - eligible.length
if (missing > 0) {
  console.log(`${missing} granter(s) skipped — missing a required grant (stock-restake grant can't compound on Realio)`)
  skipped += missing
}
console.log(`Found ${allGranters.length} granter(s); ${eligible.length} with both grants.`)
// H1: bound per-run work so cheap grant-spam can't starve real delegators.
let delegators = eligible
if (eligible.length > MAX_DELEGATORS) {
  console.log(`WARN: ${eligible.length} eligible delegators exceeds MAX_DELEGATORS=${MAX_DELEGATORS} — processing the first ${MAX_DELEGATORS} this run, deferring the rest. If these are legitimate, raise MAX_DELEGATORS; otherwise this is likely grant-spam.`)
  delegators = eligible.slice(0, MAX_DELEGATORS)
}
const memo = 'Teshy auto-compound'
const checkDestination = destinationChecker((v) => network.queryClient.getValidator(v, { timeout: REST_TIMEOUT_MS }))
// WO-063 S-1: the rewards must land in the delegator's own account (see lib/withdraw.mjs).
const checkWithdraw = withdrawChecker((d) => network.queryClient.getWithdrawAddress(d, { timeout: REST_TIMEOUT_MS }))
const batches = {} // destValoper → [{ tag, innerMsgs }] — filled in Phase 1, broadcast in Phase 2
for (const delegator of delegators) {
  const info = byDelegator[delegator]
  const tag = `[${delegator}]`
  if (overBudget()) {
    console.log(`Run budget ${RUN_BUDGET_MS}ms exhausted — stopping cleanly; remaining delegators will be handled next run.`)
    break
  }
  try {
    // WO-044: never compound into a jailed / unbonded destination (e.g. a pre-v1.8.0 grant naming
    // an old validator). Before the reward query, so a skipped delegator costs no gas.
    const dest = await checkDestination(info.destValoper)
    if (!dest.ok) {
      console.log(`${tag} SKIP — ${dest.reason}: ${info.destValoper}; delegator must re-grant to an active validator`)
      skipped++; continue
    }
    // WO-063 S-1: the delegate below is sized as if the withdrawn rewards land in THIS account. If the
    // delegator redirected its rewards, the withdraw credits another account and the delegate would be
    // paid from the delegator's principal. Before the reward query, so a skipped delegator costs no gas.
    // Fail closed: an unreadable answer skips too. (A delegator could still change the address between
    // this check and the broadcast — an accepted residual LOW, docs/12.)
    const wd = await checkWithdraw(delegator)
    if (!wd.ok) {
      if (wd.reason === 'differs') {
        console.log(`${tag} SKIP — withdraw address differs from delegator; rewards would not land in the delegated account`)
      } else {
        console.log(`${tag} SKIP — could not verify withdraw address (${wd.message || wd.reason}): fail-closed; rewards might not land in the delegated account`)
      }
      skipped++; continue
    }
    // sum floored ario rewards across ALL the delegator's reward sources
    const rewards = await network.queryClient.getRewards(delegator, { timeout: REST_TIMEOUT_MS })
    const withdrawMsgs = []
    let total = 0n
    for (const [srcValoper, entry] of Object.entries(rewards)) {
      const r = (entry.reward || []).find(x => x.denom === denom)
      if (!r) continue
      const floored = floorDecCoinAmount(r.amount)
      if (floored <= 0n) continue
      total += floored
      withdrawMsgs.push({
        typeUrl: WITHDRAW_MSG,
        value: MsgWithdrawDelegatorReward.encode(MsgWithdrawDelegatorReward.fromPartial({
          delegatorAddress: delegator, validatorAddress: srcValoper,
        })).finish(),
      })
    }
    // LOAD-BEARING (H1, docs/12): this MIN_REWARD gate sits BEFORE simulate/broadcast,
    // so a granter who never funds a delegation (0 rewards) never costs the bot gas —
    // the gas wallet is not drainable by grant-spam. Do NOT move any broadcast above this.
    if (total < MIN_REWARD) {
      console.log(`${tag} SKIP — pending ${total} ario below MIN_REWARD ${MIN_REWARD}`)
      skipped++; continue
    }
    // Gas reserve: ensure delegator always retains GAS_RESERVE liquid after compounding.
    // After tx: liquid = current_liquid + total(withdrawn) - delegateAmount >= GAS_RESERVE
    // => delegateAmount <= current_liquid + total - GAS_RESERVE
    // We always withdraw the full reward amount; any uncapped portion stays liquid.
    let liquidBalance = 0n
    try {
      const bal = await network.queryClient.getBalance(delegator, denom, { timeout: REST_TIMEOUT_MS })
      liquidBalance = BigInt(bal.amount || '0')
    } catch (e) {
      console.log(`${tag} WARN could not fetch liquid balance: ${e?.message || e} — balance query failed — fail-closed: treating liquid balance as 0n; delegator may be skipped by the gas-reserve/MIN_REWARD gates this run`)
    }
    const { amount: delegateAmount, capped, skip } = computeDelegateAmount({ total, liquid: liquidBalance, gasReserve: GAS_RESERVE, minReward: MIN_REWARD })
    if (skip) {
      console.log(`${tag} SKIP — delegate amount ${delegateAmount} ario after ${GAS_RESERVE} ario gas reserve below MIN_REWARD (liquid=${liquidBalance})`)
      skipped++; continue
    }
    if (capped) {
      console.log(`${tag} GAS RESERVE CAP — delegating ${delegateAmount} ario of ${total} ario rewards (liquid=${liquidBalance}, reserve=${GAS_RESERVE})`)
    }
    const innerMsgs = [
      ...withdrawMsgs,
      {
        typeUrl: DELEGATE_MSG,
        value: MsgDelegate.encode(MsgDelegate.fromPartial({
          delegatorAddress: delegator, validatorAddress: info.destValoper, amount: exactCoin(delegateAmount.toString(), denom),
        })).finish(),
      },
    ]
    // Phase 1: simulate individually (catches expired grants / bad state before batching)
    const execMsg = { typeUrl: '/cosmos.authz.v1beta1.MsgExec', value: { grantee: botAddress, msgs: innerMsgs } }
    const { gas, feeArio: estimatedFee, withinCap } = await simulateWithFeeCap(signingClient, botAddress, [execMsg], memo, {
      gasMultiplier: 1.1, feeCapArio: MAX_FEE, feeDenom: denom,
    })
    if (!withinCap) {
      console.log(`${tag} SKIP — fee ${estimatedFee} ario (${Number(estimatedFee) / 1e18} RIO) exceeds MAX_FEE ${MAX_FEE} ario | gas ${gas}`)
      skipped++; continue
    }
    console.log(`${tag} ${withdrawMsgs.length} source(s), ${delegateAmount} ario (${Number(delegateAmount) / 1e18} RIO) -> ${info.destValoper} | sim gas ${gas} | fee ~${estimatedFee} ario`)
    if (DRY_RUN) { console.log(`${tag} DRY — would batch -> ${info.destValoper}`) }
    if (!batches[info.destValoper]) batches[info.destValoper] = []
    batches[info.destValoper].push({ tag, innerMsgs })
    attempted++
  } catch (e) {
    console.log(`${tag} ERROR ${e?.message || e}`)
    failed++
    if (isSequenceMismatch(e)) {
      console.log(`ABORT — ${ABORT_REASON}; nothing will be broadcast this run`)
      aborted = true
      break
    }
  }
}
// On a failed batch, retry each delegator on its own so one poison grant (e.g. a grant
// that expired between the Phase 1 simulate and the Phase 2 broadcast) fails alone rather
// than atomically reverting — and starving — its whole destValoper batch. Re-simulates and
// re-checks MAX_FEE per delegator. Only runs on the failure path; costs up to MAX_FEE extra
// per delegator there, but lets the batch's healthy delegators still compound this run.
// Only DEFINITIVE failures are retried (simulate/CheckTx reject, or DeliverTx code != 0, which
// reverts the whole MsgExec). An UNCONFIRMED batch is never retried: it may have committed, and a
// retry's delegate would then re-spend rewards already staked — out of the delegator's principal
// if their liquid balance covers it (WO-040). A sequence mismatch is not retried either: it means
// some OTHER bot tx is pending or committed, possibly for these same rewards (abort, see above).
async function broadcastIndividually(batch, label) {
  for (const { tag, innerMsgs } of batch) {
    if (aborted) { console.log(`${label} ${tag} NOT SENT (retry) — run aborted`); failed++; continue }
    const execMsg = { typeUrl: '/cosmos.authz.v1beta1.MsgExec', value: { grantee: botAddress, msgs: innerMsgs } }
    try {
      const { gas, feeArio: fee, withinCap } = await simulateWithFeeCap(signingClient, botAddress, [execMsg], memo, {
        gasMultiplier: 1.1, feeCapArio: MAX_FEE, feeDenom: denom,
      })
      if (!withinCap) {
        console.log(`${label} ${tag} SKIP (retry) — fee ${fee} ario exceeds MAX_FEE ${MAX_FEE}`)
        failed++; continue
      }
      // signAndBroadcast resolves only on DeliverTx code 0; every other outcome throws (handled below).
      const res = await signingClient.signAndBroadcast(botAddress, [execMsg], gas, memo)
      console.log(`${label} ${tag} OK (retry) ${res.transactionHash}`); succeeded++
    } catch (e) {
      // Order matters: a CheckTx sequence-mismatch rejection is ALSO a TxFailedError, but it aborts.
      if (isUnconfirmed(e)) { console.log(`${label} ${tag} UNCONFIRMED (retry) ${e.transactionHash} — ${e.message}`); unconfirmed++ }
      else if (isSequenceMismatch(e)) { console.log(`${label} ${tag} ABORT (retry) — ${ABORT_REASON}: ${e?.message || e}`); failed++; aborted = true }
      else if (isTxFailed(e)) { console.log(`${label} ${tag} FAIL (retry) code ${e.code}: ${e.rawLog}`); failed++ }
      else { console.log(`${label} ${tag} ERROR (retry) ${e?.message || e}`); failed++ }
    }
  }
}
// Phase 2 — one broadcast per destination-validator group.
// innerMsgs are interleaved per delegator [A_withdraws, A_delegate, B_withdraws, B_delegate, ...]
// so each delegator's rewards are liquid before their own delegate executes.
for (const [destValoper, batch] of Object.entries(batches)) {
  const batchLabel = `[batch→${destValoper.slice(-8)} ×${batch.length}]`
  const batchTags = batch.map(b => b.tag).join(' ')
  const allInnerMsgs = batch.flatMap(b => b.innerMsgs)
  const batchExecMsg = { typeUrl: '/cosmos.authz.v1beta1.MsgExec', value: { grantee: botAddress, msgs: allInnerMsgs } }
  if (aborted) {
    console.log(`${batchLabel} NOT SENT — run aborted (${ABORT_REASON}) | ${batchTags}`)
    failed += batch.length; continue
  }
  if (DRY_RUN) {
    console.log(`${batchLabel} DRY — would send ${allInnerMsgs.length} msgs in 1 tx | ${batchTags}`)
    continue
  }
  try {
    const { gas: batchGas, feeArio: batchFee, withinCap: batchWithinCap } = await simulateWithFeeCap(signingClient, botAddress, [batchExecMsg], memo, {
      gasMultiplier: 1.1, feeCapArio: MAX_FEE * BigInt(batch.length), feeDenom: denom,
    })
    if (!batchWithinCap) {
      console.log(`${batchLabel} SKIP — batch fee ${batchFee} ario (${Number(batchFee) / 1e18} RIO) exceeds MAX_FEE×${batch.length}`)
      failed += batch.length; continue
    }
    console.log(`${batchLabel} gas ${batchGas} | fee ~${batchFee} ario (${Number(batchFee) / 1e18} RIO) | ${batchTags}`)
    // signAndBroadcast resolves only on DeliverTx code 0; every other outcome throws (handled below).
    const res = await signingClient.signAndBroadcast(botAddress, [batchExecMsg], batchGas, memo)
    console.log(`${batchLabel} OK ${res.transactionHash}`)
    succeeded += batch.length
  } catch (e) {
    if (isUnconfirmed(e)) {
      console.log(`${batchLabel} UNCONFIRMED ${e.transactionHash} — ${e.message} NOT retrying | ${batchTags}`)
      unconfirmed += batch.length; continue
    }
    if (isSequenceMismatch(e)) {
      console.log(`${batchLabel} ABORT — ${ABORT_REASON}: ${e?.message || e} — NOT retrying, not sending the remaining batches | ${batchTags}`)
      failed += batch.length; aborted = true; continue
    }
    if (isTxFailed(e)) {
      console.log(`${batchLabel} FAIL code ${e.code}: ${e.rawLog}`)
      if (batch.length > 1) { console.log(`${batchLabel} retrying ${batch.length} delegators individually so one bad grant can't starve the batch`); await broadcastIndividually(batch, batchLabel) }
      else failed += batch.length
      continue
    }
    console.log(`${batchLabel} ERROR ${e?.message || e}`)
    if (batch.length > 1) { console.log(`${batchLabel} retrying ${batch.length} delegators individually`); await broadcastIndividually(batch, batchLabel) }
    else failed += batch.length
  }
}
console.log(`Done. attempted=${attempted} succeeded=${succeeded} skipped=${skipped} failed=${failed} unconfirmed=${unconfirmed}`)
// Exit 3 = ABORTED (another bot tx pending / another run active). Keyed off the exit code, never
// log text — a granter-controlled string can land in the log.
process.exit(aborted ? 3 : (failed > 0 || unconfirmed > 0 ? 1 : 0))
