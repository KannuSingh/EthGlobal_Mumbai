// The guest book page: finds the Nainokot Wallet over EIP-6963 and signs.
const $ = (id) => document.getElementById(id);
const { guestBook } = await (await fetch("config.json")).json();
const log = (text) => { const li = document.createElement("li"); li.textContent = text; $("log").prepend(li); };

// Only the Nainokot Wallet, found by its EIP-6963 rdns, never another wallet such as MetaMask.
let provider;
window.addEventListener("eip6963:announceProvider", (e) => { if (e.detail.info.rdns === "xyz.nainokot.wallet") provider = e.detail.provider; });
window.dispatchEvent(new Event("eip6963:requestProvider"));
let account;

const word = (n) => n.toString(16).padStart(64, "0");
function signData(text) {
  const bytes = new TextEncoder().encode(text);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return "0x79d6348d" + word(32) + word(bytes.length) + hex.padEnd(64 * Math.ceil(bytes.length / 32), "0");
}
async function entries() {
  const r = await provider.request({ method: "eth_call", params: [{ to: guestBook, data: "0xf29ee125" + account.slice(2).toLowerCase().padStart(64, "0") }, "latest"] });
  $("entries").textContent = String(BigInt(r));
}

$("connect").onclick = async () => {
  if (!provider) { log("Nainokot Wallet not found: load privacy-pool/extension/out in chrome://extensions, then reload this page."); return; }
  try {
    [account] = await provider.request({ method: "eth_requestAccounts" });
    provider.on("accountsChanged", async ([a]) => {
      if (!a || a === account) return;
      account = a;
      $("account").textContent = account;
      log(`The wallet moved this site to a new account ${account}`);
      await entries();
    });
    $("account").textContent = account;
    const chainId = await provider.request({ method: "eth_chainId" });
    const caps = await provider.request({ method: "wallet_getCapabilities", params: [account, [chainId]] }).catch(() => ({}));
    const supported = !!caps?.[chainId]?.privacyPaymaster?.supported;
    $("caps").textContent = supported ? "This wallet supports privacyPaymaster on this chain." : "This wallet does not report privacyPaymaster.";
    $("calls").disabled = false; $("tx").disabled = false;
    const bal = BigInt(await provider.request({ method: "eth_getBalance", params: [account, "latest"] }));
    log(`Connected ${account} on chain ${BigInt(chainId)}, ETH balance ${bal}`);
    await entries();
  } catch (e) { log(`Connect failed: ${e.message}`); }
};

async function waitFor(check) {
  for (let i = 0; i < 90; i++) { const r = await check(); if (r) return r; await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error("not mined within 90 s");
}

$("calls").onclick = async () => {
  try {
    const chainId = await provider.request({ method: "eth_chainId" });
    const { id } = await provider.request({ method: "wallet_sendCalls", params: [{
      version: "2.0.0", chainId, from: account, atomicRequired: false,
      calls: [{ to: guestBook, data: signData($("text").value) }],
      capabilities: { privacyPaymaster: { optional: false } },
    }] });
    log(`Sent batch ${id.slice(0, 12)}…, waiting`);
    const s = await waitFor(async () => { const s = await provider.request({ method: "wallet_getCallsStatus", params: [id] }); return s.status >= 200 ? s : null; });
    log(`Batch status ${s.status}, gas ${BigInt(s.receipts[0].gasUsed)}, tx ${s.receipts[0].transactionHash}`);
    await entries();
  } catch (e) { log(`wallet_sendCalls failed (${e.code}): ${e.message}`); }
};

$("tx").onclick = async () => {
  try {
    const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from: account, to: guestBook, data: signData($("text").value) }] });
    log(`Sent ${hash}, waiting`);
    const r = await waitFor(() => provider.request({ method: "eth_getTransactionReceipt", params: [hash] }));
    log(`Mined with status ${r.status}, gas ${BigInt(r.gasUsed)}`);
    await entries();
  } catch (e) { log(`eth_sendTransaction failed (${e.code}): ${e.message}`); }
};
