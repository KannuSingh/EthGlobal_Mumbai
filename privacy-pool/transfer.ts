/**
 * Private transfers inside the privacy pool: a private address, sealing the payee's note, and
 * finding notes paid to this wallet. Browser-safe (no node:crypto), so the extension bundles it.
 *
 * A private address is "nk1" + hex(owner_pk (32) || view public key (33, secp256k1 compressed)).
 * owner_pk = Poseidon(spend key), so a note to it is spendable only with the spend key.
 *
 * A transfer's settle data is the 1,088-byte slot msp uses for an ML-KEM ciphertext, then the
 * payee note and the change note (48 bytes each). Here the slot starts with a fresh ephemeral
 * public key (33 bytes) and the rest is random. The shared secret K = SHA-256(ECDH(eph, view))
 * gives everything for the payee note, as in msp's note format but with a one-time key:
 *
 *   note = tag (16) || value XOR pad (16) || mac (16)
 *   tag  = PRF(K, "tag")[:16], pad = PRF(K, "pad")[:16], mac = PRF(K, "mac", tag || masked)[:16]
 *   rho  = PRF512(K, "rho") mod p        cm = Poseidon(2, Poseidon2(owner_pk, rho), value)
 *
 * PRF is HMAC-SHA256 under a domain label. Each K seals one note, so the pad is used once.
 * The recipient tries every transfer's slot with its view key; only its own open.
 */
import { secp256k1 } from "../deps.nosync/minimal-shielded-pool/node_modules/@noble/curves/secp256k1.js";
import { hmac } from "../deps.nosync/minimal-shielded-pool/node_modules/@noble/hashes/hmac.js";
import { sha256 } from "../deps.nosync/minimal-shielded-pool/node_modules/@noble/hashes/sha2.js";
import * as bytes from "../deps.nosync/minimal-shielded-pool/src/bytes.ts";
import * as protocol from "../deps.nosync/minimal-shielded-pool/src/protocol.ts";

const { concat, toBigint, toBytes, toHex, fromHex, word } = bytes;
const LABEL = "nainokot/privacy-pool/transfer/v1:";
export const SLOT_BYTES = 1088;
export const NOTE_BYTES = 48;

const prf = (key: Uint8Array, label: string, ...parts: Uint8Array[]) =>
  hmac(sha256, key, concat(new TextEncoder().encode(LABEL + label), ...parts));
const prfField = (key: Uint8Array, label: string) =>
  toBigint(concat(prf(key, `${label}:0`), prf(key, `${label}:1`))) % protocol.P;

/** This wallet's receiving keys: the spend key (notes) and the view key (finding them). */
export interface Keys { spend: string; view: string }

export function newKeys(): Keys {
  const r = crypto.getRandomValues(new Uint8Array(64));
  const spend = toBigint(r.subarray(0, 32)) % protocol.P || 1n;
  const view = secp256k1.utils.randomSecretKey ? secp256k1.utils.randomSecretKey() : secp256k1.utils.randomPrivateKey();
  return { spend: "0x" + spend.toString(16), view: toHex(view) };
}

export function addressOf(keys: Keys): string {
  const owner = protocol.ownerPk(BigInt(keys.spend));
  const viewPub = secp256k1.getPublicKey(fromHex(keys.view, "view key"), true);
  return "nk1" + toHex(concat(word(owner), viewPub)).slice(2);
}

export function parseAddress(text: string): { owner: bigint; viewPub: Uint8Array } {
  const t = text.trim();
  if (!/^nk1[0-9a-fA-F]{130}$/.test(t)) throw new Error("a private address is nk1 and 130 hex characters");
  const b = fromHex("0x" + t.slice(3), "private address");
  const owner = toBigint(b.subarray(0, 32));
  if (!(owner > 0n && owner < protocol.P)) throw new Error("that private address's owner key is not valid");
  const viewPub = b.slice(32);
  secp256k1.Point.fromHex(toHex(viewPub).slice(2)); // throws when it isn't a point
  return { owner, viewPub };
}

function sealWith(k: Uint8Array, value: bigint) {
  const tag = prf(k, "tag").subarray(0, 16);
  const v = toBytes(value, 16);
  const pad = prf(k, "pad").subarray(0, 16);
  const masked = v.map((x, i) => x ^ pad[i]);
  const mac = prf(k, "mac", tag, masked).subarray(0, 16);
  return { note: concat(tag, masked, mac), rho: prfField(k, "rho") };
}

/** The settle data slot and payee note for paying `value` to a private address, and the output. */
export function sealTransfer(to: string, value: bigint) {
  const { owner, viewPub } = parseAddress(to);
  const eph = secp256k1.utils.randomSecretKey ? secp256k1.utils.randomSecretKey() : secp256k1.utils.randomPrivateKey();
  const k = sha256(secp256k1.getSharedSecret(eph, viewPub, true));
  const { note, rho } = sealWith(k, value);
  const slot = concat(secp256k1.getPublicKey(eph, true), crypto.getRandomValues(new Uint8Array(SLOT_BYTES - 33)));
  return { slot, note, inner: protocol.p2(owner, rho), rho };
}

/** A transfer's payee note opened with this wallet's view key: its value and rho, or null. */
export function openTransfer(keys: Keys, slot: Uint8Array, note: Uint8Array): { value: bigint; rho: bigint } | null {
  if (slot.length !== SLOT_BYTES || note.length !== NOTE_BYTES) return null;
  let k: Uint8Array;
  try {
    k = sha256(secp256k1.getSharedSecret(fromHex(keys.view, "view key"), slot.subarray(0, 33), true));
  } catch {
    return null;
  }
  const tag = note.subarray(0, 16);
  const want = prf(k, "tag").subarray(0, 16);
  if (toHex(tag) !== toHex(want)) return null;
  const masked = note.subarray(16, 32);
  if (toHex(prf(k, "mac", tag, masked).subarray(0, 16)) !== toHex(note.subarray(32, 48))) return null;
  const pad = prf(k, "pad").subarray(0, 16);
  const value = toBigint(masked.map((x, i) => x ^ pad[i]));
  return value > 0n ? { value, rho: prfField(k, "rho") } : null;
}
