// WO-048 (T-3, T-5, T-7, T-12, T-14, T-33, T-37, T-27 partial): the authz scope the user signs,
// the stake messages, and the TS MsgDelegateEVM encoder against the bot's golden fixture.
import { describe, expect, it } from 'vitest'
import { toHex } from '@cosmjs/encoding'
import { GenericAuthorization } from 'cosmjs-types/cosmos/authz/v1beta1/authz'
import { StakeAuthorization, AuthorizationType } from 'cosmjs-types/cosmos/staking/v1beta1/authz'
import { MsgDelegate, MsgBeginRedelegate } from 'cosmjs-types/cosmos/staking/v1beta1/tx'
import { MsgRevoke } from 'cosmjs-types/cosmos/authz/v1beta1/tx'
import raw from '../test-fixtures/msg-delegate-evm.json?raw'
import { compoundGrants, delegateMsgs, redelegateMsgs, revokeMsgs } from './grants'
import {
  BOT_ADDRESS,
  DSTRX_DENOM,
  RST_DENOM,
  TESHY_VALOPER,
  TESHY_RST_VALOPER,
  TESHY_DSTRX_VALOPER,
  TESHY_LEGACY_VALOPERS,
} from './realio'

const GRANTER = 'realio1granterxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
const WITHDRAW = '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward'
const DELEGATE = '/cosmos.staking.v1beta1.MsgDelegate'
const SEND_AUTH = '/cosmos.bank.v1beta1.SendAuthorization'

describe('compoundGrants — the authz scope the user signs', () => {
  const grants = compoundGrants(GRANTER)

  it('is exactly two MsgGrants from the granter to the bot', () => {
    expect(grants).toHaveLength(2)
    for (const g of grants) {
      expect(g.typeUrl).toBe('/cosmos.authz.v1beta1.MsgGrant')
      expect(g.value.granter).toBe(GRANTER)
      expect(g.value.grantee).toBe(BOT_ADDRESS)
    }
  })

  it('grant 0 is a GenericAuthorization for MsgWithdrawDelegatorReward only', () => {
    const auth = grants[0].value.grant!.authorization!
    expect(auth.typeUrl).toBe('/cosmos.authz.v1beta1.GenericAuthorization')
    expect(GenericAuthorization.decode(auth.value).msg).toBe(WITHDRAW)
  })

  it('grant 1 is a StakeAuthorization: DELEGATE only, allow-list exactly [TESHY_VALOPER]', () => {
    const auth = grants[1].value.grant!.authorization!
    expect(auth.typeUrl).toBe('/cosmos.staking.v1beta1.StakeAuthorization')
    const d = StakeAuthorization.decode(auth.value)
    expect(d.authorizationType).toBe(AuthorizationType.AUTHORIZATION_TYPE_DELEGATE)
    expect(d.allowList?.address).toEqual([TESHY_VALOPER])
    for (const legacy of TESHY_LEGACY_VALOPERS) expect(d.allowList?.address).not.toContain(legacy)
    expect(d.denyList).toBeUndefined()
    expect(d.maxTokens).toBeUndefined()
  })

  it('grants have no expiration (they stay until revoked)', () => {
    for (const g of grants) expect(g.value.grant!.expiration).toBeUndefined()
  })

  it('never grants a SendAuthorization', () => {
    for (const g of grants) expect(g.value.grant!.authorization!.typeUrl).not.toBe(SEND_AUTH)
    expect(JSON.stringify(grants.map((g) => g.value.grant!.authorization!.typeUrl))).not.toContain(
      'SendAuthorization',
    )
  })
})

describe('revokeMsgs', () => {
  it('revokes exactly the message types compoundGrants grants', () => {
    const granted = new Set<string>()
    for (const g of compoundGrants(GRANTER)) {
      const auth = g.value.grant!.authorization!
      if (auth.typeUrl === '/cosmos.authz.v1beta1.GenericAuthorization') {
        granted.add(GenericAuthorization.decode(auth.value).msg)
      } else if (auth.typeUrl === '/cosmos.staking.v1beta1.StakeAuthorization') {
        // a DELEGATE StakeAuthorization authorizes MsgDelegate
        const d = StakeAuthorization.decode(auth.value)
        expect(d.authorizationType).toBe(AuthorizationType.AUTHORIZATION_TYPE_DELEGATE)
        granted.add(DELEGATE)
      }
    }
    const revoked = revokeMsgs(GRANTER)
    for (const r of revoked) {
      expect(r.typeUrl).toBe('/cosmos.authz.v1beta1.MsgRevoke')
      expect(r.value.granter).toBe(GRANTER)
      expect(r.value.grantee).toBe(BOT_ADDRESS)
    }
    expect(new Set(revoked.map((r: { value: MsgRevoke }) => r.value.msgTypeUrl))).toEqual(granted)
    expect(revoked).toHaveLength(granted.size)
  })
})

