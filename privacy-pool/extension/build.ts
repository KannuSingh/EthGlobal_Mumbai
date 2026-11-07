/**
 * Builds the extension into privacy-pool/extension/out/, which Chrome loads unpacked
 * (chrome://extensions, Developer mode, Load unpacked). Run after privacy-pool/deploy.sh:
 *
 *   node privacy-pool/extension/build.ts [--via privileged|raw|sidecar] [--shape last|preverify] [--rpc URL] [--sidecar URL] [--explorer URL]
 * --explorer (or EXPLORER_URL): a block explorer whose /tx/<hash> page the wallet links to; the local chain has none.
 *
 * config.json in out/ names the chain, the pool, the sidecar and the funder key, which pays for
 * "Add 0.1 ETH" and for publishing roots. POOL_DIR (default altlocal.nosync/privacy-pool) and
 * FUNDER_KEY_FILE (default altlocal.nosync/funder.key) pick another deployment.
 * esbuild comes from the root node_modules (npm ci at the root first).
 */
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const out = join(here, "out");
const esbuild = createRequire(join(root, "package.json"))("esbuild");
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const deploy = JSON.parse(readFileSync(join(resolve(root, process.env.POOL_DIR ?? "altlocal.nosync/privacy-pool"), "deploy.json"), "utf8"));
const funderKey = readFileSync(resolve(root, process.env.FUNDER_KEY_FILE ?? "altlocal.nosync/funder.key"), "utf8").split("\n")[0].trim();
const config = {
  chainId: String(BigInt(process.env.CHAIN_ID ?? "1337")),
  rpc: arg("--rpc", deploy.rpc),
  sidecar: arg("--sidecar", `http://127.0.0.1:${process.env.SIDECAR_PORT ?? "14337"}/rpc/`),
  via: arg("--via", "privileged"),
  shape: arg("--shape", "last"),
  pool: deploy.pool,
  funderKey,
  explorer: arg("--explorer", process.env.EXPLORER_URL ?? "").replace(/\/+$/, ""),
};
if (!["sidecar", "raw", "privileged"].includes(config.via)) throw new Error("--via is sidecar, raw or privileged");
if (!["last", "preverify"].includes(config.shape)) throw new Error("--shape is last or preverify");

const shims = {
  name: "node-shims",
  setup(build: any) {
    build.onResolve({ filter: /^node:/ }, ({ path }: { path: string }) =>
      path === "node:fs" ? { path: join(here, "src/shims/fs.ts") }
        : path === "node:crypto" ? { path: join(here, "src/shims/crypto.ts") }
        : { errors: [{ text: `${path} has no stand-in in the extension` }] });
  },
};

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "circuit"), { recursive: true });
const common = { bundle: true, target: "chrome120", logLevel: "warning", plugins: [shims], legalComments: "none" };
// Extension pages, the worker and the service worker are modules; the content scripts are not.
await esbuild.build({
  ...common, format: "esm", outdir: out,
  entryPoints: { background: join(here, "src/background.ts"), approve: join(here, "src/approve.ts"),
    popup: join(here, "src/popup.ts"), withdraw: join(here, "src/withdraw.ts"), "prover-worker": join(here, "src/prover-worker.ts") },
});
await esbuild.build({
  ...common, format: "iife", outdir: out,
  entryPoints: { content: join(here, "src/content.ts"), inpage: join(here, "src/inpage.ts") },
});
cpSync(join(here, "static"), out, { recursive: true });
const artifacts = join(root, "deps.nosync/minimal-shielded-pool/core/artifacts");
copyFileSync(join(artifacts, "spend_js/spend.wasm"), join(out, "circuit/spend.wasm"));
copyFileSync(join(artifacts, "spend_final.zkey"), join(out, "circuit/spend_final.zkey"));
copyFileSync(join(artifacts, "spend_vkey.json"), join(out, "circuit/spend_vkey.json"));
writeFileSync(join(out, "config.json"), JSON.stringify(config, null, 1));
console.log(`built ${out.slice(root.length + 1)}: pool ${config.pool}, chain ${config.chainId} at ${config.rpc}, sent via ${config.via}, ${config.shape} shape`);
