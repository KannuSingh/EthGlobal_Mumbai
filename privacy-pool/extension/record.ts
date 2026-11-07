/**
 * Records a demo video of the whole flow on the local chain (after deploy.sh and build.ts):
 * add funds, connect Framecaster, post with an expiry frame, post a thread (all or nothing), then
 * History and a transaction's frames in the popup. The page in view is captured several times a
 * second; each step becomes a clip with its caption underneath, and the clips one MP4.
 * Best on a new chain (an empty feed).
 *
 *   node privacy-pool/extension/record.ts [out.mp4]      (needs Playwright and ffmpeg)
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT ?? "playwright");
const out = resolve(process.argv[2] ?? join(here, "nainokot-flow.mp4"));
const ext = join(here, "out");
const work = mkdtempSync(join(tmpdir(), "nainokot-rec-"));
const W = 1280, H = 720;
const server = spawn(process.execPath, [join(here, "demo/serve.ts")], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ctx = await pw.chromium.launchPersistentContext(join(work, "profile"), {
  headless: true, channel: "chromium",
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: W, height: H }, deviceScaleFactor: 1,
});
// Each step: the page in view, its caption, and the frames captured while it was in view.
type Part = { page: any; caption: string; dir: string; frames: number; t0: number; t1: number };
const parts: Part[] = [];
let cur: Part | undefined;
const view = (page: any, caption: string) => {
  if (cur) cur.t1 = Date.now();
  if (!caption && !page) { cur = undefined; return; }
  const dir = join(work, `part-${String(parts.length).padStart(2, "0")}`);
  mkdirSync(dir);
  cur = { page, caption, dir, frames: 0, t0: Date.now(), t1: 0 };
  parts.push(cur);
};
let capturing = true;
const capture = (async () => {
  while (capturing) {
    const p = cur;
    const t = Date.now();
    if (p) {
      try {
        await p.page.screenshot({ path: join(p.dir, `f-${String(p.frames).padStart(5, "0")}.png`), timeout: 2000 });
        p.frames++;
      } catch { /* navigating or closed: skip this frame */ }
    }
    await sleep(Math.max(0, 100 - (Date.now() - t)));
  }
})();
const small = async (p: any) => { await p.setViewportSize({ width: 400, height: 640 }); };
/** Waits for the next window the extension opens (connect or send). */
const nextWindow = async (action: () => Promise<unknown>) => {
  const [win] = await Promise.all([ctx.waitForEvent("page"), action()]);
  await small(win);
  await win.waitForFunction(() => document.getElementById("title")!.textContent !== "Loading…");
  return win;
};

