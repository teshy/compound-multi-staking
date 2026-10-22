// WO-048 (T-15, T-38): the decimal→BigInt boundary for every staked amount, and the DSTRX
// ERC-20 balance lookup's failure modes.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DECIMALS,
  DSTRX_DENOM,
  BOT_ADDRESS,
  TESHY_VALOPER,
  fromDisplay,
  toRio,
  fetchErc20Balance,
  fetchValidatorBondCoin,
} from './realio'

describe('fromDisplay', () => {
  it.each([
    ['10.5', 10500000000000000000n],
    ['1', 1000000000000000000n],
    ['.5', 500000000000000000n], // current behavior: a bare leading dot is accepted
    ['0.000000000000000001', 1n],
    ['0.123456789012345678', 123456789012345678n], // exactly 18 fraction digits
    ['123456789.123456789012345678', 123456789123456789012345678n], // far above 2^53
    ['  2  ', 2000000000000000000n], // trimmed
  ])('%s → %s', (input, expected) => {
    expect(fromDisplay(input, DECIMALS)).toBe(expected)
  })

  it('respects the decimals argument', () => {
    expect(fromDisplay('1.5', 6)).toBe(1500000n)
    expect(() => fromDisplay('1.1234567', 6)).toThrow('Too many decimal places')
  })

  it.each([
    ['19 fraction digits', '0.0000000000000000001'],
    ['negative', '-1'],
    ['exponent', '1e5'],
    ['empty', ''],
    ['letters', 'abc'],
    ['two dots', '1.2.3'],
    ['trailing dot', '1.'],
    ['comma', '1,5'],
  ])('rejects %s', (_label, input) => {
    expect(() => fromDisplay(input, DECIMALS)).toThrow()
  })

  it('"Too many decimal places" is the error for 19 fraction digits', () => {
    expect(() => fromDisplay('0.0000000000000000001', DECIMALS)).toThrow('Too many decimal places')
  })
})

describe('toRio', () => {
  it('round-trips a value above 2^53 exactly', () => {
    const wei = fromDisplay('123456789.123456789012345678', DECIMALS)
    expect(wei > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true)
    expect(toRio(wei.toString())).toBe('123456789.123456789012345678')
  })

  it('formats small and whole values', () => {
    expect(toRio('1')).toBe('0.000000000000000001')
    expect(toRio('1000000000000000000')).toBe('1')
    expect(toRio('10500000000000000000')).toBe('10.5')
    expect(toRio('0')).toBe('0')
  })
})

describe('fetchErc20Balance', () => {
  const contract = DSTRX_DENOM.replace('erc20:', '')

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFetch(res: Response) {
    const fn = vi.fn(async () => res)
    vi.stubGlobal('fetch', fn)
    return fn
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  it('rejects on an HTTP 500', async () => {
    stubFetch(json({}, 500))
    await expect(fetchErc20Balance(contract, BOT_ADDRESS)).rejects.toThrow('HTTP 500')
  })

  it('rejects on a 200 carrying GraphQL errors', async () => {
    stubFetch(json({ errors: [{ message: 'indexing_error' }] }))
    await expect(fetchErc20Balance(contract, BOT_ADDRESS)).rejects.toThrow('indexing_error')
  })

  it('resolves 0n when the account has no erc20Balance entity (null)', async () => {
    stubFetch(json({ data: { erc20Balance: null } }))
    expect(await fetchErc20Balance(contract, BOT_ADDRESS)).toBe(0n)
  })

  it('resolves the exact BigInt for a 21-digit valueExact', async () => {
    stubFetch(json({ data: { erc20Balance: { valueExact: '123456789012345678901' } } }))
    expect(await fetchErc20Balance(contract, BOT_ADDRESS)).toBe(123456789012345678901n)
  })

  it('queries by the lowercased "contract/evmhex" id', async () => {
    const fn = stubFetch(json({ data: { erc20Balance: null } }))
    await fetchErc20Balance(contract, BOT_ADDRESS)
    const init = (fn.mock.calls[0] as unknown as [string, RequestInit])[1]
    const { query } = JSON.parse(String(init.body))
    expect(query).toMatch(new RegExp(`id: "${contract.toLowerCase()}/0x[0-9a-f]{40}"`))
  })

  it('is bounded like every page read: a 15 s timeout signal (docs/06 gate 2026-10-16, P-4)', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const fn = stubFetch(json({ data: { erc20Balance: null } }))
    await fetchErc20Balance(contract, BOT_ADDRESS)
    const init = (fn.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(timeout).toHaveBeenCalledWith(15_000)
    timeout.mockRestore()
  })
})

describe('toRio decimals parameter (WO-057 C-68)', () => {
  it('defaults to 18 and honors an explicit decimals', () => {
    expect(toRio('1500000')).toBe('0.0000000000015')
    expect(toRio('1500000', 6)).toBe('1.5')
    expect(toRio('1', 6)).toBe('0.000001')
    expect(toRio(2_000_000, 6)).toBe('2')
    expect(toRio('-1500000', 6)).toBe('-1.5')
  })
})

describe('fetchValidatorBondCoin goes through the checked GET (WO-057 D1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a non-2xx from the RPC rejects (so the caller treats the token as unknown)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' }),
      ),
    )
    await expect(fetchValidatorBondCoin(TESHY_VALOPER)).rejects.toThrow('502 Bad Gateway')
  })

  it('a 200 with no result value still rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ result: { response: {} } }), { status: 200 }),
      ),
    )
    await expect(fetchValidatorBondCoin(TESHY_VALOPER)).rejects.toThrow('no bond coin')
  })

  it('decodes the bond coin from a good response', async () => {
    const denom = 'arst'
    const bytes = new Uint8Array([0x0a, denom.length, ...new TextEncoder().encode(denom)])
    const value = btoa(String.fromCharCode(...bytes))
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ result: { response: { value } } }), { status: 200 }),
      ),
    )
    expect(await fetchValidatorBondCoin(TESHY_VALOPER)).toBe('arst')
  })
})
