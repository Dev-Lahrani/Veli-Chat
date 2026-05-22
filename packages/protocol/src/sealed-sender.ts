import * as c from './crypto.js';

/**
 * Sealed-sender envelope. The server-visible outer layer reveals only the
 * recipient. The sender's identity is encrypted under a key derived from a
 * fresh ephemeral DH with the recipient's identity DH key.
 *
 * Wire format:
 *   senderEphemeralPub (32) || aead(ciphertext, ad=recipientIdentityDhPub)
 *
 * Inside the AEAD plaintext is the actual ratchet payload + sender userId.
 */

const INFO = new TextEncoder().encode('Nox-SealedSender-v1');

export function sealSender(recipientIdentityDhPub: c.Bytes, innerPayload: c.Bytes): c.Bytes {
  const eph = c.generateDhKeyPair();
  const shared = c.dh(eph.privateKey, recipientIdentityDhPub);
  const key = c.hkdf(shared, new Uint8Array(32), INFO, 32);
  const sealed = c.aeadEncrypt(key, innerPayload, recipientIdentityDhPub);
  return c.concat(eph.publicKey, sealed);
}

export function openSealedSender(envelope: c.Bytes, recipientIdentityDh: c.KeyPair): c.Bytes {
  if (envelope.length < 32) throw new Error('Envelope too short');
  const senderEphPub = envelope.slice(0, 32);
  const sealed = envelope.slice(32);
  const shared = c.dh(recipientIdentityDh.privateKey, senderEphPub);
  const key = c.hkdf(shared, new Uint8Array(32), INFO, 32);
  return c.aeadDecrypt(key, sealed, recipientIdentityDh.publicKey);
}
