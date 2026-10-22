// Shared bot-wallet bootstrap for the Realio compound script.
// Extracted to kill the ~25-line setup block that was copy-pasted across every script.
//
// Realio is Ethermint: eth_secp256k1, BIP44 coin type 60 (NOT Cosmos default 118) — see
// the README. This bot is Realio-only, so slip44 is always 60; the old per-script ternary
// (`correctSlip44 ? (network.slip44 || 118) : …`) could resolve to 118 if config drifted —
// we pin it to 60 here to remove that fragility.
//
// Run from the install root: reads src/networks*.json relative to CWD, exactly
// as the scripts did inline. MNEMONIC is loaded from .env by lib/env.mjs and never printed.
import { loadDotenv } from './env.mjs'
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing'
import { Slip10RawIndex } from '@cosmjs/crypto'
import { Wallet as EthWallet } from '@ethersproject/wallet'
import Network from '../../src/utils/Network.mjs'
import Wallet from '../../src/utils/Wallet.mjs'
import EthSigner from '../../src/utils/EthSigner.mjs'
import { overrideNetworks } from '../../src/utils/Helpers.mjs'
import { applyLocalOnly, assertLiveRunIsLocal } from './local-only.mjs'
import fs from 'fs'

export const REALIO_SLIP44 = 60 // Ethermint eth_secp256k1 — the only correct value for Realio

// Loads MNEMONIC + the realio network, derives the eth_secp256k1 signer, connects, and
// returns the objects every bot script needs. Exits(1) on missing MNEMONIC / realio network
// (same fatal-config behavior the scripts had inline). gasPriceNum is the integer ario/gas
// price (e.g. 1e9) for fee math.
export async function loadBotWallet({ connectTimeout = 20000 } = {}) {
  loadDotenv() // idempotent: the entry script already loaded it; this keeps a direct caller on the same rule
  const mnemonic = process.env.MNEMONIC
  if (!mnemonic) { console.error('Missing MNEMONIC (expected in .env)'); process.exit(1) }

  // WO-072 D3 (B-7): a live run (DRY_RUN=false) outside its wrapper refuses before the mnemonic is used.
  try {
    assertLiveRunIsLocal(process.env.DRY_RUN === 'false')
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }

  const baseNetworks = JSON.parse(fs.readFileSync('src/networks.json'))
  const overrides = JSON.parse(fs.readFileSync('src/networks.local.json'))
  const found = overrideNetworks(baseNetworks, overrides).find((n) => n.name === 'realio' || n.path === 'realio')
  if (!found) { console.error('realio network not found in networks.json/networks.local.json'); process.exit(1) }
  // The run-compound.sh wrapper exports COMPOUND_LOCAL_ONLY=1: a fund-moving run then uses ONLY the
  // operator's trusted node. No matching URL in the config means refuse, never fall back.
  let data
  try {
    data = applyLocalOnly(found)
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }

  const network = new Network(data)
  await network.load()

  const slip44 = REALIO_SLIP44
  const hdPath = [
    Slip10RawIndex.hardened(44), Slip10RawIndex.hardened(slip44),
    Slip10RawIndex.hardened(0), Slip10RawIndex.normal(0), Slip10RawIndex.normal(0),
  ]
  let signer = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: network.prefix, hdPaths: [hdPath] })
  signer = EthSigner(signer, EthWallet.fromMnemonic(mnemonic), network.prefix)

  const wallet = new Wallet(network, signer)
  const botAddress = await wallet.getAddress()
  await network.connect({ timeout: connectTimeout })
  // Fail closed before anything is queried or signed: no REST URL was reachable, on the right
  // chain, AND fresh (QueryClient.findAvailableUrl — docs/06 audit 2026-10-08).
  if (!network.connected) {
    console.error('No healthy REST endpoint (every URL unreachable, wrong chain, or stale) — refusing to run')
    process.exit(1)
  }

  const signingClient = wallet.signingClient()
  const denom = network.denom
  const gasPriceNum = BigInt((data.gasPrice || '1000000000ario').replace(/[^0-9]/g, '') || '1000000000')

  return { mnemonic, data, network, wallet, signer, botAddress, signingClient, denom, gasPriceNum, slip44, hdPath }
}
