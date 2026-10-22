import _ from 'lodash'
import { format, floor, bignumber } from 'mathjs'
import { coin as _coin } from  '@cosmjs/stargate'
import axios from 'axios'
import winston from 'winston'

import { USER_AGENT } from './constants.mjs'

export function coin(amount, denom){
  return _coin(format(floor(amount), {notation: 'fixed'}), denom)
}

export function joinString(...args){
  return _.compact(args).join(' ')
}

export function rewardAmount(rewards, denom, type){
  if (!rewards)
    return 0;
  type = type || 'reward'
  const reward = rewards && rewards[type]?.find((el) => el.denom === denom);
  return reward ? bignumber(reward.amount) : 0;
}

export function overrideNetworks(networks, overrides){
  networks = networks.reduce((a, v) => ({ ...a, [v.name]: v }), {})
  const names = [...Object.keys(networks), ...Object.keys(overrides)]
  return _.uniq(names).sort().map(name => {
    let network = networks[name]
    let override = overrides[name]
    if(!network || !network.name) network = { name, ...network }
    if(!override) return network
    override.overriden = true
    return _.mergeWith(network, override, (a, b) =>
      _.isArray(b) ? b : undefined
    );
  })
}

export function buildExecMessage(grantee, messages) {
  return {
    typeUrl: "/cosmos.authz.v1beta1.MsgExec",
    value: {
      grantee: grantee,
      msgs: messages
    }
  }
}

export function buildExecableMessage(type, typeUrl, value, shouldExec){
  if (shouldExec) {
    return {
      typeUrl: typeUrl,
      value: type.encode(type.fromPartial(value)).finish()
    }
  } else {
    return {
      typeUrl: typeUrl,
      value: value
    }
  }
}

export function parseGrants(grants, grantee, granter) {
  const stakeGrant = grants.find((el) => {
    if (
      (!el.grantee || el.grantee === grantee) &&
      (!el.granter || el.granter === granter) &&
      (el.authorization["@type"] ===
      "/cosmos.staking.v1beta1.StakeAuthorization" || (
        // Handle GenericAuthorization for Ledger
        el.authorization["@type"] ===
        "/cosmos.authz.v1beta1.GenericAuthorization" &&
        el.authorization.msg ===
        "/cosmos.staking.v1beta1.MsgDelegate"
      ))
    ) {
      if (el.expiration === null) {
        // null expiration is flakey currently
        // sometimes it means it's expired, sometimes no expiration set (infinite grant)
        // we have to treat as invalid until this is resolved
        return false;
      } else if (Date.parse(el.expiration) > new Date()) {
        return true;
      } else {
        return false;
      }
    } else {
      return false;
    }
  })
  return {
    stakeGrant
  };
}

export function mapAsync(array, callbackfn) {
  return Promise.all(array.map(callbackfn));
}

export function findAsync(array, callbackfn) {
  return mapAsync(array, callbackfn).then(findMap => {
    return array.find((value, index) => findMap[index]);
  });
}

export function filterAsync(array, callbackfn) {
  return mapAsync(array, callbackfn).then(filterMap => {
    return array.filter((value, index) => filterMap[index]);
  });
}

export async function mapSync(calls, count, batchCallback) {
  const batchCalls = _.chunk(calls, count);
  let results = []
  let index = 0
  for (const batchCall of batchCalls) {
    const batchResults = await mapAsync(batchCall, call => call())
    results.push(batchResults)
    if (batchCallback) await batchCallback(batchResults, index)
    index++
  }
  return results.flat()
}

export async function executeSync(calls, count) {
  const batchCalls = _.chunk(calls, count);
  for (const batchCall of batchCalls) {
    await mapAsync(batchCall, call => call())
  }
}

// WO-064 S-32: never unbounded — a caller that passes no valid timeout gets 30 s; a valid explicit one wins.
// WO-072 D1 (docs/06 gate 2026-10-16, B-4): axios `timeout` is an IDLE timer, so a server that trickles a
// byte now and then keeps a request open past it. The same value also arms a hard deadline
// (AbortSignal.timeout); a caller's own `signal` is combined with it, never replaces it (WO-075 D4, below; WO-078
// BR-10: this line used to say the caller's signal wins). An aborted broadcast POST has no response, which
// TxConfirm.submitTx maps to TxUnconfirmedError; an aborted lookup is a rejection, which waitForTx treats
// as "not found yet". When the deadline (not the caller) aborted, the error keeps axios's own timeout
// wording, so the operator-facing log line reads "timeout of 300ms exceeded", not "canceled".
// WO-075 D4 (delta gate 2026-10-19, BT-4, BT-5): the deadline always holds. A `timeout` that is not a positive
// safe integer (0, a string, a float, NaN, a negative) is replaced by the default instead of being passed to
// AbortSignal.timeout (0 aborted at once; a string or float threw before anything was sent). A caller's own
// `signal` no longer disables the deadline: both are combined with AbortSignal.any, and only a DEADLINE abort
// is translated to the timeout error (a caller's abort stays the caller's cancellation).
// WO-077 D9 (BR-7): and the limit is 2^31-1 ms (the largest timer Node honours; a longer one overflows and fires
// at once), so a larger `timeout` falls back to the default too.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647

async function withDeadline(opts, send) {
  const timeout = Number.isSafeInteger(opts?.timeout) && opts.timeout > 0 && opts.timeout <= MAX_REQUEST_TIMEOUT_MS ? opts.timeout : DEFAULT_REQUEST_TIMEOUT_MS
  const deadline = AbortSignal.timeout(timeout)
  const signal = opts?.signal ? AbortSignal.any([opts.signal, deadline]) : deadline
  try {
    return await send({ ...opts, timeout, signal })
  } catch (e) {
    if (deadline.aborted && !opts?.signal?.aborted && (e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError')) {
      throw Object.assign(new Error(`timeout of ${timeout}ms exceeded`), { code: 'ECONNABORTED', cause: e })
    }
    throw e
  }
}

export async function get(url, opts) {
  const headers = opts?.headers ?? {}

  return withDeadline(opts, (o) => axios.get(url, {
    ...o,
    headers: {
      ...headers,
      'User-Agent': USER_AGENT,
    }
  }))
}

export async function post(url, body, opts) {
  const headers = opts?.headers ?? {}

  return withDeadline(opts, (o) => axios.post(url, body, {
    ...o,
    headers: {
      ...headers,
      'User-Agent': USER_AGENT,
    }
  }))
}

export function createLogger(module) {
  return winston.createLogger({
    level: 'debug',
    defaultMeta: { module },
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.prettyPrint(),
      winston.format.timestamp(),
      winston.format.splat(),
      winston.format.printf(({
        timestamp,
        level,
        message,
        // eslint-disable-next-line no-unused-vars -- destructured OUT so a `label` key never prints in the meta list
        label = '',
        ...meta
      }) => {
        const metaFormatted = Object.entries(meta)
          .map(([key, value]) => `${key}=${value}`)
          .join(' ')
        return `[${timestamp}] ${level}: ${message} ${metaFormatted}`
      })
    ),
    transports: [
      new winston.transports.Console()
    ],
  });
}
