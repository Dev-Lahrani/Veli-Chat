import * as c from './crypto.js';

/**
 * Sender Keys: each member of a group has a symmetric chain key for their
 * outgoing messages. The chain key is distributed to other members via the
 * existing 1:1 Double Ratchet sessions.
 */

const NEXT_CK = new Uint8Array([0x02]);
const MK = new Uint8Array([0x01]);

export interface SenderKeyState {
  chainKey: c.Bytes;
  iteration: number;
  signing: c.KeyPair;
}

export interface SenderKeyDistributionMessage {
  groupId: string;
  senderUserId: string;
  iteration: number;
  chainKey: c.Bytes;
  signingPub: c.Bytes;
}

export function createSenderKey(): {
  state: SenderKeyState;
  distribution: Omit<SenderKeyDistributionMessage, 'groupId' | 'senderUserId'>;
} {
  const signing = c.generateSignKeyPair();
  const chainKey = c.randomBytes(32);
  return {
    state: { chainKey, iteration: 0, signing },
    distribution: { iteration: 0, chainKey, signingPub: signing.publicKey },
  };
}

export interface GroupCiphertext {
  iteration: number;
  ciphertext: c.Bytes;
  signature: c.Bytes;
}

export function encryptGroup(
  state: SenderKeyState,
  plaintext: c.Bytes,
  ad: c.Bytes,
): GroupCiphertext {
  const mk = c.hmac(state.chainKey, MK);
  state.chainKey = c.hmac(state.chainKey, NEXT_CK);
  const iteration = state.iteration;
  state.iteration += 1;
  const iterBuf = new Uint8Array(4);
  new DataView(iterBuf.buffer).setUint32(0, iteration, false);
  const fullAd = c.concat(ad, iterBuf);
  const ciphertext = c.aeadEncrypt(mk, plaintext, fullAd);
  const signature = c.sign(ciphertext, state.signing.privateKey);
  return { iteration, ciphertext, signature };
}

export interface ReceiverState {
  chainKey: c.Bytes;
  iteration: number;
  signingPub: c.Bytes;
  skipped: Map<number, c.Bytes>;
}

export function initReceiver(d: SenderKeyDistributionMessage): ReceiverState {
  return {
    chainKey: d.chainKey,
    iteration: d.iteration,
    signingPub: d.signingPub,
    skipped: new Map(),
  };
}

export function decryptGroup(state: ReceiverState, msg: GroupCiphertext, ad: c.Bytes): c.Bytes {
  if (!c.verifySig(msg.signature, msg.ciphertext, state.signingPub)) {
    throw new Error('Group message signature invalid');
  }
  const iterBuf = new Uint8Array(4);
  new DataView(iterBuf.buffer).setUint32(0, msg.iteration, false);
  const fullAd = c.concat(ad, iterBuf);

  if (state.skipped.has(msg.iteration)) {
    const mk = state.skipped.get(msg.iteration)!;
    state.skipped.delete(msg.iteration);
    return c.aeadDecrypt(mk, msg.ciphertext, fullAd);
  }
  if (msg.iteration < state.iteration) {
    throw new Error('Replay or out-of-order beyond skipped window');
  }
  while (state.iteration < msg.iteration) {
    const skippedMk = c.hmac(state.chainKey, MK);
    state.skipped.set(state.iteration, skippedMk);
    state.chainKey = c.hmac(state.chainKey, NEXT_CK);
    state.iteration += 1;
    if (state.skipped.size > 2000) throw new Error('Too many skipped group messages');
  }
  const mk = c.hmac(state.chainKey, MK);
  state.chainKey = c.hmac(state.chainKey, NEXT_CK);
  state.iteration += 1;
  return c.aeadDecrypt(mk, msg.ciphertext, fullAd);
}
