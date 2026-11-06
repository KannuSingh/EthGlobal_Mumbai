/**
 * The privacy pool client: shield ETH into the privacy pool, publish its root, and send any call from a
 * fresh account of the user's whose gas the privacy pool pays from a shielded note.
 *
 *   node privacy-pool/client.ts shield 0.2
 *   node privacy-pool/client.ts publish
 *   node privacy-pool/client.ts send --to 0x... --data 0x... [--shape last|preverify]
 *        [--via sidecar|privileged|raw] [--note N] [--sender-key-file F] [--tip-gwei G]
 *        [--max-fee-gwei G] [--dry-run]
 *   node privacy-pool/client.ts notes
 *
 * State lives in $POOL_DIR/wallet.json (default altlocal.nosync/privacy-pool), owner-readable only,
 * and holds the only openings of its notes. It imports msp's own client code from $MSP (default
 * deps.nosync/minimal-shielded-pool, with the chain-1337 envelope patch applied) for the
 * Poseidon tree, the witness, the prover and the frame transaction encoding.
 *
 * --via sidecar (the default) sends eth_sendFrameTransaction to $SIDECAR_URL, the alt mempool,
 * which checks ERC-8421's rules and the (pool, nullifier) rule before relaying to ethrex.
 * --via privileged hands the transaction to ethrex's ethrex_submitPrivilegedFrameTransaction
 * directly, bypassing every mempool rule: only for testing the contracts without a sidecar.
 * --via raw uses eth_sendRawTransaction, which ethrex's own canonical mempool refuses for a
 * non-canonical paymaster that reads its storage; useful only to see that refusal.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MSP = resolve(process.env.MSP ?? join(ROOT, "deps.nosync/minimal-shielded-pool"));
const DIR = resolve(process.env.POOL_DIR ?? join(ROOT, "altlocal.nosync/privacy-pool"));
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8547";
const SIDECAR = process.env.SIDECAR_URL ?? "http://127.0.0.1:14337/rpc";

const mod = (p: string) => import(pathToFileURL(join(MSP, "src", p)).href);
const bytes = await mod("bytes.ts");
const protocol = await mod("protocol.ts");
const frametx = await mod("frametx.ts");
const walletLib = await mod("wallet.ts");
const random = await mod("random.ts");
if (typeof frametx.recentRootRefOf !== "function") {
  throw new Error(`${MSP} lacks the envelope patch (patches/msp-envelope.patch; run bash scripts/setup.sh)`);
}
const { concat, keccak, toHex, fromHex, toBigint, toBytes, word } = bytes;
const { rlpList, rlpBytes, rlpInt, MODE, APPROVE, SCHEME } = frametx;

const GWEI = 10n ** 9n;
const ETH = 10n ** 18n;
const SETTLE_SELECTOR = protocol.selector(`settleSponsored(${protocol.SPEND_TUPLE})`);
const PRE_VERIFY_SELECTOR = protocol.selector("preVerify()");
const PAY_SELECTOR = protocol.selector("payPreVerified()");
// The frames' limits. The proof check used 250,028 on this client; settlement is pinned by the
// pool at msp's 2,000,000 and 550,000.
const SENDER_VERIFY_GAS = 30_000n;
const PROOF_FRAME_GAS = BigInt(process.env.POOL_PROOF_GAS ?? "300000");
const PAY_FRAME_GAS = 20_000n;
// pre_verify writes two new storage slots (the nullifiers), 97,920 state gas each (EIP-8037).
const PRE_VERIFY_STATE_GAS = 195_840n;
const SETTLE_GAS = 2_000_000n;
const SETTLE_STATE_GAS = 550_000n;
// Refund mode (the default; --no-refund for the old settle frame): the settle frame carries the
// refund note's inner as one more word and gets 650,000 state gas, room for the extra leaf.
const SETTLE_REFUND_STATE_GAS = 650_000n;
const REFUND_NOTE_TOPIC = keccak(new TextEncoder().encode("RefundNote(bytes32,uint256,uint256)"));

// ---- small helpers ----

const hex = (v: bigint) => "0x" + v.toString(16);
const addr = (v: bigint) => "0x" + v.toString(16).padStart(40, "0");
const eth = (wei: bigint) => {
  const whole = wei / ETH;
  const frac = (wei % ETH).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};
const parseEth = (text: string): bigint => {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(text);
  if (!m) throw new Error(`not an ETH amount: ${text}`);
  return BigInt(m[1]) * ETH + BigInt((m[2] ?? "").padEnd(18, "0"));
};
const log = (line: string) => console.log(line);

async function rpc(method: string, params: unknown[] = [], url = RPC): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }, (_, v) =>
      typeof v === "bigint" ? hex(v) : v,
    ),
  });
  const reply = (await res.json()) as any;
  if (reply.error) {
    const data = reply.error.data ? ` ${JSON.stringify(reply.error.data)}` : "";
    throw new Error(`${method}: ${reply.error.message}${data}`);
  }
  return reply.result;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function receipt(hash: string, what: string): Promise<any> {
  for (let i = 0; i < 120; i++) {
    const r = await rpc("eth_getTransactionReceipt", [hash]);
    if (r) return r;
    await sleep(1000);
  }
  throw new Error(`${what} ${hash} was not mined within two minutes`);
}

// ---- wallet file ----

interface Note {
  sk: string;
  rho: string;
  value: string;
  epoch: string;
  index: string;
  cm: string;
  spent?: string; // the transaction that spent it
  from?: string; // the transaction whose change this note is (index "?" until it is mined)
  refundOf?: string; // the transaction whose refund this note is (value and cm "?" until it is mined)
  // The secrets of a pending spend, so --replace can send it again with the same nullifiers.
  pendingSpend?: { dummySk: string; dummyRho: string; changeSk: string; changeRho: string; tip: string; maxFee: string };
  pending?: string; // a transaction sent but not yet seen mined
}
interface Wallet {
  chainId: string;
  pool: string;
  funderKeyFile: string;
  notes: Note[];
  published?: { epoch: string; root: string; slot: string; block: string };
}

const WALLET = join(DIR, "wallet.json");
function load(): Wallet {
  if (!existsSync(WALLET)) throw new Error(`no ${WALLET}; run privacy-pool/deploy.sh first`);
  return JSON.parse(readFileSync(WALLET, "utf8"));
}
function save(w: Wallet): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(WALLET, JSON.stringify(w, null, 1));
  chmodSync(WALLET, 0o600);
}

// ---- ordinary transactions from the funder (shield, publish) ----

function readKey(file: string): Uint8Array {
  return frametx.parsePrivateKeyLine(readFileSync(file, "utf8").split("\n")[0], `the key in ${file}`);
}

/** An EIP-1559 call from `key`, signed here, mined before it returns. */
async function call1559(key: Uint8Array, to: bigint, data: Uint8Array, value = 0n): Promise<any> {
  const from = frametx.addressOf(key);
  const chainId = BigInt(await rpc("eth_chainId"));
  const nonce = BigInt(await rpc("eth_getTransactionCount", [addr(from), "pending"]));
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const base = BigInt(block.baseFeePerGas ?? "0x0");
  const tip = GWEI;
  const maxFee = base * 2n + tip;
  const gas = (BigInt(
    await rpc("eth_estimateGas", [{ from: addr(from), to: addr(to), data: toHex(data), value: hex(value) }]),
  ) * 13n) / 10n;
  const fields = [
    rlpInt(chainId), rlpInt(nonce), rlpInt(tip), rlpInt(maxFee), rlpInt(gas),
    rlpBytes(toBytes(to, 20)), rlpInt(value), rlpBytes(data), rlpList([]),
  ];
  const digest = keccak(concat(Uint8Array.of(2), rlpList(fields)));
  const sig = frametx.signHash(digest, key); // v || r || s
  const v = BigInt(sig[0]);
  const r = toBigint(sig.subarray(1, 33));
  const s = toBigint(sig.subarray(33, 65));
  const raw = concat(Uint8Array.of(2), rlpList([...fields, rlpInt(v), rlpInt(r), rlpInt(s)]));
  const hash = await rpc("eth_sendRawTransaction", [toHex(raw)]);
  const rec = await receipt(hash, "the call");
  if (rec.status !== "0x1") throw new Error(`call ${hash} reverted`);
  return rec;
}

