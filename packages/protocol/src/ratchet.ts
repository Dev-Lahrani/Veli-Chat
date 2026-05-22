import * as c from './crypto.js';

const MAX_SKIP = 1000;
// Hard cap on total skipped keys retained across all ratchet generations.
// Protects against an attacker who streams a malformed sequence designed to
// blow up memory by forcing perpetual key derivation without consumption.
const MAX_SKIPPED_RETAINED = 2000;
const RK_INFO = new TextEncoder().encode('Nox-RK');
const MK_CONST = new Uint8Array([0x01]);
const NEXT_CK_CONST = new Uint8Array([0x02]);

export interface MessageHeader {
  dh: c.Bytes;
  pn: number;
  n: number;
}

export interface RatchetState {
  dhSelf: c.KeyPair | null;
  dhRemote: c.Bytes | null;
  rk: c.Bytes;
  cks: c.Bytes | null;
  ckr: c.Bytes | null;
  ns: number;
  nr: number;
  pn: number;
  skipped: Map<string, c.Bytes>;
}

function kdfRk(rk: c.Bytes, dhOut: c.Bytes): { rk: c.Bytes; ck: c.Bytes } {
  const out = c.hkdf(dhOut, rk, RK_INFO, 64);
  return { rk: out.slice(0, 32), ck: out.slice(32, 64) };
}

function kdfCk(ck: c.Bytes): { ck: c.Bytes; mk: c.Bytes } {
  return { ck: c.hmac(ck, NEXT_CK_CONST), mk: c.hmac(ck, MK_CONST) };
}

export function initAlice(sharedSecret: c.Bytes, peerDhPub: c.Bytes): RatchetState {
  const dhSelf = c.generateDhKeyPair();
  const { rk, ck } = kdfRk(sharedSecret, c.dh(dhSelf.privateKey, peerDhPub));
  return {
    dhSelf,
    dhRemote: peerDhPub,
    rk,
    cks: ck,
    ckr: null,
    ns: 0,
    nr: 0,
    pn: 0,
    skipped: new Map(),
  };
}

export function initBob(sharedSecret: c.Bytes, ownPreKeyPair: c.KeyPair): RatchetState {
  return {
    dhSelf: ownPreKeyPair,
    dhRemote: null,
    rk: sharedSecret,
    cks: null,
    ckr: null,
    ns: 0,
    nr: 0,
    pn: 0,
    skipped: new Map(),
  };
}

export interface EncryptedMessage {
  header: MessageHeader;
  ciphertext: c.Bytes;
}

function encodeHeader(h: MessageHeader): c.Bytes {
  const buf = new Uint8Array(h.dh.length + 8);
  buf.set(h.dh, 0);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setUint32(h.dh.length, h.pn, false);
  dv.setUint32(h.dh.length + 4, h.n, false);
  return buf;
}

export function encrypt(state: RatchetState, plaintext: c.Bytes, ad: c.Bytes): EncryptedMessage {
  if (!state.cks || !state.dhSelf) throw new Error('Sending chain not initialized');
  const { ck, mk } = kdfCk(state.cks);
  state.cks = ck;
  const header: MessageHeader = { dh: state.dhSelf.publicKey, pn: state.pn, n: state.ns };
  state.ns += 1;
  const fullAd = c.concat(ad, encodeHeader(header));
  return { header, ciphertext: c.aeadEncrypt(mk, plaintext, fullAd) };
}

function skipKey(dhRemote: c.Bytes, n: number): string {
  return `${c.toBase64(dhRemote)}:${n}`;
}

function trySkipped(state: RatchetState, msg: EncryptedMessage, ad: c.Bytes): c.Bytes | null {
  const key = skipKey(msg.header.dh, msg.header.n);
  const mk = state.skipped.get(key);
  if (!mk) return null;
  state.skipped.delete(key);
  const fullAd = c.concat(ad, encodeHeader(msg.header));
  return c.aeadDecrypt(mk, msg.ciphertext, fullAd);
}

function skipMessageKeys(state: RatchetState, until: number) {
  if (state.nr + MAX_SKIP < until) throw new Error('Too many skipped messages');
  if (state.ckr === null) return;
  while (state.nr < until) {
    const { ck, mk } = kdfCk(state.ckr);
    state.ckr = ck;
    state.skipped.set(skipKey(state.dhRemote!, state.nr), mk);
    state.nr += 1;
    if (state.skipped.size > MAX_SKIPPED_RETAINED) {
      // Evict the oldest key. Map preserves insertion order in JS.
      const firstKey = state.skipped.keys().next().value;
      if (firstKey !== undefined) state.skipped.delete(firstKey);
    }
  }
}

function dhRatchet(state: RatchetState, header: MessageHeader) {
  state.pn = state.ns;
  state.ns = 0;
  state.nr = 0;
  state.dhRemote = header.dh;
  const r1 = kdfRk(state.rk, c.dh(state.dhSelf!.privateKey, state.dhRemote));
  state.rk = r1.rk;
  state.ckr = r1.ck;
  state.dhSelf = c.generateDhKeyPair();
  const r2 = kdfRk(state.rk, c.dh(state.dhSelf.privateKey, state.dhRemote));
  state.rk = r2.rk;
  state.cks = r2.ck;
}

export function decrypt(state: RatchetState, msg: EncryptedMessage, ad: c.Bytes): c.Bytes {
  const skipped = trySkipped(state, msg, ad);
  if (skipped) return skipped;

  const headerChanged = !state.dhRemote || !c.constantTimeEqual(msg.header.dh, state.dhRemote);
  if (headerChanged) {
    skipMessageKeys(state, msg.header.pn);
    dhRatchet(state, msg.header);
  }
  skipMessageKeys(state, msg.header.n);
  if (!state.ckr) throw new Error('No receiving chain');
  const { ck, mk } = kdfCk(state.ckr);
  state.ckr = ck;
  state.nr += 1;
  const fullAd = c.concat(ad, encodeHeader(msg.header));
  return c.aeadDecrypt(mk, msg.ciphertext, fullAd);
}
