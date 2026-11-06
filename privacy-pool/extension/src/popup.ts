/**
 * The toolbar popup, laid out like a phone wallet with a tab bar:
 * Home (private funds, the privacy setting, connected sites), Accounts (private and public),
 * History, and Settings. A site opens its own page with its account, its setting and Disconnect.
 */
import { addressOf, balance, makeRpc, shield, sync, ETH } from "../../core.ts";
import { accountList, config, load, modeOf, save, type AccountMode, type Stored } from "./store.ts";
import { $, accountAvatar, ago, copyButton, el, host, html, icon, short, shown, siteAvatar } from "./ui.ts";

type View = "home" | "accounts" | "history" | "settings" | "site";
let view: View = "home";
let openSite = "";
let accountKind: "private" | "public" = "private";
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
  for (const id of ["home", "accounts", "history", "settings", "site"]) $(id).hidden = id !== v;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#tabbar button")) {
    b.classList.toggle("active", b.dataset.view === v || (v === "site" && b.dataset.view === "home"));
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

/** The green or red banner for a setting. */
function stateBanner(target: HTMLElement, mode: AccountMode, privateText: [string, string], publicText: [string, string]) {
  const priv = mode === "transaction";
  target.className = `state ${priv ? "private" : "public"}`;
  target.replaceChildren(
    html(icon(priv ? "shield" : "alert", 22)),
    (() => { const g = el("div", "grow"); g.append(el("b", "", (priv ? privateText : publicText)[0]), el("span", "", (priv ? privateText : publicText)[1])); return g; })(),
  );
}

