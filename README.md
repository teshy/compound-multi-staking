# compound-multi-staking

Auto-compound bot for **Realio** (`realionetwork_3301-1`) — and any other Cosmos chain
using a **multistaking module that does not auto-withdraw rewards on delegate**.

On standard Cosmos chains, staking rewards are automatically credited to the wallet
when you delegate. On Realio (and other multistaking chains), they are not — so the
standard [REStake](https://github.com/eco-stake/restake) autostake mechanism fails
with `insufficient funds` because the rewards it tries to delegate are not yet
spendable. This bot fixes that by explicitly withdrawing rewards first, then delegating
the proceeds, all inside a single authz `MsgExec`.

## How it works

Delegators opt in by granting the bot **two** authz permissions:

1. `GenericAuthorization(MsgWithdrawDelegatorReward)` — allows the bot to withdraw
   their rewards on their behalf.
2. `StakeAuthorization(DELEGATE, allow_list=[their chosen validator])` — allows the
   bot to delegate to exactly the validator they chose, and no other.

For each opted-in delegator the bot builds and broadcasts:

```
MsgExec(grantee=bot) {
  MsgWithdrawDelegatorReward(delegator → src_validator_1)
  MsgWithdrawDelegatorReward(delegator → src_validator_2)  // if they stake to multiple
  ...
  MsgDelegate(delegator → their_chosen_validator, amount=total_withdrawn)
}
```

The withdraw and delegate happen atomically in one transaction. If the withdraw fails
(e.g. an expired grant), the whole tx reverts — the bot never delegates without first
confirming the rewards are liquid.

## Security model

**What the bot CAN do:**

- Withdraw a delegator's staking rewards (they granted this explicitly)
- Delegate those rewards to the validator the delegator named in their `allow_list`

**What the bot CANNOT do:**

- Move funds to any address it chooses — `StakeAuthorization` constrains the
  destination to the delegator's own `allow_list`
- Send tokens — `SendAuthorization` is never requested or granted
- Undelegate or redelegate
- Access any funds beyond the pending rewards being withdrawn

**The destination validator is read from the delegator's own grant** — it is never
hardcoded in this bot. The bot can only delegate where the user explicitly said to.

**The bot wallet holds only gas** — a small amount of RIO to pay transaction fees.
It has no delegator funds and no authority beyond what each delegator explicitly
granted.

## Realio-specific chain notes

| Fact | Why it matters |
|---|---|
| Chain ID `realionetwork_3301-1` | Hardcoded in `src/networks.local.json` |
| **Ethermint: coin type 60, `eth_secp256k1`** | Realio uses Ethereum-compatible key derivation (NOT Cosmos default 118). Using 118 produces a different address — every tx fails with "pubKey does not match signer address". |
| Denom `ario`, 18 decimals | 1 RIO = 1 × 10¹⁸ ario. Rewards are `DecCoin` strings — floored to integer ario before delegating. |
| **Multistaking does NOT auto-withdraw on delegate** | Unlike vanilla Cosmos, a bare `MsgDelegate` of pending rewards fails. The explicit `MsgWithdrawDelegatorReward` inside the same `MsgExec` is load-bearing. |
| All rewards paid in `ario` | Even if a delegator stakes RST or DSTRX, their rewards are always `ario`. One grant pair covers all bond denoms. |
| Pubkey type `/ethermint.crypto.v1.ethsecp256k1.PubKey` | The signing client must use this pubkey type or signature verification fails. Handled by `EthSigner.mjs`. |

## Prerequisites

- Node.js ≥ 20
- A Realio wallet (eth_secp256k1, coin type 60) funded with a small amount of RIO for gas
- Delegators who have granted the bot both required permissions (see [opt-in](#opt-in))

## Setup

```bash
git clone https://github.com/teshy/compound-multi-staking
cd compound-multi-staking
npm install

# Configure
cp .env.sample .env
# Edit .env and set MNEMONIC to your bot wallet's 24-word phrase

# Set your own REST and RPC endpoints in src/networks.local.json
# Replace the placeholder URLs with a node you operate or trust.
# Public Realio endpoints: https://github.com/cosmos/chain-registry/tree/master/realionetwork

# Confirm the derived address is correct before doing anything else
DRY_RUN=true node compound.mjs
# Output: "Bot address: realio1..."  — verify this matches your funded wallet
```

## Running

```bash
# Dry run — discover opted-in delegators, plan the compounding, do not broadcast
DRY_RUN=true node compound.mjs

# Live run
DRY_RUN=false node compound.mjs

# npm shortcuts
npm run dry-run
npm run compound
```

## Scheduling (systemd)

Edit `systemd/compound.service` — replace `YOUR_USER` with your Linux username and
update the `node` path to match your Node.js installation (`which node`).

```bash
sudo cp systemd/compound.service systemd/compound.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now compound.timer

# Check next scheduled run
systemctl list-timers compound.timer
```

## Opt-in

Delegators must grant the bot both permissions. A standard REStake opt-in (via
restake.app) only creates a `StakeAuthorization` — that is not enough here. You need
a dual-grant page or a manual transaction.

**Manual grant (CLI):**

```bash
# Grant 1: allow the bot to withdraw your rewards
realio-networkd tx authz grant <BOT_ADDRESS> generic \
  --msg-type /cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward \
  --from <YOUR_WALLET> --chain-id realionetwork_3301-1

# Grant 2: allow the bot to delegate to your chosen validator only
realio-networkd tx authz grant <BOT_ADDRESS> stake \
  --allow-list <YOUR_CHOSEN_VALIDATOR_VALOPER> \
  --authorization-type AUTHORIZATION_TYPE_DELEGATE \
  --from <YOUR_WALLET> --chain-id realionetwork_3301-1
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `MNEMONIC` | (required) | Bot wallet mnemonic |
| `MIN_REWARD` | `1000000000000000000` (1 RIO) | Skip delegators with less pending than this (ario) |
| `DRY_RUN` | `true` | Set to `"false"` to broadcast |

## Dependency advisories

`npm audit` reports 15 low-severity findings, all from a single upstream issue:
**CVE-2025-14505** in `elliptic` (pulled in transitively by both `@ethersproject/*`
and `@cosmjs/crypto`). It is an ECDSA nonce-truncation bug in signature *generation*
with **no published fix** — `elliptic@6.6.1`, the latest release, is itself in the
vulnerable range. A faulty signature simply fails on-chain (no funds move), and the
key-derivation precondition (obtaining a faulty *and* a correct signature over
identical inputs) does not arise in this bot, so it is accepted as low risk. Removing
it requires migrating to the `@noble/curves`-based stacks (`@cosmjs ≥ 0.32`,
`ethers v6`). There are **0 high, 0 critical, and 0 moderate** findings.

## Attribution

Signing infrastructure (`src/utils/`) is from
[eco-stake/restake](https://github.com/eco-stake/restake) (MIT), pinned at commit
`08ffa780`. No modifications were made to those files.
