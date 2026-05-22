import { beforeAll, describe, expect, it } from 'vitest';
import {
  type SenderKeyDistributionMessage,
  createSenderKey,
  decryptGroup,
  encryptGroup,
  initReceiver,
  ready,
} from '../src/index.js';

beforeAll(async () => {
  await ready;
});

describe('Sender Keys (group)', () => {
  it('round-trips a single group message', () => {
    const { state, distribution } = createSenderKey();
    const dist: SenderKeyDistributionMessage = {
      groupId: 'g',
      senderUserId: 'alice',
      iteration: distribution.iteration,
      chainKey: distribution.chainKey,
      signingPub: distribution.signingPub,
    };
    const ad = new TextEncoder().encode('Anon-Group-v1');
    const ct = encryptGroup(state, new TextEncoder().encode('hello group'), ad);
    const rs = initReceiver(dist);
    const pt = decryptGroup(rs, ct, ad);
    expect(new TextDecoder().decode(pt)).toBe('hello group');
  });

  it('handles in-order chain of group messages', () => {
    const { state, distribution } = createSenderKey();
    const ad = new Uint8Array();
    const rs = initReceiver({
      groupId: '',
      senderUserId: '',
      iteration: distribution.iteration,
      chainKey: distribution.chainKey,
      signingPub: distribution.signingPub,
    });
    for (let i = 0; i < 50; i++) {
      const ct = encryptGroup(state, new TextEncoder().encode(String(i)), ad);
      const pt = decryptGroup(rs, ct, ad);
      expect(new TextDecoder().decode(pt)).toBe(String(i));
    }
  });

  it('handles out-of-order group messages within skip window', () => {
    const { state, distribution } = createSenderKey();
    const ad = new Uint8Array();
    const rs = initReceiver({
      groupId: '',
      senderUserId: '',
      iteration: distribution.iteration,
      chainKey: distribution.chainKey,
      signingPub: distribution.signingPub,
    });
    const cts = [];
    for (let i = 0; i < 5; i++)
      cts.push(encryptGroup(state, new TextEncoder().encode(`m${i}`), ad));
    // Decrypt 3, 0, 4, 1, 2
    expect(new TextDecoder().decode(decryptGroup(rs, cts[3]!, ad))).toBe('m3');
    expect(new TextDecoder().decode(decryptGroup(rs, cts[0]!, ad))).toBe('m0');
    expect(new TextDecoder().decode(decryptGroup(rs, cts[4]!, ad))).toBe('m4');
    expect(new TextDecoder().decode(decryptGroup(rs, cts[1]!, ad))).toBe('m1');
    expect(new TextDecoder().decode(decryptGroup(rs, cts[2]!, ad))).toBe('m2');
  });
});
