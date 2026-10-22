// Realio Network chain constants + Keplr chain-suggest config.
// Realio is an Ethermint-style EVM chain: slip44/coinType 60, eth_secp256k1 keys,
// pubkey type /ethermint.crypto.v1.ethsecp256k1.PubKey.

import { fromBech32 } from '@cosmjs/encoding'
import { getJson, READ_TIMEOUT_MS, withTimeout } from './http'

export const CHAIN_ID = 'realionetwork_3301-1'
const PREFIX = 'realio' // used only in keplrChainConfig below (not exported)
const COIN_TYPE = 60 // used only in keplrChainConfig below (not exported)

export const DENOM = 'ario'
const DISPLAY = 'RIO' // used only in keplrChainConfig below (not exported)
export const DECIMALS = 18

const RPC_URL = 'https://realio-rpc.noders.services' // used in fetchValidatorBondCoin + keplrChainConfig (not exported)
export const REST_URL = 'https://realio-api.noders.services'
// Where pollTx looks a submitted tx up by hash, in order (WO-045, T-6). noders has tx indexing
// disabled (HTTP 500 "transaction indexing is disabled", re-probed 2026-10-15), so pollTx drops it
// on the first answer and falls back to STAVR: on v1.8.0, synced, kv indexing on, CORS open; a
// known bot tx was found by hash there 2026-10-15. Nothing is signed or sent there, but its answer is
// trusted for what the page tells the user and for whether a multi-stake flow sends its next stake
// (docs/06 gate 2026-10-16, P-1; see pollTx). Each host must also be in the compound target's CSP
// connect-src (firebase.json).
export const TX_LOOKUP_URLS = [REST_URL, 'https://realio.api.m.stavr.tech'] as const
// The Graph subgraph indexing DSTRX ERC-20 balances — used by the Realio explorer.
// ID format: "{contractAddress}/{evmAddress}" both lowercase.
const DSTRX_SUBGRAPH = 'https://graph-node.realio.network/subgraphs/name/dstrx-mainnet-subgraph'

// 1 gwei-equivalent: 1_000_000_000 ario per gas unit.
export const GAS_PRICE = 1_000_000_000

// Teshy autostake bot — the grantee on every grant.
export const BOT_ADDRESS = 'realio10eq6w0a7fpety33uag2f55e9tewxazt4v28aem'

// The compounding destination: every grant this page signs scopes the delegate StakeAuthorization allow_list to this validator (grants.ts compoundGrants). The bot itself honors whatever allow_list a grant carries.
// Retargeted 2026-10-07 (WO-044) to the replacement "Teshy RIO" validator: Realio v1.8.0
// (height 20,106,800) jails the old, compromised-operator validator and moves its stake here.
export const TESHY_VALOPER = 'realiovaloper1fvh0yq5v8n5c2yz0cs5pkfdgx5t77x6vm3pr6y'

// Teshy's RST and DSTRX validators (initial-stake destinations only — the compound
// bot always delegates rewards to a RIO validator; see docs/01-overview.md §6.8).
// DSTRX confirmed by the operator 2026-06-11 ("Teshy - DSTRX", BOND_STATUS_BONDED). RST
// retargeted 2026-10-07 (WO-044) to the replacement "Teshy RST" validator (v1.8.0 rotation).
export const TESHY_RST_VALOPER = 'realiovaloper1dlsleh9f0gsf7tl2kvyra7pmy3z8w7nek4u780'
export const TESHY_DSTRX_VALOPER = 'realiovaloper1ez4x5c75qn5sjkang9j0zfmrkpcl9nrqwzgp5k'

// The pre-v1.8.0 Teshy RIO / RST validators (compromised operator accounts, jailed at height
// 20,106,800, their stake moved on-chain to the replacements above). Never a destination. Stake
// still on one after the upgrade is stake v1.8.0 skipped, so the redelegate offer shows it as a
// source with a label (src/delegations.ts, WO-045).
export const TESHY_LEGACY_VALOPERS = [
  'realiovaloper18a32el4maw3pqr8xh3yrl9ja4lejs265a5nxtm', // old RIO
  'realiovaloper13jrrtkfuuvzdak6zxmr95hek9c228ug50sdsvs', // old RST
]

