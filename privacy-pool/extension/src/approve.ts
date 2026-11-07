/**
 * The approval window. For a connect, it asks which account the site gets (a new one by default,
 * or one already in use, which is linkable) and the site's setting. For a send, it shows the
 * frames and starts building the transaction at once (the private proof in a Web Worker): each
 * frame card spins until it is built and checked, then ticks. Tap a card to inspect it; Send sends
 * it, Cancel drops it and nothing is spent. The user's notes and keys never leave the extension.
 */
import { addressOf, balance, makeRpc, newAccountKey, sponsoredSend, sync, type Inspection } from "../../core.ts";
import { accountList, config, load, pastUse, save, switchAccount } from "./store.ts";
import { $, accountAvatar, el, explorerLink, host, html, icon, nameOf, rememberSite, short, shown, siteAvatar } from "./ui.ts";
import { EXPIRY, frameMap, hexChip, txOverview, untilText } from "./frames.js";
import { workerProver } from "./prover.ts";

const id = new URLSearchParams(location.search).get("id")!;
const reply = (r: object) => chrome.runtime.sendMessage({ type: "approval-reply", id, reply: r });

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
  for (const a of accountList(stored, addressOf)) rememberSite(a.address, a.sites[0]);
  if (req.from) rememberSite(req.from, req.origin);
  $("balance").textContent = `${shown(balance(stored.wallet), 4)} ETH`;
  sync(rpc, cfg, stored.wallet).then(async () => {
    await save({ wallet: stored.wallet });
    $("balance").textContent = `${shown(balance(stored.wallet), 4)} ETH`;
  }).catch(() => undefined);

  if (req.kind === "connect") renderConnect(req, stored);
  else renderSend(req, cfg, stored);

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
      await reply({ ok: true, use: use === "new" || !picked ? "new" : picked });
      window.close();
      return;
    }
    go?.();
  };
}

