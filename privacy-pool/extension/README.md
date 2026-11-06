# Nainokot Wallet (minimal Chrome extension, local chain only)

A wallet a dapp sees as an ordinary EIP-1193 provider (window.ethereum and EIP-6963). Each site
gets its own account, which holds no ETH. When the site sends, an approval window proves a spend
of one of your privacy pool notes and sends the call with the pool paying the gas, so nothing links the
account to whoever funded the gas. The unused part of the fee comes back as a refund note.

Supported: eth_requestAccounts, eth_accounts, eth_chainId, eth_sendTransaction, wallet_sendCalls
(EIP-5792, calls become one transaction's SENDER frames, not atomic), wallet_getCallsStatus,
wallet_getCapabilities ({privacyPaymaster: {supported: true}} only, as KD's draft ERC says), and
reads passed to the node. The privacyPaymaster rules from the draft: an empty capability object is
refused with -32602, an unknown required capability with 5700, another chain with 5710; there is
no other way to pay gas, so a failure is an error whatever `optional` says.

## Try it on the local chain

    bash scripts/setup.sh                             # once: tools check, msp, npm ci, the node
    bash scripts/altlocal.sh start                    # a new chain (move altlocal.nosync/privacy-pool aside first)
    bash privacy-pool/deploy.sh
    bash privacy-pool/sidecar.sh start                     # optional: the alt mempool with the (pool, nullifier) rule
    node privacy-pool/extension/build.ts                   # or --via sidecar through the alt mempool (untested)
    node privacy-pool/extension/demo/serve.ts              # the guest book on http://127.0.0.1:8142/

Then in Chrome: chrome://extensions, Developer mode on, Load unpacked, pick privacy-pool/extension/out.
Open the extension's popup and press "Add 0.1 ETH", then open http://127.0.0.1:8142/, Connect,
and Sign. After a new chain, rebuild and remove and load the extension again (its notes belong to
the old chain).

`node privacy-pool/extension/e2e.ts` does all of that in Chromium with Playwright and checks the
results (`PLAYWRIGHT=/path/to/playwright` if it is not installed globally).

## Limits (test build)

- The local dev funder's key is in config.json: it pays for "Add 0.1 ETH" and for publishing the
  pool's root before a spend. A real wallet funds the pool from the user's own wallet and leaves
  roots to a timer.
- Notes and keys are in chrome.storage.local in the clear.
- One note pays for one transaction: a refund note is too small to pay on its own until two-note
  spends land.
- The prover runs on one thread (about 3 to 5 s), because extension pages cannot start snarkjs'
  blob: helper threads; it does not verify its own proof, since the node's simulation runs the
  pool's verifier before sending.
