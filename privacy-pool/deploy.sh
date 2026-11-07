#!/usr/bin/env bash
# Deploys the privacy pool on the local alt mempool chain (scripts/altlocal.sh start) and stakes it:
# msp's Groth16 verifier and Poseidon libraries, PrivacyPoolLogic, the PrivacyPoolDispatcher as the pool,
# an ERC-8421 staking registry, and Framecaster (short posts, threads, replies, likes) as "any dapp". Then writes
# altlocal.nosync/privacy-pool/deploy.json, which build.ts, the smokes and the demo page read.
#
#   bash privacy-pool/deploy.sh            # STAKE_WEI (default 1 ETH) staked for one day
#
# RPC_URL, FUNDER_KEY_FILE, POOL_DIR and REGISTRY (an existing ERC-8421 staking registry, used
# instead of deploying one) point it at another chain 1337.
#
# The funder is the local dev chain's public key (altlocal.nosync/funder.key), worth nothing.
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
RPC=${RPC_URL:-http://127.0.0.1:8547}
MSP=${MSP:-$HERE/deps.nosync/minimal-shielded-pool}
OUT=${POOL_DIR:-$HERE/altlocal.nosync/privacy-pool}
KEYFILE=${FUNDER_KEY_FILE:-$HERE/altlocal.nosync/funder.key}
GP=$HERE/privacy-pool/contracts
STAKE_WEI=${STAKE_WEI:-1000000000000000000}
[[ -f $KEYFILE ]] || { echo "no $KEYFILE; run bash scripts/altlocal.sh setup first" >&2; exit 1; }
[[ $(cast chain-id --rpc-url "$RPC") == 1337 ]] || { echo "$RPC is not chain 1337; run bash scripts/altlocal.sh start" >&2; exit 1; }
# Once per chain: a pool already deployed on this chain would be left with notes nobody can find.
if [[ -f $OUT/deploy.json ]] && [[ $(cast code "$(jq -r .pool "$OUT/deploy.json")" --rpc-url "$RPC") != 0x ]]; then
  echo "the pool in $OUT/deploy.json is already on this chain; for a new one, start a new chain first" >&2
  exit 1
fi
KEY=$(head -1 "$KEYFILE")
export ETH_RPC_URL=$RPC
deployed() { grep -oE 'Deployed to: 0x[0-9a-fA-F]{40}' | awk '{print $3}'; }

echo "==> building"
(cd "$GP" && forge build --offline >/dev/null)
(cd "$MSP/core/contracts" && forge build >/dev/null && FOUNDRY_PROFILE=libsmall forge build >/dev/null)
INIT=$(tr -d '\n' <"$GP/yul/privacy_pool_dispatcher_init.hex")
# The committed init code must be what the Yul compiles to.
# solc 0.8.30 as forge installed it: ~/.svm on Linux and older Foundry, ~/Library/Application
# Support/svm on macOS, ~/.local/share/svm elsewhere; or SOLC=/path/to/solc.
SOLC=${SOLC:-}
for c in "$(command -v solc-0.8.30 || true)" "$HOME/.svm/0.8.30/solc-0.8.30" \
  "$HOME/Library/Application Support/svm/0.8.30/solc-0.8.30" "$HOME/.local/share/svm/0.8.30/solc-0.8.30"; do
  [[ -z $SOLC && -n $c && -x $c ]] && SOLC=$c
done
if [[ -n $SOLC ]]; then
  BUILT=$("$SOLC" --strict-assembly --optimize --optimize-runs 200 --bin "$GP/yul/PrivacyPoolDispatcher.yul" | tail -1)
  [[ $BUILT == "$INIT" ]] || { echo "privacy_pool_dispatcher_init.hex is not PrivacyPoolDispatcher.yul's build" >&2; exit 1; }
else
  echo "    (no solc 0.8.30 found, so the dispatcher's init code is not checked against its Yul; set SOLC to check)"
fi

echo "==> msp's verifier and Poseidon libraries"
VERIFIER=$(forge create --root "$MSP/core/contracts" --private-key "$KEY" --broadcast \
  src/Groth16Verifier.sol:Groth16Verifier | deployed)
T3=$(FOUNDRY_PROFILE=libsmall forge create --root "$MSP/core/contracts" --private-key "$KEY" --broadcast \
  src/PoseidonT3.sol:PoseidonT3 | deployed)
T4=$(FOUNDRY_PROFILE=libsmall forge create --root "$MSP/core/contracts" --private-key "$KEY" --broadcast \
  src/PoseidonT4.sol:PoseidonT4 | deployed)
echo "    verifier $VERIFIER, PoseidonT3 $T3, PoseidonT4 $T4"

echo "==> PrivacyPoolLogic and the pool"
LOGIC=$(forge create --root "$GP" --private-key "$KEY" --broadcast src/PrivacyPoolLogic.sol:PrivacyPoolLogic \
  --constructor-args "$T3" "$T4" | deployed)
ARGS=$(cast abi-encode 'f(address,address)' "$LOGIC" "$VERIFIER")
POOL=$(cast send --private-key "$KEY" --create "${INIT}${ARGS#0x}" --json | jq -r .contractAddress)
[[ $(cast call "$POOL" 'currentRoot()(bytes32)') == 0x2134e76ac5d21aab186c2be1dd8f84ee880a1e46eaf712f9d371b6df22191f3e ]] ||
  { echo "the pool at $POOL does not answer currentRoot with the empty root" >&2; exit 1; }
echo "    logic $LOGIC, pool $POOL"

echo "==> staking registry, Framecaster, and the pool's stake"
REGISTRY=${REGISTRY:-$(forge create --root "$GP" --private-key "$KEY" --broadcast src/NaiveStakingRegistry.sol:NaiveStakingRegistry | deployed)}
FRAMECASTER=$(forge create --root "$GP" --private-key "$KEY" --broadcast src/Framecaster.sol:Framecaster | deployed)
cast send --private-key "$KEY" "$POOL" 'stake(address,uint32)' "$REGISTRY" 86400 --value "$STAKE_WEI" >/dev/null
echo "    registry $REGISTRY: pool stake $(cast call "$REGISTRY" 'getDepositInfo(address)(uint256,uint32,uint64)' "$POOL" | tr '\n' ' ')"
echo "    Framecaster $FRAMECASTER"

mkdir -p "$OUT"
jq -n --arg pool "$POOL" --arg logic "$LOGIC" --arg verifier "$VERIFIER" --arg t3 "$T3" --arg t4 "$T4" \
  --arg registry "$REGISTRY" --arg framecaster "$FRAMECASTER" --arg rpc "$RPC" \
  '{rpc: $rpc, pool: $pool, logic: $logic, verifier: $verifier, poseidonT3: $t3, poseidonT4: $t4,
    stakingRegistry: $registry, framecaster: $framecaster}' >"$OUT/deploy.json"
echo "==> wrote ${OUT#$HERE/}/deploy.json"
