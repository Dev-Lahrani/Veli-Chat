import { randomBytes } from 'node:crypto';
import {
  type Server,
  type Socket,
  createServer,
  isIPv4,
  isIPv6,
  connect as netConnect,
} from 'node:net';
import { SocksClient } from 'socks';

function isLocalOrRFC1918(host: string): boolean {
  if (host === 'localhost') return true;
  if (isIPv4(host)) {
    const parts = host.split('.').map(Number);
    if (parts[0] === 127) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    return false;
  }
  if (isIPv6(host)) {
    if (host === '::1') return true;
    const lower = host.toLowerCase();
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb')
    )
      return true;
    return false;
  }
  return false;
}

/**
 * Padded length-prefixed framed transport over a single TCP socket.
 *
 * Wire: every frame is exactly one of a small fixed set of bucket sizes,
 * which means the on-wire byte count of a frame leaks nothing about the
 * real payload size — defeating size-based traffic analysis.
 *
 *   [4 bytes BE: bucket size B] [4 bytes BE: real length R] [R bytes payload] [B - 4 - R bytes random padding]
 *
 * Receiver verifies B is a valid bucket, reads R, returns payload[0..R].
 * Random padding is indistinguishable from ciphertext.
 */

const BUCKETS = [256, 1024, 4096, 16384, 65536, 262144];
const MAX_BUCKET = BUCKETS[BUCKETS.length - 1]!;
const MAX_PAYLOAD = MAX_BUCKET - 4;

function pickBucket(realLen: number): number {
  const total = realLen + 4;
  for (const b of BUCKETS) if (b >= total) return b;
  throw new Error('frame too large');
}

export class FramedConn {
  private buf = Buffer.alloc(0);
  private queue: Buffer[] = [];
  private waiters: Array<(buf: Buffer | null) => void> = [];
  private closed = false;
  onClose?: () => void;

  constructor(private sock: Socket) {
    sock.on('data', (chunk) => this.onData(chunk));
    sock.on('close', () => this.handleClose());
    sock.on('error', () => {
      /* swallow; close fires next */
    });
  }

  private handleClose() {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!(null);
    this.onClose?.();
  }

  private onData(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const bucket = this.buf.readUInt32BE(0);
      if (!BUCKETS.includes(bucket)) {
        this.sock.destroy();
        return;
      }
      if (this.buf.length < 4 + bucket) return;
      const body = this.buf.subarray(4, 4 + bucket);
      this.buf = this.buf.subarray(4 + bucket);
      const realLen = body.readUInt32BE(0);
      if (realLen > bucket - 4) {
        this.sock.destroy();
        return;
      }
      const payload = Buffer.from(body.subarray(4, 4 + realLen));
      const w = this.waiters.shift();
      if (w) w(payload);
      else this.queue.push(payload);
    }
  }

  async recv(): Promise<Buffer | null> {
    const head = this.queue.shift();
    if (head) return head;
    if (this.closed) return null;
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  send(payload: Uint8Array): void {
    if (this.closed) return;
    if (payload.length > MAX_PAYLOAD) throw new Error('frame too large');
    const bucket = pickBucket(payload.length);
    const out = Buffer.alloc(4 + bucket);
    out.writeUInt32BE(bucket, 0);
    out.writeUInt32BE(payload.length, 4);
    Buffer.from(payload).copy(out, 8);
    const padLen = bucket - 4 - payload.length;
    if (padLen > 0) randomBytes(padLen).copy(out, 8 + payload.length);
    this.sock.write(out);
  }

  close(): void {
    this.closed = true;
    this.sock.destroy();
  }
}

export async function listenOnce(
  localPort: number,
  host = '127.0.0.1',
): Promise<{ conn: FramedConn; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.once('connection', (sock) => {
      server.close();
      resolve({ conn: new FramedConn(sock), server });
    });
    server.listen(localPort, host);
  });
}

export interface DialOpts {
  socks?: { host: string; port: number };
}

export async function dial(host: string, port: number, opts: DialOpts = {}): Promise<FramedConn> {
  if (opts.socks) {
    const { socket } = await SocksClient.createConnection({
      proxy: { host: opts.socks.host, port: opts.socks.port, type: 5 },
      command: 'connect',
      destination: { host, port },
    });
    return new FramedConn(socket);
  }
  if (!isLocalOrRFC1918(host)) {
    throw new Error('Refusing to dial non-local/RFC1918 destination in LAN mode');
  }
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host, port }, () => resolve(new FramedConn(sock)));
    sock.on('error', reject);
  });
}
