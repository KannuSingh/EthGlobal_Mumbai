/**
 * The send window: pays private funds to an ordinary address (a withdrawal: the ETH leaves the
 * pool) or to another wallet's private address (a private transfer: it stays in the pool). Either
 * way the privacy pool itself sends the transaction and pays its gas, so no account of the user's
 * appears. One transaction spends one note, or two when one isn't enough.
 */
import { balance, eth, makeRpc, sendPrivately, spendable, sync, withdraw, ETH, GWEI } from "../../core.ts";
import { parseAddress } from "../../transfer.ts";
import { config, load, save } from "./store.ts";
import { explorerLink, $, icon, shown } from "./ui.ts";
import { workerProver } from "./prover.ts";
import { reviewStep } from "./inspect.ts";

$("shield-icon").innerHTML = icon("shield", 22);
const STEPS: [RegExp, string][] = [
  [/root/i, "Updating the pool"], [/last transaction/i, "Waiting for your last transaction"], [/prov/i, "Making the private proof"],
  [/check/i, "Checking it will go through"], [/send/i, "Sending"], [/wait/i, "Waiting for the network"],
];
const plain = (s: string) => `${STEPS.find(([re]) => re.test(s))?.[1] ?? s}…`;

function parseEth(text: string): bigint | null {
  const m = text.trim().match(/^(\d*)(?:\.(\d{0,18}))?$/);
  if (!m || (!m[1] && !m[2])) return null;
  return BigInt(m[1] || "0") * ETH + BigInt((m[2] ?? "").padEnd(18, "0") || "0");
}

type Kind = "public" | "private" | "bad" | "empty";
function kindOf(to: string): Kind {
  const t = to.trim();
  if (!t) return "empty";
  if (/^0x[0-9a-fA-F]{40}$/.test(t) && BigInt(t) !== 0n) return "public";
  if (/^nk1/i.test(t)) {
    try { parseAddress(t); return "private"; } catch { return "bad"; }
  }
  return "bad";
}

const NOTE: Record<Kind, [string, string]> = {
  empty: ["Sent by the privacy pool", "The pool itself sends it and takes the gas from your private funds. No account of yours appears."],
  bad: ["Sent by the privacy pool", "The pool itself sends it and takes the gas from your private funds. No account of yours appears."],
  public: ["Leaves the pool", "The address gets ETH from the privacy pool. The pool sends it, so nothing points to you. The amount and time are public."],
  private: ["Stays private", "A private transfer inside the pool. Only the other wallet can see the amount, and nobody can tell who paid whom."],
};

async function main() {
  const cfg = await config();
  const rpc = makeRpc(cfg.rpc);
  const s = await load();
  await sync(rpc, cfg, s.wallet).catch(() => undefined);
  await save({ wallet: s.wallet });
  // One transaction's gas bound, as the wallet prices it (about 4.2M gas at the fee cap), with room.
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const feeCap = BigInt(block.baseFeePerGas ?? "0x0") * 2n + GWEI;
  const gas = (feeCap * 4_400_000n * 11n) / 10n;
  const two = spendable(s.wallet).map((n) => BigInt(n.value)).sort((a, b) => (a > b ? -1 : 1)).slice(0, 2).reduce((a, b) => a + b, 0n);
  const most = two > gas ? two - gas : 0n;
  $("balance").textContent = `${shown(balance(s.wallet), 4)} ETH`;
  $("max").textContent = most > 0n ? `${shown(most, 6)} ETH` : "nothing yet";
  $("max").onclick = () => { if (most > 0n) ($("amount") as HTMLInputElement).value = eth(most - (most % 10n ** 12n)); };

  const toInput = $("to") as HTMLInputElement;
  const note = () => {
    const [b, t] = NOTE[kindOf(toInput.value)];
    $("note-title").textContent = b;
    $("note-text").textContent = t;
    ($("go") as HTMLButtonElement).textContent = kindOf(toInput.value) === "private" ? "Send privately" : "Send";
  };
  toInput.oninput = note;
  note();

  $("cancel").onclick = () => window.close();
  $("go").onclick = async () => {
    const to = toInput.value.trim();
    const kind = kindOf(to);
    const amount = parseEth(($("amount") as HTMLInputElement).value);
    const err = $("form-error");
    const fail = (text: string) => { err.textContent = text; err.hidden = false; };
    if (kind === "empty" || kind === "bad") return fail("Enter an address (0x and 40 hex characters) or a private address (nk1…).");
    if (!amount || amount <= 0n) return fail("Enter an amount, like 0.01.");
    if (amount > most) return fail(most > 0n ? `At most ${shown(most, 6)} ETH now: one transaction spends up to two notes, and pays its gas.` : "Add funds first.");
    $("form").hidden = true;
    $("foot").hidden = true;
    $("progress").hidden = false;
    $("progress-title").textContent = kind === "private" ? "Sending privately" : "Sending";
    const status = $("status");
    try {
      const now = await load();
      const o = {
        rpc, cfg, state: now.wallet, prover: workerProver(), step: (x: string) => (status.textContent = plain(x)),
        inspect: async (v: any) => {
          $("progress").hidden = true;
          const ok = await reviewStep($("review"), v, { pool: cfg.pool });
          $("progress").hidden = false;
          return ok;
        },
      };
      const r = kind === "private"
        ? await sendPrivately({ ...o, to, value: amount })
        : await withdraw({ ...o, amount, recipient: to });
      const after = await load();
      after.wallet = now.wallet;
      const short = kind === "private" ? `${to.slice(0, 7)}…${to.slice(-4)}` : `${to.slice(0, 6)}…${to.slice(-4)}`;
      const label = kind === "private" ? `Sent ${shown(amount, 6)} ETH privately` : `Sent ${shown(amount, 6)} ETH to ${short}`;
      after.history.push({ origin: "wallet", label, from: r.from, hash: r.hash, method: "pool", calls: 1, at: Date.now(), mode: "transaction" });
      await save({ wallet: after.wallet, history: after.history });
      $("progress-mark").className = "done-mark";
      $("progress-mark").innerHTML = icon("check", 34);
      $("progress-title").textContent = "Sent";
      const link = explorerLink(cfg.explorer, r.hash);
      if (link) $("progress").append(link);
      status.textContent = kind === "private" ? `${shown(amount, 6)} ETH sent privately to ${short}.` : `${shown(amount, 6)} ETH sent to ${short}.`;
    } catch (e) {
      $("progress-mark").className = "fail-mark";
      $("progress-mark").innerHTML = icon("x", 30);
      if ((e as Error).name === "Cancelled") {
        $("progress-title").textContent = "Not sent";
        status.textContent = "Cancelled. Nothing was spent.";
        return;
      }
      $("progress-title").textContent = "Couldn't send";
      status.textContent = (e as Error).message;
      status.className = "error";
      await save({ wallet: (await load()).wallet });
    }
  };
}

main();
