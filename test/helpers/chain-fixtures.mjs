// Shared fixtures for the bot tests (WO-051, T-43). Lives outside the `test/*.test.mjs` glob so the
// runner does not execute it. No mnemonic-shaped literal sits in the repo (the secrets scan can't
// tell a public test vector from a real phrase), so the phrase is built at runtime.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// BIP39's all-zero-entropy test vector, 11 x 'abandon' + 'about'. It holds nothing.
export const TEST_MNEMONIC = [...Array(11).fill('abandon'), 'about'].join(' ')

// The TRACKED realio entry of src/networks.local.json, with `overrides` spread over it. Tests that
// build a network from this inherit authzSupport / slip44 / correctSlip44 from the real file, so a
// regression there turns them red instead of being masked by a value the test injected itself.
export function realioNetwork(overrides = {}) {
  const base = JSON.parse(readFileSync(join(BOT_DIR, 'src', 'networks.local.json'), 'utf8')).realio
  return { ...base, ...overrides }
}

// The /cosmos/auth/v1beta1/accounts/{addr} `account` object Ethermint returns (an EthAccount wrapper).
export const ethAccount = (address, seq = '3') => ({
  '@type': '/ethermint.types.v1.EthAccount',
  base_account: { address, pub_key: null, account_number: '7', sequence: String(seq) },
})

// What axios throws for a non-2xx answer.
export const httpError = (status, data) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  })
