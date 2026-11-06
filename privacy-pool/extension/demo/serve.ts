/**
 * Serves the guest book page on http://127.0.0.1:8142/ (PORT to change), with the guest book's
 * address from altlocal.nosync/privacy-pool/deploy.json. `node privacy-pool/extension/demo/serve.ts`
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const deploy = resolve(here, "../../../altlocal.nosync/privacy-pool/deploy.json");
const port = Number(process.env.PORT ?? 8142);
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  try {
    const body = path === "/config.json"
      ? JSON.stringify({ guestBook: JSON.parse(readFileSync(deploy, "utf8")).guestBook })
      : readFileSync(join(here, path === "/" ? "index.html" : path.replace(/^\/+/, "").replace(/\.\./g, "")));
    res.writeHead(200, { "content-type": types[path.slice(path.lastIndexOf("."))] ?? "text/html" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`guest book on http://127.0.0.1:${port}/`));
