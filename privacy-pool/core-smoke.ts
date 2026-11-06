/** Smoke test of privacy-pool/core.ts in Node on the local chain (after privacy-pool/deploy.sh): shield 0.05 ETH,
 * then two guest book calls in one sponsored transaction. `node privacy-pool/core-smoke.ts` */
import { readFileSync } from "node:fs";
import * as core from "./core.ts";
import * as prover from "../deps.nosync/minimal-shielded-pool/src/prover.ts";

const d = JSON.parse(readFileSync("altlocal.nosync/privacy-pool/deploy.json", "utf8"));
const cfg: core.Config = {
  chainId: "1337", rpc: d.rpc, sidecar: "http://127.0.0.1:14337/rpc/", via: (process.env.VIA as any) ?? "privileged",
  shape: "last", pool: d.pool, funderKey: readFileSync("altlocal.nosync/funder.key", "utf8").split("\n")[0],
};
const rpc = core.makeRpc(cfg.rpc);
const state: core.State = { notes: [] };
await core.shield(rpc, cfg, state, 5n * 10n ** 16n);
const key = core.newAccountKey();
const text = new TextEncoder().encode("core smoke");
const { keccak, toHex } = await import("../deps.nosync/minimal-shielded-pool/src/bytes.ts");
// sign(string) with the text: selector, offset, length, the bytes padded to a word.
const sel = toHex(keccak(new TextEncoder().encode("sign(string)"))).slice(2, 10);
const word = (n: number) => n.toString(16).padStart(64, "0");
const signData = "0x" + sel + word(32) + word(text.length) + Buffer.from(text).toString("hex").padEnd(64 * Math.ceil(text.length / 32), "0");
const sent = await core.sponsoredSend({
  rpc, cfg, state, senderKey: key, calls: [{ to: d.guestBook, data: signData }, { to: d.guestBook, data: signData }],
  prover: (w, label) => prover.prove(w, label) as any, step: (s) => console.log("..", s),
});
console.log("sent", sent.hash, "fee", core.eth(sent.fee));
const rec = await core.receipt(rpc, sent.hash, "the spend");
console.log("status", rec.status, "gas", BigInt(rec.gasUsed));
await core.sync(rpc, cfg, state);
console.log(state.notes.map((n) => `${core.eth(BigInt(n.value))} ${n.spent ? "spent" : n.index}`).join(" | "));
console.log("guest book entries for", core.addressOf(key), BigInt(await rpc("eth_call", [{ to: d.guestBook, data: "0x" + toHex(keccak(new TextEncoder().encode("entries(address)"))).slice(2, 10) + core.addressOf(key).slice(2).toLowerCase().padStart(64, "0") }, "latest"])));
await (prover as any).terminate?.();
