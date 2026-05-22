import { beforeAll, describe, expect, it } from 'vitest';
import * as c from '../src/crypto.js';
import {
  type PreKeyBundle,
  createIdentity,
  createOneTimePreKeys,
  createSignedPreKey,
  decrypt,
  encrypt,
  initAlice,
  initBob,
  initiatorX3DH,
  ready,
  responderX3DH,
} from '../src/index.js';

beforeAll(async () => {
  await ready;
});

function bundleFor(
  bobIdent: ReturnType<typeof createIdentity>,
  spk: ReturnType<typeof createSignedPreKey>,
  opk: ReturnType<typeof createOneTimePreKeys>[number],
): PreKeyBundle {
  return {
    identitySigningPub: bobIdent.signing.publicKey,
    identityDhPub: bobIdent.dh.publicKey,
    signedPreKeyId: spk.id,
    signedPreKeyPub: spk.keypair.publicKey,
    signedPreKeySig: spk.signature,
    oneTimePreKeyId: opk.id,
    oneTimePreKeyPub: opk.keypair.publicKey,
  };
}

describe('X3DH', () => {
  it('produces matching shared secrets', () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const bobSpk = createSignedPreKey(bob, 1);
    const bobOpk = createOneTimePreKeys(1, 1)[0]!;

    const initOut = initiatorX3DH(alice, bundleFor(bob, bobSpk, bobOpk));
    const respOut = responderX3DH(bob, {
      initiatorIdentityDhPub: alice.dh.publicKey,
      initiatorEphemeralPub: initOut.ephemeralPub,
      signedPreKey: bobSpk,
      oneTimePreKey: bobOpk,
    });

    expect(c.toBase64(initOut.sharedSecret)).toBe(c.toBase64(respOut.sharedSecret));
  });
});

describe('Double Ratchet', () => {
  function setup() {
    const alice = createIdentity();
    const bob = createIdentity();
    const bobSpk = createSignedPreKey(bob, 1);
    const bobOpk = createOneTimePreKeys(1, 1)[0]!;
    const initOut = initiatorX3DH(alice, bundleFor(bob, bobSpk, bobOpk));
    const respOut = responderX3DH(bob, {
      initiatorIdentityDhPub: alice.dh.publicKey,
      initiatorEphemeralPub: initOut.ephemeralPub,
      signedPreKey: bobSpk,
      oneTimePreKey: bobOpk,
    });
    const aliceState = initAlice(initOut.sharedSecret, bobSpk.keypair.publicKey);
    const bobState = initBob(respOut.sharedSecret, bobSpk.keypair);
    return { aliceState, bobState, ad: initOut.associatedData };
  }

  it('round-trips a single message', () => {
    const { aliceState, bobState, ad } = setup();
    const pt = new TextEncoder().encode('hello bob');
    const enc = encrypt(aliceState, pt, ad);
    const dec = decrypt(bobState, enc, ad);
    expect(new TextDecoder().decode(dec)).toBe('hello bob');
  });

  it('handles back-and-forth ratchet', () => {
    const { aliceState, bobState, ad } = setup();
    const m1 = encrypt(aliceState, new TextEncoder().encode('a1'), ad);
    expect(new TextDecoder().decode(decrypt(bobState, m1, ad))).toBe('a1');
    const m2 = encrypt(bobState, new TextEncoder().encode('b1'), ad);
    expect(new TextDecoder().decode(decrypt(aliceState, m2, ad))).toBe('b1');
    const m3 = encrypt(aliceState, new TextEncoder().encode('a2'), ad);
    expect(new TextDecoder().decode(decrypt(bobState, m3, ad))).toBe('a2');
    const m4 = encrypt(bobState, new TextEncoder().encode('b2'), ad);
    expect(new TextDecoder().decode(decrypt(aliceState, m4, ad))).toBe('b2');
  });

  it('handles out-of-order delivery within one chain', () => {
    const { aliceState, bobState, ad } = setup();
    const m1 = encrypt(aliceState, new TextEncoder().encode('a1'), ad);
    const m2 = encrypt(aliceState, new TextEncoder().encode('a2'), ad);
    const m3 = encrypt(aliceState, new TextEncoder().encode('a3'), ad);
    expect(new TextDecoder().decode(decrypt(bobState, m3, ad))).toBe('a3');
    expect(new TextDecoder().decode(decrypt(bobState, m1, ad))).toBe('a1');
    expect(new TextDecoder().decode(decrypt(bobState, m2, ad))).toBe('a2');
  });

  it('survives 200 ping-pong messages', () => {
    const { aliceState, bobState, ad } = setup();
    // Bob's sending chain is only initialized after he receives Alice's first
    // message (which triggers a DH ratchet on his side). So the flow must be
    // strictly ping-pong: A→B then B→A then A→B...
    for (let i = 0; i < 100; i++) {
      const a = encrypt(aliceState, new TextEncoder().encode(`A${i}`), ad);
      expect(new TextDecoder().decode(decrypt(bobState, a, ad))).toBe(`A${i}`);
      const b = encrypt(bobState, new TextEncoder().encode(`B${i}`), ad);
      expect(new TextDecoder().decode(decrypt(aliceState, b, ad))).toBe(`B${i}`);
    }
  });
});
