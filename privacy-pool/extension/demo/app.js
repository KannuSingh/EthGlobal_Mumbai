// Framecaster: short posts on chain, through Nainokot Wallet (found over EIP-6963). Posts, threads,
// replies and likes go out with wallet_sendCalls (privacyPaymaster required): a thread is one
// batch, one call per post. The feed is read from the contract's logs. How a transaction ran is
// the wallet's to show (its History), not the site's.
import { avatarStyle, nameOf } from "./names.js";
import { cleanText } from "./text.js";

const $ = (id) => document.getElementById(id);
const { framecaster } = await (await fetch("config.json")).json();
const POSTED = "0x02eef88c2b1d82125b9081c6a23aee2204573adc2b3fc21e14872f5805c4b5ed"; // Posted(uint256,address,uint256,uint8,string)
const LIKED = "0x6790e8ded18c25977540ba89bbcefd83da7fbe624085856758cf343178c4d612"; // Liked(uint256,address)
const SEL = { post: "0x8ee93cf3", thread: "0x8e9b33ea", reply: "0xd94c783a", like: "0xe82935da" };
const MAX = 160;
const KIND = { POST: 0, REPLY: 1, THREAD: 2 };
const MAX_DEPTH = 3; // replies nest this deep, then continue flat
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const el = (tag, cls = "", text = "") => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
// What happened goes to the console only; the page itself shows posts, not plumbing.
const log = (text) => console.info(`[framecaster] ${text}`);
/** A short error under the composer, gone after a few seconds. */
let errTimer;
const showError = (text) => { $("error").textContent = text; $("error").hidden = false; clearTimeout(errTimer); errTimer = setTimeout(() => ($("error").hidden = true), 6000); };
const bytesOf = (s) => new TextEncoder().encode(s).length;
const nameFor = (a) => nameOf(a, location.origin);

// Only Nainokot Wallet, found by its EIP-6963 rdns, never another wallet such as MetaMask.
let provider;
window.addEventListener("eip6963:announceProvider", (e) => { if (e.detail.info.rdns === "xyz.nainokot.wallet") provider = e.detail.provider; });
window.dispatchEvent(new Event("eip6963:requestProvider"));
let account;
const rpc = (method, params = []) => provider.request({ method, params });

// --- ABI ------------------------------------------------------------------------------------
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
function abiTail(text) {
  const b = new TextEncoder().encode(text);
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return word(b.length) + hex.padEnd(64 * Math.ceil(b.length / 32), "0");
}
const call = {
  post: (text) => ({ to: framecaster, data: SEL.post + word(32) + abiTail(text) }),
  thread: (text) => ({ to: framecaster, data: SEL.thread + word(32) + abiTail(text) }),
  reply: (parent, text) => ({ to: framecaster, data: SEL.reply + word(parent) + word(64) + abiTail(text) }),
  like: (id) => ({ to: framecaster, data: SEL.like + word(id) }),
};
/** A string from log data, or "" when the data is malformed. */
function decodeString(hex, headWord) {
  try { return decodeRaw(hex, headWord); } catch { return ""; }
}
function decodeRaw(hex, headWord) {
  const off = Number(BigInt("0x" + hex.slice(headWord * 64, headWord * 64 + 64))) * 2;
  const len = Number(BigInt("0x" + hex.slice(off, off + 64)));
  const body = hex.slice(off + 64, off + 64 + len * 2);
  return new TextDecoder().decode(new Uint8Array(body.match(/../g)?.map((b) => parseInt(b, 16)) ?? []));
}

