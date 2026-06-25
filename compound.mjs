// Auto-compound bot for Realio (realionetwork_3301-1).
//
// Discovers opted-in delegators via authz GranteeGrants, then for each:
//   1. Reads their pending ario rewards across all their validators
//   2. Builds one authz MsgExec: [MsgWithdrawDelegatorReward(each source), MsgDelegate(total → their chosen valoper)]
//   3. Simulates then broadcasts (or skips if DRY_RUN=true)
//
// WHY THE EXPLICIT WITHDRAW: Realio's multistaking module does NOT auto-withdraw
// rewards on delegate. A bare MsgDelegate of pending rewards fails with "insufficient
// funds" because the rewards are not yet spendable bank balance. The withdraw leg
// inside the same MsgExec credits them first, then the delegate is funded.
//
// WHY THE DESTINATION IS NOT HARDCODED: the bot reads the destination validator
// from the delegator's own StakeAuthorization allow_list. This is a hard
// anti-self-dealing rule — the bot can only delegate where the user explicitly
// consented.
//
// ENV:
//   MNEMONIC    — bot wallet mnemonic (from .env via dotenv; never printed)
//   MIN_REWARD  — skip delegators below this ario threshold (default 1e18 = 1 RIO)
//   DRY_RUN     — "false" to broadcast; anything else (default) = simulate only
//
// Run from repo root: node compound.mjs

import 'dotenv/config'
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing'
import { Slip10RawIndex, pathToString } from '@cosmjs/crypto'
import { Wallet as EthWallet } from '@ethersproject/wallet'
import { MsgExec } from 'cosmjs-types/cosmos/authz/v1beta1/tx.js'
import { MsgDelegate } from 'cosmjs-types/cosmos/staking/v1beta1/tx.js'
import { MsgWithdrawDelegatorReward } from 'cosmjs-types/cosmos/distribution/v1beta1/tx.js'
import Network from './src/utils/Network.mjs'
import Wallet from './src/utils/Wallet.mjs'
import EthSigner from './src/utils/EthSigner.mjs'
import { coin, overrideNetworks } from './src/utils/Helpers.mjs'
import fs from 'fs'

const WITHDRAW_MSG = '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward'
const DELEGATE_MSG  = '/cosmos.staking.v1beta1.MsgDelegate'

const mnemonic = process.env.MNEMONIC
if (!mnemonic) {
  console.error('MNEMONIC not set — copy .env.sample to .env and add your bot wallet mnemonic')
  process.exit(1)
}

const MIN_REWARD = BigInt(process.env.MIN_REWARD || '1000000000000000000') // 1 RIO default
const DRY_RUN   = process.env.DRY_RUN !== 'false'

// --- Network setup ---

const baseNetworks = JSON.parse(fs.readFileSync('src/networks.json'))
const overrides    = JSON.parse(fs.readFileSync('src/networks.local.json'))
const data = overrideNetworks(baseNetworks, overrides).find(n => n.name === 'realio' || n.path === 'realio')
if (!data) { console.error('realio network not found in networks.json/networks.local.json'); process.exit(1) }

const network = new Network(data)
await network.load()

// --- Ethermint key derivation ---
// Realio uses eth_secp256k1 with coin type 60 (Ethermint), not Cosmos default 118.
// Using coin type 118 here produces a different address and every tx fails:
//   "pubKey does not match signer address"
const slip44 = (network.data.autostake?.correctSlip44 || network.slip44 === 60)
  ? (network.slip44 || 118)
  : (network.data.autostake?.slip44 || 118)
const hdPath = [
  Slip10RawIndex.hardened(44), Slip10RawIndex.hardened(slip44),
  Slip10RawIndex.hardened(0),  Slip10RawIndex.normal(0), Slip10RawIndex.normal(0),
]
let signer = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: network.prefix, hdPaths: [hdPath] })
if (slip44 === 60) signer = EthSigner(signer, EthWallet.fromMnemonic(mnemonic), network.prefix)

const wallet     = new Wallet(network, signer)
const botAddress = await wallet.getAddress()
await network.connect({ timeout: 20000 })

console.log(`Bot address : ${botAddress}`)
console.log(`HD path     : ${pathToString(hdPath)}`)
console.log(`REST        : ${network.restUrl}`)
console.log(`MIN_REWARD  : ${MIN_REWARD} ario (${Number(MIN_REWARD) / 1e18} RIO)`)
console.log(`DRY_RUN     : ${DRY_RUN}`)
console.log()

// --- Discover opted-in delegators via GranteeGrants (paginated) ---

async function fetchGranteeGrants() {
  const grants = []
  let key = ''
  do {
    const url = `${network.restUrl}/cosmos/authz/v1beta1/grants/grantee/${botAddress}` +
      (key ? `?pagination.key=${encodeURIComponent(key)}` : '')
    const res = await fetch(url)
    const json = await res.json()
    if (!res.ok) throw new Error(json?.message || `HTTP ${res.status}`)
    grants.push(...(json.grants || []))
    key = json.pagination?.next_key || ''
  } while (key)
  return grants
}

