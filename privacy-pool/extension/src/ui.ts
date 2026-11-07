/** Shared bits for the popup and approval windows: icons, avatars, names, formatting. */
import { avatarStyle, nameOf, rememberSite } from "./names.js";
export { nameOf, rememberSite };

const paths: Record<string, string> = {
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  alert: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
  send: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  receive: '<path d="M17 7 7 17"/><path d="M17 17H7V7"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  logout: '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
};

export function icon(name: string, size = 18): string {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

export function el(tag: string, cls = "", text = ""): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** An element from trusted markup (icons and fixed text only; never page or site data). */
export function html(markup: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as HTMLElement;
}

export const $ = (id: string) => document.getElementById(id)!;
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const host = (origin: string) => origin.replace(/^https?:\/\//, "");
/** An amount to at most six decimals. */
export const shown = (wei: bigint, digits = 6) =>
  (Number(wei / 10n ** 12n) / 1e6).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: Math.min(digits, 4) });

function hash(text: string): number {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** A round picture made from an address: two colours from its bytes. */
export function accountAvatar(address: string, size = 36): HTMLElement {
  const e = el("span", "avatar");
  e.style.cssText = `width:${size}px;height:${size}px;background:${avatarStyle(address)}`;
  return e;
}

/** A site's picture: its first letter on a colour from its name. */
export function siteAvatar(origin: string, size = 36): HTMLElement {
  const name = host(origin);
  const e = el("span", "site-avatar", (name.replace(/^www\./, "")[0] ?? "?").toUpperCase());
  e.style.cssText = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px;background:hsl(${hash(name) % 360} 55% 92%);color:hsl(${hash(name) % 360} 60% 30%)`;
  return e;
}

/** A name over its short address, e.g. "Misty Deer" / "0x671f…e3f9". */
export function nameBlock(address: string, cls = ""): HTMLElement {
  const box = el("div", `name-block ${cls}`.trim());
  box.title = address;
  box.append(el("div", "acct-name", nameOf(address)), el("div", "mono small muted", short(address)));
  return box;
}

/** "3 min ago" style time. */
export function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}

/** A copy button for an address. */
export function copyButton(text: string, onCopied?: () => void): HTMLElement {
  const b = html(`<button class="icon-btn small" title="Copy" aria-label="Copy">${icon("copy", 15)}</button>`);
  b.onclick = async (e) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(text).catch(() => undefined);
    b.innerHTML = icon("check", 15);
    setTimeout(() => (b.innerHTML = icon("copy", 15)), 1200);
    onCopied?.();
  };
  return b;
}

/** A transaction's page on the chain's block explorer, or null when the chain has none (the local chain). */
export function explorerLink(explorer: string | undefined, hash: string, label = "View on explorer"): HTMLAnchorElement | null {
  if (!explorer || !/^https?:\/\//.test(explorer) || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  const a = document.createElement("a");
  a.className = "explorer-link";
  a.href = `${explorer}/tx/${hash}`;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.innerHTML = `<span></span>${icon("external", 14)}`;
  a.querySelector("span")!.textContent = label;
  a.onclick = (e) => e.stopPropagation();
  return a;
}