try {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent("serviceworker");
  const id = new URL(sw.url()).host;

  // 1. Private funds in the popup.
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 360, height: 600 }); // the popup's own size
  await popup.goto(`chrome-extension://${id}/popup.html?tab=http://127.0.0.1:8142`);
  await sleep(600);
  view(popup, "Nainokot Wallet: private funds live in a privacy pool");
  await sleep(1800);
  await popup.click("#add");
  await popup.waitForFunction(() => /Added/.test(document.getElementById("status")!.textContent ?? ""), null, { timeout: 90_000 });
  await sleep(1800);

  // 2. Connect Framecaster: a new, empty account for this site.
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:8142/");
  await sleep(800);
  view(page, "Framecaster, any dapp: connect");
  await sleep(1500);
  const connect = await nextWindow(() => page.click("#connect"));
  view(connect, "The site gets a new account with no ETH, never your funds' address");
  await sleep(2500);
  await connect.click("#approve");
  await page.waitForSelector("#me[data-account]", { timeout: 30_000 });
  view(page, "Connected");
  await sleep(1500);

  // 3. A post that expires in 10 minutes.
  await page.click("#text");
  await page.type("#text", "gm from ETHGlobal Mumbai", { delay: 45 });
  await page.selectOption("#expires", "600");
  view(page, "A post that must land within 10 minutes: an expiry frame");
  await sleep(1500);
  const send = await nextWindow(() => page.click("#calls"));
  view(send, "The wallet builds the frame transaction: the proof is made, each frame checked");
  await send.waitForSelector("#approve:not([disabled])", { timeout: 180_000 });
  view(send, "Frame 0 is the expiry verifier (0x…8141); the pool pays the gas from a private note");
  await sleep(2200);
  await send.locator("#calls .fm-card").first().click();
  await sleep(2500);
  await send.locator("#calls .fm-card").nth(3).click();
  view(send, "Tap any frame to inspect it: here the post(string) call");
  await sleep(2500);
  await send.locator("#calls .fm-card").nth(3).click();
  await send.click("#approve");
  view(send, "Sent");
  await send.waitForSelector(".done-mark", { timeout: 120_000 }).catch(() => undefined);
  await sleep(1200);
  await page.bringToFront();
  await page.locator(".post").filter({ hasText: "gm from ETHGlobal Mumbai" }).waitFor({ timeout: 120_000 });
  view(page, "Posted; the site already sees a new account for the next one");
  await sleep(2500);

  // 4. A thread: two posts in one transaction, all or nothing.
  await page.selectOption("#expires", "0");
  await page.click("#text");
  await page.type("#text", "a thread: each post is a call frame", { delay: 35 });
  await page.click("#add-part");
  await page.type("#parts .part:nth-child(2) textarea", "one private proof pays for both", { delay: 35 });
  view(page, "A thread: two posts in one transaction");
  await sleep(1500);
  const thread = await nextWindow(() => page.click("#calls"));
  view(thread, "The calls form one atomic batch: both land or neither does");
  await thread.waitForSelector("#approve:not([disabled])", { timeout: 180_000 });
  await sleep(2800);
  await thread.click("#approve");
  await thread.waitForSelector(".done-mark", { timeout: 120_000 }).catch(() => undefined);
  await sleep(800);
  await page.bringToFront();
  await page.locator(".post").filter({ hasText: "a thread: each post is a call frame" }).waitFor({ timeout: 120_000 });
  view(page, "The thread, joined from the logs");
  await sleep(2500);

  // 5. History and one transaction's frames in the popup.
  await popup.bringToFront();
  await popup.reload();
  await popup.click('#tabbar button[data-view="history"]');
  await sleep(600);
  view(popup, "History: every transaction, from a different account each time");
  await sleep(2500);
  await popup.locator(".history-item").nth(1).click();
  await popup.waitForSelector("#tx .fm-card");
  view(popup, "Each transaction's frames, as they ran on chain");
  await sleep(3000);
  await popup.click('#tabbar button[data-view="accounts"]');
  await sleep(600);
  view(popup, "Accounts: one per transaction, none linked to your funds");
  await sleep(2500);
  view(undefined, "");
} finally {
  capturing = false;
  await capture;
  await ctx.close();
  server.kill();
}

// Each step's frames become a clip at the rate they were captured, its caption underneath; then one MP4.
const font = ["/usr/share/fonts/opentype/inter/Inter-SemiBold.otf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"].find((f) => { try { execFileSync("test", ["-f", f]); return true; } catch { return false; } });
const clips: string[] = [];
for (const [i, p] of parts.entries()) {
  if (p.frames < 2) continue;
  const fps = Math.max(1, p.frames / ((p.t1 - p.t0) / 1000));
  const clip = join(work, `clip-${String(i).padStart(2, "0")}.mp4`);
  const textFile = join(work, `cap-${i}.txt`);
  writeFileSync(textFile, p.caption);
  const vf = [
    `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x101828`,
    `pad=${W}:${H + 80}:0:0:color=0x101828`,
    ...(p.caption && font ? [`drawtext=fontfile=${font}:textfile=${textFile}:fontcolor=white:fontsize=30:x=(w-tw)/2:y=${H + 24}`] : []),
    "fps=30", "format=yuv420p",
  ].join(",");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", fps.toFixed(3), "-i", join(p.dir, "f-%05d.png"), "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", clip]);
  clips.push(clip);
}
writeFileSync(join(work, "list.txt"), clips.map((c) => `file '${c}'`).join("\n"));
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(work, "list.txt"), "-c", "copy", "-movflags", "+faststart", out]);
console.log(`recorded ${clips.length} parts into ${out}`);
