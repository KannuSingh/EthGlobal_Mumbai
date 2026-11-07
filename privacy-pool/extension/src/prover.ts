/** Proving in a Web Worker, so the window stays responsive. Used by the approval and withdraw windows. */
export function workerProver() {
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
