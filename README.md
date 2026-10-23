# compound-multi-staking

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-yellow?logo=buy-me-a-coffee)](https://buymeacoffee.com/teshy)

## What this repository is

The code behind **[compound.teshy.com](https://compound.teshy.com)**, published so that a delegator can read it
before they sign anything. It is for review. It is not packaged for hosting and has no install or run
instructions. Acting on anyone's grants needs the bot's key (its mnemonic), which is not here. As a guard
against accidents, `scripts/compound.mjs` also refuses `DRY_RUN=false` unless it is started the way Teshy's
private wrapper starts it (`assertLiveRunIsLocal`, `scripts/lib/local-only.mjs`); that is a guard, not a lock.

It holds the two parts that build or use your grants for compounding:

1. **At setup**: the code that builds what the grant page asks your wallet to sign (`page/`).
2. **Afterwards**: the compound bot, which uses the grants you signed (`scripts/`, `src/`).

The same bot key also runs other Teshy scripts that are not published here (for example, claiming the bot
wallet's own rewards, and the restake.app service, which skips grants made on this page). What a grant
*allows* is set by the grant itself, on chain, and is described below; what this code *does* with it is
narrower.

**Realio** (`realionetwork_3301-1`) does not auto-withdraw staking rewards when you delegate, so the standard
[REStake](https://github.com/eco-stake/restake) autostake fails with `insufficient funds` there: the rewards it
tries to delegate are not spendable yet. This bot withdraws the rewards first and delegates the proceeds in the
same authz `MsgExec`.

## What runs for compound.teshy.com

| What | Value |
|---|---|
| Site | https://compound.teshy.com |
| Bot (the grantee of every grant the page creates) | `realio10eq6w0a7fpety33uag2f55e9tewxazt4v28aem` |
| Destination validator, RIO | `realiovaloper1fvh0yq5v8n5c2yz0cs5pkfdgx5t77x6vm3pr6y` |
| Destination validator, RST | `realiovaloper1dlsleh9f0gsf7tl2kvyra7pmy3z8w7nek4u780` |
| Destination validator, DSTRX | `realiovaloper1ez4x5c75qn5sjkang9j0zfmrkpcl9nrqwzgp5k` |
| DSTRX token contract | `0xb841F365D5221Bed66d60E69094418D8C2aa5A44` |

Each value except the site is in [`page/src/realio.ts`](page/src/realio.ts) (`BOT_ADDRESS`, `TESHY_VALOPER`,
`TESHY_RST_VALOPER`, `TESHY_DSTRX_VALOPER`, `DSTRX_DENOM`). Check them there, then check them against what your
wallet shows when you sign.

**Teshy's bot runs this code from Teshy's private repository.** The page modules in `page/` were copied from
private commit `97e80d3`. The bot code in `scripts/` and `src/` was ported from the same repository, also at
`97e80d3`. The transaction memo (`Teshy auto-compound`, what you see on chain) and the HTTP
user agent are the same as in production. These parts differ:

- environment variable names: `COMPOUND_*` here, Teshy's own names in production;
- the trusted node's host: read from `COMPOUND_NODE_HOST` here, a fixed constant in production
  (`scripts/lib/local-only.mjs`);
- `src/networks.local.json`: placeholder endpoints here, Teshy's own node in production;
- the wording of a few error messages (`scripts/lib/env.mjs`, `scripts/lib/wallet.mjs`) and some comments.

The bot logic, the amounts and the messages are the same.

## At setup: what the page asks your wallet to sign

Every message the page asks your wallet to sign is built in `page/src/grants.ts`, and signed in `page/src/sign.ts`
(`SIGN_MODE_DIRECT`, through the type registry in `page/src/registry.ts`). Your wallet shows each message before
you approve it; that is the check that does not depend on this repository.

| Message | Built by | What it does |
|---|---|---|
| `MsgGrant` carrying `GenericAuthorization(MsgWithdrawDelegatorReward)` | `compoundGrants` → `withdrawGrant` | lets the bot withdraw your staking rewards (from any validator you delegate to) |
| `MsgGrant` carrying `StakeAuthorization(AUTHORIZATION_TYPE_DELEGATE, allow_list = [Teshy's RIO validator])` | `compoundGrants` → `delegateGrant` | lets the bot delegate **any amount of your liquid balance** for you, to that one validator only, until you revoke it: the grant sets no amount limit (`max_tokens`) and no expiration. This bot code is written to delegate only the rewards it withdrew in the same transaction (below; see also the accepted residual and the trusted node), but that is the code's behavior, not a limit in the grant. The chain enforces the `allow_list` |
| `MsgDelegate`, or `MsgDelegateEVM` for DSTRX (an ERC-20 held in EVM state) | `delegateMsgs` | optional: your own initial stake, from your own balance, in the same transaction as the grants, to the Teshy validator that bonds that denom |
| `MsgBeginRedelegate` | `redelegateMsgs` | optional: moves stake you already have to the Teshy validator that bonds the same denom (sources listed by `page/src/delegations.ts`); sent in one transaction together with the two grants above |
| `MsgRevoke` (two) | `revokeMsgs` | removes both grants again |

Both grants name the bot address above as grantee. **No expiration is set**: the grants stay until you revoke
them (`grantMsg` in `grants.ts`). The initial stake is a transaction of your own and carries no authority for
the bot. `page/src/stakes.ts` rejects an amount above your balance, a balance it could not read, and (for RIO)
leaving less than the gas reserve. When you stake, `page/src/stake-flow.ts` bundles the grants with the first
stake only, and sends the rest only if the first completed.

**What the page never asks for:** a `SendAuthorization` or any send message. No code in `page/src/` builds
either; the only match for `SendAuthorization` is the test that asserts it is never granted (`grants.test.ts`,
"never grants a SendAuthorization").

**What is not here:** the page's `main.ts` (the DOM, the form, and the call sites that choose which of the
messages above to send) is not part of this repository, and neither are its analytics and hosting
configuration. The messages are all built in the files listed, but `main.ts` decides these inputs to them:

- which Teshy validator each initial stake goes to: one of the three constants in `realio.ts`, by the denom you
  stake;
- that a redelegate is sent together with the two grants;
- the transaction memo, `https://compound.teshy.com/`;
- the page's 2 RIO gas reserve for a RIO stake.

The fee comes from the simulation in `sign.ts` / `tx-flow.ts`. Your wallet shows all of it before you approve.

## Afterwards: what the bot does with the grants

A delegator is compounded only if they hold **both** grants. A restake.app opt-in creates only the stake
grant, which is not enough here: without the withdraw grant, a bare `MsgDelegate` of pending rewards fails
because they are not liquid. `scripts/lib/grouping.mjs` records both grants per delegator, and
`scripts/compound.mjs` counts anyone with only one as skipped.

### What one run does

1. Loads the bot wallet from `MNEMONIC` and reads all authz grants to the bot address (`GranteeGrants`,
   following pagination to the end; a failed page aborts the run rather than yielding a partial list).
2. Per delegator with both grants, skips unless the destination validator (read from their own
   `allow_list`) is bonded and not jailed (`scripts/lib/destination.mjs`) and their reward withdraw address
   is their own account (`scripts/lib/withdraw.mjs`).
3. Sums the floored `ario` rewards over all their reward sources, skips below `MIN_REWARD`, and sizes the
   delegate so that `GAS_RESERVE` stays liquid in their account (`scripts/lib/plan.mjs`,
   `computeDelegateAmount`).
4. Simulates per delegator (Phase 1), then broadcasts one `MsgExec` per destination validator (Phase 2):

   ```
   MsgExec(grantee=bot) {
     MsgWithdrawDelegatorReward(delegator_1 → src_validator_a)   // one per reward source
     MsgDelegate(delegator_1 → their chosen validator, amount)
     MsgWithdrawDelegatorReward(delegator_2 → ...)
     MsgDelegate(delegator_2 → ...)
     ...
   }
   ```

   Each delegator's withdraws come right before their own delegate, so their rewards are liquid when it
   runs. If a batch fails *definitively* (CheckTx or DeliverTx code ≠ 0), each delegator in it is retried
   on its own so one bad grant cannot starve the rest.
5. Prints `Done. attempted=… succeeded=… skipped=… failed=… unconfirmed=…` and exits 0, 1 (some failed or
   unconfirmed) or 3 (aborted, below).

### The unconfirmed-transaction rule

A transaction whose outcome is **unknown** is never reported as failed and never sent again
(`src/utils/TxConfirm.mjs`). Unknown means: no HTTP answer after the bytes went out, any HTTP error
status, a body without the node's own `tx_response` or naming another hash, sdk code 19 (already in the
mempool cache), or a lookup that never finds the transaction. Such a send ends as
`TxUnconfirmedError` (log: `UNCONFIRMED <hash>`), is counted under `unconfirmed=`, and is not retried: the
transaction may have committed, and a re-send would re-spend rewards it already staked. Only a definitive
failure (the node's own non-zero code) is retried, per delegator.

A bot-account sequence mismatch (another bot transaction pending, or another run active) aborts the run
with exit 3 and nothing further is sent (`isSequenceMismatch`, `scripts/compound.mjs`).

### Fee and amount bounds

All parsed strictly: a malformed or out-of-range value exits 1 before the wallet is loaded
(`scripts/lib/plan.mjs`, `parseBoundedInt`, `parseBoundedBigInt`).

| Variable | Default | Allowed | Meaning |
|---|---|---|---|
| `MIN_REWARD` | 1 RIO (`1000000000000000000`) | 0 … 1e24 ario | a delegator below this pending reward is skipped, before any simulate or broadcast, so grant spam costs no gas |
| `GAS_RESERVE` | 2 RIO | 0 … 1e21 ario | always left liquid in the delegator's account; the delegate is capped to keep it |
| `MAX_FEE` | 0.01 RIO | 1 … 1e18 ario | a transaction whose simulated fee exceeds it is skipped (a batch: `MAX_FEE` × delegators in it) |
| `MAX_DELEGATORS` | 500 | 1 … 100000 | most delegators processed per run |
| `RUN_BUDGET_MS` | 600000 | 1000 … 899000 | wall-clock budget; the run stops cleanly between delegators |
| `ONLY_DELEGATOR` | empty | an address | keep only that delegator's grants; every other gate still applies |
| `DRY_RUN` | dry | `false` to broadcast | any other value plans and simulates only; `false` also needs the private wrapper (below) |

The fee is checked against the fee the signing client will sign (`getFee`, in `scripts/lib/broadcast.mjs`).
Requests have deadlines so one hung socket cannot stall a run: REST reads 15 s (`REST_TIMEOUT_MS` in
`scripts/compound.mjs`), account read 10 s, simulate 20 s, broadcast 30 s, tx lookup 10 s, confirmation
polling 60 s (`src/utils/SigningClient.mjs`), and a node whose latest block is more than 120 s old is
treated as unavailable (`src/utils/QueryClient.mjs`).

### Teshy's own node only

**This is Teshy's operating practice, which this repository cannot show.** The code shows only the mechanism.
Teshy runs the bot against Teshy's own node only. Its wrapper (private, not published here) exports
`COMPOUND_LOCAL_ONLY=1` and the node's host; with those set the script keeps only that host's URLs from
`src/networks.local.json` and fails if there is none, so a node that fails mid-run makes the reads fail instead
of moving to a third-party endpoint (`applyLocalOnly`, `filterLocalUrls`, `scripts/lib/local-only.mjs`). A
live run (`DRY_RUN=false`) is refused unless it looks like it was started by that wrapper, holding its run
lock (`assertLiveRunIsLocal`, same file). That is a guard against accidental live runs, not a lock: what keeps
anyone else from acting on your grants is that only the bot's key can sign as the grantee.

### The `.env` file holds only `MNEMONIC`

`scripts/lib/env.mjs` reads `.env` and **refuses any other key** (exit 1, naming the keys, never a value),
including every `COMPOUND_*` name. Settings come from the process environment, where they can be reviewed.
The mnemonic is never printed.

## Security model

**What the bot can do**, for a delegator who granted both permissions:

- withdraw their staking rewards, and delegate (a part of) those rewards to a validator in their own
  `allow_list`. The script builds only `MsgWithdrawDelegatorReward` and `MsgDelegate`, inside `MsgExec`
  (`scripts/compound.mjs`: `WITHDRAW_MSG`, `DELEGATE_MSG`).

**What it cannot do:**

- Move funds anywhere the delegator did not name: the destination is read from the delegator's own grant
  (`scripts/lib/grouping.mjs`, never hardcoded), checked bonded and not jailed
  (`scripts/lib/destination.mjs`), and the chain enforces the `allow_list`.
- Send tokens: no `SendAuthorization` is requested by the page (above), and `scripts/compound.mjs` builds no
  send message (`MsgSend` appears in `src/utils/Wallet.mjs` only as a name in upstream's list of message types).
- Undelegate or redelegate.
- Spend a delegator's principal on purpose (this is the code's behavior; the delegate grant itself would allow
  any liquid amount, see above): the delegated amount never exceeds the withdrawn rewards and
  leaves `GAS_RESERVE` liquid (`computeDelegateAmount`, `scripts/lib/plan.mjs`); a delegator whose rewards are
  redirected to another address is skipped (`scripts/lib/withdraw.mjs`).

**The node is trusted.** The amount delegated for each delegator is sized from the node's answers: their
pending rewards, their liquid balance and their withdraw address (`scripts/compound.mjs`). A node that lies,
or an attacker on the network path to it, could report inflated rewards, and the bot would then delegate up
to the delegator's liquid balance plus those rewards, less `GAS_RESERVE`: their own funds, bonded to the
validator they chose (the chain still enforces the `allow_list`), but without their consent. The "never
exceeds the withdrawn rewards" bound above holds only while the node answers honestly. That is why Teshy uses
its own node only (its practice, above).

**Accepted residual:** a delegator can change their withdraw address between the check and the broadcast.
Then the delegate is paid from their liquid balance and not from the rewards (comment in
`scripts/compound.mjs`).

**The bot wallet holds only gas.**

**Grant spam:** grants are permissionless. `MIN_REWARD` is checked before any simulate or broadcast, and
`MAX_DELEGATORS` and `RUN_BUDGET_MS` bound the work of a run.

**Untrusted text:** a grant's `allow_list` entries are attacker-chosen text. Anything that is not a
`realiovaloper1…` bech32 address (`scripts/lib/valoper.mjs`) is ignored and never written to the log.

### Realio-specific chain notes

| Fact | Why it matters |
|---|---|
| Chain ID `realionetwork_3301-1` | pinned in `page/src/realio.ts` and `src/networks.local.json`; an endpoint on another chain is skipped |
| **Ethermint: coin type 60, `eth_secp256k1`** | Realio uses Ethereum-compatible key derivation (not the Cosmos default 118). `scripts/lib/wallet.mjs` pins 60; `src/utils/EthSigner.mjs` signs. Using 118 gives another address and every transaction fails `pubKey does not match signer address`. |
| Denom `ario`, 18 decimals | 1 RIO = 1 × 10¹⁸ ario. Rewards are `DecCoin` strings, floored to integer ario. |
| **Multistaking does NOT auto-withdraw on delegate** | the explicit `MsgWithdrawDelegatorReward` inside the same `MsgExec` is load-bearing |
| All rewards are paid in `ario` | even for a delegator who stakes another bond denom; one grant pair covers all |
| Pubkey type `/ethermint.crypto.v1.ethsecp256k1.PubKey` | the signing client must use it or signature verification fails (`EthSigner.mjs`, `page/src/realio.ts`) |

## How to check it yourself

```bash
npm ci --ignore-scripts
npm --prefix page ci --ignore-scripts
npm test               # the bot tests, then the page tests
npm run lint
npm run format:check   # Prettier over test/ and the config; the bot code is kept as it was reviewed
npm --prefix page run typecheck   # tsc --noEmit over page/src
```

`npm ci --ignore-scripts` installs exactly the reviewed lockfile and runs no dependency install script. The
bot (root) and the page (`page/`) are separate npm packages, because the bot pins cosmjs 0.30 and the page
uses 0.39.

- **Bot tests** (`test/`, 18 files, Node's test runner): the planner and its bounds, grouping by grant,
  destination and withdraw-address checks, the unconfirmed-transaction rules, the signing client's hardening
  (deadlines, fee, the answer for another tx), the live-run refusal and node-host rules, the `.env` rules, the
  Ethermint signer, and an end-to-end run against stub servers. They hold no real key (the mnemonic is the
  public BIP39 test vector) and touch no real chain; addresses are synthetic.
- **Page tests** (`page/src/*.test.ts`, 12 files, vitest): the grant and delegate messages decoded and checked
  field by field ("never a `SendAuthorization`" among them), the `MsgDelegateEVM` bytes against a captured
  fixture byte for byte, the signing path (the hash of a captured on-chain transaction's bytes equals its
  on-chain hash; simulate, broadcast and polling),
  the stake-amount checks, the multi-stake flow and the redelegate retry step, redelegate sources, bech32
  decoding, the checked HTTP transport and the analytics address scrub.
- **Not covered here:** `main.ts` and the DOM, the page's hosting headers, a live broadcast, and the private
  wrapper.

The files in `page/src/` are copies, identical to the private repository's at `97e80d3` except for one
reworded comment in `realio.ts` (it named private infrastructure), and the three test files that read files
outside this set: `sign.test.ts` and `scrub.test.ts` lose the tests that read the site's hosting headers and
`main.ts`, and `grants.test.ts` and `sign.test.ts` read their three fixtures from `page/test-fixtures/`.

## Dependency advisories

`npm audit` reports 15 low-severity findings in the root package, all from one upstream issue:
**CVE-2025-14505** in `elliptic` (pulled in by `@ethersproject/*` and `@cosmjs/crypto`). It is an ECDSA
nonce-truncation bug in signature *generation* with no published fix (`elliptic@6.6.1`, the latest release, is
in the vulnerable range). A faulty signature simply fails on-chain, and the precondition (obtaining a faulty
and a correct signature over identical inputs) does not arise in this bot, so it is accepted as low risk.
Removing it means moving to the `@noble/curves`-based stacks (`@cosmjs` ≥ 0.32, `ethers` v6). There are 0
high, 0 critical and 0 moderate findings. `npm --prefix page audit` reports 0 vulnerabilities. Registry
signatures verify for every installed package (`npm audit signatures`, root and `page/`). The page's
production packages are the same versions as the grant page's (`page/package.json` pins the four direct ones
and overrides six transitive ones to the private lockfile's). Dependabot raises security alerts
for a vulnerable dependency and opens no version-update PRs (`.github/dependabot.yml`), because the root
lockfile mirrors the bot Teshy runs and moves in the private repository first, under review. `page/` follows the
private repository's lockfile by hand. The six
overrides matter: `@scure/base` 2.4.0, for example, breaks the bech32 decoding the page uses, and the private
lockfile pins 2.2.0. If they are regenerated, nothing here re-checks that the versions still match the deployed
page. Installs should use `--min-release-age=14` where npm supports it.

## Attribution

The signing and query code under `src/utils/` started as
[eco-stake/restake](https://github.com/eco-stake/restake) (MIT, pinned at commit `08ffa780`) and has been
modified for this bot; changed parts are marked `Delta over upstream` in the comments, and
`src/utils/TxConfirm.mjs` is new. The eco-stake/restake license is kept in [LICENSE](LICENSE).
