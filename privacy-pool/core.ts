/**
 * The privacy pool's spend logic without Node: shield, publish the pool's root, and send a call from
 * any account whose gas the pool pays from a shielded note, with the unused fee back as a refund
 * note. The browser extension (privacy-pool/extension) bundles it; it runs in Node as well.
 *
 * The last-frame or pre_verify shape (optionally behind an EIP-8141 expiry frame), the fee at the transaction's maximum cost,
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
import * as spendLib from "../deps.nosync/minimal-shielded-pool/src/spend.ts";
import * as transfer from "./transfer.ts";

const { concat, keccak, toHex, fromHex, toBigint, toBytes, word } = bytes;
const { rlpList, rlpBytes, rlpInt, MODE, APPROVE, SCHEME } = frametx as any;

export const GWEI = 10n ** 9n;
export const ETH = 10n ** 18n;
const SETTLE_SELECTOR = protocol.selector(`settleSponsored(${protocol.SPEND_TUPLE})`);
const PRE_VERIFY_SELECTOR = protocol.selector("preVerify()");
const PAY_SELECTOR = protocol.selector("payPreVerified()");
const SENDER_VERIFY_GAS = 30_000n;
/** EIP-8141's expiry verifier predeploy: a VERIFY frame on it with an 8-byte deadline. */
export const EXPIRY_VERIFIER = 0x8141n;
const EXPIRY_GAS = 10_000n;
/** Bit 2 of a frame's flags: the frame and the one after it revert together (atomic batch). */
const ATOMIC_BATCH = 4n;
const PROOF_FRAME_GAS = 300_000n;
const PAY_FRAME_GAS = 20_000n;
const PRE_VERIFY_STATE_GAS = 195_840n;
const SETTLE_GAS = 2_000_000n;
const SETTLE_REFUND_STATE_GAS = 650_000n;
const CLAIM_GAS = 300_000n;
const REFUND_NOTE_TOPIC = toHex(keccak(new TextEncoder().encode("RefundNote(bytes32,uint256,uint256)")));

export interface Config {
  chainId: string;
  rpc: string;
  /** The alt mempool sidecar's URL, used when via is "sidecar". */
  sidecar: string;
  /**
   * "sidecar" (the alt mempool's eth_sendFrameTransaction), "raw" (the node's own mempool,
   * eth_sendRawTransaction) or "privileged" (straight into ethrex's blocks, no mempool rules: the
   * local chain only).
   */
  via: "sidecar" | "raw" | "privileged";
  shape: "last" | "preverify";
  pool: string;
  /** The local dev chain's funder key, which pays for shields and root publishing (dev only). */
  funderKey: string;
  /** A block explorer for this chain, empty when there is none (the local chain). */
  explorer?: string;
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
  /** Unix seconds: the pending send's expiry frame deadline; after it the send can never be mined. */
  pendingUntil?: number;
  /** The private transfer that paid this note to the wallet. */
  received?: string;
}

export interface State {
  notes: Note[];
  published?: { epoch: string; root: string; slot: string; block: string };
  /** The chain these notes live on: its genesis block hash and the pool's address. */
  chain?: string;
  /** Receiving keys for private transfers (transfer.ts), made on first use. */
  keys?: transfer.Keys;
  /** The last block searched for transfers to this wallet. */
  scanned?: string;
}

/** This wallet's private address, which others pay with private transfers. */
export function privateAddress(state: State): string {
  state.keys ??= transfer.newKeys();
  return transfer.addressOf(state.keys);
}

/**
 * The notes a spend takes: the smallest one covering `need`, or else the two largest when they
 * do together (the circuit has two inputs). All must be spendable, in `epoch`, under the tree.
 */
function pickInputs(state: State, epoch: bigint, leaves: number, need: bigint): number[] | undefined {
  const ok = state.notes
    .map((n, i) => ({ n, i, v: BigInt(n.value) }))
    .filter(({ n }) => spendable(state).includes(n) && BigInt(n.epoch) === epoch && BigInt(n.index) < BigInt(leaves));
  const one = ok.filter((x) => x.v >= need).sort((a, b) => (a.v < b.v ? -1 : 1))[0];
  if (one) return [one.i];
  const two = ok.sort((a, b) => (a.v > b.v ? -1 : 1)).slice(0, 2);
  return two.length === 2 && two[0].v + two[1].v >= need ? [two[0].i, two[1].i] : undefined;
}

