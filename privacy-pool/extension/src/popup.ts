/**
 * The toolbar popup, laid out like a phone wallet with a tab bar:
 * Home (private funds), Accounts (private and public), History, and Settings (privacy, connected sites, network).
 * The top bar shows the site in the current tab; tapping it opens that site's page
 * (its account, its setting and Disconnect).
 */
import { addressOf, balance, makeRpc, newAccountKey, privateAddress, shield, sync, ETH } from "../../core.ts";
import { accountList, config, knownAccounts, load, modeOf, pastUse, save, switchAccount, type Stored } from "./store.ts";
import { $, accountAvatar, ago, copyButton, el, explorerLink, host, html, icon, nameBlock, nameOf, rememberSite, short, shown, siteAvatar } from "./ui.ts";
import { frameMap, hexChip, txOverview } from "./frames.js";

type View = "home" | "accounts" | "history" | "settings" | "site" | "tx";
let view: View = "home";
let openSite = "";
/** Where the site page goes back to. */
let siteFrom: View = "home";
/** The site in the current tab (its origin and page title), if it is a web page. */
let tab: { origin: string; title: string } | null = null;
let openTx = "";
let accountGroup: "all" | "app" = "all";
let toastTimer: any;

function toast(text: string) {
  const t = $("status");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function show(v: View) {
  view = v;
  for (const id of ["home", "accounts", "history", "settings", "site", "tx"]) $(id).hidden = id !== v;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#tabbar button")) {
    b.classList.toggle("active", b.dataset.view === v || (v === "site" && b.dataset.view === siteFrom) || (v === "tx" && b.dataset.view === "history"));
  }
  document.querySelector(".scroll")!.scrollTop = 0;
}

const tabs: Record<string, [string, string]> = {
  home: ["home", "Home"], accounts: ["users", "Accounts"], history: ["history", "History"], settings: ["settings", "Settings"],
};
for (const b of document.querySelectorAll<HTMLButtonElement>("#tabbar button")) {
  const [ic, label] = tabs[b.dataset.view!];
  b.innerHTML = `${icon(ic, 20)}<span>${label}</span>`;
  b.onclick = () => { show(b.dataset.view as View); render(); };
}
$("add").innerHTML = `${icon("plus", 16)}<span>Add 0.1 ETH</span>`;
$("withdraw").innerHTML = `${icon("send", 16)}<span>Send</span>`;
$("withdraw").onclick = () => chrome.windows.create({ url: chrome.runtime.getURL("withdraw.html"), type: "popup", width: 400, height: 640 });
$("receive").innerHTML = `${icon("receive", 16)}<span>Receive</span>`;
$("receive").onclick = () => { $("receive-card").hidden = !$("receive-card").hidden; };

/** An account's ETH balance, filled in from the chain (accounts start with none). */
function balanceTag(address: string): HTMLElement {
  const t = el("span", "bal", "… ETH");
  t.title = "ETH this account holds";
  config().then((cfg) => makeRpc(cfg.rpc)("eth_getBalance", [address, "latest"]))
    .then((wei: string) => {
      const v = BigInt(wei);
      t.textContent = `${v === 0n ? "0" : shown(v, 4)} ETH`;
      t.classList.toggle("zero", v === 0n);
    })
    .catch(() => (t.textContent = "? ETH"));
  return t;
}

/** A site's name: its page title when the popup has seen it, else its host (e.g. localhost:8142). */
const siteName = (s: Stored, origin: string) => s.siteNames[origin] || host(origin);

/** The current tab's site, or null on a page that isn't a website (a new tab, the extension's own pages). */
async function currentTab(): Promise<{ origin: string; title: string } | null> {
  // For tests, which open the popup as a tab of its own: popup.html?tab=<origin>.
  const forced = new URLSearchParams(location.search).get("tab");
  if (forced) return { origin: forced, title: "" };
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const u = new URL(t?.url ?? "");
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { origin: u.origin, title: (t.title ?? "").trim() };
  } catch {
    return null;
  }
}

/** The top bar's chip: the site in this tab, a green dot when it is connected. Tap it for the site's page. */
function renderSiteChip(s: Stored) {
  const chip = $("site-chip") as HTMLButtonElement;
  if (!tab) { chip.hidden = true; return; }
  const on = !!s.connected[tab.origin] && !!s.accounts[tab.origin];
  chip.hidden = false;
  chip.classList.toggle("off", !on);
  chip.title = on ? `${host(tab.origin)}: connected` : `${host(tab.origin)}: not connected`;
  chip.replaceChildren(siteAvatar(tab.origin, 18), el("span", "site-chip-name", siteName(s, tab.origin)), el("i", on ? "dot" : "dot off"));
  chip.disabled = !on;
  chip.onclick = on ? () => { openSite = tab!.origin; siteFrom = view === "site" ? siteFrom : view === "tx" ? "history" : view; show("site"); render(); } : null;
}

