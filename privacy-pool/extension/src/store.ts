/** What the extension keeps in chrome.storage.local, and its config (config.json, made by build.ts). */
import type { Config, State } from "../../core.ts";

/** "site": one account per site. "transaction": a new account after every transaction. */
export type AccountMode = "site" | "transaction";

export interface UsedAccount {
  address: string;
  key: string;
  /** The transactions sent from it. */
  txs: string[];
}

export interface Stored {
  wallet: State;
  /** Each site's current account: the site's origin to its private key. */
  accounts: Record<string, string>;
  /** Each site's current address, which the content script watches to tell the page. */
  addresses: Record<string, string>;
  /** Every account a site has sent from, oldest first; their keys stay, as they may hold what the site sent them. */
  used: Record<string, UsedAccount[]>;
  /** Sites the user connected. */
  connected: Record<string, boolean>;
  /** wallet_sendCalls batches: id to the transaction and site. */
  batches: Record<string, { hash: string; origin: string; chainId: string }>;
  /** The default for new sites: a new account per transaction unless the user changes it. */
  settings: { accountMode: AccountMode };
  /** A site's own setting, chosen when it connected or later in the popup. */
  siteMode: Record<string, AccountMode>;
  /** Every transaction sent, newest last. */
  history: HistoryItem[];
}

export interface HistoryItem {
  origin: string;
  from: string;
  hash: string;
  method: string;
  calls: number;
  at: number;
  /** The site's setting when it was sent. */
  mode: AccountMode;
}

export interface AccountInfo {
  address: string;
  key: string;
  sites: string[];
  txs: number;
  /** The site(s) it is the current account of. */
  currentOf: string[];
  /** Public: sites or onlookers can link it to other activity (more than one transaction, more than one site, or kept by a site). */
  public: boolean;
  why: string;
}

/** Every account with how private it is, for the Accounts screen. */
export function accountList(s: Stored, address: (key: string) => string): AccountInfo[] {
  const all = new Map<string, AccountInfo>();
  const get = (key: string) => {
    const a = address(key);
    let e = all.get(a);
    if (!e) all.set(a, (e = { address: a, key, sites: [], txs: 0, currentOf: [], public: false, why: "" }));
    return e;
  };
  for (const [site, list] of Object.entries(s.used)) for (const u of list) {
    const e = get(u.key);
    if (!e.sites.includes(site)) e.sites.push(site);
    e.txs += u.txs.length;
  }
  for (const [site, key] of Object.entries(s.accounts)) {
    if (!s.connected[site]) continue;
    const e = get(key);
    if (!e.sites.includes(site)) e.sites.push(site);
    e.currentOf.push(site);
  }
  for (const e of all.values()) {
    if (e.sites.length > 1) e.why = `Shared by ${e.sites.length} sites`;
    else if (e.txs > 1) e.why = `${e.txs} transactions can be linked`;
    else if (e.currentOf.some((site) => modeOf(s, site) === "site")) e.why = "Kept by the site for every transaction";
    e.public = !!e.why;
    if (!e.public) e.why = e.txs ? "Used once" : "Not used yet";
  }
  return [...all.values()];
}

/** The setting that applies to a site. */
export const modeOf = (s: Stored, origin: string): AccountMode => s.siteMode[origin] ?? s.settings.accountMode;

/** Every account the wallet holds, with the sites that used it, for "use an existing account". */
export function knownAccounts(s: Stored, address: (key: string) => string): { address: string; key: string; sites: string[] }[] {
  const all = new Map<string, { address: string; key: string; sites: string[] }>();
  const add = (key: string, site: string) => {
    const a = address(key);
    const e = all.get(a) ?? { address: a, key, sites: [] };
    if (!e.sites.includes(site)) e.sites.push(site);
    all.set(a, e);
  };
  for (const [site, list] of Object.entries(s.used)) for (const u of list) add(u.key, site);
  for (const [site, key] of Object.entries(s.accounts)) if (s.connected[site]) add(key, site);
  return [...all.values()];
}

const KEYS = ["wallet", "accounts", "addresses", "used", "connected", "batches", "settings", "siteMode", "history"];

export async function config(): Promise<Config> {
  return (await fetch(chrome.runtime.getURL("config.json"))).json();
}

export async function load(): Promise<Stored> {
  const s = (await chrome.storage.local.get(KEYS)) as Partial<Stored>;
  return {
    wallet: s.wallet ?? { notes: [] },
    accounts: s.accounts ?? {},
    addresses: s.addresses ?? {},
    used: s.used ?? {},
    connected: s.connected ?? {},
    batches: s.batches ?? {},
    settings: s.settings ?? { accountMode: "transaction" },
    siteMode: s.siteMode ?? {},
    history: s.history ?? [],
  };
}

export async function save(s: Partial<Stored>): Promise<void> {
  await chrome.storage.local.set(s);
}
