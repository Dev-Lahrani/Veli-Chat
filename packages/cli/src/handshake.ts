import {
  type Identity,
  type OneTimePreKey,
  type PreKeyBundle,
  type RatchetState,
  type SignedPreKey,
  crypto as c,
  initAlice,
  initBob,
  initiatorX3DH,
  responderX3DH,
  userIdFor,
  verifyIdentityDhBinding,
} from 'veilchat-protocol';
import type { StartCodePayload } from './code.js';
import type { FramedConn } from './transport.js';

/**
 * Wire format for the X3DH handshake over the framed connection. The
 * inviter (the side that issued the code) is the X3DH responder; the
 * connector (who pasted the code) is the X3DH initiator.
 *
 * Frame 1 (connector → inviter):
 *   { v:1, sigPub, dhPub, ephemeralPub, bindingSig, spkId, opkId }
 *
 * That's enough for the inviter to identify which prekeys to use and verify
 * the connector's identity-DH binding. After this single frame, both sides
 * have the X3DH shared secret and switch into Double Ratchet mode.
 */

interface InitFrame {
  v: 1;
  sigPub: string;
  dhPub: string;
  bindingSig: string;
  ephemeralPub: string;
  spkId: number;
  opkId: number;
}

const enc = c.toBase64;
const dec = c.fromBase64;

export interface HandshakeResult {
  ratchet: RatchetState;
  ad: c.Bytes;
  /** Signing pub of the peer — drives the safety-number display. */
  peerSigningPub: c.Bytes;
  peerDhPub: c.Bytes;
}

/**
 * Connector side: open a TCP/Tor connection, send our identity + ephemeral,
 * derive the shared secret as the X3DH initiator.
 */
export async function connectorHandshake(
  conn: FramedConn,
  myIdentity: Identity,
  myBindingSig: c.Bytes,
  peer: StartCodePayload,
): Promise<HandshakeResult> {
  // Build a PreKeyBundle from the code so we can use the shared X3DH code.
  const peerSigPub = dec(peer.s);
  const peerDhPub = dec(peer.d);
  if (!verifyIdentityDhBinding(peerSigPub, peerDhPub, dec(peer.bs))) {
    throw new Error('peer identity-DH binding invalid — code corrupted or tampered');
  }
  const bundle: PreKeyBundle = {
    identitySigningPub: peerSigPub,
    identityDhPub: peerDhPub,
    signedPreKeyId: peer.spkId,
    signedPreKeyPub: dec(peer.spkPub),
    signedPreKeySig: dec(peer.spkSig),
    oneTimePreKeyId: peer.opkId,
    oneTimePreKeyPub: dec(peer.opkPub),
  };
  const init = initiatorX3DH(myIdentity, bundle);

  const frame: InitFrame = {
    v: 1,
    sigPub: enc(myIdentity.signing.publicKey),
    dhPub: enc(myIdentity.dh.publicKey),
    bindingSig: enc(myBindingSig),
    ephemeralPub: enc(init.ephemeralPub),
    spkId: peer.spkId,
    opkId: peer.opkId,
  };
  conn.send(new TextEncoder().encode(JSON.stringify(frame)));

  const ratchet = initAlice(init.sharedSecret, bundle.signedPreKeyPub);
  return {
    ratchet,
    ad: init.associatedData,
    peerSigningPub: peerSigPub,
    peerDhPub: peerDhPub,
  };
}

/**
 * Inviter side: receive the connector's init frame, derive the shared
 * secret as X3DH responder.
 */
export async function inviterHandshake(
  conn: FramedConn,
  myIdentity: Identity,
  spk: SignedPreKey,
  opk: OneTimePreKey,
): Promise<HandshakeResult> {
  const raw = await conn.recv();
  if (!raw) throw new Error('peer disconnected before handshake');
  const frame = JSON.parse(raw.toString('utf8')) as InitFrame;
  if (frame.v !== 1) throw new Error('unsupported handshake version');

  const peerSigPub = dec(frame.sigPub);
  const peerDhPub = dec(frame.dhPub);
  if (!verifyIdentityDhBinding(peerSigPub, peerDhPub, dec(frame.bindingSig))) {
    throw new Error('peer identity-DH binding invalid');
  }
  if (frame.spkId !== spk.id) throw new Error('peer used wrong signed-prekey id');
  if (frame.opkId !== opk.id) throw new Error('peer used wrong one-time-prekey id');

  const resp = responderX3DH(myIdentity, {
    initiatorIdentityDhPub: peerDhPub,
    initiatorEphemeralPub: dec(frame.ephemeralPub),
    signedPreKey: spk,
    oneTimePreKey: opk,
  });

  const ratchet = initBob(resp.sharedSecret, spk.keypair);
  return {
    ratchet,
    ad: resp.associatedData,
    peerSigningPub: peerSigPub,
    peerDhPub: peerDhPub,
  };
}

/**
 * Compute a short, OOB-comparable safety-number string for verifying the
 * handshake against a MITM. Both peers compute the same string from their
 * pair of identity signing keys (sorted). Read it aloud or compare via any
 * out-of-band channel.
 */
export function safetyNumberFor(a: c.Bytes, b: c.Bytes): string {
  return c.safetyNumber(a, b);
}

export { userIdFor };
