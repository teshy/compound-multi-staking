// The page's one checked JSON GET (WO-057 D1). The status is checked BEFORE the body is parsed, so a
// non-2xx answer can never be read as data (a 5xx body that happens to be JSON, a gateway HTML page),
// and a failure always carries its HTTP status.

// A non-2xx answer, or a 2xx whose body is not JSON. `status` lets the broadcast path tell a refusal
// (4xx: nothing entered the mempool) from a failure in transit.
export class HttpError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

// Every page request is bounded (docs/06 gate 2026-10-16, P-4): a hung socket must not leave a flow
// "waiting" with the buttons locked, because the natural recovery (reload and resubmit) could stake
// twice. A timeout rejects like a network error, which every caller already handles: a read fails
// closed, an unanswered broadcast is 'unknown' and gets polled, a tx lookup just asks again next round.
export const READ_TIMEOUT_MS = 15_000

// AbortSignal.timeout needs Chrome/Edge/Brave 103+, Firefox 100+, Safari 16+ (re-review R-5). Where it
// is missing the request goes out unbounded, as it did before P-4, rather than every read failing closed
// and locking an older in-app wallet browser out of the page.
function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined
}

// `init` with a timeout signal added, unless the caller passed a signal of its own.
export function withTimeout(init: RequestInit | undefined, ms: number): RequestInit {
  const signal = init?.signal ?? timeoutSignal(ms)
  return signal ? { ...init, signal } : { ...init }
}

export async function requestJson<T>(
  url: string,
  init?: RequestInit,
  timeoutMs = READ_TIMEOUT_MS,
): Promise<T> {
  const res = await fetch(url, withTimeout(init, timeoutMs))
  if (!res.ok) {
    let message: unknown
    try {
      message = ((await res.json()) as { message?: unknown } | null)?.message
    } catch {
      /* not JSON: fall back to the status line */
    }
    throw new HttpError(
      typeof message === 'string' && message ? message : `${res.status} ${res.statusText}`,
      res.status,
    )
  }
  try {
    return (await res.json()) as T
  } catch {
    throw new HttpError(`${res.status} response was not JSON`, res.status)
  }
}

export function getJson<T>(url: string): Promise<T> {
  return requestJson<T>(url)
}
