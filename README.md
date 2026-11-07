# Nainokot Wallet

<img src="privacy-pool/extension/static/logo.svg" width="96" align="right" alt="Nainokot logo">

A wallet where every site gets its own fresh account, and that account holds no ETH. Gas
comes from a **privacy pool**: you deposit once, and each transaction privately spends one
of your pool notes to pay its gas. The same notes can be withdrawn to any address, or sent
privately to another wallet without leaving the pool. Nothing on chain links the account a site
sees to whoever funded it, and by default a site gets a new account after every transaction.

It runs on **EIP-8141 frame transactions** with the **ERC-8421 alternative mempool** rules, on
a local chain (chain 1337) on forshtat/ethrex, the alt mempool client.

## How it works

The pool has two transaction shapes, and both spend one note or two (the circuit has two inputs).

**Dapp calls: the pool as paymaster.** The user's fresh account is the transaction's sender. The
pool is a staked payer that approves gas after checking a Groth16 proof that the sender owns
unspent notes worth at least the fee:

    [verify sender] [pool pays: proof check] [user's calls...] [pool settles: marks the note spent, adds the change note]

There is also a `pre_verify` shape, where a frame before the payment marks the note spent first.
Unused gas comes back as a new private note (a refund note). Only the fee and the refund amount
are public; the notes spent and the change stay private.

**Withdrawals and private transfers: the pool as sender** (minimal-shielded-pool's own shape). No
account of the user's appears at all. The pool checks the proof, approves itself as sender and
payer, and settles; the two nullifiers are the transaction's EIP-8250 nonce keys, and a one-time
key signs:

    [pool checks the proof] [pool settles: marks the notes spent, adds the new notes, credits a withdrawal] [pool pays out]?

A private transfer pays a note to the other wallet's private address (`nk1…`: its note key and a
view key). The settle data carries a one-time public key and the note's amount sealed to the view
key (`privacy-pool/transfer.ts`), so only that wallet finds it. Both shapes mark nullifiers in the
same storage and check it before approving, so a note spent one way can't be spent the other.

**Proposed alt mempool rule** (built as a sidecar patch, `privacy-pool/sidecar/payer-keys.patch`): at
most one pending transaction per (payer, key), where a staked payer's keys are the storage slots
of its own that validation touched (here, the note's nullifier slot). This stops anyone flooding
the pool with many spends of one note. A replacement needs the same keys and 10% more on both
fees; a partial overlap is refused.

**The extension** is an ordinary EIP-1193 / EIP-6963 wallet with `wallet_sendCalls` (EIP-5792)
and a `privacyPaymaster` capability. Its popup shows private funds (add; send to any address or
privately to a private address; receive, with your private address), private and public accounts,
history with each transaction's frames decoded, settings,
and each site's account, with a switch for a new account after
every transaction.

A dapp can also shape the frame transaction it asks for. `atomicRequired: true` makes the calls
one EIP-8141 atomic batch (all land or none), and the `expiry` capability,
`{ validUntil: <unix seconds> }`, puts the chain's expiry verifier (0x…8141) first with that
deadline, so a send that isn't mined in time is dropped and can never land late; the wallet then
frees the note it locked. Framecaster's composer offers "Expires in 1 / 10 min".

## Repository

| Path | What |
| --- | --- |
| `privacy-pool/contracts/` | The privacy pool: `PrivacyPoolLogic.sol`, the pool dispatcher in Yul (`yul/`), a minimal ERC-8421 staking registry, and Framecaster (`Framecaster.sol`), short posts with threads, replies and likes, as "any dapp" |
| `privacy-pool/deploy.sh` | Deploys and stakes the privacy pool on the local chain |
| `privacy-pool/core.ts` | Shield, publish roots, sync notes, send sponsored transactions; core.ts also withdraws, sends private transfers and finds incoming ones, and runs in the browser |
| `privacy-pool/transfer.ts` | Private addresses, and sealing and opening a private transfer's note |
| `privacy-pool/core-smoke.ts` | Dapp sends (both payer shapes), the expiry frame and atomic batches, and what the pool refuses before it pays |
| `privacy-pool/pool-send-smoke.ts` | The pool as sender: withdrawals, private transfers, two-note spends and cross-shape double spends |
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

    bash scripts/altlocal.sh start         # a new chain on http://127.0.0.1:8547
    bash privacy-pool/deploy.sh
    node privacy-pool/extension/build.ts
    node privacy-pool/core-smoke.ts             # dapp sends, expiry and atomic frames, attacks refused
    node privacy-pool/pool-send-smoke.ts        # withdraw, private transfer, two-note spends
    node privacy-pool/extension/e2e.ts          # the extension in Chromium, every flow checked

A new chain needs a new deploy (`deploy.sh` refuses to deploy twice on one chain). With
[bun](https://bun.sh), `bash privacy-pool/sidecar.sh setup` builds the sidecar and runs its unit tests.

## The alt mempool locally

The node's own mempool refuses this pool (its validation reads its own storage:
StorageReadNonSender); the alt mempool admits it as a staked payer. Its proof check calls the
BN254 precompiles. `bash privacy-pool/sidecar.sh start` runs that sidecar in front of the local
chain (with those precompiles), and `VIA=sidecar` sends through it.

## Try the wallet

After `deploy.sh` and `build.ts`:

1. Chrome: `chrome://extensions`, turn on Developer mode, Load unpacked, pick `privacy-pool/extension/out`.
2. `node privacy-pool/extension/demo/serve.ts`, then open http://127.0.0.1:8142/.
3. In the Nainokot popup press "Add 0.1 ETH", then Connect on the page and post.

After a new chain, run `build.ts` again and reload the extension.

## Limits (test build)

- Local chain only; the dev funder's public key pays for "Add 0.1 ETH" and for publishing roots.
- Notes and keys sit in the extension's storage unencrypted.
- A transaction spends at most two notes, so a send can't be larger than your two largest notes
  minus gas. Many small notes (refunds) are best merged by a send to your own private address.
- The wallet finds incoming private transfers by trying every transfer since the last search with
  its view key; fine on a test chain, slow on a busy one.
- Framecaster posts are public and permanent (event logs). Posts are at most 160 bytes, a thread at most 8 parts.
  Feed reads go through the wallet's RPC (eth_getLogs from block 0), fine on a test chain, slow on a long one.
- Post text is untrusted: the page and the wallet only ever show it as text (never HTML), the page has a strict
  Content-Security-Policy (its own scripts only), hidden and direction-flipping characters are removed in the feed
  and shown as escapes such as `\u202e` in the wallet. The browser test posts an injection attempt to check it.

## Credits

Built on [minimal-shielded-pool](https://github.com/soispoke/minimal-shielded-pool) (circuit,
verifier, client), [forshtat/ethrex](https://github.com/forshtat/ethrex) `eip8141-tracer`, and
[forshtat/mempool-workshop-sidecar](https://github.com/forshtat/mempool-workshop-sidecar).

## License

Apache-2.0, see [LICENSE](LICENSE).
