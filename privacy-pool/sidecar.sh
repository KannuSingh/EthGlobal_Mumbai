#!/usr/bin/env bash
# The ERC-8421 alt mempool sidecar (forshtat/mempool-workshop-sidecar 2e22ff0) in front of the
# local chain, with privacy-pool/sidecar/payer-keys.patch: at most one pending transaction per
# (payer, payer key), a staked payer's keys being the storage slots its validation touched (the
# privacy pool's nullifier slots), replaced only by the same keys and a 10% fee bump.
#
#   bash privacy-pool/sidecar.sh setup   # clone, patch, bun install and build (needs bun), unit tests
#   bash privacy-pool/sidecar.sh start   # on http://127.0.0.1:14337/rpc/, after privacy-pool/deploy.sh
#   bash privacy-pool/sidecar.sh stop
#
# It runs with manual bundling, so admitted transactions wait until
# `bash privacy-pool/sidecar.sh bundle` (debug_bundler_sendBundleNow) hands them to ethrex.
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
SRC=$HERE/deps.nosync/mempool-workshop-sidecar
REV=2e22ff0
DEV=$HERE/altlocal.nosync/sidecar
PID=$DEV/sidecar.pid
PATCH=$HERE/privacy-pool/sidecar/payer-keys.patch
RPC=${RPC_URL:-http://127.0.0.1:8547}
PORT=${SIDECAR_PORT:-14337}
URL=http://127.0.0.1:$PORT/rpc/
running() { [[ -f $PID ]] && kill -0 "$(cat "$PID")" 2>/dev/null; }
rpc() { curl -s -X POST "$URL" -H 'content-type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}"; }

case ${1:-status} in
  setup)
    command -v bun >/dev/null || { echo "needs bun: curl -fsSL https://bun.sh/install | bash" >&2; exit 1; }
    if [[ ! -e $SRC ]]; then
      git clone -q https://github.com/forshtat/mempool-workshop-sidecar "$SRC"
      git -C "$SRC" checkout -q --detach "$REV"
    fi
    if git -C "$SRC" apply --reverse --check "$PATCH" 2>/dev/null; then
      echo "    the payer-keys patch is applied"
    else
      git -C "$SRC" apply "$PATCH"
      echo "    applied the payer-keys patch"
    fi
    (cd "$SRC" && bun install && bun run build)
    echo "==> the payer-keys unit tests and the existing mempool tests"
    (cd "$SRC/packages/executor" && bunx vitest run test/services/MempoolService)
    ;;
  start)
    if running; then echo "already running (pid $(cat "$PID"))"; exit 0; fi
    DEPLOY=$HERE/altlocal.nosync/privacy-pool/deploy.json
    [[ -f $DEPLOY ]] || { echo "run bash privacy-pool/deploy.sh first" >&2; exit 1; }
    mkdir -p "$DEV/data"
    # The relayer key is never used to sign (the privileged relayer signs nothing); the dev key.
    # The precompiles a validation frame may call (0x01-0x11 and P256VERIFY 0x100);
    # the pool's Groth16 check calls 0x06-0x08.
    PRECOMPILES='["0x0000000000000000000000000000000000000001","0x0000000000000000000000000000000000000002","0x0000000000000000000000000000000000000003","0x0000000000000000000000000000000000000004","0x0000000000000000000000000000000000000005","0x0000000000000000000000000000000000000006","0x0000000000000000000000000000000000000007","0x0000000000000000000000000000000000000008","0x0000000000000000000000000000000000000009","0x000000000000000000000000000000000000000a","0x000000000000000000000000000000000000000b","0x000000000000000000000000000000000000000c","0x000000000000000000000000000000000000000d","0x000000000000000000000000000000000000000e","0x000000000000000000000000000000000000000f","0x0000000000000000000000000000000000000010","0x0000000000000000000000000000000000000011","0x0000000000000000000000000000000000000100"]'
    jq -n --argjson precompiles "$PRECOMPILES" --arg rpc "$RPC" --arg registry "$(jq -r .stakingRegistry "$DEPLOY")" \
      --arg relayer "0x$(head -1 "$HERE/altlocal.nosync/funder.key" | sed 's/^0x//')" '{
      entryPoints: ["0x00000000000000000000000000000000000000aa"],
      canonicalEntryPoint: "0x00000000000000000000000000000000000000aa",
      standardMempoolId: "QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk",
      supportedMempools: [{mempoolId: "QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk",
        entryPoint: "0x00000000000000000000000000000000000000aa"}],
      relayers: [$relayer], rpcEndpoint: $rpc, rpcEndpointSubmit: $rpc,
      stakingRegistryAddress: $registry, minUnstakeDelay: 86400,
      precompiles: $precompiles
    }' >"$DEV/config.json"
    chmod 600 "$DEV/config.json"
    # ERC-8421's staked budget (BUDGET-010) stands in for the sidecar's fixed 100,000.
    (cd "$SRC" && SKANDHA_PRECOMPILES=$(jq -r 'join(",")' <<<"$PRECOMPILES") SIDECAR_MAX_VERIFY_GAS=${SIDECAR_MAX_VERIFY_GAS:-2500000} nohup bun --bun \
      packages/cli/bin/skandha.js standalone --configFile "$DEV/config.json" --dataDir "$DEV/data" \
      --api.address 127.0.0.1 --api.port "$PORT" --api.wsPort "$PORT" \
      --executor.bundlingMode manual >"$DEV/sidecar.log" 2>&1 & echo $! >"$PID")
    for _ in $(seq 60); do
      if rpc eth_chainId | grep -q '"result"'; then echo "    sidecar up on $URL (log altlocal.nosync/sidecar/sidecar.log)"; exit 0; fi
      running || { echo "the sidecar exited:" >&2; tail -30 "$DEV/sidecar.log" >&2; exit 1; }
      sleep 1
    done
    echo "the sidecar did not answer within 60 seconds; see altlocal.nosync/sidecar/sidecar.log" >&2; exit 1
    ;;
  bundle) rpc debug_bundler_sendBundleNow; echo ;;
  mempool) rpc debug_bundler_dumpMempool | jq '.result // . | map({txHash, sender, payer, status, payerKeys})' ;;
  stop)
    if running; then kill "$(cat "$PID")"; echo "    sidecar stopped"; fi
    rm -f "$PID" ;;
  status) if running; then echo "running (pid $(cat "$PID"))"; else echo "not running"; fi ;;
  *) echo "usage: bash privacy-pool/sidecar.sh setup|start|bundle|mempool|stop|status" >&2; exit 2 ;;
esac
