/**
 * The privacy pool's spend logic without Node: shield, publish the pool's root, and send a call from
 * any account whose gas the pool pays from a shielded note, with the unused fee back as a refund
 * note. The browser extension (privacy-pool/extension) bundles it; it runs in Node as well.
 *
 * It follows privacy-pool/client.ts (the CLI keeps its own copy for now, with the attack and mempool
 * test options): the last-frame or pre_verify shape, the fee at the transaction's maximum cost,
 * a refund note whose rho comes from the spent note's key and first nullifier.
 *
 * msp's client code is imported from deps.nosync/minimal-shielded-pool, which must carry the
 * chain-1337 envelope patch.
 */
import * as bytes from "../deps.nosync/minimal-shielded-pool/src/bytes.ts";
import * as frametx from "../deps.nosync/minimal-shielded-pool/src/frametx.ts";
import * as protocol from "../deps.nosync/minimal-shielded-pool/src/protocol.ts";
import * as random from "../deps.nosync/minimal-shielded-pool/src/random.ts";
import * as walletLib from "../deps.nosync/minimal-shielded-pool/src/wallet.ts";

const { concat, keccak, toHex, fromHex, toBigint, toBytes, word } = bytes;
const { rlpList, rlpBytes, rlpInt, MODE, APPROVE, SCHEME } = frametx as any;

export const GWEI = 10n ** 9n;
export const ETH = 10n ** 18n;
const SETTLE_SELECTOR = protocol.selector(`settleSponsored(${protocol.SPEND_TUPLE})`);
const PRE_VERIFY_SELECTOR = protocol.selector("preVerify()");
const PAY_SELECTOR = protocol.selector("payPreVerified()");
const SENDER_VERIFY_GAS = 30_000n;
const PROOF_FRAME_GAS = 300_000n;
const PAY_FRAME_GAS = 20_000n;
const PRE_VERIFY_STATE_GAS = 195_840n;
const SETTLE_GAS = 2_000_000n;
const SETTLE_REFUND_STATE_GAS = 650_000n;
const REFUND_NOTE_TOPIC = toHex(keccak(new TextEncoder().encode("RefundNote(bytes32,uint256,uint256)")));

export interface Config {
  chainId: string;
  rpc: string;
  /** The alt mempool sidecar's URL, used when via is "sidecar". */
  sidecar: string;
  /** "sidecar" (the alt mempool) or "privileged" (straight to ethrex, no mempool rules). */
  via: "sidecar" | "privileged";
  shape: "last" | "preverify";
  pool: string;
  /** The local dev chain's funder key, which pays for shields and root publishing (dev only). */
  funderKey: string;
}

export interface Note {
  sk: string;
  rho: string;
  value: string;
  epoch: string;
  index: string;
  cm: string;
  spent?: string;
  from?: string;
  refundOf?: string;
  pending?: string;
}

export interface State {
  notes: Note[];
  published?: { epoch: string; root: string; slot: string; block: string };
}

export type Rpc = (method: string, params?: unknown[], url?: string) => Promise<any>;
export type Prover = (witness: any, label: string) => Promise<{ publics: bigint[]; proof: any }>;

export const hex = (v: bigint) => "0x" + v.toString(16);
export const addr = (v: bigint) => "0x" + v.toString(16).padStart(40, "0");
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function eth(wei: bigint): string {
  const whole = wei / ETH;
  const frac = (wei % ETH).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function makeRpc(defaultUrl: string): Rpc {
  return async (method, params = [], url = defaultUrl) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }, (_, v) => (typeof v === "bigint" ? hex(v) : v)),
    });
    const reply = (await res.json()) as any;
    if (reply.error) {
      const data = reply.error.data ? ` ${JSON.stringify(reply.error.data)}` : "";
      throw new Error(`${method}: ${reply.error.message}${data}`);
    }
    return reply.result;
  };
}

