import * as c from './crypto.js';
import type { Identity, OneTimePreKey, PreKeyBundle, SignedPreKey } from './identity.js';

const INFO = new TextEncoder().encode('Nox-X3DH-v1');

export interface InitiatorOutput {
  sharedSecret: c.Bytes;
  ephemeralPub: c.Bytes;
  signedPreKeyId: number;
  oneTimePreKeyId?: number;
  associatedData: c.Bytes;
}

export function initiatorX3DH(self: Identity, peer: PreKeyBundle): InitiatorOutput {
  if (!c.verifySig(peer.signedPreKeySig, peer.signedPreKeyPub, peer.identitySigningPub)) {
    throw new Error('Invalid signed prekey signature');
  }
  const ek = c.generateDhKeyPair();
  const dh1 = c.dh(self.dh.privateKey, peer.signedPreKeyPub);
  const dh2 = c.dh(ek.privateKey, peer.identityDhPub);
  const dh3 = c.dh(ek.privateKey, peer.signedPreKeyPub);
  let combined = c.concat(dh1, dh2, dh3);
  if (peer.oneTimePreKeyPub) {
    combined = c.concat(combined, c.dh(ek.privateKey, peer.oneTimePreKeyPub));
  }
  const sharedSecret = c.hkdf(combined, new Uint8Array(32), INFO, 32);
  const associatedData = c.concat(self.dh.publicKey, peer.identityDhPub);
  return {
    sharedSecret,
    ephemeralPub: ek.publicKey,
    signedPreKeyId: peer.signedPreKeyId,
    oneTimePreKeyId: peer.oneTimePreKeyId,
    associatedData,
  };
}

export interface ResponderInput {
  initiatorIdentityDhPub: c.Bytes;
  initiatorEphemeralPub: c.Bytes;
  signedPreKey: SignedPreKey;
  oneTimePreKey?: OneTimePreKey;
}

export interface ResponderOutput {
  sharedSecret: c.Bytes;
  associatedData: c.Bytes;
}

export function responderX3DH(self: Identity, input: ResponderInput): ResponderOutput {
  const dh1 = c.dh(input.signedPreKey.keypair.privateKey, input.initiatorIdentityDhPub);
  const dh2 = c.dh(self.dh.privateKey, input.initiatorEphemeralPub);
  const dh3 = c.dh(input.signedPreKey.keypair.privateKey, input.initiatorEphemeralPub);
  let combined = c.concat(dh1, dh2, dh3);
  if (input.oneTimePreKey) {
    combined = c.concat(
      combined,
      c.dh(input.oneTimePreKey.keypair.privateKey, input.initiatorEphemeralPub),
    );
  }
  const sharedSecret = c.hkdf(combined, new Uint8Array(32), INFO, 32);
  const associatedData = c.concat(input.initiatorIdentityDhPub, self.dh.publicKey);
  return { sharedSecret, associatedData };
}
