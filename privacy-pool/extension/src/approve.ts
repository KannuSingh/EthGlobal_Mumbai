/**
 * The approval window. For a connect, it asks which account the site gets (a new one by default,
 * or one already in use, which is linkable) and the site's setting. For a send, it shows the
 * calls and that gas comes from private funds, and on Confirm proves the spend in a Web Worker and
 * sends it: the user's notes and keys never leave the extension.
 */
import { addressOf, balance, makeRpc, sponsoredSend, sync } from "../../core.ts";
import { accountList, config, load, save } from "./store.ts";
import { $, accountAvatar, el, host, html, icon, short, shown, siteAvatar } from "./ui.ts";

const id = new URLSearchParams(location.search).get("id")!;
const reply = (r: object) => chrome.runtime.sendMessage({ type: "approval-reply", id, reply: r });

function workerProver() {
  const worker = new Worker("prover-worker.js", { type: "module" });
  let n = 0;
  const waiting = new Map<number, any>();
  worker.onmessage = ({ data }) => {
    const w = waiting.get(data.id);
    waiting.delete(data.id);
    if (data.error) w?.reject(new Error(data.error));
    else w?.resolve({ publics: data.publics, proof: data.proof });
  };
  return (witness: any) => new Promise<any>((resolve, reject) => {
    const i = n++;
    waiting.set(i, { resolve, reject });
    worker.postMessage({ id: i, witness });
  });
}

/** Plain words for the prover's steps. */
const STEPS: [RegExp, string][] = [
  [/root/i, "Updating the pool"], [/prov/i, "Making the private proof"], [/check|simulat/i, "Checking it will go through"],
  [/send/i, "Sending"], [/wait|mined|receipt/i, "Waiting for the network"],
];
const plainStep = (s: string) => STEPS.find(([re]) => re.test(s))?.[1] ?? s;

for (const e of document.querySelectorAll<HTMLElement>("[data-icon]")) e.innerHTML = icon(e.dataset.icon!, 20);

async function main() {
  const req = await chrome.runtime.sendMessage({ type: "approval-request", id });
  if (!req) {
    $("title").textContent = "This request is no longer waiting";
    $("foot").hidden = true;
    return;
  }
  $("site").textContent = host(req.origin);
  $("site-avatar").replaceWith(siteAvatar(req.origin, 40));
  const cfg = await config();
  const rpc = makeRpc(cfg.rpc);
  const stored = await load();
  $("balance").textContent = `${shown(balance(stored.wallet), 4)} ETH`;
  sync(rpc, cfg, stored.wallet).then(async () => {
    await save({ wallet: stored.wallet });
    $("balance").textContent = `${shown(balance(stored.wallet), 4)} ETH`;
  }).catch(() => undefined);

  if (req.kind === "connect") renderConnect(req, stored);
  else renderSend(req, cfg);

  $("reject").onclick = async () => {
    await reply({ error: { code: 4001, message: "the user rejected the request" } });
    window.close();
  };
  $("approve").onclick = async () => {
    ($("approve") as HTMLButtonElement).disabled = true;
    ($("reject") as HTMLButtonElement).disabled = true;
    if (req.kind === "connect") {
      const use = (document.querySelector("input[name=use]:checked") as HTMLInputElement).value;
      const picked = (document.querySelector("input[name=existing]:checked") as HTMLInputElement | null)?.value;
      const mode = ($("mode-private") as HTMLInputElement).checked ? "transaction" : "site";
      await reply({ ok: true, use: use === "new" || !picked ? "new" : picked, mode });
      window.close();
      return;
    }
    await send(req, cfg, rpc);
  };
}

function renderConnect(req: any, stored: any) {
  $("title").textContent = "wants to connect";
  ($("approve") as HTMLButtonElement).textContent = "Connect";
  $("connect").hidden = false;
  const modeBox = $("mode-private") as HTMLInputElement;
  const modeText = () => {
    $("mode-sub").textContent = modeBox.checked
      ? "On: the site can't link your transactions."
      : "Off: the site and anyone watching can link every transaction here.";
    $("mode-sub").className = `sub ${modeBox.checked ? "" : "warn-text"}`;
  };
  modeBox.checked = req.mode !== "site";
  modeBox.onchange = modeText;
  modeText();

  const known = accountList(stored, addressOf).filter((a) => a.sites.length);
  const list = $("existing-list");
  const warn = () => {
    const using = (document.querySelector("input[name=use]:checked") as HTMLInputElement).value === "existing";
    list.hidden = !using;
    const picked = (document.querySelector("input[name=existing]:checked") as HTMLInputElement | null)?.value;
    const a = known.find((k) => k.address === picked);
    $("existing-warning").hidden = !using || !a;
    if (a) $("existing-warning").textContent =
      `${host(req.origin)} and ${a.sites.map(host).join(", ")} will be able to tell it's the same person, and see every transaction this account sent.`;
  };
  known.reverse().forEach((a, i) => {
    const label = el("label", "acct-option");
    label.title = a.address;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "existing";
    input.value = a.address;
    input.checked = i === 0;
    input.onchange = warn;
    const g = el("span", "grow");
    g.append(el("div", "mono", short(a.address)), el("div", "small muted", `${a.sites.map(host).join(", ")} · ${a.txs} tx`));
    label.append(input, accountAvatar(a.address, 28), g, el("span", "radio-mark"));
    list.append(label);
  });
  for (const r of document.querySelectorAll<HTMLInputElement>("input[name=use]")) r.onchange = warn;
  if (!known.length) {
    $("existing-choice").classList.add("disabled");
    (document.querySelector("input[name=use][value=existing]") as HTMLInputElement).disabled = true;
    $("existing-sub").textContent = "You don't have any accounts yet.";
  }
  warn();
}