function siteSummary(s: Stored, origin: string) {
  const used = s.used[origin] ?? [];
  return { accounts: used.length, txs: used.reduce((n, u) => n + u.txs.length, 0) };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function renderHome(s: Stored) {
  stateBanner($("privacy-state"), s.settings.accountMode,
    ["Private by default", "New sites get a fresh account after every transaction."],
    ["Public by default", "New sites keep one account, so they can link your activity."]);
  $("privacy-state").classList.add("tap");
  $("privacy-state").onclick = () => show("settings");
  const list = $("sites");
  list.replaceChildren();
  const accounts = accountList(s, addressOf);
  for (const origin of Object.keys(s.accounts).filter((o) => s.connected[o])) {
    const mode = modeOf(s, origin);
    const { accounts: n, txs } = siteSummary(s, origin);
    const shared = accounts.find((a) => a.currentOf.includes(origin) && a.sites.length > 1);
    const li = el("li", "tap site-row");
    li.dataset.site = origin;
    const g = el("div", "grow");
    g.append(el("div", "title", host(origin)));
    const sub = el("div", "sub site-sub");
    sub.append(el("span", `tag ${mode === "transaction" ? "private" : "public"}`, mode === "transaction" ? "Private" : "Public"));
    if (shared) sub.append(el("span", "tag public shared", "Shared account"));
    sub.append(el("span", "", txs ? `${plural(n, "account")} · ${plural(txs, "transaction")}` : "No transactions yet"));
    g.append(sub);
    li.append(siteAvatar(origin), g, html(`<span class="muted">${icon("right", 18)}</span>`));
    li.onclick = () => { openSite = origin; show("site"); render(); };
    list.append(li);
  }
  if (!list.children.length) list.append(el("li", "empty", "No sites yet. Connect from a site to start."));
}

function renderAccounts(s: Stored) {
  const all = accountList(s, addressOf);
  const priv = all.filter((a) => !a.public), pub = all.filter((a) => a.public);
  $("count-private").textContent = String(priv.length);
  $("count-public").textContent = String(pub.length);
  for (const b of document.querySelectorAll<HTMLButtonElement>(".segmented button")) {
    b.classList.toggle("active", b.dataset.kind === accountKind);
    b.onclick = () => { accountKind = b.dataset.kind as any; render(); };
  }
  $("accounts-help").textContent = accountKind === "private"
    ? "Used for one transaction on one site. Nothing ties them to you or to each other."
    : "Used more than once or by more than one site. Those transactions can be linked together.";
  const list = $("account-list");
  list.replaceChildren();
  for (const a of (accountKind === "private" ? priv : pub).reverse()) {
    const li = el("li", "account-item");
    li.title = a.address;
    const g = el("div", "grow");
    const t = el("div", "title");
    t.append(el("span", "mono", short(a.address)));
    if (a.currentOf.length) t.append(el("span", "tag neutral", "Current"));
    t.style.cssText = "display:flex;gap:6px;align-items:center";
    const sub = el("div", "sub", `${a.sites.map(host).join(", ")} · ${a.why}`);
    if (a.public) sub.classList.add("warn-text");
    g.append(t, sub);
    li.append(accountAvatar(a.address), g, copyButton(a.address, () => toast("Address copied")));
    list.append(li);
  }
  if (!list.children.length) {
    list.append(el("li", "empty", accountKind === "private" ? "No private accounts yet." : "No public accounts. Nice."));
  }
}

function renderHistory(s: Stored) {
  const list = $("history-list");
  list.replaceChildren();
  for (const h of [...s.history].reverse()) {
    const li = el("li", "history-item");
    li.title = h.hash;
    const ic = html(`<span class="opt-icon" style="width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent)">${icon("send", 18)}</span>`);
    const g = el("div", "grow");
    g.append(el("div", "title", host(h.origin)));
    const sub = el("div", "sub");
    sub.append(
      el("span", "", h.calls > 1 ? `${h.calls} calls` : "Contract call"),
      el("span", "", "·"),
      el("span", "mono", short(h.from)),
    );
    g.append(sub);
    const end = el("div", "end");
    end.append(el("div", "", ago(h.at)), el("span", `tag ${h.mode === "transaction" ? "private" : "public"}`, h.mode === "transaction" ? "Private" : "Public"));
    li.append(ic, g, end);
    list.append(li);
  }
  if (!list.children.length) list.append(el("li", "empty", "Nothing sent yet."));
}

async function renderSettings(s: Stored) {
  const cfg = await config();
  const box = $("default-private") as HTMLInputElement;
  box.checked = s.settings.accountMode === "transaction";
  $("default-sub").textContent = box.checked
    ? "On: sites can't link your transactions. Recommended."
    : "Off: each site keeps one account and can link everything you do there.";
  $("default-sub").className = `sub ${box.checked ? "" : "warn-text"}`;
  const live = s.wallet.notes.filter((n) => !n.spent);
  $("settings-balance").textContent = `${shown(balance(s.wallet))} ETH`;
  $("settings-notes").textContent = plural(live.length, "private note");
  $("settings-chain").textContent = `Local test chain (${cfg.chainId})`;
  $("settings-rpc").textContent = cfg.rpc.replace(/^https?:\/\//, "");
  $("settings-via").textContent = cfg.via === "sidecar" ? "Through the alt mempool" : "Straight to the node";
}

function renderSite(s: Stored) {
  const origin = openSite;
  const box = $("site");
  box.replaceChildren();
  const back = html(`<button class="subbar" id="back">${icon("left", 20)}<span>Sites</span></button>`);
  back.onclick = () => { show("home"); render(); };
  const mode = modeOf(s, origin);
  const head = el("div", "site-head");
  head.append(siteAvatar(origin, 56), el("h2", "", host(origin)),
    el("span", `tag ${mode === "transaction" ? "private" : "public"}`, mode === "transaction" ? "Private" : "Public"));

  const current = addressOf(s.accounts[origin]);
  const acct = el("div", "card pad");
  const row = el("div", "acct-row");
  const g = el("div", "grow");
  g.append(el("div", "small muted", "Account this site sees now"), el("div", "mono", short(current)));
  row.append(accountAvatar(current, 40), g, copyButton(current, () => toast("Address copied")));
  acct.append(row);
  const info = accountList(s, addressOf).find((a) => a.address === current);
  const others = info?.sites.filter((x) => x !== origin) ?? [];
  if (others.length) {
    const w = el("p", "warn-text shared-warning", `Also used by ${others.map(host).join(", ")}. These sites can tell it's the same person.`);
    w.style.margin = "10px 0 0";
    acct.append(w);
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

  const used = s.used[origin] ?? [];
  const title = el("div", "section-title");
  title.append(el("span", "", "Accounts used here"), el("span", "", plural(used.reduce((n, u) => n + u.txs.length, 0), "transaction")));
  const card = el("div", "card");
  const list = el("ul", "list");
  for (const u of [...used].reverse()) {
    const li = el("li");
    li.title = u.address;
    const gg = el("div", "grow");
    gg.append(el("div", "title mono", short(u.address)), el("div", `sub ${u.txs.length > 1 ? "warn-text" : ""}`, plural(u.txs.length, "transaction")));
    li.append(accountAvatar(u.address, 30), gg);
    if (u.address === current) li.append(el("span", "tag neutral", "Current"));
    list.append(li);
  }
  if (!used.length) list.append(el("li", "empty", "No transactions from this site yet."));
  card.append(list);

  const disconnect = html(`<button class="btn danger block" id="disconnect">${icon("logout", 16)}<span>Disconnect</span></button>`);
  disconnect.onclick = async () => {
    const now = await load();
    now.connected[origin] = false;
    await save({ connected: now.connected });
    toast(`Disconnected ${host(origin)}`);
    show("home");
    render();
  };
  box.append(back, head, acct, setting, title, card, disconnect);
}

async function render() {
  const s = await load();
  $("balance").textContent = shown(balance(s.wallet), 4);
  if (view === "home") renderHome(s);
  else if (view === "accounts") renderAccounts(s);
  else if (view === "history") renderHistory(s);
  else if (view === "settings") await renderSettings(s);
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
  $("network-name").textContent = `Local · ${cfg.chainId}`;
  await render();
  const s = await load();
  await sync(makeRpc(cfg.rpc), cfg, s.wallet).catch(() => undefined);
  await save({ wallet: s.wallet });
  await render();
})();
