import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { blake2b as nobleBlake2b } from '@noble/hashes/blake2b';
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf';
import { hmac as nobleHmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes as nobleRandomBytes } from '@noble/hashes/utils';

export const ready: Promise<void> = Promise.resolve();

export type Bytes = Uint8Array;

export interface KeyPair {
  publicKey: Bytes;
  privateKey: Bytes;
}

export function randomBytes(n: number): Bytes {
  return nobleRandomBytes(n);
}

export function generateDhKeyPair(): KeyPair {
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

export function generateSignKeyPair(): KeyPair {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

export function dh(privateKey: Bytes, publicKey: Bytes): Bytes {
  return x25519.getSharedSecret(privateKey, publicKey);
}

export function sign(message: Bytes, privateKey: Bytes): Bytes {
  return ed25519.sign(message, privateKey);
}

export function verifySig(sig: Bytes, message: Bytes, publicKey: Bytes): boolean {
  try {
    return ed25519.verify(sig, message, publicKey);
  } catch {
    return false;
  }
}

export function blake2b(data: Bytes, length = 32): Bytes {
  return nobleBlake2b(data, { dkLen: length });
}

export function hkdf(ikm: Bytes, salt: Bytes, info: Bytes, length: number): Bytes {
  return nobleHkdf(sha256, ikm, salt.length ? salt : new Uint8Array(32), info, length);
}

export function hmac(key: Bytes, data: Bytes): Bytes {
  return nobleHmac(sha256, key, data);
}

const NONCE_LEN = 24;

export function aeadEncrypt(key: Bytes, plaintext: Bytes, ad: Bytes): Bytes {
  const nonce = nobleRandomBytes(NONCE_LEN);
  const cipher = xchacha20poly1305(key, nonce, ad);
  const ct = cipher.encrypt(plaintext);
  const out = new Uint8Array(NONCE_LEN + ct.length);
  out.set(nonce, 0);
  out.set(ct, NONCE_LEN);
  return out;
}

export function aeadDecrypt(key: Bytes, ciphertext: Bytes, ad: Bytes): Bytes {
  const nonce = ciphertext.slice(0, NONCE_LEN);
  const ct = ciphertext.slice(NONCE_LEN);
  const cipher = xchacha20poly1305(key, nonce, ad);
  return cipher.decrypt(ct);
}

export function concat(...arrs: Bytes[]): Bytes {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

export function constantTimeEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i]! ^ b[i]!;
  return r === 0;
}

// URL-safe base64 (no padding). Implemented over @noble's hex utilities to
// keep the protocol package free of bespoke crypto-adjacent encoding code.
const STD_TO_URL: Record<string, string> = { '+': '-', '/': '_' };
const URL_TO_STD: Record<string, string> = { '-': '+', _: '/' };

export function toBase64(b: Bytes): string {
  // btoa works in both Node 22+ and browsers.
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  const std = btoa(bin);
  return std.replace(/[+/]/g, (ch) => STD_TO_URL[ch]!).replace(/=+$/, '');
}

export function fromBase64(s: string): Bytes {
  const std = s.replace(/[-_]/g, (ch) => URL_TO_STD[ch]!) + '==='.slice((s.length + 3) % 4);
  const bin = atob(std);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(b: Bytes): string {
  return bytesToHex(b);
}

export function fromHex(s: string): Bytes {
  return hexToBytes(s);
}

export function safetyNumber(a: Bytes, b: Bytes): string {
  const ordered = compareBytes(a, b) < 0 ? concat(a, b) : concat(b, a);
  const h = blake2b(ordered, 30);
  return toHex(h)
    .match(/.{1,5}/g)!
    .join(' ');
}

function compareBytes(a: Bytes, b: Bytes): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}
