import { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FramedConn } from '../src/transport.js';

/**
 * Pair of in-memory FramedConns that talk to each other.
 * Built on top of two paired Duplex streams so we can drive sock.write/sock.on('data')
 * without touching real TCP.
 */
function pair(): [FramedConn, FramedConn] {
  const aBuf: Buffer[] = [];
  const bBuf: Buffer[] = [];

  const aSock: any = new Duplex({
    write(chunk, _enc, cb) {
      bSock.push(chunk);
      cb();
    },
    read() {
      const c = aBuf.shift();
      if (c) this.push(c);
    },
  });
  const bSock: any = new Duplex({
    write(chunk, _enc, cb) {
      aSock.push(chunk);
      cb();
    },
    read() {
      const c = bBuf.shift();
      if (c) this.push(c);
    },
  });
  // Override push to forward as 'data' events for FramedConn's expectations.
  aSock.push = (chunk: Buffer) => {
    if (chunk) aSock.emit('data', chunk);
    return true;
  };
  bSock.push = (chunk: Buffer) => {
    if (chunk) bSock.emit('data', chunk);
    return true;
  };
  return [new FramedConn(aSock), new FramedConn(bSock)];
}

describe('FramedConn padded transport', () => {
  it('round-trips a tiny payload through the smallest bucket', async () => {
    const [a, b] = pair();
    a.send(new TextEncoder().encode('hello'));
    const got = await b.recv();
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!)).toBe('hello');
  });

  it('round-trips a large payload (50 KiB) crossing several buckets', async () => {
    const [a, b] = pair();
    const big = Buffer.alloc(50_000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    a.send(big);
    const got = await b.recv();
    expect(got).not.toBeNull();
    expect(got!.length).toBe(big.length);
    expect(Buffer.compare(got!, big)).toBe(0);
  });

  it('on-wire frame size belongs to the fixed bucket set', async () => {
    const captured: number[] = [];
    const fakeSock: any = new Duplex({
      write(chunk: Buffer, _enc: any, cb: any) {
        // First 4 bytes of every write are the bucket size.
        captured.push(chunk.readUInt32BE(0));
        cb();
      },
      read() {},
    });
    const conn = new FramedConn(fakeSock);
    conn.send(new TextEncoder().encode('x'));
    conn.send(Buffer.alloc(2000));
    conn.send(Buffer.alloc(50_000));
    expect(captured).toEqual([256, 4096, 65536]);
  });

  it('rejects an invalid bucket header by destroying the socket', async () => {
    const [a, _b] = pair();
    let destroyed = false;
    (a as any).sock.destroy = () => {
      destroyed = true;
    };
    // Inject a bogus 4-byte length prefix.
    const evil = Buffer.alloc(4);
    evil.writeUInt32BE(7777, 0);
    (a as any).sock.emit('data', evil);
    expect(destroyed).toBe(true);
  });

  it('handles back-to-back small frames coming in one chunk', async () => {
    const [a, b] = pair();
    a.send(new TextEncoder().encode('one'));
    a.send(new TextEncoder().encode('two'));
    const m1 = await b.recv();
    const m2 = await b.recv();
    expect(new TextDecoder().decode(m1!)).toBe('one');
    expect(new TextDecoder().decode(m2!)).toBe('two');
  });
});
