/**
 * The extension's service worker: answers the dapp's provider requests. Reads go to the node.
 * Connecting, eth_sendTransaction and wallet_sendCalls open an approval window, which proves and
 * sends; the request's answer waits for it. Every site gets its own account, which holds no ETH:
 * its gas is paid from the user's privacy pool notes (the privacyPaymaster capability).
 */
import { addressOf, makeRpc, newAccountKey } from "../../core.ts";
import { config, knownAccounts, load, modeOf, save } from "./store.ts";

/** EIP-1193 and EIP-5792 errors. */
const err = (code: number, message: string) => ({ error: { code, message } });
const USER_REJECTED = 4001;
const UNAUTHORIZED = 4100;
const UNSUPPORTED_METHOD = 4200;
const INVALID_PARAMS = -32602;
const UNSUPPORTED_CAPABILITY = 5700;
const UNSUPPORTED_CHAIN = 5710;
const UNKNOWN_BUNDLE = 5730;

/** Reads the node answers for any site. */
const READS = new Set([
  "eth_blockNumber", "eth_call", "eth_estimateGas", "eth_gasPrice", "eth_getBalance", "eth_getBlockByNumber",
  "eth_getBlockByHash", "eth_getCode", "eth_getLogs", "eth_getStorageAt", "eth_getTransactionByHash",
  "eth_getTransactionCount", "eth_getTransactionReceipt", "eth_maxPriorityFeePerGas", "eth_feeHistory",
]);

interface Pending { resolve: (reply: any) => void; request: any }
const pending = new Map<string, Pending>();
const windows = new Map<number, string>();

async function openApproval(kind: string, origin: string, body: object): Promise<any> {
  const id = crypto.randomUUID();
  const reply = new Promise<any>((resolve) => pending.set(id, { resolve, request: { id, kind, origin, ...body } }));
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`approve.html?id=${id}`), type: "popup", width: 400, height: 620,
  });
  if (win.id !== undefined) windows.set(win.id, id);
  return reply;
}

chrome.windows.onRemoved.addListener((winId) => {
  const id = windows.get(winId);
  windows.delete(winId);
  const p = id && pending.get(id);
  if (p) {
    pending.delete(id!);
    p.resolve(err(USER_REJECTED, "the user closed the approval window"));
  }
});

async function account(origin: string): Promise<string> {
  const s = await load();
  if (!s.accounts[origin]) {
    s.accounts[origin] = newAccountKey();
    s.addresses[origin] = addressOf(s.accounts[origin]);
    await save({ accounts: s.accounts, addresses: s.addresses });
  }
  return addressOf(s.accounts[origin]);
}

/**
 * Records a transaction the site's current account sent and, with the "new account for every
 * transaction" setting, moves the site to a fresh account. The content script sees the new
 * address in storage and tells the page (accountsChanged).
 */
async function afterSend(origin: string, from: string, hash: string, method: string, calls: number): Promise<void> {
  const s = await load();
  const list = (s.used[origin] ??= []);
  let entry = list.find((u) => u.address === from);
  if (!entry) list.push((entry = { address: from, key: s.accounts[origin], txs: [] }));
  entry.txs.push(hash);
  s.history.push({ origin, from, hash, method, calls, at: Date.now(), mode: modeOf(s, origin) });
  if (modeOf(s, origin) === "transaction") {
    s.accounts[origin] = newAccountKey();
    s.addresses[origin] = addressOf(s.accounts[origin]);
  }
  await save({ used: s.used, accounts: s.accounts, addresses: s.addresses, history: s.history });
}

/** EIP-5792 calls, checked; the capability rules are the privacyPaymaster draft's. */
function checkBatch(p: any, chainHex: string, from: string): { calls: any[]; atomic: boolean; expiry?: number } | { error: any } {
  if (!p || !Array.isArray(p.calls) || p.calls.length === 0) return err(INVALID_PARAMS, "calls must be a non-empty list");
  if (p.chainId && p.chainId.toLowerCase() !== chainHex) return err(UNSUPPORTED_CHAIN, `this wallet is on chain ${chainHex}`);
  if (p.from && p.from.toLowerCase() !== from.toLowerCase()) return err(UNAUTHORIZED, "from is not this site's account");
  const caps = p.capabilities ?? {};
  let expiry: number | undefined;
  for (const [name, cap] of Object.entries<any>(caps)) {
    if (name === "privacyPaymaster") {
      if (typeof cap?.optional !== "boolean") return err(INVALID_PARAMS, "privacyPaymaster needs optional: true or false");
    } else if (name === "expiry") {
      // { validUntil: unix seconds (number or hex) }: an EIP-8141 expiry frame goes first.
      const v = typeof cap?.validUntil === "string" ? Number(BigInt(cap.validUntil)) : cap?.validUntil;
      if (!Number.isSafeInteger(v) || v <= 0) return err(INVALID_PARAMS, "expiry needs validUntil, in unix seconds");
      if (v <= Math.floor(Date.now() / 1000)) return err(INVALID_PARAMS, "expiry.validUntil is already past");
      expiry = v;
    } else if (!cap?.optional) return err(UNSUPPORTED_CAPABILITY, `unsupported capability ${name}`);
  }
  for (const c of p.calls) {
    if (c.capabilities) {
      for (const [name, cap] of Object.entries<any>(c.capabilities)) {
        if (!cap?.optional) return err(UNSUPPORTED_CAPABILITY, `unsupported call capability ${name}`);
      }
    }
    if (typeof c.to !== "string") return err(INVALID_PARAMS, "every call needs a to address (no contract creation)");
  }
  // atomicRequired: the call frames form one EIP-8141 atomic batch, so all land or none.
  return { calls: p.calls.map((c: any) => ({ to: c.to, data: c.data ?? "0x", value: c.value ?? "0x0" })), atomic: p.atomicRequired === true, expiry };
}

