// Synthetic addresses for the tests: valid bech32 of a fixed 20-byte pattern (every byte = n), never the address of
// a real key. `account(n)` is a realio1… account, `valoper(n)` the realiovaloper1… of the same bytes.
import { toBech32 } from '@cosmjs/encoding'

const pattern = (n) => new Uint8Array(20).fill(n)

export const account = (n) => toBech32('realio', pattern(n))
export const valoper = (n) => toBech32('realiovaloper', pattern(n))
