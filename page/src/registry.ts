import { Registry } from '@cosmjs/proto-signing'
import { defaultRegistryTypes } from '@cosmjs/stargate'
import { MsgGrant, MsgRevoke } from 'cosmjs-types/cosmos/authz/v1beta1/tx'

// cosmjs's default registry covers bank/staking/distribution but NOT authz Msg types.
export const registry = new Registry(defaultRegistryTypes)
registry.register('/cosmos.authz.v1beta1.MsgGrant', MsgGrant)
registry.register('/cosmos.authz.v1beta1.MsgRevoke', MsgRevoke)

// MsgDelegateEVM — DSTRX is an ERC-20 held in EVM state; standard MsgDelegate fails.
// Value is pre-encoded proto bytes from encodeMsgDelegateEVM() in grants.ts.
// Passthrough codec: encode returns the bytes as-is, decode is a stub.
registry.register('/multistaking.v1.MsgDelegateEVM', {
  encode: (value: Uint8Array) => ({ finish: () => value }) as any,
  decode: (bytes: Uint8Array) => bytes as any,
  fromPartial: (v: any) => v,
} as any)
