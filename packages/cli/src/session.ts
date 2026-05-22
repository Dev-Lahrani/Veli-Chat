import {
  type RatchetState,
  crypto as c,
  decrypt as ratchetDecrypt,
  encrypt as ratchetEncrypt,
} from 'veilchat-protocol';
import type { FramedConn } from './transport.js';

/**
 * After the handshake, every frame on the wire is a Double-Ratchet
 * ciphertext envelope. Plaintext is JSON: a discriminated union of a
 * normal message or an in-band control message (e.g. name change).
 *
 * Wire envelope JSON (then ratchet-encrypted, then framed):
 *   { h: { dh, pn, n }, c: <ciphertext> }
 *
 * After decrypt the plaintext is JSON:
 *   { type: 'msg', t, text }
 *   { type: 'name', t, name }
 *   { type: 'bye',  t }
 */

export type ControlMessage =
  | { type: 'msg'; text: string }
  | { type: 'name'; name: string }
  | { type: 'typing' }
  | { type: 'read'; upTo: number }
  | { type: 'noop' }
  | { type: 'file-offer'; id: string; name: string; size: number; mime: string }
  | { type: 'file-chunk'; id: string; data: string }
  | { type: 'file-end'; id: string }
  | { type: 'bye' };

interface WireEnvelope {
  h: { dh: string; pn: number; n: number };
  c: string;
}

const enc = c.toBase64;
const dec = c.fromBase64;

export class Session {
  constructor(
    private conn: FramedConn,
    private state: RatchetState,
    private ad: c.Bytes,
  ) {}

  send(msg: ControlMessage): void {
    const pt = new TextEncoder().encode(JSON.stringify(msg));
    const out = ratchetEncrypt(this.state, pt, this.ad);
    const env: WireEnvelope = {
      h: { dh: enc(out.header.dh), pn: out.header.pn, n: out.header.n },
      c: enc(out.ciphertext),
    };
    this.conn.send(new TextEncoder().encode(JSON.stringify(env)));
  }

  async recv(): Promise<ControlMessage | null> {
    const raw = await this.conn.recv();
    if (!raw) return null;
    let env: WireEnvelope;
    try {
      env = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Error('malformed envelope from peer');
    }
    const pt = ratchetDecrypt(
      this.state,
      {
        header: { dh: dec(env.h.dh), pn: env.h.pn, n: env.h.n },
        ciphertext: dec(env.c),
      },
      this.ad,
    );
    return JSON.parse(new TextDecoder().decode(pt)) as ControlMessage;
  }

  close(): void {
    try {
      this.send({ type: 'bye' });
    } catch {
      /* connection may already be down */
    }
    this.conn.close();
  }
}
