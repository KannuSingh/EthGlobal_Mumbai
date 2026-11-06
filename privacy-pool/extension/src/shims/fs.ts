/** node:fs for the extension: msp's poseidon.ts reads its round constants as it loads. */
import constants from "../../../../deps.nosync/minimal-shielded-pool/src/poseidon-constants.json" with { type: "json" };

export function readFileSync(path: URL | string): string {
  if (String(path).endsWith("poseidon-constants.json")) return JSON.stringify(constants);
  throw new Error(`${path} is not in the extension`);
}
