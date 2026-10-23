// Fund-moving runs use ONLY the node the operator trusts. The run-compound.sh wrapper exports
// COMPOUND_LOCAL_ONLY=1 and COMPOUND_NODE_HOST (the host of COMPOUND_NODE_REST); with them set, the network config
// keeps just that node's URLs, so if the node fails mid-run the reads FAIL instead of silently moving to a
// third-party endpoint (the amount-sizing reads — rewards, balances, withdraw address — decide how much is
// delegated). Unset (a manual dev or dry run) leaves the ordered list untouched.
//
// "Local" is decided by the URL's HOST, never a prefix or substring match.
import fs from 'node:fs'
import path from 'node:path'

// Keeps the entries of `urls` (an array, or a lone string) whose host is `host` (the operator's node), in order.
// Throws if `host` is not a non-empty string or if none remain: the caller must fail, not fall back.
export function filterLocalUrls(urls, host) {
  if (typeof host !== 'string' || host === '') throw new Error('COMPOUND_NODE_HOST is not set')
  const list = Array.isArray(urls) ? urls : urls === undefined || urls === null ? [] : [urls]
  const kept = list.filter((u) => {
    try {
      return typeof u === 'string' && new URL(u).hostname === host
    } catch {
      return false
    }
  })
  if (kept.length === 0) throw new Error(`no local node URL (${host}) in the network config`)
  return kept
}

// applyLocalOnly is opt-in in the JS, so a bare `DRY_RUN=false node scripts/…` would use the whole configured
// list. A LIVE fund-moving run must therefore come through its run-compound.sh wrapper. COMPOUND_LOCAL_ONLY=1
// alone only proves "trusted node", so a hand-run with that variable would skip the run lock and could overlap
// a timer run. A live run therefore also proves it was started under the wrapper's lock: acquire_run_lock
// exports COMPOUND_RUN_LOCK (the absolute lock path) and leaves fd 9 open on that file, and the child inherits
// both. The check is that fd 9 and the named file are the same file (dev + ino). It does NOT prove the flock
// is still held: a caller who opens fd 9 on the named file by hand passes it. The test suites point at
// localhost stubs, so COMPOUND_TEST_SEAMS=1 (exactly that value; no unit or wrapper sets it) lets them keep
// running live paths. A dry run never needs any of this.
export const LIVE_RUN_REFUSAL =
  'a live fund-moving run must go through its run-compound.sh wrapper (it holds the run lock and checks the trusted node); refusing'

// True when fd 9 is open on the file COMPOUND_RUN_LOCK names (an absolute path), compared by dev and
// ino as BigInts (an ino can exceed 2^53). Any failure to look is "no".
export function holdsWrapperLock(env = process.env, fsApi = fs) {
  const lock = env.COMPOUND_RUN_LOCK
  if (typeof lock !== 'string' || !path.isAbsolute(lock)) return false
  try {
    const held = fsApi.fstatSync(9, { bigint: true })
    const named = fsApi.statSync(lock, { bigint: true })
    return held.dev === named.dev && held.ino === named.ino
  } catch {
    return false
  }
}

export function assertLiveRunIsLocal(isLive, env = process.env, fsApi = fs) {
  if (!isLive || env.COMPOUND_TEST_SEAMS === '1') return
  if (env.COMPOUND_LOCAL_ONLY === '1' && holdsWrapperLock(env, fsApi)) return
  throw new Error(LIVE_RUN_REFUSAL)
}

// Returns the network `data` to build the Network from: unchanged unless COMPOUND_LOCAL_ONLY === '1', in
// which case a COPY with restUrl and rpcUrl reduced to the URLs whose host is COMPOUND_NODE_HOST. Used by
// loadBotWallet so the rule is implemented once.
export function applyLocalOnly(data, env = process.env) {
  if (env.COMPOUND_LOCAL_ONLY !== '1') return data
  try {
    const host = env.COMPOUND_NODE_HOST
    return { ...data, restUrl: filterLocalUrls(data.restUrl, host), rpcUrl: filterLocalUrls(data.rpcUrl, host) }
  } catch (e) {
    throw new Error(`COMPOUND_LOCAL_ONLY=1 but ${e.message}; refusing to use a non-local node for a fund-moving run`, { cause: e })
  }
}
