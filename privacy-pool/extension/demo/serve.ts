/**
 * Serves the Framecaster page on http://127.0.0.1:8142/ (PORT to change), with Framecaster's
 * address from $POOL_DIR/deploy.json (default altlocal.nosync/privacy-pool). `node privacy-pool/extension/demo/serve.ts`
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const deploy = join(resolve(here, "../../..", process.env.POOL_DIR ?? "altlocal.nosync/privacy-pool"), "deploy.json");
const port = Number(process.env.PORT ?? 8142);
const types: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml",
};
// The site's icon, and the account names shared with the extension.
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#0f766e"/><path d="M16 10v13M7 21V9h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5v12h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>`;
// The page's own scripts only (the wallet's provider is a MAIN-world content script, which page CSP doesn't block).
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'";
createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  try {
    const d = () => JSON.parse(readFileSync(deploy, "utf8"));
    const file = resolve(here, path === "/" ? "index.html" : "." + path);
    const body = path === "/config.json" ? JSON.stringify({ framecaster: d().framecaster, pool: d().pool })
      : path === "/favicon.svg" ? FAVICON
      : path === "/names.js" ? readFileSync(join(here, "../src/names.js"))
      : path === "/text.js" ? readFileSync(join(here, "../src/text.js"))
      : file.startsWith(here + "/") && !file.endsWith(".ts") ? readFileSync(file) : null;
    const type = path === "/" ? "text/html" : types[path.slice(path.lastIndexOf("."))];
    if (body === null || !type) throw new Error("not served");
    res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`Framecaster on http://127.0.0.1:${port}/`));
