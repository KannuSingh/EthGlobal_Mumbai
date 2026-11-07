// The frame transaction breakdown: what each EIP-8141 frame does, and its data decoded by name.
// The wallet shows it before you confirm (the planned frames) and in History (the mined ones,
// with each frame's status and gas). Only the wallet decodes: a site just sees its transaction.
import { showHidden } from "./text.js";
import { nameOf } from "./names.js";

export const MODES = { 0: "DEFAULT", 1: "VERIFY", 2: "SENDER" };

// The privacy pool's entry points.
const SETTLE = "0xf25d18a7"; // settleSponsored((bytes32,uint64,uint64,bytes32,bytes32,bytes32,bytes32,bytes32,uint256,uint256,address,address))
const PRE_VERIFY = "0xdce1336f"; // preVerify()
const PAY_PRE_VERIFIED = "0x484f83b5"; // payPreVerified()
const POOL_SETTLE = "0x921fcac7"; // settle(Spend), the pool-as-sender settle
const CLAIM = "0xa3066aab"; // claimWithdrawal(address)

/** Calls the wallet can name. Anything else shows its selector and 32-byte words. */
const KNOWN = {
  "0x8ee93cf3": { sig: "post(string text)", args: [["text", "string"]] },
  "0x8e9b33ea": { sig: "thread(string text)", args: [["text", "string"]] },
  "0xd94c783a": { sig: "reply(uint256 parent, string text)", args: [["parent", "uint256"], ["text", "string"]] },
  "0xe82935da": { sig: "like(uint256 id)", args: [["id", "uint256"]] },
  "0xd85d3d27": { sig: "mint(string note)", args: [["note", "string"]] },
  "0xa9059cbb": { sig: "transfer(address to, uint256 amount)", args: [["to", "address"], ["amount", "uint256"]] },
  "0x095ea7b3": { sig: "approve(address spender, uint256 amount)", args: [["spender", "address"], ["amount", "uint256"]] },
  "0x23b872dd": { sig: "transferFrom(address from, address to, uint256 id)", args: [["from", "address"], ["to", "address"], ["id", "uint256"]] },
  "0xa22cb465": { sig: "setApprovalForAll(address operator, bool approved)", args: [["operator", "address"], ["approved", "bool"]] },
};

const SPEND = [
  ["root", "bytes32", "The pool's published root the proof is made against"],
  ["rootSlot", "uint64", "The slot that root was published in"],
  ["epoch", "uint64", "The pool's epoch"],
  ["domain", "bytes32", "Binds the proof to this chain, pool and epoch"],
  ["nf1", "bytes32", "Nullifier of the first note spent: marks it spent without saying which note it was"],
  ["nf2", "bytes32", "Nullifier of the second note spent, or of a dummy when one note is enough"],
  ["outCm1", "bytes32", "First new note: your change, or the payee's note in a private transfer (hides owner and value)"],
  ["outCm2", "bytes32", "Second new note: your change after a transfer, or an unused placeholder"],
  ["publicAmount", "uint256", "ETH leaving the pool in the open: a withdrawal's amount, else 0"],
  ["fee", "uint256", "The most gas this transaction may cost, paid by the pool"],
  ["recipient", "address", "Who gets a withdrawal, else 0"],
  ["authorizer", "address", "The key the proof is bound to: the sending account, or a one-time key that signs when the pool sends"],
];