// Bond denoms + decimals, verified on-chain 2026-06-11 via
// /cosmos/bank/v1beta1/denoms_metadata (all three are 18-decimal).
export const RST_DENOM = 'arst'
export const RST_DECIMALS = 18
export const DSTRX_DENOM = 'erc20:0xb841F365D5221Bed66d60E69094418D8C2aa5A44'
export const DSTRX_DECIMALS = 18

// Ethermint pubkey type URL. (No account-type const: getAccount duck-types
// base_account rather than matching on /ethermint.types.v1.EthAccount.)
export const ETHSECP256K1_PUBKEY_TYPE = '/ethermint.crypto.v1.ethsecp256k1.PubKey'

// ── Multistaking bond-coin helpers ───────────────────────────────────────────

// Encode a proto string field (field 1, wire type 2) as raw bytes.
function protoEncodeStringField1(str: string): Uint8Array {
  const encoded = new TextEncoder().encode(str)
  const length = encoded.length
  const lengthBytes: number[] = []
  let l = length
  while (l > 127) {
    lengthBytes.push((l & 0x7f) | 0x80)
    l >>= 7
  }
  lengthBytes.push(l)
  return new Uint8Array([0x0a, ...lengthBytes, ...encoded])
}

// Decode the first string field from a proto response (field 1, wire type 2).
function protoDecodeFirstString(bytes: Uint8Array): string {
  if (bytes[0] !== 0x0a) throw new Error('unexpected proto tag')
  let i = 1
  let length = 0
  let shift = 0
  while (true) {
    const b = bytes[i++]
    length |= (b & 0x7f) << shift
    if (!(b & 0x80)) break
    shift += 7
  }
  return new TextDecoder().decode(bytes.slice(i, i + length))
}

// Returns the bond coin denom for a validator via the multistaking ABCI query.
// The standard REST multistaking endpoints return "Not Implemented" on all public nodes;
// the Tendermint ABCI query path works and is the only available route.
export async function fetchValidatorBondCoin(valoper: string): Promise<string> {
  const msg = protoEncodeStringField1(valoper)
  const hex = bytesToHex(msg)
  const path = encodeURIComponent('"/multistaking.v1.Query/ValidatorMultiStakingCoin"')
  const json = await getJson<{ result?: { response?: { value?: string } } }>(
    `${RPC_URL}/abci_query?path=${path}&data=0x${hex}`,
  )
  const value = json?.result?.response?.value
  if (!value) throw new Error(`no bond coin for ${valoper}`)
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
  return protoDecodeFirstString(bytes)
}

// Human-readable label for a bond denom.
export function bondCoinLabel(denom: string): string {
  if (denom === DENOM) return 'RIO'
  if (denom === RST_DENOM) return 'RST'
  if (denom === DSTRX_DENOM) return 'DSTRX'
  return denom
}

// Which Teshy validator to redelegate to, based on the source validator's bond coin.
export function bondCoinToTeshyValoper(denom: string): string {
  if (denom === RST_DENOM) return TESHY_RST_VALOPER
  if (denom === DSTRX_DENOM) return TESHY_DSTRX_VALOPER
  return TESHY_VALOPER
}

// Pretty-print an ario integer string as RIO (decimals defaults to RIO's 18; every denom the page
// handles has 18, so call sites leave it out).
export function toRio(arioInt: string | number, decimals = DECIMALS): string {
  const n = typeof arioInt === 'string' ? arioInt : String(arioInt)
  const neg = n.startsWith('-')
  const digits = (neg ? n.slice(1) : n).padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '')
}

// Parse a decimal display string to the chain's minimum unit as bigint.
// e.g. fromDisplay("10.5", 18) → 10_500_000_000_000_000_000n
// Throws on negative, non-numeric, exponent notation, or precision > decimals.
export function fromDisplay(amount: string, decimals: number): bigint {
  const s = amount.trim()
  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(s)) throw new Error(`Invalid amount: "${amount}"`)
  const [whole = '', frac = ''] = s.split('.')
  if (frac.length > decimals) {
    throw new Error(`Too many decimal places (max ${decimals})`)
  }
  return BigInt((whole || '0') + frac.padEnd(decimals, '0'))
}