// --- Reading the feed -----------------------------------------------------------------------
/** Every post, with its thread parts, replies and likes, joined from the logs. */
async function readAll() {
  const [posted, liked] = await Promise.all([
    rpc("eth_getLogs", [{ address: framecaster, topics: [POSTED], fromBlock: "0x0", toBlock: "latest" }]),
    rpc("eth_getLogs", [{ address: framecaster, topics: [LIKED], fromBlock: "0x0", toBlock: "latest" }]),
  ]);
  const byId = new Map();
  const order = (l) => [BigInt(l.blockNumber), BigInt(l.logIndex)];
  posted.sort((a, b) => { const [x, y] = [order(a), order(b)]; return x[0] === y[0] ? Number(x[1] - y[1]) : Number(x[0] - y[0]); });
  let last = null; // the last post logged, to join thread parts to
  for (const l of posted) {
    const d = l.data.slice(2);
    const p = {
      id: BigInt(l.topics[1]), author: "0x" + l.topics[2].slice(26), parent: BigInt(l.topics[3]),
      kind: Number(BigInt("0x" + d.slice(0, 64))), text: cleanText(decodeString(d, 1)),
      tx: l.transactionHash, block: BigInt(l.blockNumber), likes: new Set(), replies: [], parts: [], root: null,
    };
    if (p.kind === KIND.THREAD) {
      // A thread part follows the post or part just before it, same author, same transaction.
      if (last && last.tx === p.tx && last.author === p.author && last.kind !== KIND.REPLY) {
        p.parent = last.id;
        p.root = last.root ?? last;
        p.root.parts.push(p);
      } else p.kind = KIND.POST; // a stray part reads as a post of its own
    }
    byId.set(p.id, p);
    last = p;
  }
  for (const p of byId.values()) {
    if (p.kind === KIND.REPLY) {
      const parent = byId.get(p.parent);
      if (parent) { parent.replies.push(p); p.to = parent; }
    }
  }
  for (const l of liked) byId.get(BigInt(l.topics[1]))?.likes.add("0x" + l.topics[2].slice(26).toLowerCase());
  return byId;
}

const blockTimes = new Map();
async function timeOf(block) {
  if (!blockTimes.has(block)) {
    blockTimes.set(block, rpc("eth_getBlockByNumber", ["0x" + block.toString(16), false]).then((b) => Number(BigInt(b.timestamp)) * 1000));
  }
  return blockTimes.get(block);
}
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// --- Rendering ------------------------------------------------------------------------------
let posts = new Map();
const open = new Set(); // posts whose comments are shown
let replyingTo = null; // the post a reply box is open under

const icon = {
  reply: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>',
  like: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>',
};

/** All replies under a post and its thread parts, at any depth. */
const countReplies = (p) => p.replies.reduce((n, r) => n + 1 + countReplies(r), 0);
const conversation = (root) => [root, ...root.parts];

function header(p) {
  const h = el("div", "post-head");
  const name = el("b", "name", nameFor(p.author));
  name.title = p.author;
  h.append(name);
  if (account && p.author.toLowerCase() === account.toLowerCase()) h.append(el("span", "you", "you"));
  const t = el("span", "muted time", "");
  timeOf(p.block).then((ms) => { t.textContent = `· ${ago(ms)}`; t.title = new Date(ms).toLocaleString(); });
  h.append(t);
  return h;
}

function actions(p, opts = {}) {
  const row = el("div", "post-actions");
  const replies = opts.count ?? p.replies.length;
  const r = el("button", "act reply-btn");
  r.innerHTML = icon.reply; // fixed markup only; counts and post text go in as text
  r.append(el("span", "", replies ? String(replies) : ""));
  r.title = opts.toggle ? (open.has(p.id) ? "Hide replies" : "Show replies and reply") : "Reply";
  r.onclick = () => {
    if (opts.toggle) { if (open.has(p.id)) open.delete(p.id); else open.add(p.id); }
    replyingTo = opts.toggle && !open.has(p.id) ? null : p.id;
    render();
  };
  const mine = account && p.likes.has(account.toLowerCase());
  const lk = el("button", `act like-btn${mine ? " on" : ""}`);
  lk.innerHTML = icon.like;
  lk.append(el("span", "", p.likes.size ? String(p.likes.size) : ""));
  lk.title = mine ? "You liked this" : "Like";
  lk.disabled = !!mine;
  lk.onclick = () => send([call.like(p.id)], `Like post #${p.id}`);
  row.append(r, lk);
  return row;
}

function replyBox(parent) {
  const box = el("div", "reply-box");
  const ta = el("textarea");
  ta.rows = 2;
  ta.placeholder = `Reply to ${nameFor(parent.author)}`;
  ta.setAttribute("aria-label", "Your reply");
  const foot = el("div", "reply-foot");
  const count = el("span", "part-count", `0/${MAX}`);
  const go = el("button", "btn primary small", "Reply");
  go.disabled = true;
  const check = () => {
    const n = bytesOf(cleanText(ta.value));
    count.textContent = `${n}/${MAX}`;
    count.classList.toggle("over", n > MAX);
    go.disabled = n === 0 || n > MAX;
  };
  ta.oninput = check;
  go.onclick = () => send([call.reply(parent.id, cleanText(ta.value))], `Reply to post #${parent.id}`);
  foot.append(count, go);
  box.append(ta, foot);
  setTimeout(() => ta.focus(), 0);
  return box;
}