/** Whether a note not mined yet (change on its way) would make `need` payable. */
function coming(state: State, need: bigint): boolean {
  const live = state.notes.filter((n) => !n.spent);
  const sum = live.map((n) => BigInt(n.value)).sort((a, b) => (a > b ? -1 : 1)).slice(0, 2).reduce((a, b) => a + b, 0n);
  return live.some((n) => n.index === "?" || n.pending) && sum >= need;
}

const asInput = (n: Note) => ({ sk: BigInt(n.sk), rho: BigInt(n.rho), value: BigInt(n.value), idx: BigInt(n.index) });

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
  // EIP-8272: a root written in slot S can be referenced from slot S+1. On a dev chain the next
  // block comes at once; on a slower chain, wait for it, or the spend is "not yet referenceable".
  const slot = BigInt(block.slotNumber);
  for (const until = Date.now() + 90_000; Date.now() < until; await sleep(1000)) {
    const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
    if (latest.slotNumber !== undefined && BigInt(latest.slotNumber) > slot) return;
  }
  throw new Error("the pool's new root didn't become usable within 90 seconds (no new block?)");
}

/**
 * A new local chain can reuse the pool's address, so notes kept from an earlier chain would look
 * like money. They are dropped: all of them when the chain changed since the last sync, and for a
 * state saved before the chain was recorded, each note the pool's leaves or the chain don't know.
 */
async function forgetOtherChains(rpc: Rpc, pool: bigint, state: State): Promise<void> {
  const genesis = (await rpc("eth_getBlockByNumber", ["0x0", false])).hash;
  const chain = `${String(genesis).toLowerCase()}/${addr(pool)}`;
  if (state.chain === chain) return;
  if (state.chain) {
    state.notes = [];
  } else {
    const logs = await rpc("eth_getLogs", [
      { address: addr(pool), fromBlock: "0x0", toBlock: "latest", topics: [protocol.LEAF_APPENDED] },
    ]);
    const leaves = new Set(logs.map((l: any) => protocol.parseLeafAppended(l)).filter(Boolean)
      .map((l: any) => `${l.epoch}/${l.index}/${l.cm}`));
    const known = async (h?: string) => !h || !!(await rpc("eth_getTransactionByHash", [h]).catch(() => null));
    const keep = [];
    for (const n of state.notes) {
      if (n.index !== "?" ? !leaves.has(`${BigInt(n.epoch)}/${BigInt(n.index)}/${BigInt(n.cm)}`) : !(await known(n.from ?? n.refundOf))) continue;
      if (!(await known(n.spent && n.spent.startsWith("0x") ? n.spent : n.pending))) continue;
      keep.push(n);
    }
    state.notes = keep;
  }
  delete state.published;
  delete state.scanned;
  state.chain = chain;
}

