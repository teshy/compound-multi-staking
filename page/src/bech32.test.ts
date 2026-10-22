// WO-046 Review F1: `fromBech32` at its DEFAULT limit is what src/realio.ts `bech32ToEvmHex`
// (the DSTRX balance lookup) and several cosmjs internals call. @scure/base >= 2.3.0 rejects the
// `limit = Infinity` that @cosmjs/encoding 0.39.0 passes by default, so every decode threw and DSTRX
// staking was refused for every user. This guards that class of dependency break: a lockfile bump
// that breaks bech32 decoding fails the suite instead of passing it silently.
import { describe, expect, it } from 'vitest'
import { fromBech32, toBech32 } from '@cosmjs/encoding'
import {
  TESHY_VALOPER,
  TESHY_RST_VALOPER,
  TESHY_DSTRX_VALOPER,
  TESHY_LEGACY_VALOPERS,
} from './realio'

// The bot wallet. Its EVM form is the same 20 bytes (Ethermint). The expected hex was captured
// 2026-10-08 with the bot's own @cosmjs/encoding 0.30 (a separate dependency tree from the page's).
const BOT = 'realio10eq6w0a7fpety33uag2f55e9tewxazt4v28aem'
const BOT_EVM_HEX = '7e41a73fbe4872b2463cea149a53255e5c6e8975'

describe('bech32 decoding at the cosmjs default limit', () => {
  const addrs = [
    BOT,
    TESHY_VALOPER,
    TESHY_RST_VALOPER,
    TESHY_DSTRX_VALOPER,
    ...TESHY_LEGACY_VALOPERS,
  ]

  it.each(addrs)('decodes and round-trips %s', (addr) => {
    const { prefix, data } = fromBech32(addr)
    expect(data).toHaveLength(20)
    expect(toBech32(prefix, data)).toBe(addr)
  })

  it('yields the 20 bytes the DSTRX balance lookup uses as the EVM address', () => {
    const hex = Array.from(fromBech32(BOT).data, (b) => b.toString(16).padStart(2, '0')).join('')
    expect(hex).toBe(BOT_EVM_HEX)
  })
})
