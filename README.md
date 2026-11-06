# Nainokot Wallet

<img src="privacy-pool/extension/static/logo.svg" width="96" align="right" alt="Nainokot logo">

A wallet where every site gets its own fresh account, and that account holds no ETH. Gas
comes from a **privacy pool**: you deposit once, and each transaction privately spends one
of your pool notes to pay its gas. The same notes can also be withdrawn to any address. Nothing on chain links the account a site sees to whoever
funded it, and by default a site gets a new account after every transaction.

It runs on **EIP-8141 frame transactions** with the **ERC-8421 alternative mempool** rules, on
a local chain that runs the same client as the alt mempool devnet.

## How it works

The user's fresh account is the transaction's sender. The pool is a staked payer that approves
gas after checking a Groth16 proof that the sender owns an unspent note worth at least the fee:

    [verify sender] [pool pays: proof check] [user's calls...] [pool settles: marks the note spent, adds the change note]

There is also a `pre_verify` shape, where a frame before the payment marks the note spent first.
Unused gas comes back as a new private note (a refund note). Only the fee and the refund amount
are public; the note spent and the change stay private.

**Proposed alt mempool rule** (built as a sidecar patch, `privacy-pool/sidecar/payer-keys.patch`): at
most one pending transaction per (payer, key), where a staked payer's keys are the storage slots
of its own that validation touched (here, the note's nullifier slot). This stops anyone flooding
the pool with many spends of one note. A replacement needs the same keys and 10% more on both
fees; a partial overlap is refused.

**The extension** is an ordinary EIP-1193 / EIP-6963 wallet with `wallet_sendCalls` (EIP-5792)
and a `privacyPaymaster` capability. Its popup shows private funds, private and public
accounts, history and settings, and each site's account, with a switch for a new account after
every transaction.

## Repository

| Path | What |
| --- | --- |
| `privacy-pool/contracts/` | The privacy pool: `PrivacyPoolLogic.sol`, the pool dispatcher in Yul (`yul/`), a minimal ERC-8421 staking registry, a guest book to call as "any dapp" |
| `privacy-pool/deploy.sh` | Deploys and stakes the privacy pool on the local chain |
| `privacy-pool/client.ts`, `privacy-pool/core.ts` | Shield, publish roots, sync notes, send sponsored transactions (core.ts also runs in the browser) |
| `privacy-pool/run.sh` | End-to-end check of the contracts: both shapes, refunds, abuse attempts, the mempool rule |
| `privacy-pool/sidecar.sh`, `privacy-pool/sidecar/` | The alt mempool sidecar with the (payer, key) rule |
| `privacy-pool/extension/` | The Nainokot Wallet Chrome extension, a demo dapp, and its Playwright end-to-end check |
| `scripts/setup.sh` | One-time setup from a fresh clone |
| `scripts/altlocal.sh` | The local chain: forshtat/ethrex `eip8141-tracer` as chain 1337 |
| `patches/` | Small patches to ethrex's dev mode and to minimal-shielded-pool's client |

## Setup (once)

Needs Node 24.7+, git, jq, curl, Rust (cargo) and Foundry (forge, cast). macOS or Linux.

    bash scripts/setup.sh
    npx playwright install chromium        # only for the extension's end-to-end check

This fetches [minimal-shielded-pool](https://github.com/soispoke/minimal-shielded-pool) at
`d0b2131` into `deps.nosync/` and patches it, runs `npm ci`, and builds the alt mempool ethrex
(5 to 10 minutes the first time).

## Test

    NO_SIDECAR=1 bash privacy-pool/run.sh       # contracts end to end on a new chain

    bash scripts/altlocal.sh start         # a new chain on http://127.0.0.1:8547
    bash privacy-pool/deploy.sh
    node privacy-pool/extension/build.ts
    node privacy-pool/extension/e2e.ts          # the extension in Chromium, every flow checked

`privacy-pool/run.sh` starts its own chain; after it, stop that chain or move `altlocal.nosync/privacy-pool`
aside before deploying again. With [bun](https://bun.sh), `bash privacy-pool/sidecar.sh setup` builds
the sidecar and runs its unit tests, and `bash privacy-pool/run.sh` then also checks the rule through it.

## Try the wallet

After `deploy.sh` and `build.ts`:

1. Chrome: `chrome://extensions`, turn on Developer mode, Load unpacked, pick `privacy-pool/extension/out`.
2. `node privacy-pool/extension/demo/serve.ts`, then open http://127.0.0.1:8142/.
3. In the Nainokot popup press "Add 0.1 ETH", then Connect and Sign on the page.

After a new chain, run `build.ts` again and reload the extension.

## Limits (test build)

- Local chain only; the dev funder's public key pays for "Add 0.1 ETH" and for publishing roots.
- Notes and keys sit in the extension's storage unencrypted.
- One note pays for one transaction; refund notes need two-note spends to be spent.
- The pool contract credits withdrawals to any address (`claimWithdrawal`), but the client and the
  extension don't offer withdrawing yet.
- The route through the alt mempool sidecar is built but not yet tested end to end.

## Credits

Built on [minimal-shielded-pool](https://github.com/soispoke/minimal-shielded-pool) (circuit,
verifier, client), [forshtat/ethrex](https://github.com/forshtat/ethrex) `eip8141-tracer`, and
[forshtat/mempool-workshop-sidecar](https://github.com/forshtat/mempool-workshop-sidecar).

## License

Apache-2.0, see [LICENSE](LICENSE).