/** Settles what earlier sends left open: spent inputs, change and refund notes' leaves. */
export async function sync(rpc: Rpc, cfg: Config, state: State): Promise<void> {
  const pool = BigInt(cfg.pool);
  await forgetOtherChains(rpc, pool, state);
  // A send with an expiry frame that is still not mined a minute past its deadline never will be:
  // its notes are free again, and the change and refund it would have made are dropped.
  const expired = new Set<string>();
  for (const n of state.notes) {
    if (n.pending) {
      const rec = await rpc("eth_getTransactionReceipt", [n.pending]);
      if (rec && rec.status === "0x1") {
        n.spent = n.pending;
        delete n.pending;
        delete n.pendingUntil;
      } else if (!rec && n.pendingUntil && Date.now() / 1000 > n.pendingUntil + 60) {
        expired.add(n.pending);
        delete n.pending;
        delete n.pendingUntil;
      }
    }
  }
  if (expired.size) state.notes = state.notes.filter((n) => !expired.has(n.from ?? "") && !expired.has(n.refundOf ?? ""));
  for (const n of state.notes) {
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
  await findTransfers(rpc, pool, state);
}

/**
 * Finds private transfers paid to this wallet since the last search: each spend's Notes event
 * that carries a 1,088-byte slot, opened with the view key; the payee's leaf is the one whose
 * commitment matches the opened value and rho under this wallet's spend key.
 */
async function findTransfers(rpc: Rpc, pool: bigint, state: State): Promise<void> {
  if (!state.keys) return;
  const latest = BigInt(await rpc("eth_blockNumber", []));
  const from = state.scanned ? BigInt(state.scanned) + 1n : 0n;
  if (from > latest) return;
  const logs = await rpc("eth_getLogs", [{ address: addr(pool), fromBlock: hex(from), toBlock: hex(latest), topics: [protocol.NOTES] }]);
  const sk = BigInt(state.keys.spend);
  for (const l of logs) {
    const d = fromHex(l.data, "Notes data");
    if (d.length < 64) continue;
    const len = Number(toBigint(d.subarray(32, 64)));
    if (len !== transfer.SLOT_BYTES + 2 * transfer.NOTE_BYTES) continue;
    const notes = d.subarray(64, 64 + len);
    const got = transfer.openTransfer(state.keys, notes.subarray(0, transfer.SLOT_BYTES),
      notes.subarray(transfer.SLOT_BYTES, transfer.SLOT_BYTES + transfer.NOTE_BYTES));
    if (!got) continue;
    const cm = protocol.commitment(sk, got.rho, got.value);
    if (state.notes.some((n) => n.cm !== "?" && BigInt(n.cm) === cm)) continue;
    const rec = await rpc("eth_getTransactionReceipt", [l.transactionHash]);
    const leaf = rec?.logs
      ?.filter((x: any) => BigInt(x.address) === pool)
      .map((x: any) => protocol.parseLeafAppended(x))
      .find((x: any) => x && x.cm === cm);
    if (!leaf) continue;
    state.notes.push({ sk: hex(sk), rho: hex(got.rho), value: got.value.toString(), epoch: leaf.epoch.toString(),
      index: leaf.index.toString(), cm: hex(cm), received: l.transactionHash });
  }
  state.scanned = latest.toString();
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
  /** Unix seconds: the chain drops the transaction after this (an expiry frame first). */
  expiry?: bigint;
  /** The calls revert together: every call frame but the last opens an atomic batch. */
  atomic?: boolean;
}) {
  const frame = (mode: bigint, flags: bigint, target: bigint | null, gasLimit: bigint, data: Uint8Array, stateLimit = 0n, value = 0n) =>
    ({ mode, flags, target, gasLimit, stateLimit, value, data });
  const senderFrame = frame(MODE.VERIFY, APPROVE.EXECUTION, null, SENDER_VERIFY_GAS, new Uint8Array(0));
  const callFrames = o.calls.map((c, i) =>
    frame(MODE.SENDER, o.atomic && i < o.calls.length - 1 ? ATOMIC_BATCH : 0n, c.to, c.gas, c.data, c.stateGas, c.value));
  const deadline = new Uint8Array(8);
  if (o.expiry !== undefined) new DataView(deadline.buffer).setBigUint64(0, o.expiry);
  const expiryFrames = o.expiry === undefined ? [] : [frame(MODE.VERIFY, 0n, EXPIRY_VERIFIER, EXPIRY_GAS, deadline)];
  const settleFrame = frame(MODE.DEFAULT, 0n, o.pool, SETTLE_GAS, o.settle, SETTLE_REFUND_STATE_GAS);
  const validation = o.shape === "preverify"
    ? [
        frame(MODE.DEFAULT, 0n, o.pool, PROOF_FRAME_GAS, concat(PRE_VERIFY_SELECTOR, o.proof), PRE_VERIFY_STATE_GAS),
        frame(MODE.VERIFY, APPROVE.PAYMENT, o.pool, PAY_FRAME_GAS, PAY_SELECTOR),
      ]
    : [frame(MODE.VERIFY, APPROVE.PAYMENT, o.pool, PROOF_FRAME_GAS, o.proof)];
  return {
    chainId: o.chainId, nonceKeys: [0n], nonceSeq: o.nonce, sender: o.sender,
    frames: [...expiryFrames, senderFrame, ...validation, ...callFrames, settleFrame],
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

/** A signed, proven transaction before it is sent, for the wallet to show ("Inspect"). */
export interface Inspection {
  /** Shaped like eth_getTransactionByHash's answer, so an explorer view can show it. */
  tx: any;
  /** The node's dry run: each frame's outcome and gas, or null when the node has no dry run. */
  frames: { status: string; gasUsed: string }[] | null;
  /** The most it can cost, paid from private funds. */
  fee: bigint;
}

function inspection(tx: any, raw: string, sim: any, fee: bigint): Inspection {
  return {
    tx: {
      hash: toHex(keccak(fromHex(raw, "raw"))), type: "0x6", chainId: hex(tx.chainId), sender: addr(tx.sender),
      nonceKeys: tx.nonceKeys.map(hex), nonceSeq: hex(tx.nonceSeq),
      frames: tx.frames.map((f: any) => ({
        mode: hex(f.mode), flags: hex(f.flags), to: f.target === null ? null : addr(f.target),
        gasLimit: hex(f.gasLimit), stateLimit: hex(f.stateLimit), value: hex(f.value), data: toHex(f.data),
      })),
      maxFeePerGas: hex(tx.maxFee), maxPriorityFeePerGas: hex(tx.maxPriorityFee),
      recentRootReferences: tx.recentRootRefs.map((r: any) => ({ sourceId: toHex(r.sourceId), slot: hex(r.slot), root: toHex(r.root) })),
      signatures: tx.signatures.map((x: any) => ({ scheme: hex(x.scheme), signer: addr(x.signer), msg: toHex(x.msg), signature: toHex(x.signature) })),
    },
    frames: sim?.frames ? sim.frames.map((f: any) => ({ status: f.succeeded ? "0x1" : "0x0", gasUsed: f.gasUsed })) : null,
    fee,
  };
}

/** Thrown when the user looked at the transaction and chose not to send it. */
export class Cancelled extends Error {
  constructor() { super("you cancelled it before it was sent"); this.name = "Cancelled"; }
}

export type Inspect = (v: Inspection) => Promise<boolean>;

export interface Call { to: string; data?: string; value?: string; gas?: string }

export interface Sent {
  hash: string;
  fee: bigint;
  /** The note it spent, by its index in state.notes. */
  note: number;
  /** The account that sent it. */
  from: string;
}

/**
 * Proves and sends `calls` from the account `senderKey`, its gas paid by one of the pool's notes.
 * Publishes the pool's root first when the tree moved (the dev funder pays), records the spent
 * note as pending and the change and refund notes as waiting, and returns once the transaction
 * is handed over (not mined). `step` reports progress in words.
 */
export async function sponsoredSend(o: {
  rpc: Rpc; cfg: Config; state: State; senderKey: string; calls: Call[]; prover: Prover; step?: (s: string) => void;
  /** Also take `amount` out of the pool, credited to `recipient` (claimWithdrawal pays it). */
  withdraw?: { amount: bigint; recipient: string };
  /** Shown the proven, signed transaction before it is sent; false cancels (Cancelled). */
  inspect?: Inspect;
  /** Unix seconds after which the chain drops it (an EIP-8141 expiry frame). */
  expiry?: number;
  /** All calls or none (ERC-5792 atomicRequired): the call frames form one atomic batch. */
  atomic?: boolean;
  /** Tests only: change the proven transaction the way an attacker would before it is signed
   * (return another key to sign with). The dry run must then refuse it. */
  tamper?: (tx: any) => Uint8Array | void;
}): Promise<Sent> {
  const { rpc, cfg, state, prover } = o;
  const step = o.step ?? (() => undefined);
  if (o.calls.length === 0 || o.calls.length > 8) throw new Error("send 1 to 8 calls");
  const shape = { expiry: o.expiry === undefined ? undefined : BigInt(Math.floor(o.expiry)), atomic: !!o.atomic && o.calls.length > 1 };
  if (shape.expiry !== undefined && shape.expiry <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("this request has already expired");
  if (o.calls.some((c) => c.value && BigInt(c.value) !== 0n)) {
    throw new Error("this account holds no ETH, so it can only send calls without value");
  }
  const pool = BigInt(cfg.pool);
  const chainId = BigInt(cfg.chainId);
  const out = o.withdraw?.amount ?? 0n;
  const recipient = o.withdraw ? BigInt(o.withdraw.recipient) : 0n;
  if (o.withdraw && (out <= 0n || recipient === 0n)) throw new Error("a withdrawal needs an amount and an address");
  await sync(rpc, cfg, state);

  // The pool's root must hold every note; publish it again when the tree moved.
  const epoch = await storageWord(rpc, pool, 24n);
  let tree = await poolTree(rpc, pool, epoch);
  if (!state.published || BigInt(state.published.epoch) !== epoch || BigInt(state.published.root) !== tree.root()) {
    step("Updating the pool's root");
    await publishRoot(rpc, cfg, state);
    tree = await poolTree(rpc, pool, epoch);
  }
  let pub = state.published!;

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
  let ref = (frametx as any).recentRootRefOf(protocol.recentRootTuple(source, BigInt(pub.slot), BigInt(pub.root)));
  const notesBytes = crypto.getRandomValues(new Uint8Array(96));
  const placeholder = (fee: bigint) => {
    const spend = { root: BigInt(pub.root), rootSlot: BigInt(pub.slot), epoch, domain, nf1: protocol.P - 3n, nf2: protocol.P - 4n,
      outCm1: protocol.P - 1n, outCm2: protocol.P - 2n, publicAmount: 0n, fee, recipient: 0n, authorizer: sender };
    const tx = buildTx({ chainId, pool, sender, nonce, shape: cfg.shape, calls, proof: new Uint8Array(288).fill(0xff),
      settle: settleData(spend, notesBytes, protocol.P - 5n), ref, tip, maxFee, ...shape });
    tx.signatures = [{ scheme: SCHEME.SECP256K1, signer: sender, msg: new Uint8Array(0), signature: new Uint8Array(65).fill(0xff) }];
    return frametx.maxCost(tx as any);
  };
  const fee = (placeholder(placeholder(2n ** 100n)) * 101n) / 100n;

  // The note: the smallest spendable one under the root that covers the fee. When only the change
  // of a send that isn't mined yet would cover it, wait for that (a minute at most).
  const pick = () => pickInputs(state, epoch, tree.leaves.length, fee + out);
  let picked = pick();
  for (const until = Date.now() + 60_000; picked === undefined && coming(state, fee + out) && Date.now() < until; picked = pick()) {
    step("Waiting for your last transaction");
    await sleep(1500);
    await sync(rpc, cfg, state);
    tree = await poolTree(rpc, pool, epoch);
    if (!state.published || BigInt(state.published.epoch) !== epoch || BigInt(state.published.root) !== tree.root()) {
      step("Updating the pool's root");
      await publishRoot(rpc, cfg, state);
      tree = await poolTree(rpc, pool, epoch);
    }
    pub = state.published!;
    ref = (frametx as any).recentRootRefOf(protocol.recentRootTuple(source, BigInt(pub.slot), BigInt(pub.root)));
  }
  if (picked === undefined) {
    throw new Error(`your private funds can't cover this transaction's gas (up to ${eth(fee)} ETH) from one or two notes; press "Add 0.1 ETH" in the wallet first`);
  }
  const index = picked[0];
  const inputs = [asInput(state.notes[picked[0]]), picked[1] !== undefined ? asInput(state.notes[picked[1]]) : walletLib.dummyInput(random.secureRng)];
  const input = inputs[0];
  const value = inputs[0].value + inputs[1].value;
  const [changeSk, changeRho] = walletLib.newNote(random.secureRng);
  const change = value - fee - out;
  const outputs: any = change > 0n
    ? [[protocol.inner(changeSk, changeRho), change], protocol.sinkOutputs()[1]]
    : protocol.sinkOutputs();

  step("Proving");
  const witness = walletLib.buildWitness(tree, inputs, outputs, domain, { authorizer: sender, fee, publicAmount: out, recipient } as any);
  const { publics, proof } = await prover(witness, "the sponsored spend");
  const words = { pA: proof.pA.map(BigInt), pB: proof.pB.map((r: string[]) => r.map(BigInt)), pC: proof.pC.map(BigInt) };
  const proofData = protocol.proofBytes(words, BigInt(publics[0]));
  const [nf1, nf2] = protocol.inputNullifiers(domain, inputs);
  const [outCm1, outCm2] = protocol.outputCommitments(outputs);
  const [refundSk, refundRho] = refundOpening(input.sk, nf1);
  const spend = { root: BigInt(pub.root), rootSlot: BigInt(pub.slot), epoch, domain, nf1, nf2, outCm1, outCm2,
    publicAmount: out, fee, recipient, authorizer: sender };
  const tx = buildTx({ chainId, pool, sender, nonce, shape: cfg.shape, calls, proof: proofData,
    settle: settleData(spend, notesBytes, protocol.inner(refundSk, refundRho)), ref, tip, maxFee, ...shape });
  signTransaction(tx, o.tamper?.(tx) ?? senderKey);
  const raw = toHex((frametx as any).rawTx(tx));

  step("Checking");
  const sim = await rpc("ethrex_simulateFrameTransaction", [raw, "latest", { trace: false }]).catch(() => null);
  if (sim) {
    const ok = (sim.frames ?? []).length === tx.frames.length && sim.frames.every((f: any) => f.succeeded);
    if (!ok) throw new Error(`the transaction would fail: ${sim.executionError ?? JSON.stringify(sim.failure ?? sim.frames)}`);
    // The node's own (canonical) mempool refuses a payer that reads its own storage, as this pool
    // does; the alt mempool (sidecar) admits it under ERC-8421's staked-payer rules.
    if (cfg.via === "raw" && sim.canonicalMempoolValid === false) {
      throw new Error(`the node's own mempool would refuse it (${sim.canonicalMempoolViolation ?? "no reason given"}); send it through the alt mempool instead (VIA=sidecar)`);
    }
  }
  if (o.inspect && !(await o.inspect(inspection(tx, raw, sim, fee)))) throw new Cancelled();

  step("Sending");
  let hash: string;
  if (cfg.via === "sidecar") hash = await rpc("eth_sendFrameTransaction", [frameTxDto(tx)], cfg.sidecar);
  else if (cfg.via === "raw") hash = await rpc("eth_sendRawTransaction", [raw]);
  else {
    await rpc("ethrex_submitPrivilegedFrameTransaction", [raw]);
    hash = toHex(keccak((frametx as any).rawTx(tx)));
  }
  for (const i of picked) {
    state.notes[i].pending = hash;
    if (shape.expiry !== undefined) state.notes[i].pendingUntil = Number(shape.expiry);
  }
  if (change > 0n) {
    state.notes.push({ sk: hex(changeSk), rho: hex(changeRho), value: change.toString(), epoch: epoch.toString(),
      index: "?", cm: hex(outCm1), from: hash });
  }
  state.notes.push({ sk: hex(refundSk), rho: hex(refundRho), value: "0", epoch: epoch.toString(), index: "?", cm: "?", refundOf: hash });
  return { hash, fee, note: index, from: addressOf(o.senderKey) };
}

/**
 * Takes `amount` out of the private funds to any address in one pool-as-sender transaction: the
 * pool settles the spend, crediting the address, and its DEFAULT tail claims it, sending the ETH.
 */
export async function withdraw(o: {
  rpc: Rpc; cfg: Config; state: State; amount: bigint; recipient: string; prover: Prover; step?: (s: string) => void; inspect?: Inspect;
}): Promise<Sent> {
  const sent = await poolSend({ ...o, withdraw: { amount: o.amount, recipient: addr(BigInt(o.recipient)) } });
  const rec = await receipt(o.rpc, sent.hash, "the withdrawal");
  const tail = rec.frameReceipts?.[2];
  if (rec.status !== "0x1" || (tail && tail.status !== "0x1")) throw new Error("the withdrawal transaction failed");
  await sync(o.rpc, o.cfg, o.state);
  return sent;
}

/** Pays `value` from the private funds to another wallet's private address, inside the pool. */
export async function sendPrivately(o: {
  rpc: Rpc; cfg: Config; state: State; to: string; value: bigint; prover: Prover; step?: (s: string) => void; inspect?: Inspect;
}): Promise<Sent> {
  const sealed = transfer.sealTransfer(o.to, o.value);
  const sent = await poolSend({ ...o, payee: { inner: sealed.inner, value: o.value, slot: sealed.slot, note: sealed.note } });
  const rec = await receipt(o.rpc, sent.hash, "the transfer");
  if (rec.status !== "0x1") throw new Error("the transfer failed");
  await sync(o.rpc, o.cfg, o.state);
  return sent;
}

/**
 * The pool-as-sender spend (msp's own shape): [VERIFY pool: proof] [SENDER pool: settle]
 * [DEFAULT tail]?, with the nullifiers as EIP-8250 nonce keys and a one-time authorizer key
 * signing. No account of the user's appears at all. It spends one note, or two when one is not
 * enough. `payee` pays a note to someone's private address (its 1,088-byte slot and 48-byte note
 * go in the settle data); `withdraw` credits an address and claims it in the tail. The change
 * comes back as a note.
 */
export async function poolSend(o: {
  rpc: Rpc; cfg: Config; state: State; prover: Prover; step?: (s: string) => void;
  payee?: { inner: bigint; value: bigint; slot: Uint8Array; note: Uint8Array };
  withdraw?: { amount: bigint; recipient: string };
  inspect?: Inspect;
}): Promise<Sent> {
  const { rpc, cfg, state, prover } = o;
  const step = o.step ?? (() => undefined);
  const pool = BigInt(cfg.pool);
  const chainId = BigInt(cfg.chainId);
  const out = o.withdraw?.amount ?? 0n;
  const recipient = o.withdraw ? BigInt(o.withdraw.recipient) : 0n;
  if (o.withdraw && (out <= 0n || recipient === 0n)) throw new Error("a withdrawal needs an amount and an address");
  const pay = o.payee?.value ?? 0n;
  await sync(rpc, cfg, state);
  const epoch = await storageWord(rpc, pool, 24n);
  let tree = await poolTree(rpc, pool, epoch);
  const fresh = async () => {
    if (!state.published || BigInt(state.published.epoch) !== epoch || BigInt(state.published.root) !== tree.root()) {
      step("Updating the pool's root");
      await publishRoot(rpc, cfg, state);
      tree = await poolTree(rpc, pool, epoch);
    }
  };
  await fresh();
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const tip = GWEI;
  const maxFee = BigInt(block.baseFeePerGas ?? "0x0") * 2n + tip;
  const [authKey] = walletLib.newAuthorizer(random.secureRng);
  const authorizer = frametx.addressOf(authKey);
  const domain = protocol.domainScalar(chainId, pool, epoch);
  const source = protocol.sourceId(pool, epoch);
  const changeNote = crypto.getRandomValues(new Uint8Array(48));
  const notesData = o.payee ? concat(o.payee.slot, o.payee.note, changeNote) : crypto.getRandomValues(new Uint8Array(96));
  const build = (spend: any, proof: Uint8Array, pub: NonNullable<State["published"]>) => {
    const settle = concat(protocol.selector(`settle(${protocol.SPEND_TUPLE})`), ...protocol.SPEND_FIELDS.map((f: string) => word(spend[f])), notesData);
    const ref = (frametx as any).recentRootRefOf(protocol.recentRootTuple(source, BigInt(pub.slot), BigInt(pub.root)));
    // msp's claim frame limit (100,000) is too low on this chain when the ETH goes to a new
    // account: the account's 183,600 state gas is drawn from the frame's gas limit as well.
    const tail = spend.publicAmount ? { ...spendLib.defaultClaimTail(pool, spend.recipient), gasLimit: CLAIM_GAS } : null;
    const frames = spendLib.spendFrames({ pool, recentRoot: new Uint8Array(72), proof, settle, tail, envelope: true });
    return { chainId, nonceKeys: spendLib.spendNonceKeys(settle), nonceSeq: 0n, sender: pool, frames,
      signatures: [] as any[], maxPriorityFee: tip, maxFee, maxBlobFee: 0n, blobHashes: [], recentRootRefs: [ref] };
  };
  const placeholderFee = (fee: bigint) => {
    const pub = state.published!;
    const spend = { root: BigInt(pub.root), rootSlot: BigInt(pub.slot), epoch, domain, nf1: protocol.P - 3n, nf2: protocol.P - 4n,
      outCm1: protocol.P - 1n, outCm2: protocol.P - 2n, publicAmount: out, fee, recipient, authorizer };
    const tx = build(spend, new Uint8Array(288).fill(0xff), pub);
    tx.signatures = [{ scheme: SCHEME.SECP256K1, signer: authorizer, msg: new Uint8Array(0), signature: new Uint8Array(65).fill(0xff) }];
    return frametx.maxCost(tx as any);
  };
  const fee = (placeholderFee(placeholderFee(2n ** 100n)) * 101n) / 100n;
  const need = fee + out + pay;
  let picked = pickInputs(state, epoch, tree.leaves.length, need);
  for (const until = Date.now() + 60_000; picked === undefined && coming(state, need) && Date.now() < until;) {
    step("Waiting for your last transaction");
    await sleep(1500);
    await sync(rpc, cfg, state);
    tree = await poolTree(rpc, pool, epoch);
    await fresh();
    picked = pickInputs(state, epoch, tree.leaves.length, need);
  }
  if (picked === undefined) {
    throw new Error(`your private funds can't cover ${eth(need)} ETH (including gas up to ${eth(fee)} ETH) from one or two notes`);
  }
  const pub = state.published!;
  const inputs = [asInput(state.notes[picked[0]]), picked[1] !== undefined ? asInput(state.notes[picked[1]]) : walletLib.dummyInput(random.secureRng)];
  const value = inputs[0].value + inputs[1].value;
  const [changeSk, changeRho] = walletLib.newNote(random.secureRng);
  const change = value - need;
  const changeOut: [bigint, bigint] = [protocol.inner(changeSk, changeRho), change];
  const outputs: any = o.payee
    ? [[o.payee.inner, pay], change > 0n ? changeOut : protocol.sinkOutputs()[1]]
    : change > 0n ? [changeOut, protocol.sinkOutputs()[1]] : protocol.sinkOutputs();

  step("Proving");
  const witness = walletLib.buildWitness(tree, inputs, outputs, domain, { authorizer, fee, publicAmount: out, recipient } as any);
  const { publics, proof } = await prover(witness, "the pool spend");
  const words = { pA: proof.pA.map(BigInt), pB: proof.pB.map((r: string[]) => r.map(BigInt)), pC: proof.pC.map(BigInt) };
  const proofData = protocol.proofBytes(words, BigInt(publics[0]));
  const [nf1, nf2] = protocol.inputNullifiers(domain, inputs);
  const [outCm1, outCm2] = protocol.outputCommitments(outputs);
  const spend = { root: BigInt(pub.root), rootSlot: BigInt(pub.slot), epoch, domain, nf1, nf2, outCm1, outCm2,
    publicAmount: out, fee, recipient, authorizer };
  const tx = build(spend, proofData, pub);
  signTransaction(tx, authKey);
  const raw = toHex((frametx as any).rawTx(tx));

  step("Checking");
  const sim = await rpc("ethrex_simulateFrameTransaction", [raw, "latest", { trace: false }]).catch(() => null);
  if (sim) {
    const ok = (sim.frames ?? []).length === tx.frames.length && sim.frames.every((f: any) => f.succeeded);
    if (!ok) throw new Error(`the transaction would fail: ${sim.executionError ?? JSON.stringify(sim.failure ?? sim.frames)}`);
    // The node's own (canonical) mempool refuses a payer that reads its own storage, as this pool
    // does; the alt mempool (sidecar) admits it under ERC-8421's staked-payer rules.
    if (cfg.via === "raw" && sim.canonicalMempoolValid === false) {
      throw new Error(`the node's own mempool would refuse it (${sim.canonicalMempoolViolation ?? "no reason given"}); send it through the alt mempool instead (VIA=sidecar)`);
    }
  }
  if (o.inspect && !(await o.inspect(inspection(tx, raw, sim, fee)))) throw new Cancelled();
  step("Sending");
  let hash: string;
  if (cfg.via === "sidecar") hash = await rpc("eth_sendFrameTransaction", [frameTxDto(tx)], cfg.sidecar);
  else if (cfg.via === "raw") hash = await rpc("eth_sendRawTransaction", [raw]);
  else {
    await rpc("ethrex_submitPrivilegedFrameTransaction", [raw]);
    hash = toHex(keccak((frametx as any).rawTx(tx)));
  }
  for (const i of picked) state.notes[i].pending = hash;
  if (change > 0n) {
    state.notes.push({ sk: hex(changeSk), rho: hex(changeRho), value: change.toString(), epoch: epoch.toString(),
      index: "?", cm: hex(o.payee ? outCm2 : outCm1), from: hash });
  }
  return { hash, fee, note: picked[0], from: addr(pool) };
}
