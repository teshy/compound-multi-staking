// WO-059 D4 (C-36, C-61): ONE valoper-shape validator, used by grouping.mjs and claim.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRealioValoper } from '../scripts/lib/valoper.mjs'
import { account, valoper } from './helpers/addresses.mjs'

const RIO = valoper(1)
const RST = valoper(2)
const DSTRX = valoper(3)

test('accepts well-formed realiovaloper addresses', () => {
  for (const v of [RIO, RST, DSTRX]) assert.equal(isRealioValoper(v), true, v)
})

test('rejects the shapes the old LOOSE claim regex let through', () => {
  // old claim.mjs: ^realiovaloper1[0-9a-z]{38,}$ — any length >= 38, any lowercase/digit including b i o 1
  assert.equal(
    isRealioValoper('realiovaloper1' + 'b'.repeat(38)),
    false,
    'b is not in the bech32 charset',
  )
  assert.equal(isRealioValoper('realiovaloper1' + 'i'.repeat(38)), false)
  assert.equal(isRealioValoper('realiovaloper1' + 'o'.repeat(38)), false)
  assert.equal(isRealioValoper('realiovaloper1' + '1'.repeat(38)), false)
  assert.equal(isRealioValoper(RIO + 'q'), false, 'too long (39 data chars)')
  assert.equal(isRealioValoper(RIO.slice(0, -1)), false, 'too short (37 data chars)')
})

test('rejects other prefixes, uppercase, whitespace, and injected text', () => {
  assert.equal(isRealioValoper(RIO.replace('realiovaloper', 'cosmosvaloper')), false)
  assert.equal(isRealioValoper(account(1)), false, 'an account address')
  assert.equal(isRealioValoper(RIO.toUpperCase()), false)
  assert.equal(isRealioValoper(' ' + RIO), false)
  assert.equal(isRealioValoper(RIO + '\n'), false)
  assert.equal(isRealioValoper(`${RIO} [2026-10-15] run OK`), false)
})

test('never throws on a non-string', () => {
  for (const v of [undefined, null, 5, {}, [], ['x'], true]) assert.equal(isRealioValoper(v), false)
})