const el = (tag, cls = "", text = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** EIP-8141's expiry verifier predeploy. */
export const EXPIRY = "0x0000000000000000000000000000000000008141";
/** The deadline (unix seconds) in an expiry frame's 8 bytes of data. */
export const deadlineOf = (f) => Number(BigInt("0x" + (f.data ?? "0x").slice(2, 18).padStart(16, "0")));
/** A time of day, and how far off it is. */
export const untilText = (t) => {
  const left = t - Math.floor(Date.now() / 1000);
  const at = new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return left > 0 ? `${at} (in ${left >= 120 ? `${Math.round(left / 60)} min` : `${left} s`})` : `${at} (passed)`;
};
const isAtomic = (f) => (Number(f.flags ?? 0) & 4) !== 0;
const lower = (a) => (a ?? "").toLowerCase();
const wordAt = (hex, i) => hex.slice(i * 64, i * 64 + 64);
const ethOf = (v) => (Number(v / 10n ** 9n) / 1e9).toFixed(9).replace(/\.?0+$/, "");

/** A string at a head word inside ABI-encoded hex (no 0x). */
export function abiString(hex, headWord) {
  try {
    const off = Number(BigInt("0x" + wordAt(hex, headWord))) * 2;
    const len = Number(BigInt("0x" + hex.slice(off, off + 64)));
    const body = hex.slice(off + 64, off + 64 + len * 2);
    return new TextDecoder().decode(new Uint8Array(body.match(/../g)?.map((b) => parseInt(b, 16)) ?? []));
  } catch {
    return "";
  }
}

function fmt(type, w, sender) {
  const v = BigInt("0x" + (w || "0"));
  if (type === "address") {
    if (v === 0n) return "none (zero address)";
    const a = "0x" + w.slice(24);
    return a === lower(sender) ? `${a} (${nameOf(a)}, the sender)` : a;
  }
  if (type === "bool") return v ? "true" : "false";
  if (type === "uint64") return v.toString();
  if (type === "uint256") return v === 0n ? "0" : v < 10n ** 12n ? v.toString() : `${v} wei (${ethOf(v)} ETH)`;
  return "0x" + w;
}
const field = (name, type, value, note = "") => ({ name, type, value, note });

/**
 * A frame in words: { mode, title, what }. `o` has sender and pool, and optionally
 * call(f, me) to name a SENDER frame.
 */
export function describe(f, i, frames, o) {
  const mode = MODES[Number(f.mode)] ?? `mode ${f.mode}`;
  const sender = lower(o.sender);
  const pool = lower(o.pool);
  const me = o.sender ? nameOf(o.sender) : "Your account";
  const to = lower(f.to) || sender;
  const isPool = to === pool;
  const laterPoolVerify = frames.slice(i + 1).some((g) => MODES[Number(g.mode)] === "VERIFY" && lower(g.to) === pool);
  if (mode === "VERIFY" && to === EXPIRY)
    return { mode, title: "Expiry", what: `Valid until ${untilText(deadlineOf(f))}. After that the chain drops the transaction, so it can never be mined late.` };
  // A call in an atomic batch: it and the next call land together or not at all.
  const batched = mode === "SENDER" && (isAtomic(f) || (i > 0 && isAtomic(frames[i - 1])));
  const all = batched ? " All or nothing: if any call in the batch fails, none of them happen." : "";
  if (sender && sender === pool) {
    // The pool is the sender (withdrawals and private transfers): no account of the user's.
    if (mode === "VERIFY" && isPool)
      return { mode, title: "Privacy pool checks the proof", what: "Checks a zero-knowledge proof that you own the notes it spends, and that their nullifiers are this transaction's nonce keys. Then the pool approves itself as the sender and pays the gas." };
    if (mode === "SENDER" && isPool)
      return { mode, title: "Privacy pool settles", what: "Marks the notes spent, adds the new notes (the payee's and your change) and credits any withdrawal." };
    if (mode === "DEFAULT" && isPool && lower(f.data).startsWith(CLAIM))
      return { mode, title: "Privacy pool pays out", what: "Sends the withdrawn ETH to the address." };
  }
  if (mode === "VERIFY" && to === sender)
    return { mode, title: "Account check", what: `${me} approves the transaction with its signature. It holds no ETH.` };
  if (mode === "VERIFY" && isPool)
    return { mode, title: "Privacy pool pays", what: "Checks a zero-knowledge proof that you own an unspent note worth the fee, then agrees to pay the gas." };
  if (mode === "DEFAULT" && isPool && laterPoolVerify)
    return { mode, title: "Privacy pool pre-check", what: "Checks the proof and marks the note spent before it pays (pre_verify)." };
  if (mode === "DEFAULT" && isPool)
    return { mode, title: "Privacy pool settles", what: "Marks the note spent and adds your change and the unused gas as new private notes." };
  if (mode === "SENDER") {
    const own = o.call?.(f, me);
    if (own) return { mode, batched, ...own, what: own.what + all };
    const known = KNOWN[lower(f.data).slice(0, 10)];
    const name = known ? known.sig.split("(")[0] : "a contract";
    return { mode, batched, title: known ? `Call ${name}` : `Call ${short(to)}`, what: `Runs as ${me} and calls ${name} on ${short(to)}.${all}` };
  }
  return { mode, title: `${mode} frame`, what: `Target ${short(to)}` };
}

/** What a frame's bytes say: { bytes, call, fields, raw }. tx (optional) gives the signatures. */
export function decode(f, d, tx, sender) {
  const data = lower(f.data || "0x");
  const body = data.slice(2);
  const sel = data.slice(0, 10);
  const out = { bytes: body.length / 2, call: "", fields: [], raw: data };
  if (d.title === "Expiry") {
    out.call = "No selector: the 8-byte deadline, read by the expiry verifier (0x…8141)";
    out.fields = [field("deadline", "uint64", `${deadlineOf(f)} (${untilText(deadlineOf(f))})`, "Unix seconds; the frame fails after this")];
    return out;
  }
  if (d.title === "Account check") {
    out.call = "No calldata: the account's signature sits in the transaction's signature list";
    const sig = tx?.signatures?.[0];
    if (sig) out.fields.push(
      field("scheme", "uint8", `${Number(sig.scheme)} (secp256k1)`, "The signature scheme"),
      field("signer", "address", `${sig.signer} (${nameOf(sig.signer)})`, "Who signed"),
      field("signature", "bytes", sig.signature, "65 bytes over the transaction's signing hash"),
    );
    return out;
  }
  const proofFields = (hex) => [
    ...["pA.x", "pA.y", "pB.x.c0", "pB.x.c1", "pB.y.c0", "pB.y.c1", "pC.x", "pC.y"].map((n, i) =>
      field(n, "uint256", "0x" + wordAt(hex, i), i === 0 ? "Groth16 proof points on BN254 (8 words)" : "")),
    field("beta", "uint256", "0x" + wordAt(hex, 8), "Public signal; the pool rebuilds the others from the settle frame"),
  ];
  if (sel === PAY_PRE_VERIFIED) { out.call = "payPreVerified()"; return out; }
  if (sel === PRE_VERIFY) { out.call = "preVerify() + proof (288 bytes)"; out.fields = proofFields(body.slice(8)); return out; }
  if (d.mode === "VERIFY" && out.bytes === 288) {
    out.call = "No selector: the proof (288 bytes), read by the pool's VERIFY entry";
    out.fields = proofFields(body);
    return out;
  }
  if (sel === SETTLE) {
    const b = body.slice(8);
    out.call = "settleSponsored(Spend) + note data + refund key";
    out.fields = SPEND.map(([n, t, note], i) => field(n, t, fmt(t, wordAt(b, i), sender), note));
    out.fields.push(
      field("notes", "bytes96", "0x" + b.slice(12 * 64, 12 * 64 + 192), "Data stored with the change note (random here)"),
      field("refundInner", "bytes32", "0x" + wordAt(b, 15), "Hidden key of the refund note for the unused gas"),
    );
    return out;
  }
  if (sel === POOL_SETTLE) {
    const b = body.slice(8);
    const notes = b.slice(12 * 64);
    out.call = notes.length === 1184 * 2 ? "settle(Spend) + private transfer slot + payee note + change note" : "settle(Spend) + note data";
    out.fields = SPEND.map(([n, t, note], i) => field(n, t, fmt(t, wordAt(b, i), sender), note));
    if (notes.length === 1184 * 2) {
      out.fields.push(
        field("slot", "bytes1088", "0x" + notes.slice(0, 2176), "Starts with a one-time public key; only the payee's view key opens the note"),
        field("payee note", "bytes48", "0x" + notes.slice(2176, 2272), "Tag, the hidden amount and a check, for the payee"),
        field("change note", "bytes48", "0x" + notes.slice(2272), "Random here"),
      );
    } else out.fields.push(field("notes", "bytes96", "0x" + notes, "Data stored with the new notes (random here)"));
    return out;
  }
  if (sel === CLAIM) {
    out.call = "claimWithdrawal(address who)";
    out.fields = [field("who", "address", fmt("address", wordAt(body.slice(8), 0), sender), "Gets the ETH the settle frame credited")];
    return out;
  }
  const known = KNOWN[sel];
  if (known) {
    const b = body.slice(8);
    out.call = known.sig;
    out.fields = known.args.map(([n, t], i) =>
      field(n, t, t === "string" ? showHidden(JSON.stringify(abiString(b, i))) : fmt(t, wordAt(b, i), sender)));
    return out;
  }
  out.call = body ? `selector ${sel} (unknown call: raw words below)` : "No calldata";
  return out;
}

// ---- Etherscan-style views ---------------------------------------------------------------------

const FLAGS = { 0: "none", 1: "approves payment", 2: "approves execution", 3: "approves execution and payment", 4: "atomic batch with the next frame" };
const num = (v) => BigInt(v ?? 0).toLocaleString("en-US");
const gwei = (v) => `${(Number(BigInt(v ?? 0)) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 })} gwei`;

const ICON = (d) => `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const COPY = ICON('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>');
const CHECK = ICON('<path d="M20 6 9 17l-5-5"/>');

/** Copies `text` when `b` is pressed; the icon in `ic` turns to a tick for a moment. */
function copyOnClick(b, ic, text) {
  b.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    ic.innerHTML = CHECK; // fixed markup only
    setTimeout(() => (ic.innerHTML = COPY), 1200);
  };
}

/** A copy icon on its own, for a long value shown in full (the original data). */
function copyBtn(text) {
  const b = el("button", "copy-ic");
  b.type = "button";
  b.title = "Copy";
  b.setAttribute("aria-label", "Copy");
  b.innerHTML = COPY; // fixed markup only
  copyOnClick(b, b, text);
  return b;
}

/** A long 0x value shown as 0x1234…4321, with a copy icon: tap it to copy the whole value. */
export function hexChip(v) {
  const b = el("button", "hex");
  b.type = "button";
  b.title = `${v}\nTap to copy`;
  b.dataset.value = v;
  const ic = el("span", "hex-ic");
  ic.innerHTML = COPY; // fixed markup only
  b.append(el("code", "", v.length > 14 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v), ic);
  copyOnClick(b, ic, v);
  return b;
}

/** Text with each long 0x value in it turned into a chip. */
function withHex(s, cls = "") {
  const box = el("span", cls);
  for (const part of String(s).split(/(0x[0-9a-fA-F]{12,})/)) {
    if (!part) continue;
    box.append(/^0x[0-9a-fA-F]{12,}$/.test(part) ? hexChip(part) : document.createTextNode(part));
  }
  return box;
}

/** Key/value rows like a block explorer's: [label, value, { mono, copy, note }]. */
function kvTable(rows) {
  const t = el("div", "kvt");
  for (const [k, v, opt = {}] of rows) {
    if (v === undefined || v === null) continue;
    const r = el("div", "kvt-row");
    r.append(el("div", "kvt-k", k));
    const cell = el("div", "kvt-v");
    if (v instanceof Node) cell.append(v);
    else cell.append(withHex(String(v), opt.mono ? "mono" : ""));
    if (opt.note) cell.append(el("div", "kvt-note", opt.note));
    r.append(cell);
    t.append(r);
  }
  return t;
}

/** The data box with three views, like an explorer's "View input as": Decoded, Original, Words. */
export function dataBox(x, label = "Frame data") {
  const box = el("details", "data");
  box.append(el("summary", "", `${label} · ${x.bytes.toLocaleString("en-US")} bytes`));
  const tabs = el("div", "data-tabs");
  const panes = {};
  const hex = x.raw.slice(2);
  const sel = hex.length % 64 === 8 ? hex.slice(0, 8) : "";

  const decoded = el("div", "pane");
  decoded.append(el("div", "call", x.call));
  if (x.fields.length) {
    const t = el("div", "fields");
    x.fields.forEach((f, i) => {
      const r = el("div", "field");
      const k = el("div", "k");
      k.append(el("span", "idx", String(i)), el("b", "", f.name), el("span", "", ` ${f.type}`));
      r.append(k, withHex(f.value, "v mono"));
      if (f.note) r.append(el("div", "note", f.note));
      t.append(r);
    });
    decoded.append(t);
  }
  panes.Decoded = decoded;

  if (x.bytes) {
    const original = el("div", "pane");
    const pre = el("pre", "wrap");
    pre.textContent = x.raw;
    original.append(pre, copyBtn(x.raw));
    panes.Original = original;

    const wordsPane = el("div", "pane");
    const rows = (hex.slice(sel.length).match(/.{1,64}/g) ?? []).map((w, i) => `[${String(i).padStart(2, "0")}]  ${w}`);
    const pre2 = el("pre");
    pre2.textContent = [sel && `MethodID: 0x${sel}`, ...rows].filter(Boolean).join("\n");
    wordsPane.append(pre2);
    panes.Words = wordsPane;
  }

  const names = Object.keys(panes);
  const pick = (name) => {
    for (const n of names) panes[n].hidden = n !== name;
    for (const b of tabs.children) b.classList.toggle("on", b.dataset.tab === name);
  };
  if (names.length > 1) {
    for (const n of names) {
      const b = el("button", "tab", n);
      b.type = "button";
      b.dataset.tab = n;
      b.onclick = (e) => { e.preventDefault(); pick(n); };
      tabs.append(b);
    }
    box.append(tabs);
  }
  for (const n of names) box.append(panes[n]);
  pick("Decoded");
  return box;
}

/**
 * The frames, each with its fields (mode, flags, target, limits, value; status and gas once mined)
 * and its data. frames as eth_getTransactionByHash returns them, or a plan with mode/to/data;
 * results = receipt.frameReceipts when mined. o: { sender, pool, tx }.
 */
export function frameList(frames, results, o) {
  const ol = el("ol", "fx");
  frames.forEach((f, i) => {
    const d = describe(f, i, frames, o);
    const r = results?.[i];
    const li = el("li", `fx-frame${r ? (r.status === "0x1" ? " ok" : " bad") : ""}`);
    li.append(el("div", "fx-node", r ? (r.status === "0x1" ? "✓" : "✕") : String(i + 1)));
    const body = el("div", "fx-body");
    const row = el("div", "fx-row");
    row.append(el("span", "fx-title", `${i}. ${d.title}`), el("span", `fx-mode ${d.mode}`, d.mode));
    body.append(row, el("div", "fx-what", d.what));
    const mined = f.gasLimit !== undefined;
    if (mined || r) {
      const target = f.to ? `${f.to}${lower(f.to) === lower(o.pool) ? " (privacy pool)" : lower(f.to) === lower(o.sender) ? ` (${nameOf(f.to)})` : ""}` : `null (the sender, ${o.sender ? nameOf(o.sender) : "?"})`;
      const det = el("details", "fx-fields");
      det.append(el("summary", "", "Frame fields"));
      det.append(kvTable([
        ["Mode", `${Number(f.mode)} (${d.mode})`],
        ["Flags", f.flags !== undefined ? `${f.flags} (${FLAGS[Number(f.flags)] ?? "?"})` : undefined],
        ["Target", target, { mono: true }],
        ["Gas limit", f.gasLimit !== undefined ? num(f.gasLimit) : undefined],
        ["State gas limit", f.stateLimit !== undefined ? num(f.stateLimit) : undefined],
        ["Value", f.value !== undefined ? `${BigInt(f.value)} wei` : undefined],
        ["Status", r ? (r.status === "0x1" ? "Success" : "Failed") : undefined],
        ["Gas used", r ? num(r.gasUsed) : undefined],
        ["State gas used", r ? num(r.stateGasUsed) : undefined],
        ["Logs", r?.logs ? String(r.logs.length) : undefined],
      ]));
      body.append(det);
    }
    if (r) {
      const exec = BigInt(r.gasUsed ?? 0), state = BigInt(r.stateGasUsed ?? 0);
      const limit = f.gasLimit ? ` of ${num(f.gasLimit)}` : "";
      body.append(el("div", "fx-gas", `${exec.toLocaleString("en-US")} gas${limit}${state ? ` + ${state.toLocaleString("en-US")} storage` : ""}`));
    }
    if (f.data !== undefined) body.append(dataBox(decode(f, d, o.tx, o.sender)));
    else body.append(el("div", "fx-later", d.mode === "VERIFY" && d.title !== "Account check" ? "The private proof is being made." : d.title === "Account check" ? "Being signed." : "Filled in once the proof is made."));
    li.append(body);
    ol.append(li);
  });
  return ol;
}

/** The transaction's overview, like an explorer's top section. o: { pool }. */
export function txOverview(tx, rec, o) {
  const keys = (tx.nonceKeys ?? []).map((k) => BigInt(k).toString());
  const cost = rec ? BigInt(rec.gasUsed) * BigInt(rec.effectiveGasPrice ?? 0) : null;
  const payer = rec?.payer ? `${rec.payer}${lower(rec.payer) === lower(o.pool) ? " (privacy pool)" : ""}` : undefined;
  const refs = (tx.recentRootReferences ?? []).map((r, i) => {
    const t = kvTable([
      ["Source ID", r.sourceId, { mono: true }],
      ["Slot", BigInt(r.slot).toString()],
      ["Root", r.root, { mono: true }],
    ]);
    t.prepend(el("div", "kvt-sub", `Reference ${i}`));
    return t;
  });
  const refsBox = refs.length ? (() => { const d = el("div", ""); d.append(...refs); return d; })() : undefined;
  const sigs = (tx.signatures ?? []).map((s, i) => {
    const t = kvTable([
      ["Scheme", `${Number(s.scheme)} (${Number(s.scheme) === 1 ? "secp256k1" : "?"})`],
      ["Signer", `${s.signer} (${nameOf(s.signer)})`, { mono: true }],
      ["Message", s.msg === "0x" ? "empty (signs the transaction's signing hash)" : s.msg, { mono: s.msg !== "0x" }],
      ["Signature", s.signature, { mono: true }],
    ]);
    t.prepend(el("div", "kvt-sub", `Signature ${i}`));
    return t;
  });
  const sigBox = sigs.length ? (() => { const d = el("div", ""); d.append(...sigs); return d; })() : undefined;
  return kvTable([
    // Not sent yet: no hash or status to show.
    ["Transaction hash", o.unsent ? undefined : tx.hash, { mono: true }],
    ["Status", o.unsent ? undefined : rec ? (rec.status === "0x1" ? "Success" : "Failed") : "Pending"],
    ["Block", rec ? `${BigInt(rec.blockNumber)}` : undefined],
    ["Type", `${Number(tx.type)} (EIP-8141 frame transaction)`],
    ["Chain ID", BigInt(tx.chainId ?? 0).toString()],
    ["Sender", `${tx.sender} (${nameOf(tx.sender)})`, { mono: true }],
    ["Nonce keys", keys.length ? `[${keys.join(", ")}]` : undefined, {
      note: keys.length === 1 && keys[0] === "0"
        ? "EIP-8250: key 0 alone is the account's own nonce on this chain's client (the current EIP draft writes this as [])"
        : "EIP-8250 keyed nonces: each key has its own sequence in the NONCE_MANAGER contract" }],
    ["Nonce sequence", tx.nonceSeq !== undefined ? BigInt(tx.nonceSeq).toString() : undefined, { note: "The sender's nonce under those keys" }],
    ["Payer", payer, { mono: true }],
    ["Frames", String(tx.frames?.length ?? 0)],
    ["Gas used", rec ? num(rec.gasUsed) : undefined],
    ["Max fee per gas", gwei(tx.maxFeePerGas)],
    ["Max priority fee", gwei(tx.maxPriorityFeePerGas)],
    ["Effective gas price", rec?.effectiveGasPrice ? gwei(rec.effectiveGasPrice) : undefined],
    ["Fee paid", cost !== null ? `${ethOf(cost)} ETH (from private funds)` : undefined],
    ["Recent roots", refsBox, { note: refs.length ? "Pool roots the proof uses, checked by the protocol (EIP-8272)" : undefined }],
    ["Signatures", sigBox],
  ]);
}

// ---- At a glance: a summary and one card per frame -------------------------------------------

const SVG = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const GLYPH = {
  sign: SVG('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>'),
  pay: SVG('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>'),
  run: SVG('<path d="m9 18 6-6-6-6"/><path d="M4 12h11"/>'),
  settle: SVG('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  out: SVG('<path d="M7 17 17 7"/><path d="M7 7h10v10"/>'),
};

/** What a frame does, in two or three words, and who it runs as. */
function role(f, d, o) {
  const pool = lower(o.pool), sender = lower(o.sender), to = lower(f.to) || sender;
  if (d.title === "Expiry") return { glyph: "sign", what: `until ${new Date(deadlineOf(f) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, who: "chain" };
  if (d.mode === "VERIFY") {
    const flags = f.flags !== undefined ? Number(f.flags) : to === pool ? (sender === pool ? 3 : 1) : 2;
    if (flags === 3) return { glyph: "sign", what: "approve + pay", who: "pool" };
    if (flags === 1) return { glyph: "pay", what: "pay gas", who: "payer" };
    return { glyph: "sign", what: "approve", who: "sender" };
  }
  if (d.mode === "SENDER" && to !== pool) {
    const known = KNOWN[lower(f.data).slice(0, 10)];
    return { glyph: "run", what: known ? known.sig.split("(")[0] : "call", who: d.batched ? "sender · batch" : "sender" };
  }
  if (lower(f.data).startsWith(CLAIM)) return { glyph: "out", what: "pay out", who: "pool" };
  return { glyph: "settle", what: d.title.includes("pre-check") ? "pre-check" : "settle", who: "pool" };
}

/**
 * The frames at a glance, like an explorer: a short summary (when tx is given), then a row of
 * cards, one per frame, with a tick when it ran. Tapping a card shows that frame's details;
 * the user's own call is open to start with.
 */
export function frameMap(frames, results, o) {
  const box = el("div", "fmap");
  const tx = o.tx;
  // o.summary: false leaves the summary out where the page already shows it (the send window).
  if (tx && o.summary !== false) {
    const rec = o.rec;
    const st = rec ? (rec.status === "0x1" ? ["ok", "On chain"] : ["bad", "Failed"]) : o.unsent ? ["wait", "Signed, not sent"] : ["wait", "Pending"];
    const status = el("span", "fm-status");
    status.append(el("i", `fm-dot ${st[0]}`), st[1]);
    const payer = rec?.payer ?? (lower(tx.sender) === lower(o.pool) ? tx.sender : o.pool);
    const who = (a) => { const s = el("span", "", ""); s.append(hexChip(a)); if (lower(a) === lower(o.pool)) s.append(" · pool"); return s; };
    const grid = el("div", "fm-sum");
    const rows = [
      ["Status", status],
      ["Sender", who(tx.sender)],
      ["Nonce", tx.nonceSeq !== undefined ? BigInt(tx.nonceSeq).toString() : undefined],
      ["Payer", payer ? who(payer) : undefined],
      ["Max fee", tx.maxFeePerGas !== undefined ? `${(Number(BigInt(tx.maxFeePerGas)) / 1e9).toLocaleString("en-US", { maximumSignificantDigits: 3 })} gwei` : undefined],
    ];
    for (const [k, v] of rows) if (v !== undefined && !(o.skip ?? []).includes(k)) grid.append(el("span", "fm-k", k), typeof v === "string" ? el("span", "", v) : v);
    box.append(grid);
  }
  const list = frameList(frames, results, o);
  const items = [...list.children];
  const cards = el("div", "fm-cards");
  const pick = (i) => {
    items.forEach((li, j) => (li.hidden = j !== i));
    [...cards.children].forEach((c, j) => c.classList.toggle("on", j === i));
  };
  frames.forEach((f, i) => {
    const d = describe(f, i, frames, o);
    const r = role(f, d, o);
    const res = results?.[i];
    const c = el("button", `fm-card ${d.mode}`);
    c.type = "button";
    c.title = d.title;
    const top = el("span", "fm-top");
    // The frame's type (VERIFY, SENDER or DEFAULT) where an icon used to be.
    top.append(el("b", "", `Frame ${i}`));
    if (d.batched) c.classList.add("batched");
    const tag = d.title === "Expiry" ? "EXPIRY" : d.mode;
    c.append(top, el("span", `fm-mode ${d.mode}${d.title === "Expiry" ? " EXPIRY" : ""}`, tag), el("span", "fm-what", r.what), el("span", "fm-who", r.who),
      el("span", `fm-tick ${res ? (res.status === "0x1" ? "ok" : "bad") : ""}`, res ? (res.status === "0x1" ? "✓" : "✕") : ""));
    c.onclick = () => pick(c.classList.contains("on") ? -1 : i);
    cards.append(c);
  });
  box.append(cards, list);
  // Details stay closed until a card is tapped.
  pick(o.open ?? -1);
  return box;
}
