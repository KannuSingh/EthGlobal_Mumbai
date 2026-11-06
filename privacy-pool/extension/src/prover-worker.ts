/**
 * The spend prover, in a Web Worker of the approval window: snarkjs 0.7.5's browser build proves
 * from the circuit files packed in the extension (circuit/), on one thread. Messages: {id, witness} in, {id, publics, proof} or {id, error} out.
 */
// @ts-expect-error snarkjs ships no type declarations.
import * as snarkjs from "../../../deps.nosync/minimal-shielded-pool/node_modules/snarkjs/build/browser.esm.js";

let circuit: Promise<{ wasm: Uint8Array; zkey: Uint8Array; vkey: unknown }> | undefined;
const fetched = (name: string) => fetch(new URL(`circuit/${name}`, self.location.href)).then((r) => {
  if (!r.ok) throw new Error(`could not load the circuit's ${name}: ${r.status}`);
  return r;
});
const load = () =>
  (circuit ??= Promise.all([
    fetched("spend.wasm").then((r) => r.arrayBuffer()),
    fetched("spend_final.zkey").then((r) => r.arrayBuffer()),
    fetched("spend_vkey.json").then((r) => r.json()),
  ]).then(([wasm, zkey, vkey]) => ({ wasm: new Uint8Array(wasm), zkey: new Uint8Array(zkey), vkey })));

self.onmessage = async ({ data }: MessageEvent<{ id: number; witness: any }>) => {
  try {
    const { wasm, zkey, vkey } = await load();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      data.witness, { type: "mem", data: wasm }, { type: "mem", data: zkey }, undefined, undefined,
      // One thread: snarkjs' helper threads start from blob: URLs, which an extension page may not load.
      { singleThread: true });
    // No local verify: snarkjs' verify starts helper threads too. The node's simulation runs the
    // pool's own verifier before anything is sent.
    void vkey;
    const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
    const [pA, pB, pC] = JSON.parse(`[${calldata}]`);
    self.postMessage({ id: data.id, publics: publicSignals, proof: { pA, pB, pC } });
  } catch (e) {
    self.postMessage({ id: data.id, error: e instanceof Error ? e.message : String(e) });
  }
};