export async function receipt(rpc: Rpc, hash: string, what: string, seconds = 120): Promise<any> {
  for (let i = 0; i < seconds; i++) {
    const rec = await rpc("eth_getTransactionReceipt", [hash]);
    if (rec) return rec;
    await sleep(1000);
  }
  throw new Error(`${what} ${hash} was not mined within ${seconds} seconds`);
}

export function keyOf(text: string): Uint8Array {
  return (frametx as any).parsePrivateKeyLine(text.trim(), "the key");
}
export function newAccountKey(): string {
  const [key] = walletLib.newAuthorizer(random.secureRng);
  return toHex(key);
}
export function addressOf(key: string): string {
  return (frametx as any).checksumAddress(frametx.addressOf(fromHex(key, "key")));
}

/** The pool's notes that are live: unspent, not pending, and in the tree. */
export const spendable = (s: State) => s.notes.filter((n) => !n.spent && !n.pending && n.index !== "?");
export const balance = (s: State) =>
  s.notes.filter((n) => !n.spent).reduce((sum, n) => sum + BigInt(n.value), 0n);

// ---- ordinary transactions from the dev funder ----

async function call1559(rpc: Rpc, key: Uint8Array, to: bigint, data: Uint8Array, value = 0n): Promise<any> {
  const from = frametx.addressOf(key);
  const chainId = BigInt(await rpc("eth_chainId"));
  const nonce = BigInt(await rpc("eth_getTransactionCount", [addr(from), "pending"]));
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const base = BigInt(block.baseFeePerGas ?? "0x0");
  const tip = GWEI;
  const maxFee = base * 2n + tip;
  const gas =
    (BigInt(await rpc("eth_estimateGas", [{ from: addr(from), to: addr(to), data: toHex(data), value: hex(value) }])) * 13n) / 10n;
  const fields = [
    rlpInt(chainId), rlpInt(nonce), rlpInt(tip), rlpInt(maxFee), rlpInt(gas),
    rlpBytes(toBytes(to, 20)), rlpInt(value), rlpBytes(data), rlpList([]),
  ];
  const digest = keccak(concat(Uint8Array.of(2), rlpList(fields)));
  const sig = frametx.signHash(digest, key);
  const raw = concat(Uint8Array.of(2), rlpList([
    ...fields, rlpInt(BigInt(sig[0])), rlpInt(toBigint(sig.subarray(1, 33))), rlpInt(toBigint(sig.subarray(33, 65))),
  ]));
  const hash = await rpc("eth_sendRawTransaction", [toHex(raw)]);
  const rec = await receipt(rpc, hash, "the call");
  if (rec.status !== "0x1") throw new Error(`call ${hash} reverted`);
  return rec;
}

async function storageWord(rpc: Rpc, account: bigint, slot: bigint): Promise<bigint> {
  return BigInt(await rpc("eth_getStorageAt", [addr(account), hex(slot), "latest"]));
}

export async function poolTree(rpc: Rpc, pool: bigint, epoch: bigint) {
  const logs = await rpc("eth_getLogs", [
    { address: addr(pool), fromBlock: "0x0", toBlock: "latest", topics: [protocol.LEAF_APPENDED] },
  ]);
  const leaves = logs
    .map((l: any) => protocol.parseLeafAppended(l))
    .filter((l: any) => l && l.epoch === epoch)
    .sort((a: any, b: any) => (a.index < b.index ? -1 : 1));
  const tree = new walletLib.Tree();
  leaves.forEach((l: any, i: number) => {
    if (l.index !== BigInt(i)) throw new Error(`the pool's leaves skip index ${i}`);
    tree.append(l.cm);
  });
  return tree;
}