const allGrants = await fetchGranteeGrants()

// Group per granter — need BOTH a withdraw grant and a delegate grant to compound.
// A delegator who only granted StakeAuthorization (e.g. via restake.app) is
// skipped: without the withdraw grant the bot cannot withdraw first, so the
// delegate would have no funds and the tx would fail.
const byDelegator = {}
for (const g of allGrants) {
  const d = (byDelegator[g.granter] ||= { withdraw: false, destValoper: null })
  const type = g.authorization?.['@type']
  if (type === '/cosmos.authz.v1beta1.GenericAuthorization' && g.authorization.msg === WITHDRAW_MSG) {
    d.withdraw = true
  } else if (type === '/cosmos.staking.v1beta1.StakeAuthorization'
    && g.authorization.authorization_type === 'AUTHORIZATION_TYPE_DELEGATE') {
    // Sort allow_list for deterministic selection if multiple validators are listed
    const list = (g.authorization.allow_list?.address || []).slice().sort()
    d.destValoper = list[0] || null
  }
}

const eligible = Object.entries(byDelegator).filter(([, d]) => d.withdraw && d.destValoper)
const incomplete = Object.keys(byDelegator).length - eligible.length
if (incomplete > 0) {
  console.log(`${incomplete} granter(s) skipped — missing withdraw or delegate grant (must opt in via the dual-grant page, not restake.app)`)
}
console.log(`${eligible.length} delegator(s) with both required grants`)
console.log()

// --- Per-delegator compound ---

const denom         = network.denom
const signingClient = wallet.signingClient()
signingClient.registry.register('/cosmos.authz.v1beta1.MsgExec', MsgExec)
const memo = 'auto-compound'

let attempted = 0, succeeded = 0, skipped = 0, failed = 0

for (const [delegator, info] of eligible) {
  const tag = `[${delegator}]`
  try {
    // Sum floored ario rewards across ALL reward sources for this delegator.
    // Realio pays all bond-denom rewards (RIO/RST/DSTRX) as ario, so this
    // single loop captures everything.
    const rewards    = await network.queryClient.getRewards(delegator)
    const withdrawMsgs = []
    let total = 0n

    for (const [srcValoper, entry] of Object.entries(rewards)) {
      const r = (entry.reward || []).find(x => x.denom === denom)
      if (!r) continue
      const floored = BigInt(String(r.amount).split('.')[0]) // rewards are DecCoins
      if (floored <= 0n) continue
      total += floored
      withdrawMsgs.push({
        typeUrl: WITHDRAW_MSG,
        value: MsgWithdrawDelegatorReward.encode(MsgWithdrawDelegatorReward.fromPartial({
          delegatorAddress: delegator,
          validatorAddress: srcValoper,
        })).finish(),
      })
    }

    if (total < MIN_REWARD) {
      console.log(`${tag} SKIP — ${total} ario pending (${Number(total) / 1e18} RIO), below MIN_REWARD`)
      skipped++
      continue
    }

    // Build authz MsgExec: [withdraw from every source, delegate total to their chosen valoper]
    // The destination comes from the delegator's own StakeAuthorization allow_list.
    const innerMsgs = [
      ...withdrawMsgs,
      {
        typeUrl: DELEGATE_MSG,
        value: MsgDelegate.encode(MsgDelegate.fromPartial({
          delegatorAddress: delegator,
          validatorAddress: info.destValoper,
          amount: coin(total.toString(), denom),
        })).finish(),
      },
    ]
    const execMsg = {
      typeUrl: '/cosmos.authz.v1beta1.MsgExec',
      value: { grantee: botAddress, msgs: innerMsgs },
    }

    console.log(`${tag} ${withdrawMsgs.length} source(s) | ${Number(total) / 1e18} RIO → ${info.destValoper}`)
    attempted++

    if (DRY_RUN) {
      console.log(`${tag} DRY — skipping broadcast`)
      continue
    }

    const gas = await signingClient.simulate(botAddress, [execMsg], memo, 1.1)
    const res = await signingClient.signAndBroadcast(botAddress, [execMsg], gas, memo)
    if (res.code === 0) {
      console.log(`${tag} OK  ${res.transactionHash}`)
      succeeded++
    } else {
      console.log(`${tag} FAIL code ${res.code}: ${res.rawLog}`)
      failed++
    }
  } catch (e) {
    console.log(`${tag} ERROR ${e?.message || e}`)
    failed++
  }
}

console.log()
console.log(`Done. attempted=${attempted} succeeded=${succeeded} skipped=${skipped} failed=${failed}`)
process.exit(failed > 0 ? 1 : 0)
