/**
 * Carries the page's provider requests to the extension and the answers back, and tells the page
 * when this site's account changes (EIP-1193 accountsChanged), as it does after every transaction
 * with the "new account for every transaction" setting.
 */
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.target !== "nainokot-content") return;
  const { id, method, params } = event.data;
  chrome.runtime.sendMessage({ type: "rpc", method, params }, (reply) => {
    const error = chrome.runtime.lastError
      ? { code: -32603, message: chrome.runtime.lastError.message }
      : reply?.error;
    window.postMessage({ target: "nainokot-inpage", id, result: reply?.result, error }, window.location.origin);
  });
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  const origin = window.location.origin;
  // Disconnected from the wallet's popup: the site sees no account.
  if (changes.connected?.oldValue?.[origin] && !changes.connected.newValue?.[origin]) {
    window.postMessage({ target: "nainokot-inpage", event: "accountsChanged", data: [] }, origin);
    return;
  }
  if (!changes.addresses) return;
  const before = changes.addresses.oldValue?.[origin];
  const after = changes.addresses.newValue?.[origin];
  if (!after || before === after) return;
  const { connected } = await chrome.storage.local.get("connected");
  if (!connected?.[origin]) return;
  window.postMessage({ target: "nainokot-inpage", event: "accountsChanged", data: [after] }, origin);
});
