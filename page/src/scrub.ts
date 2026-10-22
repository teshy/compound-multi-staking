// Strip identifiers from chain error text before it reaches analytics. The locked privacy rule is:
// no wallet address and no tx hash in dataLayer (CLAUDE.md). rawLog often embeds the signer's realio
// bech32 address (e.g. "account realio1… not found"); it can also carry a 64-hex tx hash, a 0x EVM
// address (the same account in hex), or the signer's account number, which the chain maps back to the
// address (docs/06 gate 2026-10-16, P-3). Any other run of 40+ hex digits (a pubkey the address derives
// from, a bare or glued hash or address) is caught last (re-review R-3). Amounts are kept (operator
// decision, WO-065 D1).
export function scrubAddr(s: string): string {
  return s
    .replace(/realio(valoper|valcons)?1[ac-hj-np-z02-9]{38,40}/gi, '[addr]')
    .replace(/\b(?:0x)?[0-9a-f]{64}\b/gi, '[hash]')
    .replace(/\b0x[0-9a-f]{40}\b/gi, '[addr]')
    .replace(/(?:0x)?[0-9a-f]{40,}/gi, '[hex]')
    .replace(/(account number\s*\(?\s*)\d+/gi, '$1[n]')
}
