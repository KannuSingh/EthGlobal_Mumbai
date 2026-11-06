#!/usr/bin/env bash
# One-time setup from a fresh clone (macOS or Linux):
#   1. checks the tools (Node 24.7+, git, jq, curl, Rust/cargo, Foundry's forge and cast)
#   2. fetches minimal-shielded-pool (msp) at d0b2131 into deps.nosync/ and applies
#      patches/msp-envelope.patch and patches/msp-verify-gas.patch, then npm ci there
#   3. npm ci at the root (esbuild, Playwright for the end-to-end check)
#   4. bash scripts/altlocal.sh setup: fetches and builds the alt mempool ethrex (5-10 min)
#
#   bash scripts/setup.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
cd "$HERE"
MSP=deps.nosync/minimal-shielded-pool
MSP_REV=d0b2131c480d802c124e3cfd86124267c7579ff0
step() { printf '\n==> %s\n' "$*"; }
need() { command -v "$1" >/dev/null || { echo "missing $1: $2" >&2; exit 1; }; }

step "tools"
need node "install Node 24 (nvm install 24 && nvm use 24)"
need git "install git"
need jq "brew install jq (or apt install jq)"
need curl "install curl"
need cargo "install Rust from https://rustup.rs"
need forge "install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup"
need cast "install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<24||(a===24&&b<7)) { console.error(`Node ${process.versions.node}: needs 24.7 or later (nvm install 24 && nvm use 24)`); process.exit(1) }'
echo "    node $(node -v), $(forge --version | head -1), $(cargo --version)"

step "minimal-shielded-pool at $MSP_REV"
if [[ ! -d $MSP/.git ]]; then
  mkdir -p "$MSP"
  git -C "$MSP" init -q
  # A global git-lfs filter would fail the checkout.
  git -C "$MSP" config filter.lfs.required false
  for k in process smudge clean; do git -C "$MSP" config "filter.lfs.$k" ""; done
  git -C "$MSP" remote add origin https://github.com/soispoke/minimal-shielded-pool
  git -C "$MSP" fetch -q --depth 1 origin "$MSP_REV"
  git -C "$MSP" checkout -q --detach FETCH_HEAD
fi
[[ $(git -C "$MSP" rev-parse --short=7 HEAD) == "${MSP_REV:0:7}" ]] ||
  { echo "$MSP is not at ${MSP_REV:0:7}; move it away and run this again" >&2; exit 1; }
# msp-verify-gas.patch sits on top of msp-envelope.patch, so check from the top down.
ENV=$HERE/patches/msp-envelope.patch VG=$HERE/patches/msp-verify-gas.patch
if git -C "$MSP" apply --reverse --check "$VG" 2>/dev/null; then
  echo "    both patches are applied"
elif git -C "$MSP" apply --reverse --check "$ENV" 2>/dev/null; then
  git -C "$MSP" apply "$VG" && echo "    applied msp-verify-gas.patch"
elif git -C "$MSP" apply --check "$ENV" 2>/dev/null; then
  git -C "$MSP" apply "$ENV" && git -C "$MSP" apply "$VG" && echo "    applied both patches"
else
  echo "$MSP has other changes; move it away (mv $MSP $MSP.old) and run this again" >&2
  exit 1
fi
(cd "$MSP" && npm ci --no-audit --no-fund >/dev/null)
echo "    npm ci done in $MSP"

step "npm ci at the root"
npm ci --no-audit --no-fund >/dev/null
echo "    done (for the end-to-end check also: npx playwright install chromium)"

step "the alt mempool node (forshtat/ethrex eip8141-tracer)"
bash scripts/altlocal.sh setup

step "ready"
echo "    bash privacy-pool/run.sh                       # contracts end to end on a new chain"
echo "    see README.md for the extension"