/** Shields value from the dev funder into a new note of this wallet. */
export async function shield(rpc: Rpc, cfg: Config, state: State, value: bigint): Promise<Note> {
  const pool = BigInt(cfg.pool);
  const [sk, rho] = walletLib.newNote(random.secureRng);
  const inner = protocol.inner(sk, rho);
  const note = crypto.getRandomValues(new Uint8Array(48));
  const rec = await call1559(rpc, keyOf(cfg.funderKey), pool, protocol.encodeShield(inner, note), value);
  const leaf = rec.logs
    .filter((l: any) => BigInt(l.address) === pool)
    .map((l: any) => protocol.parseLeafAppended(l))
    .find((l: any) => l);
  const cm = protocol.commitment(sk, rho, value);
  if (!leaf || leaf.cm !== cm) throw new Error("the shield did not append this note");
  const made: Note = {
    sk: hex(sk), rho: hex(rho), value: value.toString(), epoch: leaf.epoch.toString(),
    index: leaf.index.toString(), cm: hex(cm),
  };
  state.notes.push(made);
  return made;
}

/** Publishes the pool's current root (the dev funder pays) and records it. */
export async function publishRoot(rpc: Rpc, cfg: Config, state: State): Promise<void> {
  const pool = BigInt(cfg.pool);
  const epoch = await storageWord(rpc, pool, 24n);
  const rec = await call1559(rpc, keyOf(cfg.funderKey), pool, protocol.encodePublish(epoch));
  const block = await rpc("eth_getBlockByNumber", [rec.blockNumber, false]);
  if (block.slotNumber === undefined) throw new Error("this node's blocks carry no slotNumber");
  state.published = {
    epoch: epoch.toString(), root: hex(await storageWord(rpc, pool, 22n)),
    slot: BigInt(block.slotNumber).toString(), block: BigInt(rec.blockNumber).toString(),
  };
}

/** Settles what earlier sends left open: spent inputs, change and refund notes' leaves. */
export async function sync(rpc: Rpc, cfg: Config, state: State): Promise<void> {
  const pool = BigInt(cfg.pool);
  for (const n of state.notes) {
    if (n.pending) {
      const rec = await rpc("eth_getTransactionReceipt", [n.pending]);
      if (rec && rec.status === "0x1") {
        n.spent = n.pending;
        delete n.pending;
      }
    }
    if (n.refundOf && n.index === "?") {
      const rec = await rpc("eth_getTransactionReceipt", [n.refundOf]);
      if (rec) {
        const r = refundLog(rec, pool);
        const cm = r && protocol.commitment(BigInt(n.sk), BigInt(n.rho), r.value);
        const leaf = r && rec.logs
          .filter((l: any) => BigInt(l.address) === pool)
          .map((l: any) => protocol.parseLeafAppended(l))
          .find((l: any) => l && l.cm === cm);
        if (leaf && cm === r!.cm) {
          n.value = r!.value.toString();
          n.cm = hex(cm!);
          n.index = leaf.index.toString();
          n.epoch = leaf.epoch.toString();
        } else n.spent = "nothing (no refund was made)";
      }
    }
    if (n.from && n.index === "?") {
      const rec = await rpc("eth_getTransactionReceipt", [n.from]);
      const leaf = rec?.logs
        ?.filter((l: any) => BigInt(l.address) === pool)
        .map((l: any) => protocol.parseLeafAppended(l))
        .find((l: any) => l && l.cm === BigInt(n.cm));
      if (leaf) {
        n.index = leaf.index.toString();
        n.epoch = leaf.epoch.toString();
      }
    }
  }
}

export function refundLog(rec: any, pool: bigint) {
  const l = rec?.logs?.find((l: any) => BigInt(l.address) === pool && l.topics?.[0]?.toLowerCase() === REFUND_NOTE_TOPIC);
  if (!l) return undefined;
  const d = fromHex(l.data, "RefundNote data");
  return { cm: BigInt(l.topics[1]), value: toBigint(d.slice(0, 32)), chargedGas: toBigint(d.slice(32, 64)) };
}

// ---- the sponsored transaction ----

