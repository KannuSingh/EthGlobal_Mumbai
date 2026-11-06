# Privacy pool on the local alt mempool chain

A separate shielded pool whose notes pay gas for any transaction. The user's fresh account
(no ETH) is the sender; the pool is the staked payer. Two shapes:

- **last frame**: `[verify sender] [pool pays: proof check] [user calls...] [pool settleSponsored]`
- **pre_verify**: `[verify sender] [pool preVerify: proof check, marks nullifiers] [pool pays] [user calls...] [pool settleSponsored]`

The alt mempool rule (sidecar patch `sidecar/payer-keys.patch`): at most one pending transaction
per (payer, payer key). A staked payer's keys are the storage slots of its own that the
validation prefix touched, which for this pool are the two nullifier slots. Another transaction
with the same keys replaces the pending one only with exactly the same keys and at least 10% more
on both fees; a partial overlap is refused. Different nullifiers of the same pool sit side by side.

## Refund notes

The proof's fee is the transaction's maximum cost, about twice what it uses. By default the settle
frame now carries one more word, the inner of a refund note, and gives the unused part back as a
new note: the fee less an upper bound of what the pool is charged (intrinsic gas plus every
finished frame's measured use, read with FRAMEPARAM 0x0A/0x0B, this frame's use so far, and a
reserve for the root and events still to come), at tx.gasprice. The pool keeps about 30,000 gas
worth as margin. The refund's rho comes from the spent note's key and nullifier, so no new secret
needs saving. `client send --no-refund` sends the old settle frame for comparison.

## Run (from the repository root, Node 24, after bash scripts/setup.sh)

    bash privacy-pool/sidecar.sh setup      # once: clone the sidecar, apply the patch, build, unit tests (needs bun)
    bash privacy-pool/run.sh                # fresh chain, both shapes, abuse checks, then the rule through the sidecar
    NO_SIDECAR=1 bash privacy-pool/run.sh   # without the sidecar

Files: `contracts/` (PrivacyPoolLogic, staking registry, guest book; `yul/` the pool dispatcher),
`deploy.sh`, `client.ts` (shield, publish, notes, send), `sidecar.sh`, `run.sh`.
