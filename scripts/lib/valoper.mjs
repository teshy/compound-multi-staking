// The ONE realio valoper-shape test (WO-059 D4, C-36/C-61), shared by grouping.mjs (grant allow_lists)
// and claim.mjs (rewards entries). Both used to carry their own regex, of different strictness.
//
// A realio valoper in bech32 shape: "realiovaloper1" + 38 data/checksum chars (20-byte address) from
// the bech32 charset (no 1, b, i, o). The chain does NOT validate allow_list entries at grant time,
// and a rewards entry comes from a REST response, so either is attacker/remote-chosen text that would
// otherwise reach the logs verbatim — log lines the wrapper and the metrics exporter parse (docs/06
// re-review 2026-10-08). Shape only: the chain still rejects a bad checksum at simulate, before
// anything is broadcast.
const VALOPER_SHAPE = /^realiovaloper1[02-9ac-hj-np-z]{38}$/

export function isRealioValoper(v) {
  return typeof v === 'string' && VALOPER_SHAPE.test(v)
}