function buildTx(o: {
  chainId: bigint; pool: bigint; sender: bigint; nonce: bigint; shape: string;
  calls: { to: bigint; data: Uint8Array; value: bigint; gas: bigint; stateGas: bigint }[];
  proof: Uint8Array; settle: Uint8Array; ref: any; tip: bigint; maxFee: bigint;
}) {
  const frame = (mode: bigint, flags: bigint, target: bigint | null, gasLimit: bigint, data: Uint8Array, stateLimit = 0n, value = 0n) =>
    ({ mode, flags, target, gasLimit, stateLimit, value, data });
  const senderFrame = frame(MODE.VERIFY, APPROVE.EXECUTION, null, SENDER_VERIFY_GAS, new Uint8Array(0));
  const callFrames = o.calls.map((c) => frame(MODE.SENDER, 0n, c.to, c.gas, c.data, c.stateGas, c.value));
  const settleFrame = frame(MODE.DEFAULT, 0n, o.pool, SETTLE_GAS, o.settle, SETTLE_REFUND_STATE_GAS);
  const validation = o.shape === "preverify"
    ? [
        frame(MODE.DEFAULT, 0n, o.pool, PROOF_FRAME_GAS, concat(PRE_VERIFY_SELECTOR, o.proof), PRE_VERIFY_STATE_GAS),
        frame(MODE.VERIFY, APPROVE.PAYMENT, o.pool, PAY_FRAME_GAS, PAY_SELECTOR),
      ]
    : [frame(MODE.VERIFY, APPROVE.PAYMENT, o.pool, PROOF_FRAME_GAS, o.proof)];
  return {
    chainId: o.chainId, nonceKeys: [0n], nonceSeq: o.nonce, sender: o.sender,
    frames: [senderFrame, ...validation, ...callFrames, settleFrame],
    signatures: [] as any[], maxPriorityFee: o.tip, maxFee: o.maxFee, maxBlobFee: 0n, blobHashes: [],
    recentRootRefs: [o.ref],
  };
}

function settleData(spend: Record<string, bigint>, notesBytes: Uint8Array, refundInner: bigint): Uint8Array {
  const words = protocol.SPEND_FIELDS.map((f: string) => word(spend[f]));
  return concat(SETTLE_SELECTOR, ...words, notesBytes, word(refundInner));
}

function refundOpening(sk: bigint, nf1: bigint): [bigint, bigint] {
  const tag = new TextEncoder().encode("nainokot/privacy-pool/refund/v1");
  return [sk, toBigint(keccak(concat(tag, word(sk), word(nf1)))) % protocol.P];
}

function signTransaction(tx: any, key: Uint8Array) {
  const unsigned = { scheme: SCHEME.SECP256K1, signer: frametx.addressOf(key), msg: new Uint8Array(0) };
  tx.signatures = [{ ...unsigned, signature: new Uint8Array(0) }];
  tx.signatures = [{ ...unsigned, signature: frametx.signHash(frametx.sigHash(tx), key) }];
}

function frameTxDto(tx: any) {
  return {
    chainId: hex(tx.chainId), nonceKeys: tx.nonceKeys.map(hex), nonceSeq: hex(tx.nonceSeq), sender: addr(tx.sender),
    frames: tx.frames.map((f: any) => ({
      mode: Number(f.mode), flags: Number(f.flags), target: f.target === null ? null : addr(f.target),
      limits: { execution: hex(f.gasLimit), state: hex(f.stateLimit) }, value: hex(f.value), data: toHex(f.data),
    })),
    signatures: tx.signatures.map((s: any) => ({
      scheme: Number(s.scheme), signer: addr(s.signer), msg: toHex(s.msg), signature: toHex(s.signature),
    })),
    fees: { maxPriorityFeePerGas: hex(tx.maxPriorityFee), maxFeePerGas: hex(tx.maxFee), maxFeePerBlobGas: "0x0" },
    blobVersionedHashes: [],
    recentRootReferences: tx.recentRootRefs.map((r: any) => ({ sourceId: toHex(r.sourceId), slot: hex(r.slot), root: toHex(r.root) })),
  };
}

