/**
 * Drives the extension in Chromium against the local chain: add gas money, connect the demo
 * Framecaster site, post once with wallet_sendCalls (privacyPaymaster required) and once with
 * eth_sendTransaction, approving each in the extension's window, and checks the capability rules.
 * Needs Playwright (the machine's global install, or PLAYWRIGHT=path) and a built out/ against a
 * deployed pool:
 *
 *   node privacy-pool/extension/build.ts --via privileged && node privacy-pool/extension/e2e.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let pw: any;
try {
  pw = require(process.env.PLAYWRIGHT ?? "playwright");
} catch {
  console.error("needs Playwright: npm install --no-save playwright && npx playwright install chromium");
  process.exit(2);
}
const ext = join(here, "out");
const pageLog: string[] = [];
const server = spawn(process.execPath, [join(here, "demo/serve.ts")], { stdio: "inherit" });
await new Promise((r) => setTimeout(r, 800));
const step = (s: string) => console.log(`==> ${s}`);
let failed = false;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

const ctx = await pw.chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "nainokot-ext-")), {
  headless: process.env.HEADED ? false : true,
  // The new headless mode, which loads extensions.
  channel: "chromium",
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: 1200, height: 900 },
  // VIDEO=dir records every page as .webm, for a demo video.
  ...(process.env.VIDEO ? { recordVideo: { dir: process.env.VIDEO, size: { width: 1200, height: 900 } } } : {}),
});
// The page writes what happened to the console only ("[framecaster] ..."), so the test reads it there.
const logs = new Map<any, string[]>();
const watch = (p: any) => {
  const a: string[] = [];
  logs.set(p, a);
  p.on("console", (m: any) => { const t = m.text(); pageLog.push(t); if (t.startsWith("[framecaster] ")) a.push(t.slice(14)); });
};
try {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent("serviceworker");
  const id = new URL(sw.url()).host;
  ctx.on("page", (p: any) => p.on("console", (m: any) => m.type() === "error" && console.log(`   [${new URL(p.url()).pathname}] ${m.text()}`)));

  step("add gas money from the popup");
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.click("#add");
  await popup.waitForFunction(() => /Added|Error|error|:/.test(document.getElementById("status")!.textContent ?? ""), null, { timeout: 60_000 });
  check((await popup.textContent("#status")) === "Added 0.1 ETH.", `popup: ${await popup.textContent("#status")}`);
  await popup.close();

  const page = await ctx.newPage();
  watch(page);
  await page.goto("http://127.0.0.1:8142/");
  /** Opens an approval window with `action`, lets `choose` pick options in it, and approves. */
  const approve = async (action: () => Promise<unknown>, choose?: (win: any) => Promise<void>) => {
    const [win] = await Promise.all([ctx.waitForEvent("page"), action()]);
    await win.setViewportSize({ width: 400, height: 640 });
    await win.waitForFunction(() => document.getElementById("title")!.textContent !== "Loading…");
    console.log(`   approval window: ${await win.textContent("#title")} (${await win.textContent("#site")})`);
    const send = !/connect/.test((await win.textContent("#title")) ?? "");
    if (send) await built(win);
    else await win.waitForSelector("#approve:not([disabled])");
    if (choose) await choose(win);
    await win.click("#approve", { timeout: 180_000 });
    if (send && !doneShot) {
      doneShot = true;
      await win.waitForSelector(".done-mark", { timeout: 120_000 });
      const cfgx = JSON.parse(readFileSync(join(here, "out", "config.json"), "utf8"));
      if (cfgx.explorer) check(/\/tx\/0x/.test((await win.getAttribute("#progress .explorer-link", "href")) ?? ""), "once sent, the window links to the transaction on the explorer");
      await win.screenshot({ path: join(here, "out-sent.png") });
      if (cfgx.explorer) await win.click("#close");
    }
    return win;
  };
  /** The Send money window shows the built frames after its proof: Send there. */
  const submitReview = async (win: any) => {
    await win.waitForSelector("#inspect-submit", { timeout: 180_000 });
    await win.click("#inspect-submit");
  };
  let inspected = false, doneShot = false;
  /** A send window builds at once: frames spin, then tick, and Send turns on. The first time, checks that. */
  const built = async (win: any) => {
    if (!inspected) {
      await win.waitForSelector("#calls .fm-tick.spin", { timeout: 10_000 });
      const spinning = await win.locator("#calls .fm-card:has(.fm-tick.spin) .fm-who").allTextContents();
      check(await win.isDisabled("#approve") && (spinning.join() === "payer" || spinning.length === 4) && (await win.locator("#calls .fx-frame:not([hidden])").count()) === 0,
        `the window starts building at once: the frame being made spins (${spinning.join(", ")}), no frame details open, Send waits`);
      await win.screenshot({ path: join(here, "out-building.png") });
    }
    await win.waitForSelector("#approve:not([disabled])", { timeout: 180_000 });
    if (!inspected) {
      inspected = true;
      const frames = await win.locator("#calls .fm-card").count();
      const t = (await win.textContent("#calls")) ?? "";
      check((await win.locator("#calls .fm-tick.ok").count()) === frames && (await win.locator("#calls .fm-sum").count()) === 0 && (await win.textContent("#approve")) === "Send",
        `built: all ${frames} frames ticked by the dry run, no repeated summary, and Send is on`);
      await win.locator("#calls .fm-card").first().click();
      const t2 = (await win.textContent("#calls")) ?? "";
      await win.screenshot({ path: join(here, "out-built.png") });
      await win.locator("#calls .fm-card").first().click();
      check(await win.locator("#calls .fx-frame:not([hidden])").count() === 0, "tapping it again closes it: no details until a frame is tapped");
      check(!/Transaction hash/.test(t2) && !/Not sent yet/.test(t2) && /MethodID/.test(t2) && /Groth16 proof points/.test(t2) && /Signatures/.test(t2),
        "each frame can be inspected right there (decoded data with the proof), and All fields has no hash or status before it is sent");
      check((await win.locator("#calls .hex").count()) > 0 && (await win.locator("#calls .copy, #calls button:text-is('Copy')").count()) === 0,
        "long 0x values show as 0x1234…4321 chips, with no Copy text buttons");
    }
  };
  const lines = async (p = page) => logs.get(p) ?? [];
  const logged = async (re: RegExp, p = page, timeout = 120_000) => {
    for (const t0 = Date.now(); !(logs.get(p) ?? []).some((l) => re.test(l)); await new Promise((r) => setTimeout(r, 250)))
      if (Date.now() - t0 > timeout) throw new Error(`the page never logged ${re}`);
  };
  /** The site's account, as the page shows it. */
  const acct = (p = page) => p.getAttribute("#me", "data-account");
  /** Waits until the page shows an account other than `from`. */
  const movedFrom = (from: string, p = page) =>
    p.waitForFunction((a: string) => (document.getElementById("me")!.dataset.account ?? "") !== a, from, { timeout: 120_000 });
  /** Posts posts by the current account in the feed (the "you" tag). */
  const postedByMe = (n: number) => page.waitForFunction((k: number) => document.querySelectorAll("#feed .you").length === k, n, { timeout: 120_000 });
  /** A post sent with eth_sendTransaction straight from the page (the site's own button sends wallet_sendCalls). */
  const plainPost = (text: string) => page.evaluate(async (t: string) => {
    const eth = (window as any).ethereum;
    const { framecaster } = await (await fetch("config.json")).json();
    const [from] = await eth.request({ method: "eth_accounts" });
    const b = new TextEncoder().encode(t);
    const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    const w = (n: number) => n.toString(16).padStart(64, "0");
    const data = "0x8ee93cf3" + w(32) + w(b.length) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
    const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from, to: framecaster, data }] });
    for (let i = 0; i < 180; i++) {
      const r = await eth.request({ method: "eth_getTransactionReceipt", params: [hash] });
      if (r) return r.status as string;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return "not mined";
  }, text);

  step("connect with the defaults: a new account, new account after every transaction");
  await approve(() => page.click("#connect"), async (win) => {
    check(await win.isChecked("input[name=use][value=new]"), "the window picks a new account by default");
    await win.screenshot({ path: join(here, "out-e2e-connect-first.png") });
    check(await win.isDisabled("input[name=use][value=existing]"), "the existing-account choice is off while the wallet has none");
  });
  await logged(/Connected 0x/);
  check((await lines()).some((l) => /privacyPaymaster supported/.test(l)) && await page.isHidden("#error"), "the wallet reports privacyPaymaster, and the page shows no error");

  step("capability rules (no window opens for these)");
  const code = (params: object) => page.evaluate(async (p: object) => {
    const eth = (window as any).ethereum;
    const [from] = await eth.request({ method: "eth_accounts" });
    try {
      await eth.request({ method: "wallet_sendCalls", params: [{ version: "2.0.0", chainId: "0x539", from, calls: [{ to: from, data: "0x" }], ...p }] });
      return "accepted";
    } catch (e: any) {
      return e.code;
    }
  }, params);
  check((await code({ capabilities: { privacyPaymaster: {} } })) === -32602, "empty privacyPaymaster object is refused with -32602");
  check((await code({ capabilities: { somethingElse: { url: "x" } } })) === 5700, "an unknown required capability is refused with 5700");
  check((await code({ chainId: "0x1" })) === 5710, "another chain is refused with 5710");

  step("wallet_sendCalls with privacyPaymaster required");
  const first = await acct();
  await page.fill("#text", "gm from ETHGlobal Mumbai");
  const t0 = Date.now();
  await approve(() => page.click("#calls"), async (win) => {
    await win.screenshot({ path: join(here, "out-e2e-send.png") });
    check(await win.isHidden("#privacy"), "a fresh account: no warning");
    const planned = await win.locator(".fx-frame").count();
    await win.locator("#calls .fm-card").nth(2).click();
    await win.locator(".fx-frame").nth(2).locator("details.data > summary").click();
    const call = (await win.locator(".fx-frame").nth(2).textContent()) ?? "";
    check(planned === 4 && /post\(string text\)/.test(call) && /gm from ETHGlobal Mumbai/.test(call),
      `the window breaks the transaction into ${planned} frames and decodes the call to post(string text)`);
    await win.screenshot({ path: join(here, "out-e2e-breakdown.png"), fullPage: true });
  });
  await logged(/Batch status|wallet_sendCalls failed/);
  const batch = (await lines()).find((l) => /Batch status|failed/.test(l)) ?? "";
  check(/Batch status 200/.test(batch), `${batch} (${((Date.now() - t0) / 1000).toFixed(1)} s from click)`);
  await page.waitForFunction(() => document.getElementById("calls")!.textContent === "Post", null, { timeout: 60_000 });
  await page.screenshot({ path: join(here, "out-demo-page.png"), fullPage: true });
  await movedFrom(first!);
  const second = await acct();
  check(second !== first, `the site moved to a new account ${second}`);
  await postedByMe(0);
  // A public RPC can answer the receipt before its logs show up, so give the feed a moment (it refreshes every 15 s).
  const inFeed = await page.waitForFunction(() => /gm from ETHGlobal Mumbai/.test(document.getElementById("feed")?.textContent ?? ""), null, { timeout: 45_000 }).then(() => true, () => false);
  check(inFeed, "the post is in the feed");

  step("eth_sendTransaction from the new account");
  let sent: Promise<string> | undefined;
  await approve(async () => { sent = plainPost("a plain transaction, gas still paid privately"); });
  const st = await sent!;
  check(st === "0x1", `mined (${st})`);
  await movedFrom(second!);
  const third = await acct();
  check(third !== second, `and moved again to ${third}`);
  const bal = await page.evaluate(async () => {
    const eth = (window as any).ethereum;
    const [a] = await eth.request({ method: "eth_accounts" });
    return BigInt(await eth.request({ method: "eth_getBalance", params: [a, "latest"] })).toString();
  });
  check(bal === "0", `the site's account holds ${bal} wei`);

  step("the popup: keep one account on this site");
  const settings = await ctx.newPage();
  // As if opened over the site's tab: the top bar names the site, with a green dot, and opens its page.
  await settings.goto(`chrome-extension://${id}/popup.html?tab=${encodeURIComponent("http://127.0.0.1:8142")}`);
  await settings.waitForSelector("#site-chip:not([hidden]) .dot:not(.off)");
  check((await settings.textContent("#site-chip .site-chip-name")) === "127.0.0.1:8142", `the top bar shows the connected site: ${await settings.textContent("#site-chip")}`);
  await settings.screenshot({ path: join(here, "out-popup-home-chip.png") });
  await settings.click("#site-chip");
  await settings.waitForSelector("#site-private");
  check(await settings.isChecked("#site-private"), "the site page shows the site's switch on");
  await settings.click("#site-private");
  await settings.waitForFunction(() => /keeps its current account/.test(document.getElementById("status")!.textContent ?? ""));
  await settings.click('#tabbar button[data-view="settings"]');
  await settings.waitForFunction(() => (document.getElementById("settings-chain")!.textContent ?? "") !== "");
  check(await settings.isChecked("#default-private"), "the default for new sites stays a new account per transaction");
  await settings.close();
  await approve(async () => { sent = plainPost("same account as my last post"); }, async (win) => {
    check(await win.isHidden("#privacy"), "this account hasn't sent anything yet: no warning");
  });
  check((await sent!) === "0x1", "mined");
  await postedByMe(1);
  // A post that tries to inject markup and script, with a hidden direction override (U+202E).
  const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>\u202Eevil';
  await page.fill("#text", evil);
  await approve(() => page.click("#calls"), async (win) => {
    await win.locator("#calls .fm-card").nth(2).click();
    const warned = (await win.getAttribute("#privacy", "aria-label")) ?? "";
    check(await win.isVisible("#privacy") && /^Account used before: 1 earlier transaction on 127\.0\.0\.1:8142/.test(warned), `same account again: the window warns: ${warned}`);
    await win.screenshot({ path: join(here, "out-e2e-send-reused.png") });
    await win.locator(".fx-frame").nth(2).locator("details.data > summary").click();
    const call = (await win.locator(".fx-frame").nth(2).textContent()) ?? "";
    // The page strips the hidden character before sending (the wallet would show one as \\u202e).
    check(call.includes("<script>") && !call.includes("\u202E") && (await win.locator(".fx-frame img, .fx-frame script").count()) === 0,
      "the wallet shows the post's markup as text, and the page already took the hidden character out");
  });
  await postedByMe(2);
  const shown = await page.evaluate(() => {
    const p = [...document.querySelectorAll("#feed .text")].find((e) => e.textContent!.includes("<script>"));
    return { text: p?.textContent ?? "", tags: document.querySelectorAll("#feed img, #feed script").length, xss: (window as any).__xss ?? null };
  });
  check(shown.text === '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>evil' && shown.tags === 0 && shown.xss === null,
    "the feed shows the post's markup as plain text, no tag in the DOM, no script ran, the hidden character removed");
  check((await acct()) === third, "two transactions later the site still has the same account, with 2 posts");

  step("a thread of three posts in one transaction");
  // A tag per run, so a rerun on the same chain finds its own posts.
  const tag = Date.now().toString(36).slice(-5);
  const head = `a thread, 1: three posts (${tag})`, said = `a comment on the thread (${tag})`, back = `a reply to that comment (${tag})`;
  await page.fill("#text", head);
  await page.click("#add-part");
  await page.fill('#parts .part:nth-child(2) textarea', "2: each post is its own call frame");
  await page.click("#add-part");
  await page.fill('#parts .part:nth-child(3) textarea', "3: one private proof pays for all of them");
  check((await page.textContent("#calls")) === "Post thread (3)", "the button reads Post thread (3)");
  await page.fill("#text", "x".repeat(161));
  check(await page.isDisabled("#calls") && /161\/160/.test((await page.textContent("#parts")) ?? ""), "161 bytes is refused, with the counter in red");
  await page.fill("#text", head);
  // This one expires in 10 minutes: an EIP-8141 expiry frame goes first; the thread is all or nothing.
  await page.selectOption("#expires", "600");
  await approve(() => page.click("#calls"), async (win) => {
    const n = await win.locator(".fx-frame").count();
    const t = (await win.textContent("#calls")) ?? "";
    check(n === 7 && /post\(string text\)/.test(t) && /thread\(string text\)/.test(t), `the window shows ${n} frames: expiry, then a post and two thread calls`);
    const first = win.locator(".fm-card").first();
    check(/EXPIRY/.test((await first.textContent()) ?? "") && /until/.test((await first.textContent()) ?? ""), "frame 0 is the EXPIRY frame, with its time");
    check(await win.isVisible("#expiry-row") && /in 1\d min|in 9 min|in 10 min/.test((await win.textContent("#expiry")) ?? ""), `the window shows when it expires: ${await win.textContent("#expiry")}`);
    check(await win.isVisible("#atomic-row") && (await win.locator(".fm-card.batched").count()) === 3, "and that the three calls are all or nothing (one atomic batch)");
    // The account sent twice already: the warning offers a new one, and the user takes it.
    check(/^Account used before: 2 earlier transactions/.test((await win.getAttribute("#privacy", "aria-label")) ?? ""), "the window warns about the used account");
    const was = (await win.getAttribute("#from", "title")) ?? "";
    await win.click("#use-new");
    await win.waitForSelector("#switched:not([hidden])");
    const now = (await win.getAttribute("#from", "title")) ?? "";
    check(await win.isHidden("#privacy") && now !== was && /^0x/.test(now), `"Use a new account instead" sends from ${now} instead`);
    await win.screenshot({ path: join(here, "out-e2e-send-switched.png") });
  });
  const root = page.locator(".post").filter({ hasText: head });
  await root.waitFor({ timeout: 120_000 });
  await page.selectOption("#expires", "0");
  const fourth = await acct();
  check(fourth !== third, `the site now sees the new account ${fourth}`);
  check((await root.locator(".post-row").count()) === 3 && (await root.locator(".post-row.threaded").count()) === 2,
    "the feed shows it as one card: three parts joined by a line");
  await page.screenshot({ path: join(here, "out-demo-thread.png"), fullPage: true });

  step("comments, a reply to a comment, and a like");
  await root.locator(".post-row").first().locator(".reply-btn").click();
  await root.locator(".reply-box textarea").fill(said);
  await approve(() => root.locator(".reply-box .btn").click());
  await page.waitForFunction((t) => document.getElementById("feed")!.textContent!.includes(t), said, { timeout: 120_000 });
  const comment = root.locator(".replies.top > .reply").filter({ hasText: said });
  check((await comment.count()) === 1 && /Replying to @/.test((await comment.textContent()) ?? ""), "the comment shows under the post, replying to its author");
  await comment.locator(".post-actions .reply-btn").first().click();
  await comment.locator(".reply-box textarea").fill(back);
  await approve(() => comment.locator(".reply-box .btn").click());
  await page.waitForFunction((t) => document.getElementById("feed")!.textContent!.includes(t), back, { timeout: 120_000 });
  const nested = root.locator(".replies.top > .reply .replies.nested > .reply").filter({ hasText: back });
  check((await nested.count()) === 1, "the reply to the comment is nested under it");
  check(/2/.test((await root.locator(".post-row").first().locator(".reply-btn").textContent()) ?? ""), "the post counts 2 replies");
  await root.locator(".post-row").first().locator(".like-btn").click();
  const liker = await ctx.waitForEvent("page");
  await liker.setViewportSize({ width: 400, height: 640 });
  await liker.waitForSelector("#approve:not([disabled])", { timeout: 180_000 });
  await liker.click("#approve");
  await page.waitForSelector('.post .post-row:first-child .like-btn.on', { timeout: 120_000 });
  check(/1/.test((await root.locator(".post-row").first().locator(".like-btn").textContent()) ?? ""), "the like shows: 1, filled in");
  await page.screenshot({ path: join(here, "out-demo-replies.png"), fullPage: true });
  const wide = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(here, "out-demo-phone.png") });
  if (wide) await page.setViewportSize(wide);

  step("a second site connects with an existing account");
  const other = await ctx.newPage();
  watch(other);
  other.on("console", (m: any) => pageLog.push(`[localhost] ${m.text()}`));
  await other.goto("http://localhost:8142/");
  await approve(() => other.click("#connect"), async (win) => {
    check(await win.isEnabled("input[name=use][value=existing]"), "the existing-account choice is offered");
    await win.click("#existing-choice");
    check(await win.isChecked("input[name=use][value=existing]"), "picking it selects that choice");
    check(await win.isVisible(".acct-option"), "and lists the accounts to pick from");
    const warning = (await win.textContent("#existing-warning")) ?? "";
    check(/same person/.test(warning), `with a red warning: ${warning}`);
    await win.screenshot({ path: join(here, "out-e2e-connect.png"), fullPage: true });
  });
  await logged(/Connected 0x/, other);
  const shared = (await acct(other))!;
  check([first, second, third, fourth].map((a) => a?.toLowerCase()).includes(shared.toLowerCase()), `the second site sees ${shared}, an account the first site used`);

  step("the popup after all that");
  const after = await ctx.newPage();
  await after.goto(`chrome-extension://${id}/popup.html?tab=${encodeURIComponent("http://localhost:8142")}`);
  await after.waitForFunction(() => document.getElementById("balance")!.textContent !== "…");
  console.log(`   private funds ${await after.textContent("#balance")} ETH`);
  await after.click('#tabbar button[data-view="settings"]');
  await after.waitForSelector(".site-row");
  const summary = await after.textContent('.site-row[data-site="http://127.0.0.1:8142"] .site-sub');
  // 4 posts, then the thread, two replies and a like
  check(/4 accounts · 8 transactions/.test(summary ?? ""), `popup: ${summary}`);
  check((await after.$$(".site-row .tag.shared")).length === 2, "the popup flags the shared account on both sites");
  const shots = async (theme: string) => {
    await after.emulateMedia({ colorScheme: theme });
    for (const v of ["home", "accounts", "history", "settings"]) {
      await after.click(`#tabbar button[data-view="${v}"]`);
      await after.waitForTimeout(300);
      await after.screenshot({ path: join(here, `out-popup-${v}-${theme}.png`) });
    }
    await after.click("#site-chip");
    await after.waitForSelector("#site-private");
    await after.screenshot({ path: join(here, `out-popup-site-${theme}.png`) });
  };
  await after.setViewportSize({ width: 360, height: 600 });
  await after.click('#tabbar button[data-view="history"]');
  await after.waitForTimeout(300);
  check((await after.$$(".history-item")).length === 8, `history lists ${(await after.$$(".history-item")).length} transactions`);
  const explorer = JSON.parse(readFileSync(join(here, "out", "config.json"), "utf8")).explorer;
  if (explorer) {
    const hrefs = await after.locator(".history-item .explorer-link").evaluateAll((as: any[]) => as.map((a) => a.href));
    check(hrefs.length === 8 && hrefs.every((h: string) => h.startsWith(`${explorer}/tx/0x`)), `each History item links to the explorer (${hrefs[0]})`);
  } else console.log("   (no explorer configured: no explorer links)");
  // The oldest is the first sendCalls: open it and check the mined frames, decoded.
  await after.locator(".history-item").last().click();
  await after.waitForSelector("#tx .fm-card");
  if (explorer) check(/\/tx\/0x/.test((await after.getAttribute("#tx .explorer-link", "href")) ?? ""), "the transaction view has a View on explorer link");
  const okFrames = await after.locator("#tx .fx-frame.ok").count();
  check((await after.locator("#tx .fm-card").count()) === 4 && (await after.locator("#tx .fm-tick.ok").count()) === 4 && /On chain/.test((await after.textContent("#tx-status")) ?? ""),
    "the transaction shows at a glance: On chain, and four frame cards, each ticked");
  await after.screenshot({ path: join(here, "out-popup-tx-glance.png"), fullPage: true });
  await after.locator("#tx .fm-card").nth(3).click();
  await after.locator("#tx .fx-frame").nth(3).locator("details.data > summary").click();
  const settleText = (await after.locator("#tx .fx-frame").nth(3).textContent()) ?? "";
  check(okFrames === 4 && /settleSponsored/.test(settleText) && /nf1/.test(settleText) && /the sender/.test(settleText),
    `a transaction in History shows its ${okFrames} mined frames, with the settle data decoded`);
  const txText = (await after.textContent("#tx")) ?? "";
  check(/\(privacy pool\)/.test(txText) && /Nonce keys\[0\]/.test(txText) && /Nonce sequence0/.test(txText) && /Recent roots/.test(txText),
    "its overview shows the payer (the privacy pool), nonce key [0] and sequence 0, and the recent root");
  await after.locator("#tx .fx-frame").nth(3).locator(".data-tabs .tab", { hasText: "Words" }).click();
  check(/MethodID: 0xf25d18a7/.test((await after.locator("#tx .fx-frame").nth(3).textContent()) ?? ""), "and the settle data as words, with its method id");
  await after.screenshot({ path: join(here, "out-popup-tx.png"), fullPage: true });
  await after.click("#tx-back");
  await after.click('#tabbar button[data-view="accounts"]');
  await after.waitForTimeout(300);
  const nAll = Number(await after.textContent("#count-all"));
  check(nAll >= 4 && (await after.locator("#account-list .account-item").count()) === nAll,
    `Accounts lists all ${nAll} accounts in one list`);
  await after.click("#seg-app");
  const groups = await after.locator(".app-group").evaluateAll((g: any[]) => g.map((x) => x.dataset.site));
  check(groups.includes("http://127.0.0.1:8142") && groups.includes("http://localhost:8142") &&
    (await after.locator('.app-group[data-site="http://127.0.0.1:8142"] .account-item').count()) >= 4,
    `By app groups them under each site: ${groups.join(", ")}`);
  await after.screenshot({ path: join(here, "out-popup-accounts-by-app.png") });
  await after.click("#seg-all");
  await shots("light");
  await shots("dark");
  await after.emulateMedia({ colorScheme: "light" });

  step("switch the second site's account from the popup");
  const before = await acct(other);
  await after.click("#switch-account");
  await after.waitForSelector("#switch-list:not([hidden])");
  check((await after.locator("#switch-list .switch-row").count()) >= 2 && (await after.locator("#switch-list .switch-row .warn-text").count()) >= 1,
    "the popup offers a new account and the wallet's others, used ones marked");
  await after.screenshot({ path: join(here, "out-popup-switch.png") });
  await after.click('#switch-list .switch-row[data-account="new"]');
  await after.waitForFunction(() => /now sees/.test(document.getElementById("status")!.textContent ?? ""));
  await other.waitForFunction((b) => document.getElementById("me")?.getAttribute("data-account") !== b, before, { timeout: 10_000 });
  check((await acct(other)) !== before, `the site sees the new account ${await acct(other)}`);

  step("disconnect the second site from its page");
  await after.click("#disconnect");
  await after.waitForFunction(() => /Disconnected/.test(document.getElementById("status")!.textContent ?? ""));
  const left = await other.evaluate(() => (window as any).ethereum.request({ method: "eth_accounts" }));
  check(Array.isArray(left) && left.length === 0, `the site now sees ${JSON.stringify(left)}`);
  await after.waitForSelector("#site-chip .dot.off");
  check((await after.$$('.site-row[data-site="http://localhost:8142"]')).length === 0, "and is gone from the popup's sites, and the top bar shows it not connected");
  await page.screenshot({ path: join(here, "out-e2e-page.png") });
  step("cancel after inspecting: nothing is spent");
  {
    const c = await ctx.newPage();
    await c.setViewportSize({ width: 400, height: 640 });
    await c.goto(`chrome-extension://${id}/withdraw.html`);
    await c.waitForFunction(() => /ETH|nothing/.test(document.getElementById("max")!.textContent ?? ""));
    const before = await c.textContent("#balance");
    await c.fill("#to", "0x000000000000000000000000000000000000dEaD");
    await c.fill("#amount", "0.001");
    await c.click("#go");
    await c.waitForSelector("#inspect-cancel", { timeout: 180_000 });
    await c.click("#inspect-cancel");
    await c.waitForFunction(() => document.getElementById("progress-title")!.textContent === "Not sent");
    await c.reload();
    await c.waitForFunction(() => /ETH|nothing/.test(document.getElementById("max")!.textContent ?? ""));
    check((await c.textContent("#balance")) === before, `cancelled: private funds still ${before}`);
    await c.close();
  }
  step("withdraw private funds to a new address");
  const to = "0x" + [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const w = await ctx.newPage();
  await w.setViewportSize({ width: 400, height: 620 });
  await w.goto(`chrome-extension://${id}/withdraw.html`);
  await w.waitForFunction(() => /ETH|nothing/.test(document.getElementById("max")!.textContent ?? ""));
  check(/ETH/.test((await w.textContent("#max")) ?? ""), `the window offers at most ${await w.textContent("#max")}`);
  await w.fill("#to", to);
  await w.fill("#amount", "0.01");
  await w.screenshot({ path: join(here, "out-withdraw.png") });
  await w.click("#go");
  await submitReview(w);
  await w.waitForFunction(() => /^Sent$|Couldn't/.test(document.getElementById("progress-title")!.textContent ?? ""), null, { timeout: 180_000 });
  check((await w.textContent("#progress-title")) === "Sent", `withdraw: ${await w.textContent("#status")}`);
  const got = await w.evaluate(async (a) => {
    const cfg = await (await fetch("config.json")).json();
    const r = await fetch(cfg.rpc, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [a, "latest"] }) });
    return (await r.json()).result;
  }, to);
  check(BigInt(got) === 10n ** 16n, `the address now holds ${BigInt(got)} wei`);
  await after.reload();
  await after.click('#tabbar button[data-view="history"]');
  await after.waitForTimeout(300);
  check(/Sent 0\.010* ETH to/.test((await after.textContent("#history-list")) ?? ""), "and History lists the withdrawal");
  await after.click(".history-item");
  await after.waitForFunction(() => /MethodID/.test(document.getElementById("tx")!.textContent ?? ""), null, { timeout: 20_000 });
  const wtx = (await after.textContent("#tx")) ?? "";
  check(/Privacy pool checks the proof/.test(wtx) && /Privacy pool pays out/.test(wtx) && /MethodID: 0x921fcac7/.test(wtx) && /The privacy pool/.test(wtx),
    "its view shows the pool as sender: proof, settle(Spend), payout");
  await after.screenshot({ path: join(here, "out-withdraw-tx.png"), fullPage: true });

  step("send privately to the wallet's own private address, and receive it");
  await after.click('#tabbar button[data-view="home"]');
  await after.click("#receive");
  const mine = ((await after.textContent("#private-address")) ?? "").trim();
  check(/^nk1[0-9a-f]{130}$/.test(mine), `the popup shows a private address ${mine.slice(0, 12)}…`);
  await after.screenshot({ path: join(here, "out-receive.png") });
  const p2 = await ctx.newPage();
  await p2.setViewportSize({ width: 400, height: 640 });
  await p2.goto(`chrome-extension://${id}/withdraw.html`);
  await p2.waitForFunction(() => /ETH|nothing/.test(document.getElementById("max")!.textContent ?? ""));
  await p2.fill("#to", mine);
  check((await p2.textContent("#go")) === "Send privately" && (await p2.textContent("#note-title")) === "Stays private", "a private address makes it a private transfer");
  await p2.fill("#amount", "0.02");
  await p2.screenshot({ path: join(here, "out-send-private.png") });
  await p2.click("#go");
  await submitReview(p2);
  await p2.waitForFunction(() => /^Sent$|Couldn't/.test(document.getElementById("progress-title")!.textContent ?? ""), null, { timeout: 180_000 });
  check((await p2.textContent("#progress-title")) === "Sent", `private transfer: ${await p2.textContent("#status")}`);
  await after.reload();
  await after.waitForFunction(() => /Received 0\.02/.test(document.getElementById("status")!.textContent ?? ""), null, { timeout: 30_000 });
  await after.click('#tabbar button[data-view="history"]');
  await after.waitForTimeout(300);
  const hist = (await after.textContent("#history-list")) ?? "";
  check(/Sent 0\.020* ETH privately/.test(hist) && /Received 0\.020* ETH privately/.test(hist), "History lists the transfer sent and received");
  await page.close().catch(() => undefined);
  if (failed) throw new Error("a check failed");
} catch (e) {
  console.error(e);
  failed = true;
  console.log("--- page log ---\n" + pageLog.slice(-20).join("\n"));
  for (const p of ctx.pages()) {
    const where = new URL(p.url());
    const status = await p.textContent("#status").catch(() => null);
    const log = logs.has(p) ? logs.get(p)!.slice(-12).join(" | ") : null;
    console.log(`--- ${where.host}${where.pathname}: status ${status ?? "-"} | log ${log ?? "-"}`);
  }
} finally {
  await ctx.close();
  server.kill();
}
console.log(failed ? "FAILED" : "PASSED");
process.exit(failed ? 1 : 0);