describe('delegateMsgs', () => {
  const fixture = JSON.parse(raw)

  it('the golden fixture targets the contract inside DSTRX_DENOM', () => {
    // precondition for the hex comparisons below: same contract, or the bytes would differ for a boring reason
    expect(fixture.primary.contractAddress).toBe(DSTRX_DENOM.replace('erc20:', ''))
    expect(fixture.longAmountField.contractAddress).toBe(DSTRX_DENOM.replace('erc20:', ''))
  })

  for (const key of ['primary', 'longAmountField'] as const) {
    it(`DSTRX entry (${key}) encodes MsgDelegateEVM to the bot's golden hex`, () => {
      const f = fixture[key]
      const [msg] = delegateMsgs(f.delegatorAddress, [
        { denom: DSTRX_DENOM, valoper: f.validatorAddress, amount: BigInt(f.amount) },
      ])
      expect(msg.typeUrl).toBe('/multistaking.v1.MsgDelegateEVM')
      expect(toHex(msg.value as Uint8Array)).toBe(f.expectedHex)
    })
  }

  it('an ario entry is a MsgDelegate with exact denom and a 21-digit amount string', () => {
    const [msg] = delegateMsgs(GRANTER, [
      { denom: 'ario', valoper: TESHY_VALOPER, amount: 123456789012345678901n },
    ])
    expect(msg.typeUrl).toBe(DELEGATE)
    const v = msg.value as MsgDelegate
    expect(v.delegatorAddress).toBe(GRANTER)
    expect(v.validatorAddress).toBe(TESHY_VALOPER)
    expect(v.amount).toEqual({ denom: 'ario', amount: '123456789012345678901' })
  })

  it('an arst entry stays a plain MsgDelegate in arst', () => {
    const [msg] = delegateMsgs(GRANTER, [
      { denom: RST_DENOM, valoper: TESHY_RST_VALOPER, amount: 5n },
    ])
    expect(msg.typeUrl).toBe(DELEGATE)
    expect((msg.value as MsgDelegate).amount).toEqual({ denom: 'arst', amount: '5' })
  })

  it('drops a 0n entry and keeps order for the rest', () => {
    const msgs = delegateMsgs(GRANTER, [
      { denom: 'ario', valoper: TESHY_VALOPER, amount: 0n },
      { denom: 'ario', valoper: TESHY_VALOPER, amount: 1n },
      { denom: DSTRX_DENOM, valoper: TESHY_DSTRX_VALOPER, amount: 0n },
      { denom: RST_DENOM, valoper: TESHY_RST_VALOPER, amount: 2n },
    ])
    expect(msgs.map((m) => (m.value as MsgDelegate).amount?.amount)).toEqual(['1', '2'])
  })
})

describe('redelegateMsgs (T-27 partial)', () => {
  it('preserves each entry’s src, dest, own denom and exact amount', () => {
    const msgs = redelegateMsgs(GRANTER, [
      {
        srcValoper: 'realiovaloper1src1',
        destValoper: TESHY_VALOPER,
        amount: 123456789012345678901n,
        denom: 'ario',
      },
      {
        srcValoper: 'realiovaloper1src2',
        destValoper: TESHY_RST_VALOPER,
        amount: 7n,
        denom: 'arst',
      },
    ])
    expect(msgs).toHaveLength(2)
    const v = msgs.map((m) => {
      expect(m.typeUrl).toBe('/cosmos.staking.v1beta1.MsgBeginRedelegate')
      return m.value as MsgBeginRedelegate
    })
    expect(v[0].delegatorAddress).toBe(GRANTER)
    expect(v[0].validatorSrcAddress).toBe('realiovaloper1src1')
    expect(v[0].validatorDstAddress).toBe(TESHY_VALOPER)
    expect(v[0].amount).toEqual({ denom: 'ario', amount: '123456789012345678901' })
    expect(v[1].validatorSrcAddress).toBe('realiovaloper1src2')
    expect(v[1].validatorDstAddress).toBe(TESHY_RST_VALOPER)
    expect(v[1].amount).toEqual({ denom: 'arst', amount: '7' })
  })
})
