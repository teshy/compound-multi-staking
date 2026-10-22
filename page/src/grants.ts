import { GenericAuthorization, Grant } from 'cosmjs-types/cosmos/authz/v1beta1/authz'
import { MsgGrant, MsgRevoke } from 'cosmjs-types/cosmos/authz/v1beta1/tx'
import { StakeAuthorization, AuthorizationType } from 'cosmjs-types/cosmos/staking/v1beta1/authz'
import { MsgDelegate, MsgBeginRedelegate } from 'cosmjs-types/cosmos/staking/v1beta1/tx'
import { BOT_ADDRESS, TESHY_VALOPER, DSTRX_DENOM } from './realio'
import type { EncodeObject } from './sign'

// Used internally by withdrawGrant + revokeMsgs (no longer imported elsewhere).
const WITHDRAW_MSG = '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward'
// EncodeObject for a single MsgGrant carrying the given authorization Any.
// No expiration is set — grants remain active until explicitly revoked.
function grantMsg(granter: string, authorization: { typeUrl: string; value: Uint8Array }) {
  return {
    typeUrl: '/cosmos.authz.v1beta1.MsgGrant',
    value: MsgGrant.fromPartial({
      granter,
      grantee: BOT_ADDRESS,
      grant: Grant.fromPartial({
        authorization,
      }),
    }),
  }
}

// Grant 1: let the bot withdraw the delegator's staking rewards (global — any validator).
// Internal helper of compoundGrants (not exported).
function withdrawGrant(granter: string) {
  return grantMsg(granter, {
    typeUrl: '/cosmos.authz.v1beta1.GenericAuthorization',
    value: GenericAuthorization.encode(
      GenericAuthorization.fromPartial({ msg: WITHDRAW_MSG }),
    ).finish(),
  })
}

// Grant 2: let the bot delegate ONLY to the Teshy RIO validator (the compounding destination).
// Compounding destination is hard-coded to Teshy (d0b678e was the last commit with
// user-editable validator fields — restore from there if that flow is ever needed again).
// Internal helper of compoundGrants (not exported).
function delegateGrant(granter: string, valoper: string) {
  return grantMsg(granter, {
    typeUrl: '/cosmos.staking.v1beta1.StakeAuthorization',
    value: StakeAuthorization.encode(
      StakeAuthorization.fromPartial({
        authorizationType: AuthorizationType.AUTHORIZATION_TYPE_DELEGATE,
        allowList: { address: [valoper] },
      }),
    ).finish(),
  })
}

// Both grants the Phase-3a compound requires, in one tx.
// Destination is always TESHY_VALOPER — rewards compound into Teshy stake.
export function compoundGrants(granter: string) {
  return [withdrawGrant(granter), delegateGrant(granter, TESHY_VALOPER)]
}

// Optional initial stake — the user delegating their OWN tokens in the same tx as
// the grants. Each denom must go to a validator that bonds that denom (multistaking;
// docs/01-overview.md §6.8). These are the user's own MsgDelegates, not authz —
// the bot's grant scope is unchanged.
export interface StakeEntry {
  denom: string // 'ario' | 'arst' | 'erc20:…'
  valoper: string
  amount: bigint // in minimum units
}

// Manual proto3 encoder for MsgDelegateEVM. Mirrors the bot's copy in
// bot/scripts/lib/proto-evm.mjs; both are pinned to the shared golden fixture
// bot/test/fixtures/msg-delegate-evm.json (see src/grants.test.ts, WO-048).
// Fields: 1=delegator_address, 2=validator_address, 3=contract_address, 4=amount (decimal string).
function encodeVarint(n: number): number[] {
  const bytes: number[] = []
  let v = n
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  bytes.push(v & 0x7f)
  return bytes
}

function encodeStringField(fieldNum: number, str: string): Uint8Array {
  const strBytes = new TextEncoder().encode(str)
  const tag = (fieldNum << 3) | 2 // wire type 2 = length-delimited
  return new Uint8Array([...encodeVarint(tag), ...encodeVarint(strBytes.length), ...strBytes])
}

function encodeMsgDelegateEVM(delegator: string, valoper: string, amount: string): Uint8Array {
  const contract = DSTRX_DENOM.replace('erc20:', '')
  const parts = [
    encodeStringField(1, delegator),
    encodeStringField(2, valoper),
    encodeStringField(3, contract),
    encodeStringField(4, amount),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

// Returns one delegate message per entry (skips entries with amount === 0n).
// DSTRX uses MsgDelegateEVM (ERC-20 held in EVM state); all others use MsgDelegate.
export function delegateMsgs(delegator: string, stakes: StakeEntry[]): EncodeObject[] {
  return stakes
    .filter((s) => s.amount > 0n)
    .map((s) => {
      if (s.denom === DSTRX_DENOM) {
        return {
          typeUrl: '/multistaking.v1.MsgDelegateEVM',
          value: encodeMsgDelegateEVM(delegator, s.valoper, s.amount.toString()),
        }
      }
      return {
        typeUrl: '/cosmos.staking.v1beta1.MsgDelegate',
        value: MsgDelegate.fromPartial({
          delegatorAddress: delegator,
          validatorAddress: s.valoper,
          amount: { denom: s.denom, amount: s.amount.toString() },
        }),
      }
    })
}

export interface RedelegateEntry {
  srcValoper: string
  destValoper: string // Teshy validator matching the bond denom (RIO/RST/DSTRX)
  amount: bigint // in minimum units
  denom: string // actual bond denom (ario/arst/erc20:...) — NOT the 'stake' the staking
  // module reports; fetched via multistaking ABCI query per validator
}

// Redelegate stake to the appropriate Teshy validator. srcValoper → destValoper.
// Each entry must use the bond denom returned by fetchValidatorBondCoin(), not 'stake'.
export function redelegateMsgs(delegator: string, entries: RedelegateEntry[]): EncodeObject[] {
  return entries.map((e) => ({
    typeUrl: '/cosmos.staking.v1beta1.MsgBeginRedelegate',
    value: MsgBeginRedelegate.fromPartial({
      delegatorAddress: delegator,
      validatorSrcAddress: e.srcValoper,
      validatorDstAddress: e.destValoper,
      amount: { denom: e.denom, amount: e.amount.toString() },
    }),
  }))
}

// Revoke flow (trust/UX): one MsgRevoke per granted msg type.
export function revokeMsgs(granter: string) {
  const revoke = (msgTypeUrl: string) => ({
    typeUrl: '/cosmos.authz.v1beta1.MsgRevoke',
    value: MsgRevoke.fromPartial({ granter, grantee: BOT_ADDRESS, msgTypeUrl }),
  })
  return [revoke(WITHDRAW_MSG), revoke('/cosmos.staking.v1beta1.MsgDelegate')]
}
