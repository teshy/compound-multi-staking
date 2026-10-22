// Pure grant-grouping logic extracted from multi-compound.mjs (TQA-010,
// TEST-QA-FINDINGS.md). Grants are permissionless (H1, docs/12) — a single
// malformed or adversarial grant (e.g. a non-array allow_list.address) must
// never abort the whole run; it is logged and skipped instead.
const WITHDRAW_MSG_DEFAULT = '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward'
import { isRealioValoper } from './valoper.mjs'

// groups authz grants by granter -> { withdraw: bool, destValoper: string|null }
export function groupGrants(grants, { withdrawMsgTypeUrl = WITHDRAW_MSG_DEFAULT, log = () => {} } = {}) {
  const byDelegator = {}
  for (const g of grants) {
    try {
      const d = (byDelegator[g.granter] ||= { withdraw: false, destValoper: null })
      const type = g.authorization?.['@type']
      if (type === '/cosmos.authz.v1beta1.GenericAuthorization' && g.authorization.msg === withdrawMsgTypeUrl) {
        d.withdraw = true
      } else if (type === '/cosmos.staking.v1beta1.StakeAuthorization'
        && g.authorization.authorization_type === 'AUTHORIZATION_TYPE_DELEGATE') {
        // Sort so the choice is deterministic regardless of REST ordering (L2, docs/12):
        // a multi-entry allow_list (trivial to create via the grantStake precompile) must
        // not yield an order-dependent destination. Any listed valoper is authorized.
        const rawList = g.authorization.allow_list?.address
        if (!Array.isArray(rawList)) {
          log(`  (warn) malformed grant from ${g.granter}: allow_list.address is not an array (${typeof rawList}) — skipping this grant`)
          continue
        }
        const list = rawList.filter(isRealioValoper).sort()
        if (list.length < rawList.length) {
          // Name only the granter (chain-validated) — never echo the rejected entry itself.
          log(`  (warn) ${g.granter} allow_list has ${rawList.length - list.length} entry(ies) that are not a realio valoper address — ignored`)
        }
        d.destValoper = list[0] || null
        if (list.length > 1) log(`  (note) ${g.granter} allow_list has ${list.length} validators; using ${d.destValoper} (lexicographically first)`)
      }
    } catch (e) {
      log(`  (warn) malformed grant from ${g?.granter ?? '<unknown>'}, skipping: ${e?.message || e}`)
    }
  }
  return byDelegator
}
