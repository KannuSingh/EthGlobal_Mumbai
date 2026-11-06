/**
 * Drives the extension in Chromium against the local chain: add gas money, connect the guest
 * book, sign once with wallet_sendCalls (privacyPaymaster required) and once with
 * eth_sendTransaction, approving each in the extension's window, and checks the capability rules.
 * Needs Playwright (the machine's global install, or PLAYWRIGHT=path) and a built out/ against a
 * deployed pool:
 *
 *   node privacy-pool/extension/build.ts --via privileged && node privacy-pool/extension/e2e.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
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
});
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
  page.on("console", (m: any) => pageLog.push(m.text()));
  await page.goto("http://127.0.0.1:8142/");
  /** Opens an approval window with `action`, lets `choose` pick options in it, and approves. */
  const approve = async (action: () => Promise<unknown>, choose?: (win: any) => Promise<void>) => {
    const [win] = await Promise.all([ctx.waitForEvent("page"), action()]);
    await win.setViewportSize({ width: 400, height: 640 });
    await win.waitForSelector("#approve:not([disabled])");
    await win.waitForFunction(() => document.getElementById("title")!.textContent !== "Loading…");
    console.log(`   approval window: ${await win.textContent("#title")} (${await win.textContent("#site")})`);
    if (choose) await choose(win);
    await win.click("#approve");
    return win;
  };
  const logText = (p = page) => p.textContent("#log");
  const logged = (re: RegExp, p = page, timeout = 120_000) =>
    p.waitForFunction((src: string) => new RegExp(src).test(document.getElementById("log")!.textContent ?? ""), re.source, { timeout });
  /** Waits until the page shows an account other than `from`. */
  const movedFrom = (from: string, p = page) =>
    p.waitForFunction((a: string) => document.getElementById("account")!.textContent !== a, from, { timeout: 120_000 });
  const lines = async (p = page) => (await p.$$eval("#log li", (l: any[]) => l.map((x) => x.textContent))) as string[];

  step("connect with the defaults: a new account, new account after every transaction");
  await approve(() => page.click("#connect"), async (win) => {
    check(await win.isChecked("input[name=use][value=new]"), "the window picks a new account by default");
    check(await win.isChecked("#mode-private"), "and a new account after every transaction by default");
    await win.screenshot({ path: join(here, "out-e2e-connect-first.png") });
    check(await win.isDisabled("input[name=use][value=existing]"), "the existing-account choice is off while the wallet has none");
  });
  await logged(/Connected 0x/);
  check(/supports privacyPaymaster/.test(await page.textContent("#caps")), `capabilities: ${await page.textContent("#caps")}`);

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
  const first = await page.textContent("#account");
  const t0 = Date.now();
  await approve(() => page.click("#calls"), async (win) => {
    await win.screenshot({ path: join(here, "out-e2e-send.png") });
    check(/^Private/.test(await win.textContent("#privacy")), `the window says: ${await win.textContent("#privacy")}`);
  });
  await logged(/Batch status|wallet_sendCalls failed/);
  const batch = (await lines()).find((l) => /Batch status|failed/.test(l)) ?? "";
  check(/Batch status 200/.test(batch), `${batch} (${((Date.now() - t0) / 1000).toFixed(1)} s from click)`);
  await movedFrom(first!);
  const second = await page.textContent("#account");
  check(second !== first, `the site moved to a new account ${second}`);
  await page.waitForFunction(() => document.getElementById("entries")!.textContent === "0");
  check(true, "the new account has 0 guest book entries");

  step("eth_sendTransaction from the new account");
  await approve(() => page.click("#tx"));
  await logged(/Mined with status|eth_sendTransaction failed/);
  check(/Mined with status 0x1/.test((await logText())!), "mined");
  await movedFrom(second!);
  const third = await page.textContent("#account");
  check(third !== second, `and moved again to ${third}`);
  const bal = await page.evaluate(async () => {
    const eth = (window as any).ethereum;
    const [a] = await eth.request({ method: "eth_accounts" });
    return BigInt(await eth.request({ method: "eth_getBalance", params: [a, "latest"] })).toString();
  });
  check(bal === "0", `the site's account holds ${bal} wei`);

  step("the popup: keep one account on this site");
  const settings = await ctx.newPage();
  await settings.goto(`chrome-extension://${id}/popup.html`);
  await settings.click('.site-row[data-site="http://127.0.0.1:8142"]');
  await settings.waitForSelector("#site-private");
  check(await settings.isChecked("#site-private"), "the site page shows the site's switch on");
  await settings.click("#site-private");
  await settings.waitForFunction(() => /keeps its current account/.test(document.getElementById("status")!.textContent ?? ""));
  await settings.click('#tabbar button[data-view="settings"]');
  await settings.waitForFunction(() => (document.getElementById("settings-chain")!.textContent ?? "") !== "");
  check(await settings.isChecked("#default-private"), "the default for new sites stays a new account per transaction");
  await settings.close();
  await approve(() => page.click("#tx"), async (win) => {
    check(/^Linkable/.test(await win.textContent("#privacy")), `the window warns: ${await win.textContent("#privacy")}`);
  });
  await page.waitForFunction(() => document.getElementById("entries")!.textContent === "1", null, { timeout: 120_000 });
  await approve(() => page.click("#calls"));
  await page.waitForFunction(() => document.getElementById("entries")!.textContent === "2", null, { timeout: 120_000 });
  check((await page.textContent("#account")) === third, "two transactions later the site still has the same account, with 2 entries");

  step("a second site connects with an existing account");
  const other = await ctx.newPage();
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
  const shared = (await other.textContent("#account"))!;
  check([first, second, third].map((a) => a?.toLowerCase()).includes(shared.toLowerCase()), `the second site sees ${shared}, an account the first site used`);

  step("the popup after all that");
  const after = await ctx.newPage();
  await after.goto(`chrome-extension://${id}/popup.html`);
  await after.waitForFunction(() => document.getElementById("balance")!.textContent !== "…");
  console.log(`   private funds ${await after.textContent("#balance")} ETH`);
  const summary = await after.textContent('.site-row[data-site="http://127.0.0.1:8142"] .site-sub');
  check(/3 accounts · 4 transactions/.test(summary ?? ""), `popup: ${summary}`);
  check((await after.$$(".site-row .tag.shared")).length === 2, "the popup flags the shared account on both sites");
  const shots = async (theme: string) => {
    await after.emulateMedia({ colorScheme: theme });
    for (const v of ["home", "accounts", "history", "settings"]) {
      await after.click(`#tabbar button[data-view="${v}"]`);
      await after.waitForTimeout(300);
      await after.screenshot({ path: join(here, `out-popup-${v}-${theme}.png`) });
    }
    await after.click(`#tabbar button[data-view="home"]`);
    await after.click('.site-row[data-site="http://localhost:8142"]');
    await after.waitForSelector("#site-private");
    await after.screenshot({ path: join(here, `out-popup-site-${theme}.png`) });
  };
  await after.setViewportSize({ width: 360, height: 600 });
  await after.click('#tabbar button[data-view="history"]');
  await after.waitForTimeout(300);
  check((await after.$$(".history-item")).length === 4, `history lists ${(await after.$$(".history-item")).length} transactions`);
  await after.click('#tabbar button[data-view="accounts"]');
  await after.waitForTimeout(300);
  console.log(`   accounts: ${await after.textContent("#count-private")} private, ${await after.textContent("#count-public")} public`);
  await shots("light");
  await shots("dark");
  await after.emulateMedia({ colorScheme: "light" });

  step("disconnect the second site from its page");
  await after.click("#disconnect");
  await after.waitForFunction(() => /Disconnected/.test(document.getElementById("status")!.textContent ?? ""));
  const left = await other.evaluate(() => (window as any).ethereum.request({ method: "eth_accounts" }));
  check(Array.isArray(left) && left.length === 0, `the site now sees ${JSON.stringify(left)}`);
  check((await after.$$('.site-row[data-site="http://localhost:8142"]')).length === 0, "and is gone from the popup's sites");
  await page.screenshot({ path: join(here, "out-e2e-page.png") });
  await page.close().catch(() => undefined);
  if (failed) throw new Error("a check failed");
} catch (e) {
  console.error(e);
  failed = true;
  console.log("--- page log ---\n" + pageLog.slice(-20).join("\n"));
  for (const p of ctx.pages()) {
    const where = new URL(p.url());
    const status = await p.textContent("#status").catch(() => null);
    const log = await p.textContent("#log").catch(() => null);
    console.log(`--- ${where.host}${where.pathname}: status ${status ?? "-"} | log ${log ?? "-"}`);
  }
} finally {
  await ctx.close();
  server.kill();
}
console.log(failed ? "FAILED" : "PASSED");
process.exit(failed ? 1 : 0);