function renderSend(req: any, cfg: any) {
  $("title").textContent = req.calls.length > 1 ? `wants you to send ${req.calls.length} calls` : "wants you to send a transaction";
  $("send").hidden = false;
  const priv = req.accountMode === "transaction";
  const badge = $("privacy");
  badge.hidden = false;
  badge.className = `state ${priv ? "private" : "public"}`;
  const g = el("div", "grow");
  g.append(el("b", "", priv ? "Private" : "Linkable"),
    el("span", "", priv
      ? "This site gets a new account after this transaction."
      : "This site keeps this account, so it can link all your transactions here."));
  badge.replaceChildren(html(icon(priv ? "shield" : "alert", 22)), g);
  // e2e and screen readers read the banner as one line.
  badge.setAttribute("aria-label", `${priv ? "Private" : "Linkable"}: ${g.lastChild!.textContent}`);

  const from = $("from");
  from.title = req.from;
  from.append(accountAvatar(req.from, 20), el("span", "mono", short(req.from)));
  $("net").textContent = `Local test chain (${cfg.chainId})`;
  $("calls-title").textContent = req.calls.length > 1 ? `${req.calls.length} interactions` : "Interaction";
  const list = $("calls");
  for (const c of req.calls) {
    const li = el("li", "card call");
    const to = el("div", "kv");
    const t = el("span", "acct-row");
    t.append(html(`<span class="muted">${icon("code", 16)}</span>`), el("span", "mono", short(c.to)));
    t.title = c.to;
    to.append(el("span", "muted", "Contract"), t);
    li.append(to);
    if (c.value && BigInt(c.value) > 0n) {
      const v = el("div", "kv");
      v.append(el("span", "muted", "Amount"), el("span", "", `${shown(BigInt(c.value))} ETH`));
      li.append(v);
    }
    const bytes = (c.data.length - 2) / 2;
    const d = el("details");
    d.append(el("summary", "", bytes ? `Show data (${bytes} bytes)` : "No data"), el("code", "", c.data));
    li.append(d);
    list.append(li);
  }
}

async function send(req: any, cfg: any, rpc: any) {
  $("send").hidden = true;
  $("progress").hidden = false;
  $("foot").hidden = true;
  const status = $("status");
  try {
    const now = await load();
    // The key of the account this request names: the site's current one, or one it used before.
    const current = now.accounts[req.origin];
    const key = current && addressOf(current) === req.from
      ? current
      : now.used[req.origin]?.find((u) => u.address === req.from)?.key;
    if (!key) throw new Error(`no key for ${req.from}`);
    const sent = await sponsoredSend({
      rpc, cfg, state: now.wallet, senderKey: key, calls: req.calls, prover: workerProver(),
      step: (s) => (status.textContent = `${plainStep(s)}…`),
    });
    await save({ wallet: now.wallet });
    $("progress-mark").className = "done-mark";
    $("progress-mark").innerHTML = icon("check", 34);
    $("progress-title").textContent = "Sent";
    status.textContent = `Sent. Gas up to ${shown(sent.fee)} ETH, the unused part comes back.`;
    await reply({ hash: sent.hash });
    setTimeout(() => window.close(), 1500);
  } catch (e) {
    $("progress-mark").className = "fail-mark";
    $("progress-mark").innerHTML = icon("x", 30);
    $("progress-title").textContent = "Couldn't send";
    const msg = (e as Error).message;
    status.textContent = /failed to fetch/i.test(msg)
      ? cfg.via === "sidecar"
        ? `Can't reach the alt mempool at ${cfg.sidecar}. Start it with "bash privacy-pool/sidecar.sh start", or rebuild with --via privileged to send straight to the node.`
        : `Can't reach the node at ${cfg.rpc}. Is the local chain running?`
      : msg;
    status.className = "error";
    await reply({ error: { code: 5710, message: `the privacy paymaster could not pay: ${(e as Error).message}` } });
  }
}

main();
