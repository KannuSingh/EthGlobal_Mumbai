/**
 * Smoke test of the pool-as-sender spends in privacy-pool/core.ts on the local chain (after
 * privacy-pool/deploy.sh): a withdrawal from two notes in one transaction, a private transfer to
 * another wallet that finds it with its view key and spends it, and a dapp send paid from two
 * notes. Then a note spent as sender can't be spent again as paymaster. `node privacy-pool/pool-send-smoke.ts`
 */
import { readFileSync } from "node:fs";
import * as core from "./core.ts";
import * as prover from "../deps.nosync/minimal-shielded-pool/src/prover.ts";

const d = JSON.parse(readFileSync(`${process.env.POOL_DIR ?? "altlocal.nosync/privacy-pool"}/deploy.json`, "utf8"));
const cfg: core.Config = {
  chainId: "1337", rpc: d.rpc, sidecar: process.env.SIDECAR_URL ?? "http://127.0.0.1:14337/rpc/", via: (process.env.VIA as any) ?? "privileged",
  shape: "last", pool: d.pool, funderKey: readFileSync(process.env.FUNDER_KEY_FILE ?? "altlocal.nosync/funder.key", "utf8").split("\n")[0],
};
const rpc = core.makeRpc(cfg.rpc);
const prove = (w: any, label: string) => prover.prove(w, label) as any;
const log = (who: string) => (s: string) => console.log(`.. ${who}:`, s);
const check = (ok: boolean, what: string) => { if (!ok) throw new Error(what); console.log("OK", what); };
const E = 10n ** 16n; // 0.01 ETH

// 1. Two notes of 0.03 each; withdraw 0.05, which only both cover, in one transaction.
const a: core.State = { notes: [] };
await core.shield(rpc, cfg, a, 3n * E);
await core.shield(rpc, cfg, a, 3n * E);
const to = core.addressOf(core.newAccountKey());
const w = await core.withdraw({ rpc, cfg, state: a, amount: 5n * E, recipient: to, prover: prove, step: log("withdraw") });
const wrec = await core.receipt(rpc, w.hash, "withdraw");
const wtx = await rpc("eth_getTransactionByHash", [w.hash]);
check(BigInt(await rpc("eth_getBalance", [to, "latest"])) === 5n * E, "withdraw of 0.05 from two notes reached the address");
check(wtx.sender.toLowerCase() === d.pool.toLowerCase() && wrec.payer.toLowerCase() === d.pool.toLowerCase(), "the pool sent and paid it");
check(wtx.frames.length === 3 && wtx.nonceKeys.length === 2, "three frames, the two nullifiers as nonce keys");
check(a.notes.filter((n) => n.spent === w.hash).length === 2, "both notes marked spent");

// 2. Private transfer: a pays 0.02 to b's private address; b finds it and withdraws from it.
const b: core.State = { notes: [] };
const bAddr = core.privateAddress(b);
await core.sync(rpc, cfg, b);
await core.shield(rpc, cfg, a, 5n * E);
const t = await core.sendPrivately({ rpc, cfg, state: a, to: bAddr, value: 2n * E, prover: prove, step: log("transfer") });
await core.sync(rpc, cfg, b);
check(core.balance(b) === 2n * E && b.notes[0]?.received === t.hash, "b found the 0.02 paid to its private address");
const c: core.State = { notes: [] };
core.privateAddress(c);
await core.sync(rpc, cfg, c);
check(c.notes.length === 0, "another wallet finds nothing");
const to2 = core.addressOf(core.newAccountKey());
await core.withdraw({ rpc, cfg, state: b, amount: 1n * E, recipient: to2, prover: prove, step: log("b withdraw") });
check(BigInt(await rpc("eth_getBalance", [to2, "latest"])) === 1n * E, "b spent the received note");

// 3. A dapp call paid from two notes (the paymaster shape), each too small alone.
const e: core.State = { notes: [] };
await core.shield(rpc, cfg, e, 3n * 10n ** 15n);
await core.shield(rpc, cfg, e, 3n * 10n ** 15n);
const text = new TextEncoder().encode("two notes");
const { keccak, toHex } = await import("../deps.nosync/minimal-shielded-pool/src/bytes.ts");
const sel = toHex(keccak(new TextEncoder().encode("post(string)"))).slice(2, 10);
const wd = (n: number) => n.toString(16).padStart(64, "0");
const data = "0x" + sel + wd(32) + wd(text.length) + Buffer.from(text).toString("hex").padEnd(64, "0");
const s = await core.sponsoredSend({ rpc, cfg, state: e, senderKey: core.newAccountKey(), calls: [{ to: d.framecaster, data }], prover: prove, step: log("dapp") });
check((await core.receipt(rpc, s.hash, "dapp")).status === "0x1", "dapp send went through");
await core.sync(rpc, cfg, e);
check(e.notes.filter((n) => n.spent === s.hash).length === 2, "its gas came from both notes");

// 4. No double spend across shapes: re-spend a's withdrawn notes through the paymaster shape.
const replay: core.State = { notes: a.notes.filter((n) => n.spent === w.hash).map((n) => ({ ...n, spent: undefined })), chain: a.chain, published: a.published };
let refused = false;
try {
  await core.sponsoredSend({ rpc, cfg, state: replay, senderKey: core.newAccountKey(), calls: [{ to: d.framecaster, data }], prover: prove, step: log("replay") });
  console.log("replay was sent?!");
} catch (err) {
  refused = true;
  console.log("   replay refused:", String((err as Error).message).slice(0, 160));
}
check(refused, "a note spent with the pool as sender can't be spent again as paymaster");
const back: core.State = { notes: e.notes.filter((n) => n.spent === s.hash).map((n) => ({ ...n, spent: undefined })), chain: e.chain, published: e.published };
refused = false;
try {
  await core.withdraw({ rpc, cfg, state: back, amount: 10n ** 15n, recipient: to, prover: prove, step: log("replay 2") });
  console.log("replay 2 was sent?!");
} catch (err) {
  refused = true;
  console.log("   replay refused:", String((err as Error).message).slice(0, 160));
}
check(refused, "a note spent as paymaster can't be spent again with the pool as sender");
await (await import("./give-back.ts")).giveBack(rpc, cfg, [a, b, e], prove);
console.log("ALL OK");
await (prover as any).terminate?.();