/** A reply and, nested under it, its own replies. */
function replyNode(p, depth) {
  const li = el("li", "reply");
  li.dataset.id = String(p.id);
  const av = el("span", "avatar sm");
  av.style.background = avatarStyle(p.author);
  const body = el("div", "reply-body");
  const to = el("div", "muted small replying");
  to.append("Replying to ", el("span", "at", `@${nameFor(p.to.author)}`));
  body.append(header(p), to, el("p", "text", p.text), actions(p));
  if (replyingTo === p.id) body.append(replyBox(p));
  li.append(av, body);
  if (p.replies.length) {
    const kids = el("ol", depth < MAX_DEPTH ? "replies nested" : "replies flat");
    for (const r of p.replies) kids.append(replyNode(r, depth + 1));
    // Past the depth limit replies stop indenting, so deep chains stay readable on a phone.
    body.append(kids);
  }
  return li;
}

/** A post as a card: the post, its thread parts joined by a line, then the replies when open. */
function card(root) {
  const li = el("li", "card post");
  li.dataset.id = String(root.id);
  const parts = conversation(root);
  const total = countReplies(root) + root.parts.reduce((n, q) => n + countReplies(q), 0);
  parts.forEach((p, i) => {
    const row = el("div", `post-row${i < parts.length - 1 ? " threaded" : ""}`);
    row.dataset.id = String(p.id);
    const rail = el("div", "rail");
    const av = el("span", "avatar");
    av.style.background = avatarStyle(p.author);
    rail.append(av);
    const body = el("div", "post-body");
    body.append(header(p));
    if (parts.length > 1) body.append(el("span", "thread-n muted small", `${i + 1}/${parts.length}`));
    body.append(el("p", "text", p.text));
    // The first part's reply button opens the whole conversation; each part can be liked.
    body.append(actions(p, i === 0 ? { toggle: true, count: total } : {}));
    if (replyingTo === p.id && (i > 0 || open.has(root.id))) body.append(replyBox(p));
    row.append(rail, body);
    li.append(row);
  });
  if (open.has(root.id)) {
    const all = parts.flatMap((p) => p.replies).sort((a, b) => (a.id < b.id ? -1 : 1));
    const list = el("ol", "replies top");
    for (const r of all) list.append(replyNode(r, 1));
    if (!all.length) list.append(el("li", "muted small empty", "No replies yet."));
    li.append(list);
  }
  return li;
}

function render() {
  const roots = [...posts.values()].filter((p) => p.kind === KIND.POST).sort((a, b) => (a.id > b.id ? -1 : 1));
  const feed = $("feed");
  feed.replaceChildren(...roots.map(card));
  if (!roots.length) feed.append(el("li", "empty", "No posts yet."));
}

async function refresh() {
  if (!provider) return;
  try {
    posts = await readAll();
  } catch (e) {
    if (account) log(`Couldn't read the feed: ${e.message}`);
    return;
  }
  render();
}

// --- Composer -------------------------------------------------------------------------------
const partAreas = () => [...$("parts").querySelectorAll("textarea")];
function composerState() {
  // What is counted and sent is the cleaned text, the same as the feed will show.
  const texts = partAreas().map((t) => cleanText(t.value));
  let ok = !busy;
  for (const [i, t] of partAreas().entries()) {
    const n = bytesOf(texts[i]);
    const c = t.parentElement.querySelector(".part-count");
    c.textContent = n ? `${n}/${MAX}` : "";
    c.classList.toggle("over", n > MAX);
    if (!texts[i] || n > MAX) ok = false;
  }
  $("calls").disabled = !ok;
  $("add-part").disabled = texts.length >= 8 || !texts[texts.length - 1];
  $("calls").textContent = busy ? "Posting…" : texts.length > 1 ? `Post thread (${texts.length})` : "Post";
  return texts;
}
$("text").oninput = composerState;
$("add-part").onclick = () => {
  const part = el("div", "part");
  const ta = el("textarea");
  ta.rows = 2;
  ta.placeholder = "Add another post";
  ta.setAttribute("aria-label", `Thread post ${partAreas().length + 1}`);
  ta.oninput = composerState;
  const x = el("button", "part-x", "×");
  x.title = "Remove";
  x.onclick = () => { part.remove(); composerState(); };
  part.append(ta, el("span", "part-count", ""), x);
  $("parts").append(part);
  composerState();
  ta.focus();
};
function clearComposer() {
  for (const p of [...$("parts").children].slice(1)) p.remove();
  $("text").value = "";
  composerState();
}

