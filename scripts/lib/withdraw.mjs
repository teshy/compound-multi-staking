// The delegator's reward withdraw address (WO-063 D1, Security S-1). multi-compound sizes each
// delegate as if the withdrawn rewards land in the delegator's OWN account (it delegates exactly the
// summed reward on top of the liquid balance). A delegator can point its rewards somewhere else
// (MsgSetWithdrawAddress); then the withdraw credits that other account and the delegate would be paid
// from the delegator's own principal. So a delegator whose withdraw address is not itself is skipped.
// Pure helpers, no I/O of their own — same shape as lib/destination.mjs.

// withdrawAddress: what the chain returned. The distribution query ALWAYS answers with an address (the
// delegator's own when none was set; verified on mainnet 2026-10-16), so an empty or missing one is a
// malformed answer, not "self": fail closed (docs/06 gate 2026-10-16, B-5; this supersedes WO-063 D1,
// which read empty as the chain default).
export function withdrawVerdict(delegator, withdrawAddress) {
  if (withdrawAddress === undefined || withdrawAddress === null || withdrawAddress === '') return { ok: false, reason: 'empty' }
  if (typeof withdrawAddress !== 'string') return { ok: false, reason: 'unreadable' }
  return withdrawAddress === delegator ? { ok: true } : { ok: false, reason: 'differs' }
}

// fetchWithdrawAddress(delegator) -> the address string; a rejected query is NOT "self": fail closed.
export function withdrawChecker(fetchWithdrawAddress) {
  return async (delegator) => {
    let withdrawAddress
    try {
      withdrawAddress = await fetchWithdrawAddress(delegator)
    } catch (e) {
      return { ok: false, reason: 'query-failed', message: e?.message || String(e) }
    }
    return withdrawVerdict(delegator, withdrawAddress)
  }
}
