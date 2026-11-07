/** Smoke test of the dapp path in privacy-pool/core.ts, on the local chain (after privacy-pool/deploy.sh):
 *  1. a two-post Framecaster thread in one sponsored transaction, then two sends back to back;
 *  2. the frames a dapp can ask for: an EIP-8141 expiry frame first (with either payer shape) and
 *     an atomic batch, and a send whose deadline passes, never mined, its note freed again;
 *  3. what the pool refuses before it pays: each attack is a changed copy of a proven transaction;
 *  4. notes from another chain are dropped.
 * At the end the test wallet's leftovers go back to the funder. `node privacy-pool/core-smoke.ts` */
import { readFileSync } from "node:fs";
import * as core from "./core.ts";
import * as prover from "../deps.nosync/minimal-shielded-pool/src/prover.ts";
import { giveBack } from "./give-back.ts";

const d = JSON.parse(readFileSync(`${process.env.POOL_DIR ?? "altlocal.nosync/privacy-pool"}/deploy.json`, "utf8"));
const cfg: core.Config = {
  chainId: "1337", rpc: d.rpc, sidecar: "", via: "privileged", shape: "last", pool: d.pool,
  funderKey: readFileSync(process.env.FUNDER_KEY_FILE ?? "altlocal.nosync/funder.key", "utf8").split("\n")[0],
};
const rpc = core.makeRpc(cfg.rpc);
const prove = (w: any, label: string) => prover.prove(w, label) as any;
const { keccak, toHex } = await import("../deps.nosync/minimal-shielded-pool/src/bytes.ts");
const selOf = (sig: string) => toHex(keccak(new TextEncoder().encode(sig))).slice(2, 10);
const word = (n: number) => n.toString(16).padStart(64, "0");
const text = (t: string) => { const b = new TextEncoder().encode(t); return word(32) + word(b.length) + Buffer.from(b).toString("hex").padEnd(64 * Math.ceil(b.length / 32), "0"); };
const post = (t: string) => ({ to: d.framecaster, data: "0x" + selOf("post(string)") + text(t) });
const part = (t: string) => ({ to: d.framecaster, data: "0x" + selOf("thread(string)") + text(t) });
const quiet = () => undefined;
let failed = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "OK  " : "FAIL"} ${what}`); if (!ok) failed++; };

const state: core.State = { notes: [] };
await core.shield(rpc, cfg, state, 5n * 10n ** 16n);

// 1. A thread in one transaction, then two sends back to back (the second waits for the first's change).
const sent = await core.sponsoredSend({ rpc, cfg, state, senderKey: core.newAccountKey(), calls: [post("core smoke"), part("core smoke, 2")], prover: prove, step: quiet });
const rec = await core.receipt(rpc, sent.hash, "the thread");
const posted = await rpc("eth_getLogs", [{ address: d.framecaster, fromBlock: "0x0", toBlock: "latest", topics: [toHex(keccak(new TextEncoder().encode("Posted(uint256,address,uint256,uint8,string)")))] }]);
const kinds = posted.filter((l: any) => l.transactionHash === sent.hash).map((l: any) => Number(BigInt("0x" + l.data.slice(2, 66))));
check(rec.status === "0x1" && kinds.join(",") === "0,2", `a post and its thread part in one transaction (gas ${BigInt(rec.gasUsed)})`);
const s1 = await core.sponsoredSend({ rpc, cfg, state, senderKey: core.newAccountKey(), calls: [post("back to back 1")], prover: prove, step: quiet });
const s2 = await core.sponsoredSend({ rpc, cfg, state, senderKey: core.newAccountKey(), calls: [post("back to back 2")], prover: prove, step: quiet });
const both = [await core.receipt(rpc, s1.hash, "send 1"), await core.receipt(rpc, s2.hash, "send 2")];
check(both.every((r) => r.status === "0x1"), "two sends back to back: the second waited for the first's change");

// 2. An expiry frame first and an atomic batch over the two calls.
const now = Math.floor(Date.now() / 1000);
const ex = await core.sponsoredSend({ rpc, cfg, state, senderKey: core.newAccountKey(), calls: [post("expiring thread"), part("part two")], prover: prove, step: quiet, expiry: now + 120, atomic: true });
const exRec = await core.receipt(rpc, ex.hash, "the expiring send");
const frames = (await rpc("eth_getTransactionByHash", [ex.hash])).frames ?? [];
const target = (f: any) => String(f.target ?? f.to ?? "").toLowerCase();
const flags = (f: any) => Number(BigInt(f.flags ?? 0));
check(exRec.status === "0x1" && frames.length === 6 && target(frames[0]) === "0x0000000000000000000000000000000000008141" &&
  BigInt(frames[0].data) === BigInt(now + 120), "an expiry frame first (0x…8141, the 8-byte deadline): mined");
check(flags(frames[3]) === 4 && flags(frames[4]) === 0, "the calls as one atomic batch: the first opens it, the second closes it");

// The pre_verify shape (proof checked and nullifiers marked in a DEFAULT frame before payment), behind an expiry frame.
const pv = await core.sponsoredSend({ rpc, cfg: { ...cfg, shape: "preverify" }, state, senderKey: core.newAccountKey(), calls: [post("pre_verify shape")], prover: prove, step: quiet, expiry: now + 300 });
check((await core.receipt(rpc, pv.hash, "the pre_verify send")).status === "0x1", "the pre_verify shape, behind an expiry frame: mined");

// A deadline that passes before a block takes it: the dry run refuses it, or the chain never mines it.
let late: string | undefined, lateErr = "";
try {
  late = (await core.sponsoredSend({ rpc, cfg, state, senderKey: core.newAccountKey(), calls: [post("too late")], prover: prove,
    expiry: Math.floor(Date.now() / 1000) + 2, inspect: async () => { await core.sleep(4000); return true; } })).hash;
} catch (e) { lateErr = (e as Error).message; }
if (late) {
  let r = null;
  for (let i = 0; i < 20 && !r; i++) { await core.sleep(1000); r = await rpc("eth_getTransactionReceipt", [late]); }
  check(!r, "a send past its deadline is never mined");
  await core.sleep(62_000);
  await core.sync(rpc, cfg, state);
  check(!state.notes.some((n) => n.pending === late || n.from === late || n.refundOf === late), "a minute past its deadline the wallet frees its note again");
} else check(/would fail/.test(lateErr), "a send past its deadline is refused by the dry run");

// 3. What the pool refuses before it pays. Each is a proven, changed copy that must fail the dry run.
const attacks: [string, (tx: any) => Uint8Array | void][] = [
  ["lift: someone else's account sends the proof", (tx) => { const k = core.newAccountKey(); tx.sender = BigInt(core.addressOf(k)); return core.keyOf(k); }],
  ["no settle frame", (tx) => { tx.frames.pop(); }],
  ["settle with less gas", (tx) => { tx.frames.at(-1).gasLimit = 100_000n; }],
  ["the last call opens an atomic batch with settlement", (tx) => { tx.frames.at(-2).flags = 4n; }],
  ["a higher max fee than the proof covers", (tx) => { tx.maxFee *= 3n; }],
  ["a second settle frame in the middle", (tx) => { tx.frames.splice(tx.frames.length - 1, 0, { ...tx.frames.at(-1) }); }],
  ["the pool asked to approve execution too", (tx) => { tx.frames[2].flags = 3n; }],
  ["an expiry frame that approves payment", (tx) => { tx.frames[0].flags = 1n; }],
  ["an expiry frame with 9 bytes of data", (tx) => { tx.frames[0].data = new Uint8Array(9).fill(0xff); }],
  ["another VERIFY frame first instead of the expiry verifier", (tx) => { tx.frames[0].target = BigInt(d.framecaster); }],
];
for (const [what, tamper] of attacks) {
  const before = JSON.stringify(state.notes);
  let err = "";
  try {
    // All with an expiry frame first, so the attacks also cover the shifted frame indices.
    await core.sponsoredSend({ rpc, cfg, state, senderKey: core.newAccountKey(), calls: [post("attack")], prover: prove, expiry: Math.floor(Date.now() / 1000) + 300, tamper });
  } catch (e) { err = (e as Error).message; }
  check(/would fail|invalid/i.test(err) && JSON.stringify(state.notes) === before, `refused, nothing spent: ${what}`);
}

// 4. Notes from another chain are dropped: pretend the state was saved on a different chain.
const old = { notes: state.notes.map((n) => ({ ...n })), chain: "0xdead/" + d.pool.toLowerCase() };
await core.sync(rpc, cfg, old);
const legacy: core.State = { notes: [...state.notes.map((n) => ({ ...n })), { ...state.notes[0], cm: "0x1234" }] };
await core.sync(rpc, cfg, legacy);
check(old.notes.length === 0 && legacy.notes.length === state.notes.length, "notes from another chain are dropped");

await giveBack(rpc, cfg, [state], prove);
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("ALL OK");
process.exit(0);
