// The TRACKED network config the bot actually loads. `authzSupport` regressing would make a run a silent no-op
// (it runs, does nothing, exits 0). Tests that build their own network used to inject authzSupport themselves,
// which hid exactly that. This test reads src/networks.json + src/networks.local.json through the same merge the
// bot uses (Helpers.overrideNetworks, called by scripts/lib/wallet.mjs loadBotWallet) and builds the real Network.
// It injects nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { overrideNetworks } from '../src/utils/Helpers.mjs'
import Network from '../src/utils/Network.mjs'
import SigningClient from '../src/utils/SigningClient.mjs'
import { simulateWithFeeCap } from '../scripts/lib/broadcast.mjs'

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

async function loadRealio() {
  const base = JSON.parse(readFileSync(join(ROOT_DIR, 'src', 'networks.json'), 'utf8'))
  const local = JSON.parse(readFileSync(join(ROOT_DIR, 'src', 'networks.local.json'), 'utf8'))
  const data = overrideNetworks(base, local).find((n) => n.name === 'realio' || n.path === 'realio')
  assert.ok(data, 'realio must exist in the merged networks')
  const network = new Network(data)
  await network.load()
  return { data, network }
}

test('realio: authzSupport is true after the merge (false/undefined = a silent no-op run)', async () => {
  const { network } = await loadRealio()
  assert.equal(network.authzSupport, true)
})

test('realio: Ethermint coin type 60, never the Cosmos default 118', async () => {
  const { data, network } = await loadRealio()
  assert.equal(network.slip44, 60)
  assert.equal(data.autostake?.correctSlip44, true)
})

test('realio: chain id, denom, prefix and decimals are the mainnet values', async () => {
  const { network } = await loadRealio()
  assert.equal(network.chainId, 'realionetwork_3301-1')
  assert.equal(network.denom, 'ario')
  assert.equal(network.prefix, 'realio')
  assert.equal(network.decimals, 18)
})

test('realio: the tracked endpoints are placeholders (no real node is named in the repo)', async () => {
  const { data } = await loadRealio()
  for (const u of [...data.restUrl, ...data.rpcUrl]) assert.match(u, /YOUR-/, u)
})

// The fee math (compound.mjs) reads `gasPrice`, signing reads `gasPricePrefer`. If they drift, MAX_FEE is
// enforced against the wrong price.
test('realio: gasPrice === gasPricePrefer (fee math and signing use the same price, so MAX_FEE is exact)', async () => {
  const { data } = await loadRealio()
  assert.ok(data.gasPrice, 'gasPrice must be set')
  assert.equal(data.gasPrice, data.gasPricePrefer)
})

// This one builds the REAL signing client from the realio config with gasPricePrefer drifted away from
// gasPrice and asserts the fee-cap helper sees the fee that client signs.
test('realio: with gasPricePrefer drifted from gasPrice, the MAX_FEE check sees the fee that is SIGNED', async () => {
  const { data } = await loadRealio()
  const drifted = { ...data, gasPricePrefer: '3000000000ario', gasPrice: '1000000000ario' }
  const signing = SigningClient({ ...drifted, slip44: 60 }, { getAccounts: async () => [] })
  const client = { simulate: async () => 200000, getFee: signing.getFee }
  const r = await simulateWithFeeCap(client, 'bot1', [{}], 'memo', {
    feeCapArio: 10n ** 16n,
    feeDenom: 'ario',
  })
  assert.equal(r.feeArio, BigInt(signing.getFee(200000).amount[0].amount))
  assert.equal(r.feeArio, 200000n * 3_000_000_000n, 'priced at gasPricePrefer, as signing does')
  assert.notEqual(r.feeArio, 200000n * 1_000_000_000n, 'not at the drifted gasPrice')
})
