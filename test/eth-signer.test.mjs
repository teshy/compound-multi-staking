// WO-061 D1: the acceptance test for the EthSigner refactor (C-31, C-72). It pins, from the code as it
// was BEFORE the phantom imports (`bech32`, `@tharsis/address-converter`) were removed, what the bot's
// signer derives and signs for the public BIP39 test mnemonic: the realio1… address, the 0x address and
// the signature bytes of a fixed SignDoc. EthSigner is built directly with the inputs loadBotWallet gives
// it (the cosmos wallet on m/44'/60'/0'/0/0 + the ethers wallet), because loadBotWallet connects to a
// network. A test mnemonic holds nothing; the bot's own is never used.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DirectSecp256k1HdWallet, makeSignDoc } from '@cosmjs/proto-signing'
import { Slip10RawIndex } from '@cosmjs/crypto'
import { fromBech32, toHex, fromHex } from '@cosmjs/encoding'
import { Wallet as EthWallet } from '@ethersproject/wallet'
import EthSigner from '../src/utils/EthSigner.mjs'
import { TEST_MNEMONIC } from './helpers/chain-fixtures.mjs'

const HD_PATH = [
  Slip10RawIndex.hardened(44),
  Slip10RawIndex.hardened(60),
  Slip10RawIndex.hardened(0),
  Slip10RawIndex.normal(0),
  Slip10RawIndex.normal(0),
]

// Pinned from the pre-refactor code (2026-10-15).
const REALIO_ADDRESS = 'realio1npvwllfr9dqr8erajqqr6s0vxnk2ak55q9kprq'
const ETH_ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const COSMOS_PUBKEY_HEX = '0237b0bb7a8288d38ed49a524b5dc98cff3eb5ca824c9f9dc0dfdb3d9cd600f299'
const SIGNATURE_B64 =
  '7vd19V2kEhNduEBqBSz7rXqj/dhOX3TuCraQrUpiglgAlcaT/JTzo2/kdhilT5Z+pChpQPtSzYr9XC2l/ZgvqA=='

async function build(prefix = 'realio') {
  const cosmos = await DirectSecp256k1HdWallet.fromMnemonic(TEST_MNEMONIC, {
    prefix,
    hdPaths: [HD_PATH],
  })
  const eth = EthWallet.fromMnemonic(TEST_MNEMONIC)
  return { signer: EthSigner(cosmos, eth, prefix), eth }
}

test('getAddress: the realio1… address of the test mnemonic is pinned', async () => {
  const { signer } = await build()
  assert.equal(await signer.getAddress(), REALIO_ADDRESS)
})

test('the 0x address of the ethers wallet is pinned, and the bech32 payload IS those 20 bytes', async () => {
  const { signer, eth } = await build()
  assert.equal(await eth.getAddress(), ETH_ADDRESS)
  const { prefix, data } = fromBech32(await signer.getAddress())
  assert.equal(prefix, 'realio')
  assert.equal(toHex(data), ETH_ADDRESS.slice(2).toLowerCase())
})

test('getAddress honours the prefix argument (a wrong prefix cannot pass unnoticed)', async () => {
  const { signer } = await build('realiovaloper')
  const addr = await signer.getAddress()
  assert.equal(fromBech32(addr).prefix, 'realiovaloper')
  assert.equal(toHex(fromBech32(addr).data), toHex(fromBech32(REALIO_ADDRESS).data))
})

test('getAddress accepts the ethers checksummed (mixed-case) form: same bytes as the lowercase hex', async () => {
  const { signer } = await build()
  assert.notEqual(ETH_ADDRESS, ETH_ADDRESS.toLowerCase())
  assert.deepEqual(
    fromBech32(await signer.getAddress()).data,
    fromHex(ETH_ADDRESS.slice(2).toLowerCase()),
  )
})

test("getAccounts: the wrapped cosmos signer's pubkey is pinned", async () => {
  const { signer } = await build()
  const [account] = await signer.getAccounts()
  assert.equal(toHex(account.pubkey), COSMOS_PUBKEY_HEX)
})

test('signDirect: the signature bytes of a fixed SignDoc are pinned (keccak digest, r||s, 64 bytes)', async () => {
  const { signer } = await build()
  const doc = makeSignDoc(
    new Uint8Array([1, 2, 3, 4]),
    new Uint8Array([5, 6, 7, 8]),
    'realionetwork_3301-1',
    7,
  )
  const out = await signer.signDirect('ignored', doc)
  assert.equal(out.signed, doc)
  assert.equal(out.signature.signature, SIGNATURE_B64)
  assert.equal(Buffer.from(out.signature.signature, 'base64').length, 64)
  assert.equal(
    out.signature.pub_key.value,
    Buffer.from(COSMOS_PUBKEY_HEX, 'hex').toString('base64'),
  )
})

test('signDirect is deterministic (RFC 6979): the same SignDoc signs to the same bytes', async () => {
  const { signer } = await build()
  const doc = makeSignDoc(new Uint8Array([9]), new Uint8Array([8]), 'realionetwork_3301-1', 1)
  const a = await signer.signDirect('x', doc)
  const b = await signer.signDirect('x', doc)
  assert.equal(a.signature.signature, b.signature.signature)
})
