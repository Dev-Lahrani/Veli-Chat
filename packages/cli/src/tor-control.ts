import { readFile } from 'node:fs/promises';
import { type Socket, connect } from 'node:net';

/**
 * Tiny Tor control-protocol client. Just enough to open an ephemeral v3
 * onion service for one session and tear it down on disconnect.
 *
 * Tor's control protocol is line-based ASCII with reply codes (`250 OK`,
 * multi-line `250-...` then `250 OK`). Auth is via cookie file (default on
 * Linux distros), password (HashedControlPassword), or no-auth.
 *
 * For this app we ONLY use cookie auth. Document the user's responsibility:
 *   torrc:
 *     ControlPort 9051
 *     CookieAuthentication 1
 */

const COOKIE_PATHS = [
  '/run/tor/control.authcookie',
  '/var/run/tor/control.authcookie',
  '/var/lib/tor/control_auth_cookie',
  '/usr/local/var/lib/tor/control_auth_cookie', // macOS Homebrew
];

export interface TorOnion {
  /** v3 .onion hostname WITHOUT the trailing ".onion". */
  serviceId: string;
  /** Public-facing port advertised by the hidden service. */
  virtualPort: number;
  /** Local TCP port the service forwards to. */
  localPort: number;
  /** Tear down the onion service. */
  destroy(): Promise<void>;
}

export class TorControl {
  private sock: Socket | null = null;
  private buf = '';
  private waiters: Array<(line: string) => void> = [];
  private accumulated: string[] = [];

  constructor(
    private host = '127.0.0.1',
    private port = 9051,
  ) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = connect({ host: this.host, port: this.port }, () => resolve());
      sock.on('error', reject);
      sock.on('data', (chunk) => this.onData(chunk.toString('utf8')));
      sock.on('close', () => {
        this.sock = null;
      });
      this.sock = sock;
    });
  }

  private onData(s: string) {
    this.buf += s;
    while (true) {
      const nl = this.buf.indexOf('\r\n');
      if (nl < 0) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 2);
      const w = this.waiters.shift();
      if (w) w(line);
      else this.accumulated.push(line);
    }
  }

  private readLine(): Promise<string> {
    const buffered = this.accumulated.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise((r) => this.waiters.push(r));
  }

  /** Send a command and read until a final-status line (mid-line is `250-`, end is `250 ` or 5xx error). */
  private async command(cmd: string): Promise<string[]> {
    if (!this.sock) throw new Error('not connected');
    this.sock.write(`${cmd}\r\n`);
    const lines: string[] = [];
    while (true) {
      const line = await this.readLine();
      lines.push(line);
      // Final line uses a space after the status code; intermediate uses '-'.
      if (/^\d{3} /.test(line)) {
        if (!line.startsWith('250')) {
          throw new Error(`Tor control error: ${lines.join(' | ')}`);
        }
        return lines;
      }
    }
  }

  async authenticate(providedCookieHex?: string): Promise<void> {
    let cookieHex = providedCookieHex;
    if (!cookieHex) {
      for (const p of COOKIE_PATHS) {
        try {
          const buf = await readFile(p);
          cookieHex = buf.toString('hex');
          break;
        } catch {
          /* try next */
        }
      }
    }
    if (!cookieHex) {
      throw new Error(
        'No Tor cookie file found. Ensure Tor is running with `ControlPort 9051` and `CookieAuthentication 1`, and that this user can read the cookie file.',
      );
    }
    await this.command(`AUTHENTICATE ${cookieHex}`);
  }

  /**
   * Create an ephemeral v3 onion service. Returns the .onion service ID
   * (the part before `.onion`). The service lives only as long as this
   * control connection — when we disconnect, Tor reaps it.
   */
  async addEphemeralOnion(virtualPort: number, localPort: number): Promise<TorOnion> {
    const lines = await this.command(
      `ADD_ONION NEW:ED25519-V3 Port=${virtualPort},127.0.0.1:${localPort} Flags=DiscardPK`,
    );
    let serviceId: string | null = null;
    for (const l of lines) {
      const m = l.match(/^250-ServiceID=(\S+)/);
      if (m) serviceId = m[1]!;
    }
    if (!serviceId) throw new Error('ADD_ONION returned no ServiceID');
    return {
      serviceId,
      virtualPort,
      localPort,
      destroy: async () => {
        try {
          await this.command(`DEL_ONION ${serviceId}`);
        } catch {
          /* control may already be gone */
        }
      },
    };
  }

  close(): void {
    try {
      this.sock?.write('QUIT\r\n');
    } catch {
      /* ignore */
    }
    this.sock?.destroy();
    this.sock = null;
  }
}
