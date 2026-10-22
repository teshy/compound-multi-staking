// WO-057 D1 (C-2, C-23, C-30, C-46): one checked GET helper. The status is checked BEFORE the body
// is parsed, so a non-2xx never reads as data and a non-JSON error page still carries its status.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getJson, requestJson, HttpError, READ_TIMEOUT_MS, withTimeout, isAbortError } from './http'

const json = (body: unknown, status = 200, statusText = '') =>
  new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  })
const text = (body: string, status: number, statusText = '') =>
  new Response(body, { status, statusText })

afterEach(() => {
  vi.unstubAllGlobals()
})

async function caught(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError)
    return e as HttpError
  }
  throw new Error('expected a rejection')
}

describe('getJson', () => {
  it('resolves the parsed body of a 2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ a: 1 })),
    )
    expect(await getJson<{ a: number }>('https://x/y')).toEqual({ a: 1 })
  })

  it('a JSON error body throws HttpError with the status and the body message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ message: 'tx not found' }, 404)),
    )
    const e = await caught(getJson('https://x/y'))
    expect(e.status).toBe(404)
    expect(e.message).toBe('tx not found')
  })

  it('a JSON error body WITHOUT a message falls back to "<status> <statusText>"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ code: 5 }, 503, 'Service Unavailable')),
    )
    const e = await caught(getJson('https://x/y'))
    expect(e.status).toBe(503)
    expect(e.message).toBe('503 Service Unavailable')
  })

  it('a NON-JSON error body (an HTML 502 page) still throws HttpError carrying the status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => text('<html>Bad Gateway</html>', 502, 'Bad Gateway')),
    )
    const e = await caught(getJson('https://x/y'))
    expect(e.status).toBe(502)
    expect(e.message).toBe('502 Bad Gateway')
  })

  it('a non-JSON 2xx body throws HttpError (status 200), never a bare SyntaxError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => text('not json', 200, 'OK')),
    )
    const e = await caught(getJson('https://x/y'))
    expect(e.status).toBe(200)
  })

  it('does not parse a failing response as data: a 500 with a data-shaped body still throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ balances: [] }, 500, 'Internal Server Error')),
    )
    const e = await caught(getJson('https://x/y'))
    expect(e.status).toBe(500)
  })

  it('a network failure propagates as the fetch rejection (not an HttpError)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(getJson('https://x/y')).rejects.toThrow('Failed to fetch')
    await expect(getJson('https://x/y')).rejects.not.toBeInstanceOf(HttpError)
  })
})

describe('requestJson', () => {
  it('passes the init (method/headers/body) through to fetch, plus a timeout signal', async () => {
    const fn = vi.fn(async () => json({ ok: true }))
    vi.stubGlobal('fetch', fn)
    await requestJson('https://x/y', { method: 'POST', body: '{"a":1}' })
    expect(fn).toHaveBeenCalledWith('https://x/y', {
      method: 'POST',
      body: '{"a":1}',
      signal: expect.any(AbortSignal),
    })
  })
})

// docs/06 gate 2026-10-16 (P-4): no page request is unbounded.
describe('timeouts', () => {
  it('getJson and requestJson default to READ_TIMEOUT_MS (15 s); an explicit budget wins', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ ok: true })),
    )
    await getJson('https://x/y')
    await requestJson('https://x/y', { method: 'POST' }, 30_000)
    expect(READ_TIMEOUT_MS).toBe(15_000)
    expect(timeout.mock.calls.map((c) => c[0])).toEqual([15_000, 30_000])
    timeout.mockRestore()
  })

  it('without AbortSignal.timeout (an older browser) withTimeout adds no signal and the request still goes out (R-5)', async () => {
    const original = AbortSignal.timeout
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true })
    try {
      expect(withTimeout({ method: 'POST' }, 1000)).toEqual({ method: 'POST' })
      const fn = vi.fn(async () => json({ ok: true }))
      vi.stubGlobal('fetch', fn)
      expect(await getJson('https://x/y')).toEqual({ ok: true })
      expect(fn).toHaveBeenCalledWith('https://x/y', {})
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', { value: original, configurable: true })
    }
  })

  it('isAbortError: TimeoutError and AbortError only', () => {
    expect(isAbortError(new DOMException('t', 'TimeoutError'))).toBe(true)
    expect(isAbortError(new DOMException('a', 'AbortError'))).toBe(true)
    expect(isAbortError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isAbortError(new SyntaxError('bad json'))).toBe(false)
    expect(isAbortError(undefined)).toBe(false)
  })

  it("withTimeout keeps the caller's own signal instead of adding one", () => {
    const own = new AbortController().signal
    expect(withTimeout({ signal: own }, 1000).signal).toBe(own)
    expect(withTimeout(undefined, 1000).signal).toBeInstanceOf(AbortSignal)
  })

  it('a timed-out request rejects like a network error (not an HttpError)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('signal timed out', 'TimeoutError')
      }),
    )
    await expect(getJson('https://x/y')).rejects.toThrow('signal timed out')
    await expect(getJson('https://x/y')).rejects.not.toBeInstanceOf(HttpError)
  })
})