function renderConnect(req: any, stored: any) {
  $("title").textContent = "wants to connect";
  ($("approve") as HTMLButtonElement).textContent = "Connect";
  $("connect").hidden = false;
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
    g.append(el("div", "acct-name", nameOf(a.address)), el("div", "small muted", `${short(a.address)} · ${a.sites.map(host).join(", ")} · ${a.txs} tx`));
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

function renderSend(req: any, cfg: any, stored: any) {
  $("title").textContent = req.calls.length > 1 ? `wants you to send ${req.calls.length} calls` : "wants you to send a transaction";
  $("send").hidden = false;
  // Warn when this account already sent a transaction (this one can then be linked to those),
  // and offer a new account instead, so the user decides knowing that.
  const use = pastUse(stored, req.from);
  const badge = $("privacy");
  badge.hidden = !use.txs;
  if (use.txs) {
    const n = use.txs;
    badge.className = "state public warn-box";
    const g = el("div", "grow");
    g.append(el("b", "", "Account used before"),
      el("span", "", `${n} earlier transaction${n === 1 ? "" : "s"} on ${use.sites.map(host).join(", ")}. Anyone can link this one to ${n === 1 ? "it" : "them"}.`));
    const fix = html(`<button class="btn block" id="use-new">${icon("sparkles", 16)}<span>Use a new account instead</span></button>`) as HTMLButtonElement;
    fix.onclick = async () => {
      fix.disabled = true;
      req.from = await switchAccount(req.origin, newAccountKey(), addressOf);
      badge.hidden = true;
      $("from").replaceChildren();
      showFrom(req, cfg);
      $("switched").hidden = false;
      build(req, cfg, makeRpc(cfg.rpc));
    };
    const top = el("div", "warn-top");
    top.append(html(icon("alert", 22)), g);
    badge.replaceChildren(top, fix);
    // e2e and screen readers read the banner as one line.
    badge.setAttribute("aria-label", `Account used before: ${g.lastChild!.textContent}`);
  }
  showFrom(req, cfg);
  build(req, cfg, makeRpc(cfg.rpc));
}

/** The From row, the nonce, and the planned frames, for the account the request sends from. */
function showFrom(req: any, cfg: any) {
  rememberSite(req.from, req.origin);
  const from = $("from");
  from.title = req.from;
  // The name over its address (0x1234…4321, tap to copy), so neither has to wrap.
  const who = el("span", "from-block");
  who.append(el("span", "acct-name", nameOf(req.from)), hexChip(req.from));
  from.append(accountAvatar(req.from, 28), who);
  $("net").textContent = `Local test chain (${cfg.chainId})`;
  showShape(req);
  // nonce_keys [0], which this chain's EIP-8250 client reads as the account's own nonce.
  makeRpc(cfg.rpc)("eth_getTransactionCount", [req.from, "latest"])
    .then((n: string) => ($("nonce").textContent = `${BigInt(n)} (key 0)`))
    .catch(() => ($("nonce").textContent = "key 0"));
  // The frames this transaction will have, with each call's data decoded. The proof, the
  // signature and the settle data are being made, so those frames spin until built.
  const deadline = req.expiry ? "0x" + BigInt(req.expiry).toString(16).padStart(16, "0") : undefined;
  const atomic = !!req.atomic && req.calls.length > 1;
  const plan = [
    ...(deadline ? [{ mode: 1, to: EXPIRY, flags: 0, data: deadline }] : []),
    { mode: 1, to: null },
    ...(cfg.shape === "preverify" ? [{ mode: 0, to: cfg.pool }] : []),
    { mode: 1, to: cfg.pool },
    ...req.calls.map((c: any, i: number) => ({ mode: 2, to: c.to, data: c.data ?? "0x", flags: atomic && i < req.calls.length - 1 ? 4 : 0 })),
    { mode: 0, to: cfg.pool },
  ];
  $("calls-title").textContent = `${plan.length} frames`;
  $("calls").replaceWith(Object.assign(frameMap(plan, null, { sender: req.from, pool: cfg.pool }), { id: "calls" }));
}

/** The Expires row, counting down (Send turns off once it passes), and the All or nothing row. */
let expiryTimer: ReturnType<typeof setInterval> | undefined;
function showShape(req: any) {
  $("atomic-row").hidden = !(req.atomic && req.calls.length > 1);
  $("expiry-row").hidden = !req.expiry;
  clearInterval(expiryTimer);
  if (!req.expiry) return;
  const tick = () => {
    const late = Math.floor(Date.now() / 1000) >= req.expiry;
    $("expiry").textContent = untilText(req.expiry);
    $("expiry").classList.toggle("late", late);
    if (late && !$("send").hidden) {
      clearInterval(expiryTimer);
      drop?.();
      go = drop = undefined;
      const approve = $("approve") as HTMLButtonElement;
      approve.disabled = true;
      approve.textContent = "Expired";
      $("build-status").textContent = "This request expired before it was sent. The site can ask again.";
    }
  };
  tick();
  expiryTimer = setInterval(tick, 1000);
}

/** Each build; a newer one (after switching account) makes an older one's result void. */
let generation = 0;
/** Sends the built transaction (set once it is built), or undefined while building. */
let go: (() => void) | undefined;
/** Drops a built but unsent transaction. */
let drop: (() => void) | undefined;

/**
 * Shows which frames are being worked on now, by the build's real step:
 * the site's calls are known from the start; the private proof goes in the payer frame;
 * then the proof and signature are in and the node dry-runs every frame.
 */
function building(phase: "start" | "proof" | "check") {
  for (const c of document.querySelectorAll<HTMLElement>("#calls .fm-card")) {
    const who = c.querySelector(".fm-who")?.textContent ?? "";
    // Calls and the expiry frame are known up front; the rest wait for the proof or signature.
    const call = c.classList.contains("SENDER") || !!c.querySelector(".fm-mode.EXPIRY");
    const tick = c.querySelector<HTMLElement>(".fm-tick")!;
    const busy = phase === "check" || (phase === "proof" && who === "payer");
    c.classList.toggle("pending", !call && !busy);
    tick.className = `fm-tick ${busy ? "spin" : call ? "" : "wait"}`;
    tick.textContent = "";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Once built: the frames come ready one by one, in order, each ticked by its dry-run result. */
async function readyInOrder(box: HTMLElement, mine: number): Promise<boolean> {
  const cards = [...box.querySelectorAll<HTMLElement>(".fm-card")];
  const ticks = cards.map((c) => {
    const t = c.querySelector<HTMLElement>(".fm-tick")!;
    const end = [t.className, t.textContent ?? ""] as const;
    c.classList.add("pending");
    t.className = "fm-tick wait";
    t.textContent = "";
    return { t, end };
  });
  for (let i = 0; i < cards.length; i++) {
    cards[i].classList.remove("pending");
    ticks[i].t.className = "fm-tick spin";
    await sleep(260);
    if (mine !== generation) return false;
    ticks[i].t.className = ticks[i].end[0].includes("ok") || ticks[i].end[0].includes("bad") ? ticks[i].end[0] : "fm-tick ok";
    ticks[i].t.textContent = ticks[i].end[1] || "✓";
  }
  return true;
}

/** Builds (proves, signs, dry-runs) the transaction for req.from, then waits for Send or Cancel. */
function build(req: any, cfg: any, rpc: any) {
  const mine = ++generation;
  drop?.();
  go = drop = undefined;
  const approve = $("approve") as HTMLButtonElement;
  approve.disabled = true;
  approve.textContent = "Building…";
  $("build-status").textContent = "Making the private proof…";
  $("build-status").className = "muted small build-status";
  building("start");
  (async () => {
    const now = await load();
    // The key of the account this request names: the site's current one, or one it used before.
    const current = now.accounts[req.origin];
    const key = current && addressOf(current) === req.from
      ? current
      : now.used[req.origin]?.find((u) => u.address === req.from)?.key;
    if (!key) throw new Error(`no key for ${req.from}`);
    return sponsoredSend({
      rpc, cfg, state: now.wallet, senderKey: key, calls: req.calls, prover: workerProver(), atomic: req.atomic, expiry: req.expiry,
      step: (st) => {
        if (mine !== generation) return;
        if (/send/i.test(st)) { $("status").textContent = "Sending…"; return; }
        $("build-status").textContent = `${plainStep(st)}…`;
        building(/check|simulat/i.test(st) ? "check" : "proof");
      },
      inspect: async (v: Inspection) => {
        if (mine !== generation) return false;
        // Built: the real frames, ticked by the dry run; tap one to inspect it.
        const all = el("details", "card pad all-fields");
        all.append(el("summary", "", "All fields"), txOverview(v.tx, null, { pool: cfg.pool, unsent: true }));
        const map = frameMap(v.tx.frames, v.frames, { sender: v.tx.sender, pool: cfg.pool, tx: v.tx, unsent: true, summary: false });
        const box = el("div", "built");
        box.id = "calls";
        box.append(map, all);
        $("calls").replaceWith(box);
        $("build-status").textContent = "Checking each frame…";
        if (!(await readyInOrder(map, mine))) return false;
        $("calls-title").textContent = `${v.tx.frames.length} frames · ready`;
        $("build-status").textContent = "";
        $("max-fee").textContent = `up to ${shown(v.fee, 6)} ETH`;
        approve.textContent = "Send";
        approve.disabled = false;
        approve.focus();
        return new Promise<boolean>((resolve) => {
          go = () => {
            go = drop = undefined;
            $("send").hidden = true;
            $("progress").hidden = false;
            $("foot").hidden = true;
            $("status").textContent = "Sending…";
            resolve(true);
          };
          drop = () => resolve(false);
        });
      },
    }).then((sent) => ({ sent, wallet: now.wallet }));
  })().then(async ({ sent, wallet }) => {
    await save({ wallet });
    $("progress-mark").className = "done-mark";
    $("progress-mark").innerHTML = icon("check", 34);
    $("progress-title").textContent = "Sent";
    $("status").textContent = `Gas up to ${shown(sent.fee)} ETH. The unused part comes back.`;
    await reply({ hash: sent.hash, from: req.from });
    // With an explorer, the window stays open to offer its link; without one it closes itself.
    const link = explorerLink(cfg.explorer, sent.hash);
    if (link) {
      const close = el("button", "btn secondary", "Close") as HTMLButtonElement;
      close.id = "close";
      close.onclick = () => window.close();
      const row = el("div", "done-actions");
      row.append(link, close);
      $("progress").append(row);
    } else setTimeout(() => window.close(), 1500);
  }).catch(async (e) => {
    if (mine !== generation || (e as Error).name === "Cancelled") return;
    const msg = (e as Error).message;
    const text = /failed to fetch/i.test(msg)
      ? cfg.via === "sidecar"
        ? `Can't reach the alt mempool at ${cfg.sidecar}. Start it with "bash privacy-pool/sidecar.sh start", or rebuild with --via privileged to send straight to the node.`
        : `Can't reach the node at ${cfg.rpc}. Is the local chain running?`
      : msg;
    for (const t of document.querySelectorAll<HTMLElement>("#calls .fm-tick.spin")) { t.className = "fm-tick bad"; t.textContent = "✕"; }
    if (!$("progress").hidden) {
      $("progress-mark").className = "fail-mark";
      $("progress-mark").innerHTML = icon("x", 30);
      $("progress-title").textContent = "Couldn't send";
      $("status").textContent = text;
      $("status").className = "error";
    } else {
      $("build-status").textContent = text;
      $("build-status").className = "error small build-status";
      approve.textContent = "Can't send";
    }
    await reply({ error: { code: 5710, message: `the privacy paymaster could not pay: ${msg}` } });
  });
}

main();