function siteSummary(s: Stored, origin: string) {
  const used = s.used[origin] ?? [];
  return { accounts: used.length, txs: used.reduce((n, u) => n + u.txs.length, 0) };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;



function renderHome(s: Stored) {
  const mine = privateAddress(s.wallet);
  if ($("private-address").textContent !== mine) {
    $("private-address").textContent = mine;
    $("receive-copy").replaceChildren(copyButton(mine, () => toast("Private address copied")));
  }
}

/** The connected sites, in Settings: each opens its page. */
function renderSites(s: Stored) {
  const list = $("sites");
  list.replaceChildren();
  const accounts = accountList(s, addressOf);
  for (const origin of Object.keys(s.accounts).filter((o) => s.connected[o])) {
    const mode = modeOf(s, origin);
    const { accounts: n, txs } = siteSummary(s, origin);
    const shared = accounts.find((a) => a.currentOf.includes(origin) && a.sites.length > 1);
    const li = el("li", "tap site-row");
    li.dataset.site = origin;
    li.title = host(origin);
    const g = el("div", "grow");
    g.append(el("div", "title", siteName(s, origin)));
    const sub = el("div", "sub site-sub");
    if (shared) sub.append(el("span", "tag public shared", "Shared account"));
    sub.append(el("span", "", txs ? `${plural(n, "account")} · ${plural(txs, "transaction")}` : "No transactions yet"));
    g.append(sub);
    li.append(siteAvatar(origin), g, html(`<span class="muted">${icon("right", 18)}</span>`));
    li.onclick = () => { openSite = origin; siteFrom = "settings"; show("site"); render(); };
    list.append(li);
  }
  if (!list.children.length) list.append(el("li", "empty", "No sites yet. Connect from a site to start."));
}

/** One account row: avatar, name, short address and use, balance. */
function accountRow(a: ReturnType<typeof accountList>[number], site?: string): HTMLElement {
  const li = el("li", "account-item");
  li.title = a.address;
  li.dataset.account = a.address;
  const g = el("div", "grow");
  const t = el("div", "title acct-title");
  t.append(el("span", "", nameOf(a.address)));
  if (site ? a.currentOf.includes(site) : a.currentOf.length) t.append(el("span", "tag neutral", "Current"));
  const where = site ? a.sites.filter((x) => x !== site) : a.sites;
  const sub = el("div", "sub");
  sub.append(hexChip(a.address), el("span", "", plural(a.txs, "tx")));
  g.append(t, sub);
  if (where.length) g.append(el("div", `sub sites ${a.public ? "warn-text" : ""}`, site ? `Also on ${where.map(host).join(", ")}` : where.map(host).join(", ")));
  li.append(accountAvatar(a.address), g, balanceTag(a.address));
  return li;
}

/** All accounts, newest first, or grouped by the app (site) that used them. */
function renderAccounts(s: Stored) {
  const all = accountList(s, addressOf).reverse();
  const apps = [...new Set(all.flatMap((a) => a.sites))];
  $("count-all").textContent = String(all.length);
  $("count-apps").textContent = String(apps.length);
  for (const b of document.querySelectorAll<HTMLButtonElement>("#accounts .segmented button")) {
    b.classList.toggle("active", b.dataset.group === accountGroup);
    b.onclick = () => { accountGroup = b.dataset.group as any; render(); };
  }
  const box = $("account-groups");
  box.replaceChildren();
  if (!all.length) {
    const c = el("div", "card");
    c.append(el("p", "empty", "No accounts yet. Connect from a site to start."));
    box.append(c);
    return;
  }
  if (accountGroup === "all") {
    const c = el("div", "card");
    const list = el("ul", "list");
    list.id = "account-list";
    for (const a of all) list.append(accountRow(a));
    c.append(list);
    box.append(c);
    return;
  }
  for (const site of apps) {
    const group = el("section", "app-group");
    group.dataset.site = site;
    const head = el("div", "app-head");
    const mine = all.filter((a) => a.sites.includes(site));
    head.append(siteAvatar(site, 22), el("b", "", siteName(s, site)), el("span", "muted small", plural(mine.length, "account")));
    const c = el("div", "card");
    const list = el("ul", "list");
    for (const a of mine) list.append(accountRow(a, site));
    c.append(list);
    group.append(head, c);
    box.append(group);
  }
}

async function renderHistory(s: Stored) {
  const explorer = (await config()).explorer;
  const list = $("history-list");
  list.replaceChildren();
  for (const h of [...s.history].reverse()) {
    const li = el("li", "tap history-item");
    li.title = h.hash;
    li.onclick = () => { openTx = h.hash; show("tx"); render(); };
    const ic = html(`<span class="opt-icon" style="width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent)">${icon(h.label?.startsWith("Received") ? "receive" : "send", 18)}</span>`);
    const g = el("div", "grow");
    g.append(el("div", "title", h.label ?? siteName(s, h.origin)));
    const sub = el("div", "sub");
    sub.append(el("span", "", h.method === "pool" ? (h.label?.startsWith("Received") ? "From another wallet" : "Sent by the pool") : nameOf(h.from)));
    if (h.calls > 1) sub.append(el("span", "", `${h.calls} calls`));
    g.append(sub);
    const end = el("div", "end");
    end.append(el("div", "", ago(h.at)));
    const link = explorerLink(explorer, h.hash, "");
    if (link) { link.title = "View on explorer"; link.setAttribute("aria-label", "View on explorer"); end.append(link); }
    li.append(ic, g, end);
    list.append(li);
  }
  if (!list.children.length) list.append(el("li", "empty", "Nothing sent yet."));
}

/** One transaction: what was sent, then each frame as mined, with its gas and decoded data. */
async function renderTx(s: Stored) {
  const h = s.history.find((x) => x.hash === openTx);
  const box = $("tx");
  const back = html(`<button class="subbar" id="tx-back">${icon("left", 20)}<span>History</span></button>`);
  back.onclick = () => { show("history"); render(); };
  if (!h) { box.replaceChildren(back, el("p", "muted", "Not found.")); return; }
  const head = el("div", "card rows");
  const kv = (k: string, v: string | HTMLElement) => {
    const d = el("div", "kv");
    d.append(el("span", "muted", k), typeof v === "string" ? el("span", "", v) : v);
    return d;
  };
  const from = el("span", "acct-row");
  if (h.method === "pool") from.append(el("span", "acct-name", "The privacy pool"));
  else from.append(accountAvatar(h.from, 18), el("span", "acct-name", nameOf(h.from)));
  const status = el("span", "fm-status tx-status");
  status.id = "tx-status";
  status.append(el("i", "fm-dot wait"), "Checking…");
  head.classList.add("tx-head");
  head.append(kv(h.origin === "wallet" ? "What" : "Site", h.label ?? siteName(s, h.origin)), kv("Status", status), kv("From", from),
    kv("Transaction", hexChip(h.hash)), kv("Sent", ago(h.at)));
  const link = explorerLink((await config()).explorer, h.hash);
  if (link) head.append(kv("Explorer", link));
  const title = el("div", "section-title", "Frames");
  const slot = el("div", "", "");
  slot.append(el("p", "muted small", "Loading from the chain…"));
  box.replaceChildren(back, head, title, slot);
  try {
    const cfg = await config();
    const rpc = makeRpc(cfg.rpc);
    const [tx, rec] = await Promise.all([rpc("eth_getTransactionByHash", [h.hash]), rpc("eth_getTransactionReceipt", [h.hash])]);
    if (openTx !== h.hash) return;
    const [dot, word] = !tx ? ["bad", "Not on this chain"] : !rec ? ["wait", "Pending"] : rec.status === "0x1" ? ["ok", "On chain"] : ["bad", "Failed"];
    status.replaceChildren(el("i", `fm-dot ${dot}`), word);
    if (!tx) { slot.replaceChildren(el("p", "muted small", "This chain doesn't know this transaction (a new chain?).")); return; }
    if (!tx.frames) {
      slot.replaceChildren(el("p", "muted small", "An ordinary transaction, with no frames."));
      return;
    }
    const all = el("details", "card pad all-fields");
    all.append(el("summary", "", "All fields"), txOverview(tx, rec, { pool: cfg.pool }));
    title.textContent = `Frames · ${tx.frames.length}`;
    slot.replaceChildren(frameMap(tx.frames, rec?.frameReceipts ?? null, { sender: tx.sender ?? h.from, pool: cfg.pool, tx, rec, summary: false }), all);
  } catch (e) {
    slot.replaceChildren(el("p", "error small", (e as Error).message));
  }
}

async function renderSettings(s: Stored) {
  const cfg = await config();
  renderSites(s);
  const box = $("default-private") as HTMLInputElement;
  box.checked = s.settings.accountMode === "transaction";
  $("default-sub").textContent = box.checked
    ? "On: sites can't link your transactions. Recommended."
    : "Off: each site keeps one account and can link everything you do there.";
  $("default-sub").className = `sub ${box.checked ? "" : "warn-text"}`;
  $("settings-chain").textContent = `Local test chain (${cfg.chainId})`;
  $("settings-rpc").textContent = cfg.rpc.replace(/^https?:\/\//, "");
  $("settings-via").textContent = cfg.via === "sidecar" ? "Through the alt mempool" : "Straight to the node";
}

function renderSite(s: Stored) {
  const origin = openSite;
  const box = $("site");
  box.replaceChildren();
  const backTo = siteFrom === "site" || siteFrom === "tx" ? "home" : siteFrom;
  const back = html(`<button class="subbar" id="back">${icon("left", 20)}<span>${tabs[backTo][1]}</span></button>`);
  back.onclick = () => { show(backTo); render(); };
  const mode = modeOf(s, origin);
  const head = el("div", "site-head");
  head.append(siteAvatar(origin, 56), el("h2", "", siteName(s, origin)),
    ...(siteName(s, origin) !== host(origin) ? [el("span", "muted small", host(origin))] : []));

  const current = addressOf(s.accounts[origin]);
  const acct = el("div", "card pad");
  const row = el("div", "acct-row");
  const g = el("div", "grow");
  const info = accountList(s, addressOf).find((a) => a.address === current);
  const others = info?.sites.filter((x) => x !== origin) ?? [];
  const tags = el("div", "acct-title");
  if (others.length) tags.append(el("span", "tag public shared", `Shared with ${others.map(host).join(", ")}`));
  g.append(el("div", "small muted", "Account this site sees now"), el("div", "acct-name", nameOf(current)), hexChip(current), tags);
  row.append(accountAvatar(current, 40), g, balanceTag(current));
  acct.append(row);

  // Switch account: a new one (private) or one the wallet already has (marked when it can be linked).
  const switcher = html(`<button class="btn secondary block" id="switch-account">${icon("users", 16)}<span>Switch account</span></button>`);
  const picker = el("div", "card switch-list");
  picker.id = "switch-list";
  picker.hidden = true;
  switcher.onclick = () => { picker.hidden = !picker.hidden; };
  const pick = (label: HTMLElement, key: string) => {
    label.onclick = async () => {
      const a = await switchAccount(origin, key, addressOf);
      toast(`${host(origin)} now sees ${nameOf(a)}`);
      render();
    };
  };
  const fresh = el("button", "switch-row new");
  fresh.dataset.account = "new";
  const fg = el("span", "grow");
  fg.append(el("b", "", "New account"), el("span", "sub ok-text", "Never used. Nothing links it to you."));
  fresh.append(html(`<span class="opt-icon">${icon("sparkles", 18)}</span>`), fg);
  pick(fresh, newAccountKey());
  picker.append(fresh);
  for (const k of knownAccounts(s, addressOf).filter((k) => k.address !== current).reverse()) {
    const use = pastUse(s, k.address);
    const row = el("button", "switch-row");
    row.dataset.account = k.address;
    row.title = k.address;
    const g = el("span", "grow");
    const linked = use.txs > 0 || k.sites.some((x) => x !== origin);
    g.append(el("b", "", nameOf(k.address)),
      el("span", `sub ${linked ? "warn-text" : ""}`, use.txs
        ? `Used: ${plural(use.txs, "transaction")} on ${use.sites.map(host).join(", ")}`
        : k.sites.some((x) => x !== origin) ? `Also on ${k.sites.filter((x) => x !== origin).map(host).join(", ")}` : "Not used yet"));
    row.append(accountAvatar(k.address, 30), g, ...(linked ? [html(`<span class="warn-text">${icon("alert", 16)}</span>`)] : []));
    pick(row, k.key);
    picker.append(row);
  }

  const setting = el("div", "card rows");
  const r = el("div");
  const tg = el("div", "grow");
  tg.append(el("b", "", "New account after each transaction"),
    el("span", `sub ${mode === "transaction" ? "" : "warn-text"}`, mode === "transaction"
      ? "The site can't tell your transactions are from the same person."
      : "The site and anyone watching the chain can link all your transactions here."));
  const sw = html(`<label class="switch"><input type="checkbox" id="site-private" aria-label="New account after each transaction"><span></span></label>`);
  const input = sw.querySelector("input")!;
  input.checked = mode === "transaction";
  input.onchange = async () => {
    const now = await load();
    now.siteMode[origin] = input.checked ? "transaction" : "site";
    await save({ siteMode: now.siteMode });
    toast(input.checked ? `${host(origin)} gets a new account after every transaction.` : `${host(origin)} keeps its current account.`);
    render();
  };
  r.append(tg, sw);
  setting.append(r);

  // The accounts this site used live in Accounts (By app); here just a way there.
  const nAcc = accountList(s, addressOf).filter((a) => a.sites.includes(origin)).length;
  const { txs: nTx } = siteSummary(s, origin);
  const card = el("div", "card");
  const list = el("ul", "list");
  const go = el("li", "tap site-accounts");
  go.id = "site-accounts";
  const gg = el("div", "grow");
  gg.append(el("div", "title", "Accounts used here"), el("div", "sub", `${plural(nAcc, "account")} · ${plural(nTx, "transaction")}`));
  go.append(html(`<span class="muted">${icon("users", 18)}</span>`), gg, html(`<span class="muted">${icon("right", 18)}</span>`));
  go.onclick = () => {
    accountGroup = "app";
    show("accounts");
    render().then(() => document.querySelector(`.app-group[data-site="${CSS.escape(origin)}"]`)?.scrollIntoView({ block: "start" }));
  };
  list.append(go);
  card.append(list);

  const disconnect = html(`<button class="btn danger block" id="disconnect">${icon("logout", 16)}<span>Disconnect</span></button>`);
  disconnect.onclick = async () => {
    const now = await load();
    now.connected[origin] = false;
    await save({ connected: now.connected });
    toast(`Disconnected ${siteName(s, origin)}`);
    show(backTo);
    render();
  };
  box.append(back, head, acct, switcher, picker, setting, card, disconnect);
}

/** Lists in History each private transfer the wallet found paid to it (once, when first seen). */
async function noteReceived(s: Stored) {
  // By hash and label: a transfer to yourself is both a send and a receipt, with one hash.
  const known = new Set(s.history.filter((h) => h.label?.startsWith("Received")).map((h) => h.hash));
  let added = 0n;
  for (const n of s.wallet.notes) {
    if (!n.received || known.has(n.received)) continue;
    known.add(n.received);
    added += BigInt(n.value);
    s.history.push({ origin: "wallet", label: `Received ${shown(BigInt(n.value), 6)} ETH privately`, from: (await config()).pool,
      hash: n.received, method: "pool", calls: 1, at: Date.now(), mode: "transaction" });
  }
  if (added > 0n) {
    await save({ history: s.history });
    toast(`Received ${shown(added, 6)} ETH privately`);
  }
}

async function render() {
  const s = await load();
  // Names read like a subname of the account's (first) site: amberotter.example.org.
  for (const a of accountList(s, addressOf)) rememberSite(a.address, a.sites[0]);
  for (const h of s.history) if (h.origin !== "wallet") rememberSite(h.from, h.origin);
  await noteReceived(s);
  // Remember the site's own name (its page title) once it is connected.
  if (tab?.title && s.connected[tab.origin] && s.siteNames[tab.origin] !== tab.title) {
    s.siteNames[tab.origin] = tab.title;
    await save({ siteNames: s.siteNames });
  }
  renderSiteChip(s);
  $("balance").textContent = shown(balance(s.wallet), 4);
  if (view === "home") renderHome(s);
  else if (view === "accounts") renderAccounts(s);
  else if (view === "history") await renderHistory(s);
  else if (view === "settings") await renderSettings(s);
  else if (view === "tx") await renderTx(s);
  else renderSite(s);
}

($("default-private") as HTMLInputElement).onchange = async (e) => {
  const on = (e.target as HTMLInputElement).checked;
  await save({ settings: { accountMode: on ? "transaction" : "site" } });
  toast(on ? "New sites get a new account after every transaction." : "New sites keep one account.");
  render();
};

$("disconnect-all").onclick = async () => {
  await save({ connected: {} });
  toast("Disconnected all sites");
  render();
};

$("add").onclick = async () => {
  const button = $("add") as HTMLButtonElement;
  button.disabled = true;
  toast("Adding 0.1 ETH…");
  try {
    const cfg = await config();
    const s = await load();
    await shield(makeRpc(cfg.rpc), cfg, s.wallet, ETH / 10n);
    await save({ wallet: s.wallet });
    toast("Added 0.1 ETH.");
  } catch (e) {
    toast((e as Error).message);
  }
  button.disabled = false;
  await render();
};

(async () => {
  const cfg = await config();
  tab = await currentTab();
  await render();
  const s = await load();
  await sync(makeRpc(cfg.rpc), cfg, s.wallet).catch(() => undefined);
  await save({ wallet: s.wallet });
  await render();
})();
