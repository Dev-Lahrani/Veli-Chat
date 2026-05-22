import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { get } from 'node:https';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';

const TOR_VERSION = '15.0.10';

function getTorDownloadUrl(): string {
  const os = platform();
  const a = arch();
  const map: Record<string, string> = {
    'linux:x64': 'linux-x86_64',
    'linux:ia32': 'linux-i686',
    'darwin:x64': 'macos-x86_64',
    'darwin:arm64': 'macos-aarch64',
    'win32:x64': 'windows-x86_64',
    'win32:ia32': 'windows-i686',
  };
  const key = `${os}:${a}`;
  const suffix = map[key];
  if (!suffix) throw new Error(`Unsupported OS/Arch for auto-download: ${key}`);
  return `https://dist.torproject.org/torbrowser/${TOR_VERSION}/tor-expert-bundle-${suffix}-${TOR_VERSION}.tar.gz`;
}

async function downloadAndExtractTor(): Promise<string> {
  const binDir = join(homedir(), '.veilchat', 'bin');
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });

  const exeName = platform() === 'win32' ? 'tor.exe' : 'tor';
  const torPath = join(binDir, 'tor', exeName);
  if (existsSync(torPath)) return torPath;

  console.error(
    `\n\x1b[90m[veil] Tor binary not found. Downloading v${TOR_VERSION} expert bundle...\x1b[0m`,
  );
  const url = getTorDownloadUrl();
  const tarPath = join(binDir, 'tor-expert-bundle.tar.gz');

  await new Promise<void>((resolve, reject) => {
    get(url, (res) => {
      if (res.statusCode !== 200) {
        if (res.statusCode === 302 || res.statusCode === 301) {
          // If it redirects, we should follow it, but for torproject it usually doesn't.
          return reject(new Error(`Failed to download Tor: HTTP ${res.statusCode} (Redirect)`));
        }
        return reject(new Error(`Failed to download Tor: HTTP ${res.statusCode}`));
      }
      const file = createWriteStream(tarPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', reject);
  });

  console.error('\x1b[90m[veil] Extracting Tor...\x1b[0m');
  // System tar is available on Mac/Linux and Windows 10+
  execSync(`tar -xzf "${tarPath}" -C "${binDir}"`);

  if (!existsSync(torPath)) {
    throw new Error(`Extraction failed, could not find ${torPath}`);
  }
  return torPath;
}

function findTorBinary(): string {
  try {
    const out = execSync(platform() === 'win32' ? 'where tor' : 'which tor', { stdio: 'pipe' });
    return out.toString().split('\n')[0]!.trim();
  } catch {
    return '';
  }
}

export interface TorInstance {
  socksPort: number;
  controlPort: number;
  cookieHex: string;
  close: () => Promise<void>;
}

export interface SpawnOpts {
  onProgress?: (pct: number, phase: string) => void;
}

export async function spawnTor(spawnOpts: SpawnOpts = {}): Promise<TorInstance> {
  let bin = findTorBinary();
  if (!bin) bin = await downloadAndExtractTor();

  const dataDir = await mkdtemp(join(tmpdir(), 'veil-tor-'));
  const pid = process.pid;

  console.error('\x1b[90m[veil] Spawning embedded Tor...\x1b[0m');

  return new Promise((resolve, reject) => {
    const tor = spawn(bin, [
      '--DataDirectory',
      dataDir,
      '--SocksPort',
      'auto',
      '--ControlPort',
      'auto',
      '--CookieAuthentication',
      '1',
      '--__OwningControllerProcess',
      String(pid),
    ]);

    let socksPort = 0;
    let controlPort = 0;
    let errBuf = '';
    let isReady = false;

    const checkReady = () => {
      if (isReady) return;
      if (socksPort && controlPort) {
        isReady = true;
        // Read the auth cookie that Tor generated
        const cookiePath = join(dataDir, 'control_auth_cookie');
        let cookieHex = '';
        try {
          cookieHex = readFileSync(cookiePath).toString('hex');
        } catch (e) {
          return reject(new Error(`Failed to read Tor auth cookie: ${(e as Error).message}`));
        }

        resolve({
          socksPort,
          controlPort,
          cookieHex,
          close: async () => {
            tor.kill('SIGINT');
            try {
              await rm(dataDir, { recursive: true, force: true });
            } catch {}
          },
        });
      }
    };

    tor.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      const sMatch = s.match(/Socks listener listening on port (\d+)/);
      if (sMatch) socksPort = Number(sMatch[1]);

      const cMatch = s.match(/Control listener listening on port (\d+)/);
      if (cMatch) controlPort = Number(cMatch[1]);

      // Stream every Bootstrapped milestone, not just 100%.
      const bootRe = /Bootstrapped (\d+)% \(([^)]+)\)/g;
      let m: RegExpExecArray | null = bootRe.exec(s);
      while (m) {
        spawnOpts.onProgress?.(Number(m[1]), m[2] ?? '');
        m = bootRe.exec(s);
      }

      if (s.includes('Bootstrapped 100%')) {
        checkReady();
      }
    });

    tor.stderr.on('data', (chunk) => {
      errBuf += chunk.toString();
    });

    tor.on('close', (code) => {
      if (!isReady && code !== 0) {
        reject(new Error(`Tor exited with code ${code}. Log:\n${errBuf}`));
      }
    });

    tor.on('error', (err) => {
      if (!isReady) reject(err);
    });
  });
}