export interface Call { to: string; data?: string; value?: string; gas?: string }

export interface Sent {
  hash: string;
  fee: bigint;
  /** The note it spent, by its index in state.notes. */
  note: number;
}

/**
 * Proves and sends `calls` from the account `senderKey`, its gas paid by one of the pool's notes.
 * Publishes the pool's root first when the tree moved (the dev funder pays), records the spent
 * note as pending and the change and refund notes as waiting, and returns once the transaction
 * is handed over (not mined). `step` reports progress in words.
 */
export async function sponsoredSend(o: {
  rpc: Rpc; cfg: Config; state: State; senderKey: string; calls: Call[]; prover: Prover; step?: (s: string) => void;
}): Promise<Sent> {
  const { rpc, cfg, state, prover } = o;
  const step = o.step ?? (() => undefined);
  if (o.calls.length === 0 || o.calls.length > 8) throw new Error("send 1 to 8 calls");
  if (o.calls.some((c) => c.value && BigInt(c.value) !== 0n)) {
    throw new Error("this account holds no ETH, so it can only send calls without value");
  }
  const pool = BigInt(cfg.pool);
  const chainId = BigInt(cfg.chainId);
  await sync(rpc, cfg, state);

  // The pool's root must hold every note; publish it again when the tree moved.
  const epoch = await storageWord(rpc, pool, 24n);
  let tree = await poolTree(rpc, pool, epoch);
  if (!state.published || BigInt(state.published.epoch) !== epoch || BigInt(state.published.root) !== tree.root()) {
    step("Updating the pool's root");
    await publishRoot(rpc, cfg, state);
    tree = await poolTree(rpc, pool, epoch);
  }
  const pub = state.published!;

  const senderKey = keyOf(o.senderKey);
  const sender = frametx.addressOf(senderKey);
  const nonce = BigInt(await rpc("eth_getTransactionCount", [addr(sender), "latest"]));
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const base = BigInt(block.baseFeePerGas ?? "0x0");
  const tip = GWEI;
  const maxFee = base * 2n + tip;

  // Each call is its own SENDER frame, its gas from eth_estimateGas as the sender, with room.
  const calls = [];
  for (const call of o.calls) {
    const to = BigInt(call.to);
    const data = fromHex(call.data ?? "0x", "data");
    let gas: bigint;
    try {
      gas = (BigInt(await rpc("eth_estimateGas", [{ from: addr(sender), to: addr(to), data: toHex(data) }])) * 15n) / 10n;
    } catch {
      gas = 200_000n;
    }
    if (call.gas) gas = BigInt(call.gas);
    calls.push({ to, data, value: 0n, gas, stateGas: 200_000n });
  }

  const domain = protocol.domainScalar(chainId, pool, epoch);
  const source = protocol.sourceId(pool, epoch);
  const ref = (frametx as any).recentRootRefOf(protocol.recentRootTuple(source, BigInt(pub.slot), BigInt(pub.root)));
  const notesBytes = crypto.getRandomValues(new Uint8Array(96));
  const placeholder = (fee: bigint) => {
    const spend = { root: BigInt(pub.root), rootSlot: BigInt(pub.slot), epoch, domain, nf1: protocol.P - 3n, nf2: protocol.P - 4n,
      outCm1: protocol.P - 1n, outCm2: protocol.P - 2n, publicAmount: 0n, fee, recipient: 0n, authorizer: sender };
    const tx = buildTx({ chainId, pool, sender, nonce, shape: cfg.shape, calls, proof: new Uint8Array(288).fill(0xff),
      settle: settleData(spend, notesBytes, protocol.P - 5n), ref, tip, maxFee });
    tx.signatures = [{ scheme: SCHEME.SECP256K1, signer: sender, msg: new Uint8Array(0), signature: new Uint8Array(65).fill(0xff) }];
    return frametx.maxCost(tx as any);
  };
  const fee = (placeholder(placeholder(2n ** 100n)) * 101n) / 100n;

  // The note: the smallest spendable one under the root that covers the fee.
  const index = state.notes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => spendable(state).includes(n) && BigInt(n.epoch) === epoch && BigInt(n.index) < BigInt(tree.leaves.length) && BigInt(n.value) >= fee)
    .sort((a, b) => (BigInt(a.n.value) < BigInt(b.n.value) ? -1 : 1))[0]?.i;
  if (index === undefined) {
    throw new Error(`no note covers this transaction's gas (up to ${eth(fee)} ETH); add gas money first`);
  }
  const note = state.notes[index];
  const value = BigInt(note.value);
  const input = { sk: BigInt(note.sk), rho: BigInt(note.rho), value, idx: BigInt(note.index) };
  const dummy = walletLib.dummyInput(random.secureRng);
  const [changeSk, changeRho] = walletLib.newNote(random.secureRng);
  const change = value - fee;
  const outputs: any = change > 0n
    ? [[protocol.inner(changeSk, changeRho), change], protocol.sinkOutputs()[1]]
    : protocol.sinkOutputs();

  step("Proving");
  const witness = walletLib.buildWitness(tree, [input, dummy], outputs, domain, { authorizer: sender, fee } as any);
  const { publics, proof } = await prover(witness, "the sponsored spend");
  const words = { pA: proof.pA.map(BigInt), pB: proof.pB.map((r: string[]) => r.map(BigInt)), pC: proof.pC.map(BigInt) };
  const proofData = protocol.proofBytes(words, BigInt(publics[0]));
  const [nf1, nf2] = protocol.inputNullifiers(domain, [input, dummy]);
  const [outCm1, outCm2] = protocol.outputCommitments(outputs);
  const [refundSk, refundRho] = refundOpening(input.sk, nf1);
  const spend = { root: BigInt(pub.root), rootSlot: BigInt(pub.slot), epoch, domain, nf1, nf2, outCm1, outCm2,
    publicAmount: 0n, fee, recipient: 0n, authorizer: sender };
  const tx = buildTx({ chainId, pool, sender, nonce, shape: cfg.shape, calls, proof: proofData,
    settle: settleData(spend, notesBytes, protocol.inner(refundSk, refundRho)), ref, tip, maxFee });
  signTransaction(tx, senderKey);
  const raw = toHex((frametx as any).rawTx(tx));

  step("Checking");
  const sim = await rpc("ethrex_simulateFrameTransaction", [raw, "latest", { trace: false }]).catch(() => null);
  if (sim) {
    const ok = (sim.frames ?? []).length === tx.frames.length && sim.frames.every((f: any) => f.succeeded);
    if (!ok) throw new Error(`the transaction would fail: ${sim.executionError ?? JSON.stringify(sim.failure ?? sim.frames)}`);
  }

  step("Sending");
  let hash: string;
  if (cfg.via === "sidecar") hash = await rpc("eth_sendFrameTransaction", [frameTxDto(tx)], cfg.sidecar);
  else {
    await rpc("ethrex_submitPrivilegedFrameTransaction", [raw]);
    hash = toHex(keccak((frametx as any).rawTx(tx)));
  }
  note.pending = hash;
  if (change > 0n) {
    state.notes.push({ sk: hex(changeSk), rho: hex(changeRho), value: change.toString(), epoch: epoch.toString(),
      index: "?", cm: hex(outCm1), from: hash });
  }
  state.notes.push({ sk: hex(refundSk), rho: hex(refundRho), value: "0", epoch: epoch.toString(), index: "?", cm: "?", refundOf: hash });
  return { hash, fee, note: index };
}
