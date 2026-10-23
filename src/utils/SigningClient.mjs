import { multiply, ceil, bignumber } from 'mathjs'
import { Long } from "cosmjs-types/helpers.js";

import {
  defaultRegistryTypes as defaultStargateTypes,
  GasPrice
} from "@cosmjs/stargate";
import { sleep } from "@cosmjs/utils";
import { makeSignDoc, Registry } from "@cosmjs/proto-signing";
import { toBase64, fromBase64 } from '@cosmjs/encoding'
import { PubKey } from "cosmjs-types/cosmos/crypto/secp256k1/keys.js";
import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing.js";
import { AuthInfo, Fee, TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx.js";

import { coin, get, post } from './Helpers.mjs'
import { submitTx, waitForTx, assertTxSuccess, txHashOf } from './TxConfirm.mjs'

function SigningClient(network, signer) {

  const defaultGasPrice = network.gasPricePrefer || network.gasPrice
  const { restUrl, gasModifier: defaultGasModifier, slip44: coinType, chainId } = network

  const registry = new Registry(defaultStargateTypes);

  function getAccount(address) {
    // WO-064 S-12: bounded — a hung account read must fail before anything is signed (a plain error)
    return get(restUrl + "/cosmos/auth/v1beta1/accounts/" + address, { timeout: network.accountTimeout || 10_000 })
      .then((res) => res.data.account)
      .then((value) => {
        // see https://github.com/chainapsis/keplr-wallet/blob/7ca025d32db7873b7a870e69a4a42b525e379132/packages/cosmos/src/account/index.ts#L73
        // If the chain modifies the account type, handle the case where the account type embeds the base account.
        // (Actually, the only existent case is ethermint, and this is the line for handling ethermint)
        const baseAccount =
          value.BaseAccount || value.baseAccount || value.base_account;
        if (baseAccount) {
          value = baseAccount;
        }

        // If the account is the vesting account that embeds the base vesting account,
        // the actual base account exists under the base vesting account.
        // But, this can be different according to the version of cosmos-sdk.
        // So, anyway, try to parse it by some ways...
        const baseVestingAccount =
          value.BaseVestingAccount ||
          value.baseVestingAccount ||
          value.base_vesting_account;
        if (baseVestingAccount) {
          value = baseVestingAccount;

          const baseAccount =
            value.BaseAccount || value.baseAccount || value.base_account;
          if (baseAccount) {
            value = baseAccount;
          }
        }

        // Handle nested account like Desmos
        const nestedAccount = value.account
        if(nestedAccount){
          value = nestedAccount
        }

        return value
      })
      .catch((error) => {
        if(error.response?.status === 404){
          throw new Error('Account does not exist on chain')
        }else{
          throw error
        }
      })
  };

  // vendored to handle large integers
  // https://github.com/cosmos/cosmjs/blob/0f0c9d8a754cbf01e17acf51d3f2dbdeaae60757/packages/stargate/src/fee.ts
  function calculateFee(gasLimit, gasPrice) {
    const processedGasPrice = typeof gasPrice === "string" ? GasPrice.fromString(gasPrice) : gasPrice;
    const { denom, amount: gasPriceAmount } = processedGasPrice;
    const amount = ceil(bignumber(multiply(bignumber(gasPriceAmount.toString()), bignumber(gasLimit.toString()))));
    return {
      amount: [coin(amount, denom)],
      gas: gasLimit.toString()
    };
  }

  // WO-064 S-31: the gas limit must be a positive finite number. It used to default to 200000 for a
  // falsy gas, so a failed or malformed simulation silently became a fixed-fee transaction.
  function getFee(gas, gasPrice) {
    const n = Number(gas);
    if (gas === null || gas === undefined || gas === '' || !Number.isFinite(n) || n <= 0)
      throw new Error(`getFee needs a positive, finite gas limit, got ${String(gas)}`);
    return calculateFee(gas, gasPrice || defaultGasPrice);
  }

  async function signAndBroadcastWithoutBalanceCheck(address, msgs, gas, memo, gasPrice) {
    return await signAndBroadcast(address, msgs, gas, memo, gasPrice)
  }

  async function signAndBroadcast(address, messages, gas, memo, gasPrice) {
    if (!gas)
      gas = await simulate(address, messages, memo);
    const fee = getFee(gas, gasPrice); // throws on a non-positive / non-finite gas (S-31)
    const txBody = await sign(address, messages, memo, fee)
    return broadcast(txBody)
  }

  // Delta over upstream (WO-040, see TxConfirm.mjs): upstream RETURNED the poll-timeout Error, so callers
  // saw `code: undefined` and treated a submitted (usually committed) tx as failed. Now every
  // outcome is explicit: resolves only on DeliverTx code 0; throws TxFailedError on a definitive
  // failure (CheckTx reject — never entered the mempool; DeliverTx code != 0 — reverted
  // atomically), both safe to retry; throws TxUnconfirmedError when the outcome is unknown
  // (submitTx's rules, a poll timeout, a result without a code), which callers must NOT
  // auto-retry. The poll uses the locally computed hash, never one echoed back by an endpoint.
  // Timeouts bound a hung socket (docs/06 audit 2026-10-08): a POST timeout is unconfirmed, a
  // lookup timeout is just another "not found yet".
  async function broadcast(txBody){
    const txBytes = TxRaw.encode(txBody).finish()
    const transactionHash = txHashOf(txBytes)
    const checkTx = parseTxResult(await submitTx((bytes) => post(restUrl + '/cosmos/tx/v1beta1/txs', {
      tx_bytes: toBase64(bytes),
      mode: "BROADCAST_MODE_SYNC"
    }, { timeout: network.txBroadcastTimeout || 30_000 }), txBytes))
    assertTxSuccess(checkTx, 'checktx', transactionHash)
    const value = await waitForTx(
      (txId) => get(restUrl + '/cosmos/tx/v1beta1/txs/' + txId, { timeout: network.txQueryTimeout || 10_000 })
        .then((res) => {
          const found = parseTxResult(res.data.tx_response)
          // An answer about some other tx is no answer: keep polling (it ends unconfirmed), never
          // read another tx's code as this one's verdict (docs/06 re-review 2026-10-08).
          if (String(found.transactionHash || '').toUpperCase() !== txId) {
            throw new Error(`the lookup answered for tx ${found.transactionHash || '(none)'}, not ${txId}`)
          }
          return found
        }),
      transactionHash,
      { timeoutMs: network.txTimeout || 60_000, pollIntervalMs: network.txPollIntervalMs || 3_000, sleep },
    )
    return assertTxSuccess(value, 'delivertx', transactionHash)
  }

  async function sign(address, messages, memo, fee){
    const account = await getAccount(address)
    const { account_number: accountNumber } = account
    const txBodyBytes = makeBodyBytes(messages, memo)
    // Sign using standard protobuf messages
    const authInfoBytes = await makeAuthInfoBytes(account, {
      amount: fee.amount,
      gasLimit: fee.gas,
    }, SignMode.SIGN_MODE_DIRECT)
    const signDoc = makeSignDoc(txBodyBytes, authInfoBytes, chainId, accountNumber);
    const { signature, signed } = await signer.signDirect(address, signDoc);
    return {
      bodyBytes: signed.bodyBytes,
      authInfoBytes: signed.authInfoBytes,
      signatures: [fromBase64(signature.signature)],
    }
  }

  async function simulate(address, messages, memo, modifier) {
    const account = await getAccount(address)
    const fee = getFee(100_000)
    const txBody = {
      bodyBytes: makeBodyBytes(messages, memo),
      authInfoBytes: await makeAuthInfoBytes(account, {
        amount: fee.amount,
        gasLimit: fee.gas,
      }, SignMode.SIGN_MODE_UNSPECIFIED),
      signatures: [new Uint8Array()],
    }

    try {
      const estimate = await post(restUrl + '/cosmos/tx/v1beta1/simulate', {
        tx_bytes: toBase64(TxRaw.encode(txBody).finish()),
      }, { timeout: network.simulateTimeout || 20_000 }).then(el => el.data?.gas_info?.gas_used)
      // WO-064 S-31: gas_used is a uint64 string; anything else is an error, never a default fee.
      if (!/^[1-9][0-9]*$/.test(String(estimate)))
        throw new Error('simulate returned no usable gas_used')
      return Math.trunc(Number(estimate) * (modifier || defaultGasModifier));
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- no { cause }: the caught error can be an AxiosError, and an uncaught throw would print its config, request and response
      throw new Error(error.response?.data?.message || error.message)
    }
  }

  function parseTxResult(result){
    return {
      code: result.code,
      codespace: result.codespace,
      height: result.height,
      rawLog: result.raw_log,
      transactionHash: result.txhash,
      gasUsed: result.gas_used,
      gasWanted: result.gas_wanted,
    }
  }

  function makeBodyBytes(messages, memo){
    const anyMsgs = messages.map((m) => registry.encodeAsAny(m));
    return TxBody.encode(
      TxBody.fromPartial({
        messages: anyMsgs,
        memo: memo,
      })
    ).finish()
  }

  async function makeAuthInfoBytes(account, fee, mode){
    const { sequence } = account
    const accountFromSigner = (await signer.getAccounts())[0]
    if (!accountFromSigner) {
      throw new Error("Failed to retrieve account from signer");
    }
    const signerPubkey = accountFromSigner.pubkey;
    return AuthInfo.encode({
      signerInfos: [
        {
          publicKey: {
            typeUrl: pubkeyTypeUrl(account.pub_key),
            value: PubKey.encode({
              key: signerPubkey,
            }).finish(),
          },
          sequence: Long.fromNumber(sequence, true),
          modeInfo: { single: { mode: mode } },
        },
      ],
      fee: Fee.fromPartial(fee),
    }).finish()
  }

  function pubkeyTypeUrl(pub_key){
    if(pub_key && pub_key['@type']) return pub_key['@type']

    if(network.path === 'injective'){
      return '/injective.crypto.v1beta1.ethsecp256k1.PubKey'
    }

    if(coinType === 60){
      return '/ethermint.crypto.v1.ethsecp256k1.PubKey'
    }
    return '/cosmos.crypto.secp256k1.PubKey'
  }

  return {
    signer,
    registry,
    getFee,
    simulate,
    signAndBroadcast,
    signAndBroadcastWithoutBalanceCheck
  };
}

export default SigningClient;
