// Friendly names and pictures for accounts, so people can tell them apart without reading 0x….
// Both come only from the address, so the wallet and a site show the same name for the same
// account, and they reveal nothing the address doesn't. Shared by the extension and the demo.

const ADJECTIVES = [
  "Amber", "Azure", "Brave", "Bright", "Calm", "Clever", "Coral", "Cosmic", "Crimson", "Daring",
  "Dusky", "Eager", "Fancy", "Gentle", "Golden", "Happy", "Hazel", "Honey", "Indigo", "Jolly",
  "Kind", "Lively", "Lucky", "Lunar", "Maple", "Merry", "Misty", "Mossy", "Nimble", "Noble",
  "Ocean", "Olive", "Peachy", "Plucky", "Polar", "Quiet", "Rapid", "Rosy", "Ruby", "Rustic",
  "Sandy", "Silent", "Silver", "Sleepy", "Snowy", "Solar", "Spicy", "Starry", "Stormy", "Sunny",
  "Swift", "Teal", "Tidy", "Tiny", "Velvet", "Violet", "Wild", "Windy", "Witty", "Woolly",
  "Young", "Zany", "Zesty", "Breezy",
];
const ANIMALS = [
  "Badger", "Bear", "Beaver", "Bison", "Bunny", "Camel", "Cat", "Cheetah", "Crane", "Crow",
  "Deer", "Dingo", "Dolphin", "Dove", "Duck", "Eagle", "Falcon", "Ferret", "Finch", "Fox",
  "Gecko", "Goat", "Goose", "Heron", "Hippo", "Ibis", "Jaguar", "Koala", "Lemur", "Lion",
  "Llama", "Lynx", "Marten", "Mole", "Moose", "Newt", "Octopus", "Orca", "Otter", "Owl",
  "Panda", "Parrot", "Pelican", "Penguin", "Puffin", "Quail", "Rabbit", "Raven", "Robin", "Seal",
  "Sparrow", "Squid", "Swan", "Tapir", "Tiger", "Toucan", "Turtle", "Walrus", "Whale", "Wolf",
  "Wombat", "Yak", "Zebra", "Hedgehog",
];

function hash(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** "Amber Otter" for an address. */
export function wordsOf(address) {
  const h = hash(String(address).toLowerCase());
  return `${ADJECTIVES[h % 64]} ${ANIMALS[(h >>> 6) % 64]}`;
}

/** The site each account belongs to (its first one), so its name reads like a site's subname. */
const siteOf = new Map();
export function rememberSite(address, origin) {
  const k = String(address).toLowerCase();
  if (origin && !siteOf.has(k)) siteOf.set(k, origin);
}

/** A site's host without its port: "app.example.org" from "https://app.example.org:8443". */
export function siteLabel(origin) {
  try { return new URL(origin).hostname; } catch { return String(origin); }
}

/**
 * The account's name: "amberotter.example.org" when the wallet knows the account's site (like
 * a subname of the site), else "Amber Otter". Display only: nothing resolves it on chain.
 */
export function nameOf(address, origin) {
  const site = origin ?? siteOf.get(String(address).toLowerCase());
  const words = wordsOf(address);
  return site ? `${words.replace(" ", "").toLowerCase()}.${siteLabel(site)}` : words;
}

/** The two colours and angle of the account's round picture. */
export function avatarStyle(address) {
  const h = hash(String(address).toLowerCase());
  const a = h % 360, b = (a + 40 + ((h >> 9) % 120)) % 360, angle = (h >> 17) % 360;
  return `linear-gradient(${angle}deg,hsl(${a} 75% 58%),hsl(${b} 70% 45%))`;
}
