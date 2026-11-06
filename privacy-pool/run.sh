#!/usr/bin/env bash
# The privacy pool from scratch on a new local alt mempool chain: deploy and stake it, shield three
# notes, then let fresh accounts with no ETH sign a guest book with the pool paying their gas.
#
#   bash privacy-pool/run.sh              # both shapes straight to ethrex, then the (pool, nullifier)
#                                    # rule through the sidecar (bash privacy-pool/sidecar.sh setup first)
#   NO_SIDECAR=1 bash privacy-pool/run.sh # only the contracts, without the sidecar
#
# Every spend gets its unused fee back as a refund note (pass --no-refund to client send for the
# old settle frame). Each run starts a new chain (scripts/altlocal.sh), so earlier gas-pool notes are moved aside.
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
cd "$HERE"
G=altlocal.nosync/privacy-pool
client() { node privacy-pool/client.ts "$@"; }
step() { printf '\n==> %s\n' "$*"; }

bash privacy-pool/sidecar.sh stop >/dev/null 2>&1 || true
bash scripts/altlocal.sh stop >/dev/null 2>&1 || true
if [[ -e $G ]]; then
  mv "$G" "$G.$(date +%Y%m%d-%H%M%S)"
  echo "moved the old $G aside"
fi
bash scripts/altlocal.sh start
bash privacy-pool/deploy.sh 2>&1 | grep -E '^(==>|    )'
GB=$(jq -r .guestBook $G/deploy.json)
sign() { cast calldata 'sign(string)' "$1"; }

step "three notes of 0.3 ETH each, and the pool's root"
client shield 0.3
client shield 0.3
client shield 0.3
client publish

step "last-frame shape, sent straight to ethrex (no mempool rules)"
client send --to "$GB" --data "$(sign 'paid by the privacy pool, last-frame shape')" --note 0 --via privileged
client publish
step "pre_verify shape, sent straight to ethrex"
client send --to "$GB" --data "$(sign 'paid by the privacy pool, pre_verify shape')" --note 1 --shape preverify --via privileged
client publish

step "what the pool refuses before it pays (simulated only)"
for attack in lift no-settle settle-gas atomic fee pool-call refund-inner; do
  printf '%-11s ' "$attack"
  client send --to "$GB" --data "$(sign attack)" --note 2 --attack "$attack" 2>&1 |
    grep -oE 'VERIFY frame [0-9] \(target 0x[0-9a-f]+, [0-9]+ bytes of code\) failed: [A-Za-z]+|no execution error' | head -1
done

if [[ ${NO_SIDECAR:-0} == 1 ]]; then
  client notes
  exit 0
fi

step "the alt mempool: the sidecar with the (pool, nullifier) rule"
bash privacy-pool/sidecar.sh start
export SIDECAR_URL=http://127.0.0.1:${SIDECAR_PORT:-14337}/rpc/
echo "-- note 2 from a fresh account: admitted"
client send --to "$GB" --data "$(sign 'note 2, first try')" --note 2 --shape preverify --no-wait
echo "-- note 5, another note of the same pool: admitted alongside"
client send --to "$GB" --data "$(sign 'note 5')" --note 5 --no-wait
echo "-- note 2 again from another fresh account, same fee: refused"
client send --to "$GB" --data "$(sign 'note 2, same fee')" --note 2 --shape preverify --replace --same-fee --no-wait || true
echo "-- note 2 again, 10% more on both fees: replaces the first"
client send --to "$GB" --data "$(sign 'note 2, fee bumped')" --note 2 --shape preverify --replace --no-wait
bash privacy-pool/sidecar.sh mempool
step "hand the pending transactions to ethrex"
bash privacy-pool/sidecar.sh bundle
sleep 12
client notes
