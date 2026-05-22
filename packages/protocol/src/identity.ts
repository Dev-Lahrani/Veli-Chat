import * as c from './crypto.js';

export interface Identity {
  signing: c.KeyPair;
  dh: c.KeyPair;
}

export interface SignedPreKey {
  id: number;
  keypair: c.KeyPair;
  signature: c.Bytes;
  createdAt: number;
}

export interface OneTimePreKey {
  id: number;
  keypair: c.KeyPair;
}

export interface PreKeyBundle {
  identitySigningPub: c.Bytes;
  identityDhPub: c.Bytes;
  signedPreKeyId: number;
  signedPreKeyPub: c.Bytes;
  signedPreKeySig: c.Bytes;
  oneTimePreKeyId?: number;
  oneTimePreKeyPub?: c.Bytes;
}

export function createIdentity(): Identity {
  return {
    signing: c.generateSignKeyPair(),
    dh: c.generateDhKeyPair(),
  };
}

export function createSignedPreKey(id: Identity, keyId: number): SignedPreKey {
  const kp = c.generateDhKeyPair();
  return {
    id: keyId,
    keypair: kp,
    signature: c.sign(kp.publicKey, id.signing.privateKey),
    createdAt: Date.now(),
  };
}

export function createOneTimePreKeys(startId: number, count: number): OneTimePreKey[] {
  const out: OneTimePreKey[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ id: startId + i, keypair: c.generateDhKeyPair() });
  }
  return out;
}

export function verifyPreKeyBundle(b: PreKeyBundle): boolean {
  return c.verifySig(b.signedPreKeySig, b.signedPreKeyPub, b.identitySigningPub);
}

export function userIdFor(identitySigningPub: c.Bytes): string {
  return c.toBase64(c.blake2b(identitySigningPub, 20));
}

const ID_DH_BIND_DOMAIN = new TextEncoder().encode('Nox-IdentityDhBinding-v1');

/**
 * Bind the identity-DH key to the identity-signing key. Without this, an
 * attacker can register a userId (which is hash(signingPub)) but supply any
 * identityDhPub they want — the server has no way to know if the DH key
 * really belongs to the same user. With this signature, the server enforces
 * that only the holder of the signing private key could have produced the
 * binding, so identityDhPub is provably owned by the same identity.
 */
export function signIdentityDhBinding(id: Identity): c.Bytes {
  return c.sign(c.concat(ID_DH_BIND_DOMAIN, id.dh.publicKey), id.signing.privateKey);
}

export function verifyIdentityDhBinding(
  identitySigningPub: c.Bytes,
  identityDhPub: c.Bytes,
  signature: c.Bytes,
): boolean {
  return c.verifySig(signature, c.concat(ID_DH_BIND_DOMAIN, identityDhPub), identitySigningPub);
}