// --- Account ---------------------------------------------------------------------------------
function showAccount() {
  const on = !!account;
  $("connect").hidden = on;
  $("me").hidden = !on;
  composerState();
  if (!on) return;
  $("me").dataset.account = account;
  $("me").title = account;
  $("me-name").textContent = nameFor(account);
  $("me-avatar").style.background = avatarStyle(account);
  $("compose-avatar").style.background = avatarStyle(account);
}

/** Connects to the wallet; true when the site has an account. */
async function connect() {
  if (!provider) { showError("Nainokot Wallet not found. Load the extension, then reload this page."); return false; }
  try {
    [account] = await rpc("eth_requestAccounts");
    provider.on("accountsChanged", async ([a]) => {
      if (!a) { account = undefined; showAccount(); render(); log("The wallet disconnected this site"); return; }
      if (a === account) return;
      account = a;
      showAccount();
      log(`The wallet moved this site to a new account ${account}`);
      await refresh();
    });
    showAccount();
    const chainId = await rpc("eth_chainId");
    const caps = await rpc("wallet_getCapabilities", [account, [chainId]]).catch(() => ({}));
    const supported = !!caps?.[chainId]?.privacyPaymaster?.supported;
    if (!supported) showError("This wallet can't pay gas privately on this chain.");
    const bal = BigInt(await rpc("eth_getBalance", [account, "latest"]));
    log(`Connected ${account} on chain ${BigInt(chainId)}, ETH balance ${bal}, privacyPaymaster ${supported ? "supported" : "not supported"}`);
    await refresh();
    return true;
  } catch (e) { log(`Connect failed: ${e.message}`); return false; }
}
$("connect").onclick = connect;

// --- Sending ----------------------------------------------------------------------------------
async function waitFor(check) {
  for (let i = 0; i < 180; i++) { const r = await check(); if (r) return r; await sleep(1000); }
  throw new Error("not mined within 3 minutes");
}
let busy = false;

/** Sends calls as one batch with wallet_sendCalls, the gas paid privately, then reloads the feed. */
async function send(calls, what) {
  if (busy) return;
  if (!account && !(await connect())) return false;
  busy = true;
  composerState();
  try {
    const chainId = await rpc("eth_chainId");
    // Expires: an EIP-8141 expiry frame, so a post that isn't mined in time never lands late.
    const secs = Number($("expires").value);
    const validUntil = secs ? Math.floor(Date.now() / 1000) + secs : 0;
    const capabilities = { privacyPaymaster: { optional: false } };
    if (validUntil) capabilities.expiry = { validUntil, optional: false };
    // atomicRequired: a thread's parts land together or not at all (one atomic batch).
    const { id } = await rpc("wallet_sendCalls", [{ version: "2.0.0", chainId, from: account, atomicRequired: true, calls, capabilities }]);
    log(`${what}: sent batch ${id.slice(0, 12)}…${validUntil ? `, valid until ${new Date(validUntil * 1000).toLocaleTimeString()}` : ""}, waiting`);
    const s = await waitFor(async () => {
      const s = await rpc("wallet_getCallsStatus", [id]);
      if (s.status >= 200) return s;
      // Past its deadline (and a few blocks' grace) it can no longer be mined.
      if (validUntil && Date.now() / 1000 > validUntil + 30) throw new Error("it expired before it was mined");
      return null;
    });
    log(`Batch status ${s.status}, gas ${BigInt(s.receipts[0].gasUsed)}, tx ${s.receipts[0].transactionHash}`);
    if (s.status !== 200) throw new Error(`status ${s.status}`);
    replyingTo = null;
    return true;
  } catch (e) {
    // Turning the request down in the wallet (4001) needs no message.
    if (e.code !== 4001) showError(`Not posted: ${e.message}`);
    log(`wallet_sendCalls failed (${e.code ?? "-"}): ${e.message}`);
    return false;
  } finally {
    busy = false;
    composerState();
    await refresh();
  }
}

$("calls").onclick = async () => {
  const texts = composerState();
  const calls = texts.map((t, i) => (i === 0 ? call.post(t) : call.thread(t)));
  if (await send(calls, texts.length > 1 ? `Thread of ${texts.length}` : "Post")) clearComposer();
};

composerState();
setTimeout(() => refresh(), 300); // the feed shows before connecting when the wallet allows reads
// Keep the feed fresh while the page is open (others post too).
setInterval(() => { if (!busy && !replyingTo && document.visibilityState === "visible") refresh().catch(() => undefined); }, 15_000);