// ---- the pool's tree, from its LeafAppended logs ----

async function poolTree(pool: bigint, epoch: bigint) {
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

async function storageWord(account: bigint, slot: bigint): Promise<bigint> {
  return BigInt(await rpc("eth_getStorageAt", [addr(account), hex(slot), "latest"]));
}

// ---- commands ----

async function shield(amount: string) {
  const w = load();
  const pool = BigInt(w.pool);
  const value = parseEth(amount);
  const [sk, rho] = walletLib.newNote(random.secureRng);
  const inner = protocol.inner(sk, rho);
  // The pool publishes notes and never reads them; this wallet keeps the opening itself, so the
  // note is 48 random bytes.
  const note = crypto.getRandomValues(new Uint8Array(48));
  const rec = await call1559(readKey(w.funderKeyFile), pool, protocol.encodeShield(inner, note), value);
  const leaf = rec.logs
    .filter((l: any) => BigInt(l.address) === pool)
    .map((l: any) => protocol.parseLeafAppended(l))
    .find((l: any) => l);
  if (!leaf) throw new Error("the shield left no LeafAppended log");
  const cm = protocol.commitment(sk, rho, value);
  if (leaf.cm !== cm) throw new Error("the shielded commitment is not this note's");
  w.notes.push({
    sk: hex(sk), rho: hex(rho), value: value.toString(), epoch: leaf.epoch.toString(),
    index: leaf.index.toString(), cm: hex(cm),
  });
  save(w);
  log(`shielded ${eth(value)} ETH as note ${w.notes.length - 1} (epoch ${leaf.epoch}, leaf ${leaf.index}), tx ${rec.transactionHash}`);
}

async function publish() {
  const w = load();
  const pool = BigInt(w.pool);
  const epoch = await storageWord(pool, 24n);
  const rec = await call1559(readKey(w.funderKeyFile), pool, protocol.encodePublish(epoch));
  const block = await rpc("eth_getBlockByNumber", [rec.blockNumber, false]);
  if (block.slotNumber === undefined) throw new Error("this node's blocks carry no slotNumber");
  const root = await storageWord(pool, 22n);
  w.published = {
    epoch: epoch.toString(), root: hex(root), slot: BigInt(block.slotNumber).toString(),
    block: BigInt(rec.blockNumber).toString(),
  };
  save(w);
  log(`published epoch ${epoch}'s root ${hex(root)} in slot ${w.published.slot}, tx ${rec.transactionHash}`);
}

async function notes() {
  const w = load();
  await sync(w);
  w.notes.forEach((n, i) => {
    const state = n.spent ? `spent in ${n.spent}` : n.pending ? `pending in ${n.pending}` : n.index === "?" ? `waiting for ${n.from ?? n.refundOf}` : "unspent";
    log(`note ${i}: ${eth(BigInt(n.value))} ETH, epoch ${n.epoch} leaf ${n.index}, ${state}`);
  });
}

/** One spend's frames and envelope, its fee set to the transaction's maximum cost. */
function buildTx(o: {
  chainId: bigint; pool: bigint; sender: bigint; nonce: bigint; shape: string;
  calls: { to: bigint; data: Uint8Array; value: bigint; gas: bigint; stateGas: bigint }[];
  proof: Uint8Array; settle: Uint8Array; ref: any; tip: bigint; maxFee: bigint; refund: boolean;
}) {
  const frame = (mode: bigint, flags: bigint, target: bigint | null, gasLimit: bigint, data: Uint8Array, stateLimit = 0n, value = 0n) =>
    ({ mode, flags, target, gasLimit, stateLimit, value, data });
  const senderFrame = frame(MODE.VERIFY, APPROVE.EXECUTION, null, SENDER_VERIFY_GAS, new Uint8Array(0));
  const callFrames = o.calls.map((c) => frame(MODE.SENDER, 0n, c.to, c.gas, c.data, c.stateGas, c.value));
  const settleFrame = frame(MODE.DEFAULT, 0n, o.pool, SETTLE_GAS, o.settle, o.refund ? SETTLE_REFUND_STATE_GAS : SETTLE_STATE_GAS);
  const validation = o.shape === "preverify"
    ? [
        frame(MODE.DEFAULT, 0n, o.pool, PROOF_FRAME_GAS, concat(PRE_VERIFY_SELECTOR, o.proof), PRE_VERIFY_STATE_GAS),
        frame(MODE.VERIFY, APPROVE.PAYMENT, o.pool, PAY_FRAME_GAS, PAY_SELECTOR),
      ]
    : [frame(MODE.VERIFY, APPROVE.PAYMENT, o.pool, PROOF_FRAME_GAS, o.proof)];
  return {
    // EIP-8250 key 0 alone: the sender's ordinary account nonce.
    chainId: o.chainId, nonceKeys: [0n], nonceSeq: o.nonce, sender: o.sender,
    frames: [senderFrame, ...validation, ...callFrames, settleFrame],
    signatures: [], maxPriorityFee: o.tip, maxFee: o.maxFee, maxBlobFee: 0n, blobHashes: [],
    recentRootRefs: [o.ref],
  };
}

function settleData(spend: Record<string, bigint>, notesBytes: Uint8Array, refundInner?: bigint): Uint8Array {
  const words = protocol.SPEND_FIELDS.map((f: string) => word(spend[f]));
  return refundInner === undefined
    ? concat(SETTLE_SELECTOR, ...words, notesBytes)
    : concat(SETTLE_SELECTOR, ...words, notesBytes, word(refundInner));
}

/** The refund note's opening: the spent note's key, and rho from that key and the first
 * nullifier, so a wallet restored from its notes' keys can find its refunds again. */
function refundOpening(sk: bigint, nf1: bigint): [bigint, bigint] {
  const rho = toBigint(keccak(concat(new TextEncoder().encode("nainokot/privacy-pool/refund/v1"), word(sk), word(nf1)))) % protocol.P;
  return [sk, rho];
}

/** The transaction as the sidecar's eth_sendFrameTransaction takes it. */
function frameTxDto(tx: any) {
  return {
    chainId: hex(tx.chainId), nonceKeys: tx.nonceKeys.map(hex), nonceSeq: hex(tx.nonceSeq), sender: addr(tx.sender),
    frames: tx.frames.map((f: any) => ({
      mode: Number(f.mode), flags: Number(f.flags), target: f.target === null ? null : addr(f.target),
      limits: { execution: hex(f.gasLimit), state: hex(f.stateLimit) }, value: hex(f.value),
      data: toHex(f.data),
    })),
    signatures: tx.signatures.map((s: any) => ({
      scheme: Number(s.scheme), signer: addr(s.signer), msg: toHex(s.msg), signature: toHex(s.signature),
    })),
    fees: { maxPriorityFeePerGas: hex(tx.maxPriorityFee), maxFeePerGas: hex(tx.maxFee), maxFeePerBlobGas: "0x0" },
    blobVersionedHashes: [],
    recentRootReferences: tx.recentRootRefs.map((r: any) => ({
      sourceId: toHex(r.sourceId), slot: hex(r.slot), root: toHex(r.root),
    })),
  };
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
}

async function send(args: string[]) {
  const w = load();
  const pool = BigInt(w.pool);
  const chainId = BigInt(w.chainId);
  const shape = option(args, "--shape") ?? "last";
  if (shape !== "last" && shape !== "preverify") throw new Error("--shape is last or preverify");
  const via = option(args, "--via") ?? "sidecar";
  let dryRun = args.includes("--dry-run");
  const to = option(args, "--to");
  if (!to) throw new Error("send needs --to ADDRESS (and usually --data 0x...)");
  const data = fromHex(option(args, "--data") ?? "0x", "--data");
  const callValue = 0n;
  const pub = w.published;
  if (!pub) throw new Error("publish the pool's root first");

  // The note: --note N, or the first unspent one.
  const pick = option(args, "--note");
  await sync(w);
  const index = pick !== undefined ? Number(pick) : w.notes.findIndex((n) => !n.spent && !n.pending && n.index !== "?");
  const note = w.notes[index];
  if (!note) throw new Error("no unspent note; shield some ETH first");
  if (note.spent) throw new Error(`note ${index} is spent`);
  // --replace: send this note's pending spend again with the same nullifiers (the same dummy
  // input) and fees raised by at least 10%, so the alt mempool lets it take over the old one.
  const replace = args.includes("--replace");
  const previous = note.pendingSpend;
  if (replace && !(note.pending && previous)) throw new Error(`note ${index} has no pending spend to replace`);
  if (!replace && note.pending) throw new Error(`note ${index} is pending in ${note.pending}; pass --replace to raise its fee`);
  const epoch = BigInt(pub.epoch);
  if (BigInt(note.epoch) !== epoch) throw new Error(`note ${index} is in epoch ${note.epoch}, the published root is epoch ${epoch}`);
  const tree = await poolTree(pool, epoch);
  if (tree.root() !== BigInt(pub.root)) {
    throw new Error("the pool's tree changed since the last publish; run publish again");
  }
  if (BigInt(note.index) >= BigInt(tree.leaves.length)) throw new Error("the note is not under the published root; publish again");

  // The sender: a fresh account each time unless a key file is given (to replace a pending one).
  const keyFile = option(args, "--sender-key-file");
  let senderKey: Uint8Array;
  if (keyFile && existsSync(keyFile)) senderKey = readKey(keyFile);
  else {
    [senderKey] = walletLib.newAuthorizer(random.secureRng);
    if (keyFile) {
      writeFileSync(keyFile, toHex(senderKey) + "\n", { mode: 0o600 });
    }
  }
  const sender = frametx.addressOf(senderKey);
  const nonce = BigInt(await rpc("eth_getTransactionCount", [addr(sender), "latest"]));

  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const base = BigInt(block.baseFeePerGas ?? "0x0");
  let tip = option(args, "--tip-gwei") ? BigInt(Math.round(Number(option(args, "--tip-gwei")) * 1e9)) : GWEI;
  let maxFee = option(args, "--max-fee-gwei")
    ? BigInt(Math.round(Number(option(args, "--max-fee-gwei")) * 1e9))
    : base * 2n + tip;
  if (replace && args.includes("--same-fee")) {
    // Only to see the alt mempool refuse a second transaction on the same nullifiers.
    tip = BigInt(previous!.tip);
    maxFee = BigInt(previous!.maxFee);
  } else if (replace && !option(args, "--tip-gwei") && !option(args, "--max-fee-gwei")) {
    // At least 10% over the pending one on both fees, as the sidecar asks of a replacement.
    const bump = (v: bigint) => (v * 11n + 9n) / 10n;
    tip = bump(BigInt(previous!.tip));
    maxFee = bump(BigInt(previous!.maxFee));
    if (maxFee < tip) maxFee = tip;
  }

  // The user's call: its gas from eth_estimateGas as the sender, with room to spare.
  let callGas: bigint;
  try {
    callGas = (BigInt(await rpc("eth_estimateGas", [{ from: addr(sender), to, data: toHex(data) }])) * 15n) / 10n;
  } catch (e) {
    callGas = 200_000n;
    log(`  could not estimate the call's gas (${(e as Error).message}); giving it 200,000`);
  }
  if (option(args, "--call-gas")) callGas = BigInt(option(args, "--call-gas")!);
  // EIP-8037 state gas for whatever new storage the call writes: 97,920 per new slot. Unused
  // state gas is not charged, but the fee covers it.
  const callStateGas = BigInt(option(args, "--call-state-gas") ?? "200000");
  const calls = [{ to: BigInt(to), data, value: callValue, gas: callGas, stateGas: callStateGas }];

  const domain = protocol.domainScalar(chainId, pool, epoch);
  const source = protocol.sourceId(pool, epoch);
  const ref = frametx.recentRootRefOf(protocol.recentRootTuple(source, BigInt(pub.slot), BigInt(pub.root)));
  const input = { sk: BigInt(note.sk), rho: BigInt(note.rho), value: BigInt(note.value), idx: BigInt(note.index) };
  const dummy = replace
    ? { sk: BigInt(previous!.dummySk), rho: BigInt(previous!.dummyRho), value: 0n, idx: null }
    : walletLib.dummyInput(random.secureRng);
  const [changeSk, changeRho] = replace
    ? [BigInt(previous!.changeSk), BigInt(previous!.changeRho)]
    : walletLib.newNote(random.secureRng);
  const notesBytes = crypto.getRandomValues(new Uint8Array(96));
  const refund = !args.includes("--no-refund");
  // The refund inner's placeholder is a full word, like the real one.
  const placeholderInner = refund ? protocol.P - 5n : undefined;

  // The fee is the transaction's maximum cost, which depends a little on the fee's own bytes,
  // so size it against a placeholder statement first.
  const placeholder = (fee: bigint) => {
    const spend = { root: BigInt(pub.root), rootSlot: BigInt(pub.slot), epoch, domain, nf1: protocol.P - 3n, nf2: protocol.P - 4n,
      outCm1: protocol.P - 1n, outCm2: protocol.P - 2n, publicAmount: 0n, fee, recipient: 0n, authorizer: sender };
    const tx = buildTx({ chainId, pool, sender, nonce, shape, calls, proof: new Uint8Array(288).fill(0xff),
      settle: settleData(spend, notesBytes, placeholderInner), ref, tip, maxFee, refund });
    tx.signatures = [{ scheme: SCHEME.SECP256K1, signer: sender, msg: new Uint8Array(0), signature: new Uint8Array(65).fill(0xff) }];
    return frametx.maxCost(tx);
  };
  let fee = placeholder(2n ** 100n);
  // One percent over, for the nonzero bytes the real statement may have where the placeholder has none.
  fee = (placeholder(fee) * 101n) / 100n;
  const value = BigInt(note.value);
  if (fee > value) throw new Error(`note ${index} holds ${eth(value)} ETH, the gas can cost up to ${eth(fee)} ETH`);
  const change = value - fee;
  const outputs = change > 0n
    ? [[protocol.inner(changeSk, changeRho), change], protocol.sinkOutputs()[1]]
    : protocol.sinkOutputs();

  const terms = { authorizer: sender, fee };
  const witness = walletLib.buildWitness(tree, [input, dummy], outputs, domain, terms);
  log(`proving the spend of note ${index} (${eth(value)} ETH, gas fee up to ${eth(fee)} ETH) for sender ${frametx.checksumAddress(sender)}`);
  const prover = await mod("prover.ts");
  const spendLib = await mod("spend.ts");
  const started = Date.now();
  const { publics, proof } = await prover.prove(witness, "the sponsored spend");
  await prover.terminate();
  log(`  proved in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const words = (p: any) => ({
    pA: p.pA.map(BigInt), pB: p.pB.map((r: string[]) => r.map(BigInt)), pC: p.pC.map(BigInt),
  });
  const proofData = protocol.proofBytes(words(proof), publics[0]);
  const [nf1, nf2] = protocol.inputNullifiers(domain, [input, dummy]);
  const [outCm1, outCm2] = protocol.outputCommitments(outputs);
  const [refundSk, refundRho] = refundOpening(input.sk, nf1);
  const refundInner = refund ? protocol.inner(refundSk, refundRho) : undefined;
  const spend = { root: BigInt(pub.root), rootSlot: BigInt(pub.slot), epoch, domain, nf1, nf2, outCm1, outCm2,
    publicAmount: 0n, fee, recipient: 0n, authorizer: sender };

  const tx = buildTx({ chainId, pool, sender, nonce, shape, calls, proof: proofData,
    settle: settleData(spend, notesBytes, refundInner), ref, tip, maxFee, refund });
  // --attack NAME: change the transaction the way an attacker would, then only simulate it.
  // The pool must refuse each one in its validation frames, before it pays.
  const attack = option(args, "--attack");
  let signKey = senderKey;
  if (attack !== undefined) {
    const lastFrame = tx.frames[tx.frames.length - 1];
    const callFrame = tx.frames[tx.frames.length - 2];
    if (attack === "lift") {
      // Someone else copies the proof and statement into a transaction of their own.
      [signKey] = walletLib.newAuthorizer(random.secureRng);
      tx.sender = frametx.addressOf(signKey);
    } else if (attack === "no-settle") tx.frames.pop();
    else if (attack === "settle-gas") lastFrame.gasLimit = 100_000n;
    else if (attack === "atomic") callFrame.flags = frametx.ATOMIC_BATCH;
    else if (attack === "fee") tx.maxFee *= 3n;
    else if (attack === "pool-call") {
      // A second pool frame in the middle: a DEFAULT call to settleSponsored before the end.
      tx.frames.splice(tx.frames.length - 1, 0, { ...lastFrame });
    } else if (attack === "refund-inner") {
      // A refund inner that is no field element: settlement's Poseidon call would fail after payment.
      if (!refund) throw new Error("--attack refund-inner needs refund mode");
      lastFrame.data = concat(lastFrame.data.slice(0, lastFrame.data.length - 32), word(protocol.P));
    } else if (attack === "pay-scope") {
      // Ask the pool to approve execution too, so later frames would run as the pool.
      const pay = tx.frames[shape === "preverify" ? 2 : 1];
      pay.flags = APPROVE.EXECUTION_AND_PAYMENT;
    } else throw new Error(`unknown --attack ${attack}`);
    args.push("--force");
    // --send-attack: hand it to the sidecar anyway, to see the mempool refuse it.
    if (!args.includes("--send-attack")) dryRun = true;
  }
  spendLib.signTransaction(tx, signKey);
  if (attack === undefined && frametx.maxCost(tx) > fee) throw new Error("internal: the fee is below the maximum cost");
  const raw = toHex(frametx.rawTx(tx));
  const nfSlot = (nf: bigint) => toHex(keccak(concat(word(nf), word(26n))));
  log(`  shape ${shape}: ${tx.frames.length} frames, nullifier slots ${nfSlot(nf1)} ${nfSlot(nf2)}`);

  const sim = await rpc("ethrex_simulateFrameTransaction", [raw, "latest", { trace: true }]).catch((e: Error) => {
    log(`  simulate: ${e.message}`);
    return null;
  });
  if (sim) {
    const frames = (sim.frames ?? []).map((f: any, i: number) =>
      `${i}:${f.succeeded ? "ok" : "FAIL"}/${BigInt(f.gasUsed ?? 0).toLocaleString("en-US")}`);
    log(`  simulated: payer ${sim.payer}, frames ${frames.join(" ")}, ${sim.executionError ?? "no execution error"}`);
    log(`  ethrex's own canonical mempool: ${sim.canonicalMempoolValid ? "would admit" : `would refuse (${sim.canonicalMempoolViolation})`}`);
    if (sim.failure) log(`  failure: ${JSON.stringify(sim.failure)}`);
    if (process.env.SIM_DUMP) writeFileSync(process.env.SIM_DUMP, JSON.stringify(sim, null, 1));
    const ok = (sim.frames ?? []).length === tx.frames.length && sim.frames.every((f: any) => f.succeeded);
    if (!ok && !args.includes("--force")) throw new Error("a frame fails in simulation; not sending (pass --force to send anyway)");
  }
  if (dryRun) {
    log("  dry run: not sent");
    return;
  }
  let hash: string;
  if (via === "sidecar") hash = await rpc("eth_sendFrameTransaction", [frameTxDto(tx)], SIDECAR);
  else if (via === "privileged") {
    // --hold-blocks N: ethrex holds it back N blocks (its targetBlock), to test replacement.
    const hold = option(args, "--hold-blocks");
    const target = hold ? [hex(BigInt(await rpc("eth_blockNumber")) + BigInt(hold))] : [];
    await rpc("ethrex_submitPrivilegedFrameTransaction", [raw, ...target]);
    hash = toHex(keccak(frametx.rawTx(tx)));
  } else hash = await rpc("eth_sendRawTransaction", [raw]);
  log(`  sent via ${via}: ${hash}`);
  if (attack !== undefined) {
    log("  an attack was admitted; the note's saved state is left as it was");
    return;
  }
  const replaced = note.pending;
  note.pending = hash;
  note.pendingSpend = {
    dummySk: hex(dummy.sk), dummyRho: hex(dummy.rho), changeSk: hex(changeSk), changeRho: hex(changeRho),
    tip: tip.toString(), maxFee: maxFee.toString(),
  };
  if (replaced) w.notes = w.notes.filter((n) => n.from !== replaced && n.refundOf !== replaced);
  // The change note's opening is saved before waiting, so a crash or --no-wait never loses it;
  // sync() fills in its leaf once the transaction is mined.
  if (change > 0n) {
    w.notes.push({ sk: hex(changeSk), rho: hex(changeRho), value: change.toString(), epoch: epoch.toString(),
      index: "?", cm: hex(outCm1), from: hash });
  }
  if (refund) {
    w.notes.push({ sk: hex(refundSk), rho: hex(refundRho), value: "0", epoch: epoch.toString(),
      index: "?", cm: "?", refundOf: hash });
  }
  save(w);
  if (args.includes("--no-wait")) return;
  const rec = await receipt(hash, "the sponsored transaction");
  const frameReceipts = rec.frameReceipts ?? [];
  const statuses = frameReceipts.map((f: any) => f.status).join(",");
  log(`  mined in block ${BigInt(rec.blockNumber)}: status ${rec.status}, payer ${rec.payer ?? "?"}, gas ${BigInt(rec.gasUsed).toLocaleString("en-US")}, frames [${statuses}]`);
  const spentNow = await storageWord(pool, BigInt(nfSlot(nf1)));
  log(`  nullifier marked spent: ${spentNow === 1n}`);
  await sync(w);
  const made = w.notes.findIndex((n) => n.from === hash);
  if (made >= 0) log(`  change ${eth(change)} ETH is note ${made} (leaf ${w.notes[made].index})`);
  // What the pool was charged and what came back.
  const price = BigInt(rec.effectiveGasPrice ?? "0x0");
  const charged = BigInt(rec.gasUsed) * price;
  log(`  fee ${eth(fee)} ETH, charged ${eth(charged)} ETH (${BigInt(rec.gasUsed).toLocaleString("en-US")} gas at ${Number(price) / 1e9} gwei), overpaid ${eth(fee - charged)} ETH`);
  const r = refundLog(rec, pool);
  if (r) {
    const got = w.notes.findIndex((n) => n.refundOf === hash);
    log(`  refund ${eth(r.value)} ETH is note ${got} (leaf ${got >= 0 ? w.notes[got].index : "?"}); the pool keeps ${eth(fee - charged - r.value)} ETH; ` +
      `priced at ${r.chargedGas.toLocaleString("en-US")} gas, ${(r.chargedGas - BigInt(rec.gasUsed)).toLocaleString("en-US")} over the real charge`);
    if (r.chargedGas < BigInt(rec.gasUsed)) log("  WARNING: the refund was priced below the real charge, so the pool lost ETH");
  } else if (refund) log("  no refund (the fee did not cover the reserve)");
}

/** The pool's RefundNote log in a receipt: (cm, value, chargedGas). */
function refundLog(rec: any, pool: bigint) {
  const l = rec?.logs?.find((l: any) => BigInt(l.address) === pool && l.topics?.[0]?.toLowerCase() === toHex(REFUND_NOTE_TOPIC));
  if (!l) return undefined;
  const d = fromHex(l.data, "RefundNote data");
  return { cm: BigInt(l.topics[1]), value: toBigint(d.slice(0, 32)), chargedGas: toBigint(d.slice(32, 64)) };
}

/** Settles what earlier sends left pending: spent inputs, and change notes' leaves. */
async function sync(w: Wallet) {
  const pool = BigInt(w.pool);
  for (const n of w.notes) {
    if (n.pending) {
      const rec = await rpc("eth_getTransactionReceipt", [n.pending]);
      if (rec && rec.status === "0x1") {
        n.spent = n.pending;
        delete n.pending;
        delete n.pendingSpend;
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
          n.cm = hex(cm);
          n.index = leaf.index.toString();
          n.epoch = leaf.epoch.toString();
        } else n.spent = "nothing (no refund was made)"; // mined without one: nothing to spend
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
  save(w);
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "shield") await shield(rest[0] ?? "0.2");
  else if (cmd === "publish") await publish();
  else if (cmd === "send") await send(rest);
  else if (cmd === "notes") await notes();
  else if (cmd === "unpend") {
    // A pending spend that was dropped (never mined): make the note spendable again.
    const w = load();
    const n = w.notes[Number(rest[0])];
    if (!n?.pending) throw new Error(`note ${rest[0]} is not pending`);
    const rec = await rpc("eth_getTransactionReceipt", [n.pending]);
    if (rec) throw new Error(`${n.pending} was mined; run notes`);
    w.notes = w.notes.filter((m) => m.from !== n.pending && m.refundOf !== n.pending);
    delete n.pending;
    delete n.pendingSpend;
    save(w);
    log(`note ${rest[0]} is spendable again`);
  }
  else {
    console.error("usage: node privacy-pool/client.ts shield ETH | publish | send --to ADDR --data HEX [--shape last|preverify] [--replace] | notes | unpend N");
    process.exit(2);
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
