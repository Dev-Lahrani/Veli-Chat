import { beforeAll, describe, expect, it } from 'vitest';
import { createIdentity, openSealedSender, ready, sealSender } from '../src/index.js';

beforeAll(async () => {
  await ready;
});

describe('sealed sender', () => {
  it('round-trips an opaque payload', () => {
    const recipient = createIdentity();
    const payload = new TextEncoder().encode('inner-ratchet-blob');
    const env = sealSender(recipient.dh.publicKey, payload);
    const out = openSealedSender(env, recipient.dh);
    expect(new TextDecoder().decode(out)).toBe('inner-ratchet-blob');
  });

  it('different recipient cannot decrypt', () => {
    const recipient = createIdentity();
    const stranger = createIdentity();
    const env = sealSender(recipient.dh.publicKey, new TextEncoder().encode('secret'));
    expect(() => openSealedSender(env, stranger.dh)).toThrow();
  });
});