async function handle(origin: string, method: string, params: any): Promise<any> {
  const cfg = await config();
  const chainHex = "0x" + BigInt(cfg.chainId).toString(16);
  const s = await load();
  const connected = !!s.connected[origin];

  switch (method) {
    case "eth_chainId": return { result: chainHex };
    case "net_version": return { result: cfg.chainId };
    case "eth_accounts": return { result: connected ? [await account(origin)] : [] };
    case "eth_requestAccounts": {
      if (connected) return { result: [await account(origin)] };
      // The window asks: a new account (the default) or an existing one, and the site's setting.
      const reply = await openApproval("connect", origin, { mode: modeOf(s, origin) });
      if (reply.error) return reply;
      const now = await load();
      let key: string;
      if (reply.use === "new") key = newAccountKey();
      else {
        const found = knownAccounts(now, addressOf).find((a) => a.address === reply.use);
        if (!found) return err(-32603, `no key for ${reply.use}`);
        key = found.key;
      }
      now.accounts[origin] = key;
      now.addresses[origin] = addressOf(key);
      // The connect window no longer asks; the site follows the default unless changed in the popup.
      if (reply.mode === "site" || reply.mode === "transaction") now.siteMode[origin] = reply.mode;
      now.connected[origin] = true;
      await save({ accounts: now.accounts, addresses: now.addresses, siteMode: now.siteMode, connected: now.connected });
      return { result: [now.addresses[origin]] };
    }
    case "wallet_switchEthereumChain": {
      const want = params?.[0]?.chainId?.toLowerCase();
      return want === chainHex ? { result: null } : err(4902, `this wallet only knows chain ${chainHex}`);
    }
    case "wallet_getCapabilities": {
      // Only whether a privacy paymaster is configured, per the draft: nothing about balances.
      return { result: { [chainHex]: { privacyPaymaster: { supported: true }, atomic: { status: "supported" }, expiry: { supported: true } } } };
    }
    case "eth_sendTransaction":
    case "wallet_sendCalls": {
      if (!connected) return err(UNAUTHORIZED, "connect first (eth_requestAccounts)");
      const from = await account(origin);
      let checked: any;
      if (method === "eth_sendTransaction") {
        const t = params?.[0] ?? {};
        checked = checkBatch({ calls: [{ to: t.to, data: t.data ?? t.input, value: t.value }], from: t.from }, chainHex, from);
      } else checked = checkBatch(params?.[0], chainHex, from);
      if (checked.error) return checked;
      const reply = await openApproval("send", origin, {
        from, calls: checked.calls, atomic: checked.atomic, expiry: checked.expiry, method, accountMode: modeOf(s, origin),
      });
      if (reply.error) return reply;
      // The window may have switched to a new account (after warning about a used one).
      await afterSend(origin, reply.from ?? from, reply.hash, method, checked.calls.length);
      if (method === "eth_sendTransaction") return { result: reply.hash };
      const id = "0x" + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const now = await load();
      now.batches[id] = { hash: reply.hash, origin, chainId: chainHex, atomic: checked.atomic };
      await save({ batches: now.batches });
      return { result: { id } };
    }
    case "wallet_getCallsStatus": {
      const b = s.batches[params?.[0]];
      if (!b || b.origin !== origin) return err(UNKNOWN_BUNDLE, "unknown batch id");
      const rec = await makeRpc(cfg.rpc)("eth_getTransactionReceipt", [b.hash]);
      const status = !rec ? 100 : rec.status === "0x1" ? 200 : 500;
      return {
        result: {
          version: "2.0.0", id: params[0], chainId: b.chainId, atomic: !!b.atomic, status,
          receipts: rec
            ? [{ logs: rec.logs, status: rec.status, blockHash: rec.blockHash, blockNumber: rec.blockNumber,
                 gasUsed: rec.gasUsed, transactionHash: rec.transactionHash }]
            : undefined,
        },
      };
    }
    case "wallet_showCallsStatus": return { result: null };
    default:
      if (READS.has(method)) {
        try {
          return { result: await makeRpc(cfg.rpc)(method, params ?? []) };
        } catch (e) {
          return err(-32603, (e as Error).message);
        }
      }
      return err(UNSUPPORTED_METHOD, `${method} is not supported by this wallet`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "rpc") {
    const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : "unknown");
    handle(origin, msg.method, msg.params).then(sendResponse, (e) => sendResponse(err(-32603, String(e?.message ?? e))));
    return true;
  }
  if (msg.type === "approval-request") {
    sendResponse(pending.get(msg.id)?.request ?? null);
    return false;
  }
  if (msg.type === "approval-reply") {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p.resolve(msg.reply);
    }
    sendResponse(true);
    return false;
  }
  return false;
});
