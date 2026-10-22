// Delegate-destination safety gate (WO-044). The destination comes from each delegator's own
// StakeAuthorization allow_list (never hardcoded). Realio v1.8.0 (height 20,106,800) jails the two
// old compromised-operator validators and moves their stake to replacements, but a grant that names
// an old validator still authorizes delegating to it — compounding would then stake rewards into a
// jailed validator that earns nothing. Only a BONDED, non-jailed destination is compounded into;
// anything else is skipped until the delegator re-grants. Fail-closed: an unknown status skips.

// validator: a staking `validator` object (REST), or null/undefined when the query failed.
export function destinationVerdict(validator) {
  if (!validator) return { ok: false, reason: 'destination status unknown (query failed)' }
  if (validator.jailed === true) return { ok: false, reason: 'destination is jailed' }
  if (validator.status !== 'BOND_STATUS_BONDED') return { ok: false, reason: `destination is not bonded (${validator.status ?? 'no status'})` }
  return { ok: true }
}

// Returns a memoized async (valoper) -> verdict, so a run queries each destination once.
export function destinationChecker(getValidator) {
  const cache = new Map()
  return (valoper) => {
    if (!cache.has(valoper)) {
      cache.set(valoper, getValidator(valoper).then(destinationVerdict, () => destinationVerdict(null)))
    }
    return cache.get(valoper)
  }
}
