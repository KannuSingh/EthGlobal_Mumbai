#!/usr/bin/env bash
# A local stand-in for the ERC-8421 alt mempool devnet: forshtat/ethrex eip8141-tracer (the
# client that devnet runs, with the ninth envelope field and RECENTROOTREFLOAD 0xB6) in dev
# mode as chain 1337, with the validation gas cap raised to 500,000 so msp's ~228k proof frame
# fits. It shows the whole flow working on that client before asking the devnet's
# operators to raise their cap.
#
#   bash scripts/altlocal.sh setup    # fetch and build that ethrex (once, ~5-10 min), genesis, keys
#   bash scripts/altlocal.sh start    # a new chain on http://127.0.0.1:8547, in the background
#   bash scripts/altlocal.sh stop
#   bash scripts/altlocal.sh status
#
# Then: bash privacy-pool/deploy.sh (or bash privacy-pool/run.sh, which starts its own chain).
# Each start is a fresh chain, so deploy again after it (move altlocal.nosync/config.json away).
# MAX_VERIFY_GAS=100000 bash scripts/altlocal.sh start reproduces the devnet's refusal.
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
DEV=$HERE/altlocal.nosync
SRC=$HERE/deps.nosync/ethrex-altmempool
ETHREX=$SRC/target/release/ethrex
REV=9aa3645d795945c64400f41a70aace0edfa7f383
PORT=8547
RPC=http://127.0.0.1:$PORT
PID=$DEV/node.pid

running() { [[ -f $PID ]] && kill -0 "$(cat "$PID")" 2>/dev/null; }

setup() {
  mkdir -p "$DEV/keys"
  if [[ -e $SRC ]]; then
    [[ $(git -C "$SRC" rev-parse HEAD 2>/dev/null) == "$REV" ]] ||
      { echo "${SRC#$HERE/} exists but is not at ${REV:0:7}; move it away" >&2; exit 1; }
    echo "==> ethrex-altmempool is at ${REV:0:7}"
  else
    echo "==> fetching forshtat/ethrex eip8141-tracer at ${REV:0:7}"
    mkdir -p "$SRC"
    # A global git-lfs filter would fail the checkout.
    git -C "$SRC" init -q
    for k in required process smudge clean; do
      [[ $k == required ]] && git -C "$SRC" config filter.lfs.required false || git -C "$SRC" config "filter.lfs.$k" ""
    done
    git -C "$SRC" remote add origin https://github.com/forshtat/ethrex
    git -C "$SRC" fetch -q --depth 1 origin "$REV"
    git -C "$SRC" checkout -q --detach FETCH_HEAD
  fi
  # Its dev block producer still asks for Amsterdam payloads under Hegotá; the same patch as
  # the chain-8141 node's makes it use forkchoiceUpdatedV5 and newPayloadV6.
  local patch=$HERE/patches/ethrex-dev-hegota.patch
  if git -C "$SRC" apply --reverse --check "$patch" 2>/dev/null; then
    echo "    the dev-mode patch is applied"
  else
    git -C "$SRC" apply "$patch"
    echo "    applied the dev-mode patch"
  fi
  echo "==> building it (about 5-10 minutes the first time)"
  (cd "$SRC" && cargo build --release --bin ethrex)
  echo "==> genesis (ethrex's Hegotá genesis, every fork at time 0, chain id 1337) and keys"
  jq '.config.chainId = 1337' "$SRC/fixtures/genesis/l1-hegota.json" >"$DEV/genesis-1337.json"
  # The public dev key that genesis funds; worth nothing anywhere else.
  local key
  key=$(sed -n 1p "$SRC/fixtures/keys/private_keys_l1.txt")
  (umask 077 && printf '%s\n' "$key" >"$DEV/funder.key")
  if [[ ! -f $DEV/keys/devnet-deployer ]]; then
    local pw
    pw=$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
    (umask 077 && printf '%s\n' "$pw" >"$DEV/keys/pw.txt")
    cast wallet import devnet-deployer --private-key "$key" --unsafe-password "$pw" \
      --keystore-dir "$DEV/keys" >/dev/null
  fi
  echo "    funder $(cast wallet address --private-key "$key")"
}

start() {
  if running; then echo "already running (pid $(cat "$PID"))"; return; fi
  [[ -x $ETHREX && -f $DEV/genesis-1337.json ]] || { echo "run bash scripts/altlocal.sh setup first" >&2; exit 1; }
  if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
    echo "something else already answers on $RPC; stop it first" >&2; exit 1
  fi
  rm -rf "$DEV/data"
  cd "$DEV"
  nohup "$ETHREX" --dev --network "$DEV/genesis-1337.json" --datadir "$DEV/data" \
    --http.addr 127.0.0.1 --http.port "$PORT" --authrpc.port 8552 --http.api eth,net,web3,ethrex,debug,txpool \
    --mempool.max-verify-gas "${MAX_VERIFY_GAS:-500000}" --p2p.disabled >"$DEV/node.log" 2>&1 &
  echo $! >"$PID"
  for _ in $(seq 60); do
    if [[ $(cast chain-id --rpc-url "$RPC" 2>/dev/null) == 1337 ]]; then
      echo "    node up on $RPC, chain 1337, verify cap ${MAX_VERIFY_GAS:-500000} (pid $(cat "$PID"), log altlocal.nosync/node.log)"
      return
    fi
    running || { echo "the node exited:" >&2; tail -20 "$DEV/node.log" >&2; exit 1; }
    sleep 1
  done
  echo "the node did not answer within 60 seconds; see altlocal.nosync/node.log" >&2; exit 1
}

case ${1:-status} in
  setup) setup ;;
  start) start ;;
  stop)
    if running; then
      kill "$(cat "$PID")"
      for _ in $(seq 20); do running || break; sleep 0.5; done
      ! running || kill -9 "$(cat "$PID")"
      echo "    node stopped"
    fi
    rm -f "$PID" ;;
  status)
    if running; then echo "running (pid $(cat "$PID")), block $(cast block-number --rpc-url "$RPC" 2>/dev/null || echo '?')"
    else echo "not running"; fi ;;
  *) echo "usage: bash scripts/altlocal.sh setup|start|stop|status" >&2; exit 2 ;;
esac
