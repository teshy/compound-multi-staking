// WO-049 (T-26): analytics must never carry a wallet address (CLAUDE.md privacy rule). scrubAddr
// strips realio bech32 addresses from chain error text; the source-scan test makes sure every
// `error_message:` that reaches the dataLayer goes through it.
import { describe, expect, it } from 'vitest'
import { toBech32 } from '@cosmjs/encoding'
import txFlowSrc from './tx-flow.ts?raw'
import { scrubAddr } from './scrub'
import { BOT_ADDRESS, TESHY_VALOPER } from './realio'

const VALCONS = toBech32(
  'realiovalcons',
  new Uint8Array(20).map((_, i) => i * 11 + 3),
)

describe('scrubAddr', () => {
  it('replaces an account address embedded mid-string and keeps the surrounding text', () => {
    expect(scrubAddr(`account ${BOT_ADDRESS} not found: key not found`)).toBe(
      'account [addr] not found: key not found',
    )
  })

  it('replaces validator-operator addresses', () => {
    expect(scrubAddr(`validator ${TESHY_VALOPER} is jailed`)).toBe('validator [addr] is jailed')
  })

  it('replaces validator-consensus addresses', () => {
    expect(VALCONS.startsWith('realiovalcons1')).toBe(true)
    expect(scrubAddr(`slashed ${VALCONS}!`)).toBe('slashed [addr]!')
  })

  it('replaces every occurrence, not just the first', () => {
    expect(scrubAddr(`${BOT_ADDRESS} -> ${TESHY_VALOPER} / ${BOT_ADDRESS}`)).toBe(
      '[addr] -> [addr] / [addr]',
    )
  })

  it('leaves text without an address untouched', () => {
    const msg = 'insufficient funds: 5ario is smaller than 10ario'
    expect(scrubAddr(msg)).toBe(msg)
    expect(scrubAddr('')).toBe('')
  })

  it('leaves a non-realio bech32 address alone', () => {
    const cosmos = 'cosmos1' + 'q'.repeat(38)
    expect(scrubAddr(`from ${cosmos}`)).toBe(`from ${cosmos}`)
  })
})

// docs/06 gate 2026-10-16 (P-3): the other forms that resolve to the signer's account.
describe('scrubAddr — hashes, hex addresses and account numbers', () => {
  const HASH = 'C13FF23FFE0A4A28B549801F9E5B4F553CFC361F8D0F91E79BE4FEBB9DC7717E'

  it('a 64-hex tx hash, in either case and with or without 0x → [hash]', () => {
    expect(scrubAddr(`tx ${HASH} failed`)).toBe('tx [hash] failed')
    expect(scrubAddr(`tx ${HASH.toLowerCase()} failed`)).toBe('tx [hash] failed')
    expect(scrubAddr(`tx 0x${HASH} failed`)).toBe('tx [hash] failed')
  })

  it('a 0x EVM address (the same account in hex) → [addr]', () => {
    const evm = '0xb841F365D5221Bed66d60E69094418D8C2aa5A44'
    expect(scrubAddr(`insufficient balance for ${evm}`)).toBe('insufficient balance for [addr]')
  })

  it('an upper-case realio bech32 address → [addr]', () => {
    expect(scrubAddr(`account ${BOT_ADDRESS.toUpperCase()} not found`)).toBe(
      'account [addr] not found',
    )
  })

  it('the account number in a signature-verification failure → [n]; sequence and chain id stay', () => {
    expect(
      scrubAddr(
        'signature verification failed; please verify account number (17), sequence (3) and chain-id (realionetwork_3301-1): unauthorized',
      ),
    ).toBe(
      'signature verification failed; please verify account number ([n]), sequence (3) and chain-id (realionetwork_3301-1): unauthorized',
    )
  })

  it('any other run of 40+ hex digits → [hex]: a 66-hex pubkey, a bare 40-hex address, a glued hash (R-3)', () => {
    const pubkey = '02' + 'ab'.repeat(32)
    expect(scrubAddr(`pubkey ${pubkey} mismatch`)).toBe('pubkey [hex] mismatch')
    expect(scrubAddr(`from ${'b841f365d5221bed66d60e69094418d8c2aa5a44'} to`)).toBe('from [hex] to')
    expect(scrubAddr(`tx_${HASH}_failed`)).toBe('tx_[hex]_failed')
  })

  it('amounts and short hex-looking words are kept (operator decision: amounts stay)', () => {
    const msg =
      'spendable balance 1000ario is smaller than 2000ario: insufficient funds (code 5, deadbeef)'
    expect(scrubAddr(msg)).toBe(msg)
  })
})

// WO-057 D4: main.ts's two copies of the pipeline became one (tx-flow.ts), so the scan follows it.
// main.ts must not grow an error event of its own; every `error_message:` that reaches the
// dataLayer is in tx-flow.ts and goes through scrubAddr.
describe('every analytics error_message is scrubbed', () => {
  const values = [...txFlowSrc.matchAll(/error_message:\s*([^\n]*)/g)].map((m) => m[1])

  it('finds the error_message site(s) in tx-flow.ts (the scan is not vacuous)', () => {
    expect(values.length).toBeGreaterThanOrEqual(1)
  })

  it('every error_message value expression starts with scrubAddr(', () => {
    for (const v of values) expect(v.trimStart().startsWith('scrubAddr(')).toBe(true)
  })
})