// ── DSTRX (ERC-20) balance via The Graph subgraph ───────────────────────────

// Hex-encode raw bytes (no "0x" prefix).
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Ethermint bech32 and EVM addresses share the same underlying 20 bytes.
function bech32ToEvmHex(addr: string): string {
  const { data } = fromBech32(addr)
  return '0x' + bytesToHex(data)
}

// DSTRX lives in EVM state, so the Cosmos bank module has no record of it. We read the
// balance from the Realio explorer's DSTRX subgraph (CORS-open — returns
// `Access-Control-Allow-Origin: *`, verified 2026-06-26). Returns 0n when the account
// has no balance record; throws on a transport failure, an HTTP-level failure (non-2xx),
// or a GraphQL error response — which the caller (fetchBalances) surfaces as "—" and
// which blocks DSTRX staking (fail-safe — the display balance is re-validated on-chain
// at broadcast regardless).
//
// No EVM-JSON-RPC fallback: every public Realio EVM endpoint tested (noders, genznodes,
// sr20de) omits Access-Control-Allow-Origin, so a browser fetch can never read them —
// listing them only widened the CSP for dead endpoints. The subgraph is the sole
// browser-usable source today.
// TODO(teshy-infra): once Teshy's own node exposes a CORS-enabled DSTRX indexer (or EVM
// RPC), add it here as a first-party fallback so the page no longer depends on a single
// third-party source. See docs/03-operations.md → "Future: Teshy-operated endpoints".
export async function fetchErc20Balance(
  contractAddress: string,
  bech32Addr: string,
): Promise<bigint> {
  const evmAddr = bech32ToEvmHex(bech32Addr).toLowerCase()
  const id = `${contractAddress.toLowerCase()}/${evmAddr}`
  const res = await fetch(
    DSTRX_SUBGRAPH,
    withTimeout(
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: `{ erc20Balance(id: "${id}") { valueExact } }` }),
      },
      READ_TIMEOUT_MS, // P-4: bounded like every page read (http.ts)
    ),
  )
  if (!res.ok) throw new Error(`DSTRX subgraph HTTP ${res.status}`)
  const json = await res.json()
  if (Array.isArray(json?.errors) && json.errors.length > 0) {
    throw new Error(`DSTRX subgraph: ${json.errors[0]?.message ?? 'GraphQL error'}`)
  }
  const valueExact: string | null = json?.data?.erc20Balance?.valueExact ?? null
  return valueExact !== null ? BigInt(valueExact) : 0n
}

// ── Keplr chain config ────────────────────────────────────────────────────────

// Keplr experimentalSuggestChain config so Realio works even if not pre-listed.
export function keplrChainConfig() {
  const currency = { coinDenom: DISPLAY, coinMinimalDenom: DENOM, coinDecimals: DECIMALS }
  return {
    chainId: CHAIN_ID,
    chainName: 'Realio Network',
    rpc: RPC_URL,
    rest: REST_URL,
    bip44: { coinType: COIN_TYPE },
    bech32Config: {
      bech32PrefixAccAddr: PREFIX,
      bech32PrefixAccPub: PREFIX + 'pub',
      bech32PrefixValAddr: PREFIX + 'valoper',
      bech32PrefixValPub: PREFIX + 'valoperpub',
      bech32PrefixConsAddr: PREFIX + 'valcons',
      bech32PrefixConsPub: PREFIX + 'valconspub',
    },
    currencies: [currency],
    feeCurrencies: [{ ...currency, gasPriceStep: { low: 1, average: 1, high: 1.4 } }],
    stakeCurrency: currency,
    // Ethermint signing features — these tell Keplr to use eth_secp256k1 + keccak signing.
    features: ['eth-address-gen', 'eth-key-sign'],
  }
}
