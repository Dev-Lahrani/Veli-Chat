#!/usr/bin/env node
import { createServer as netCreateServer } from 'node:net';
import { createInterface } from 'node:readline';
import {
  createIdentity,
  createOneTimePreKeys,
  createSignedPreKey,
  ready,
  signIdentityDhBinding,
} from 'veilchat-protocol';
import { runChat } from './chat.js';
import { buildStartCode, parseStartCode } from './code.js';
import { connectorHandshake, inviterHandshake, safetyNumberFor } from './handshake.js';
import { scrub } from './scrub.js';
import { Session } from './session.js';
import { badge, banner, heading, prompt, status, t } from './theme.js';
import { TorControl } from './tor-control.js';
import { type TorInstance, spawnTor } from './tor-daemon.js';
import { dial, listenOnce } from './transport.js';

const VERSION = '0.4.0';
const TAGLINE = 'two-party · end-to-end · ephemeral';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

await ready;

const lanMode = hasFlag('lan');
const lanHost = arg('lan-host') ?? '127.0.0.1';
const lanPortFlag = arg('lan-port');
const presetMode = arg('mode');
const presetCode = arg('code');
const presetName = arg('name') ?? '';
const idleMinutes = Number(arg('idle-minutes') ?? '0') || 0;
const coverTraffic = hasFlag('cover');
const stealthFlag = hasFlag('stealth');
const altScreen = hasFlag('alt-screen');

if (lanMode) {
  console.error(`${badge('LAN MODE', 'warn')} ${t.fog('location anonymity disabled')}`);
}

async function ask(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(prompt(label), resolve));
  rl.close();
  return answer.trim();
}

async function chooseMode(): Promise<'start' | 'connect' | 'help'> {
  if (presetMode === 'start' || presetMode === 'connect' || presetMode === 'help') {
    return presetMode;
  }
  console.log(`\n${banner(TAGLINE, VERSION)}\n`);
  console.log(
    `  ${t.bold(t.accent('1'))}  ${t.bone('Start session')}   ${t.ink('— generate a code to share')}`,
  );
  console.log(
    `  ${t.bold(t.accent('2'))}  ${t.bone('Join session')}    ${t.ink('— paste a code you received')}`,
  );
  console.log(
    `  ${t.bold(t.accent('3'))}  ${t.bone('How it works')}    ${t.ink('— security & threat model')}\n`,
  );
  while (true) {
    const v = await ask('select');
    if (v === '1' || v.toLowerCase() === 'start') return 'start';
    if (v === '2' || v.toLowerCase() === 'join' || v.toLowerCase() === 'connect') return 'connect';
    if (v === '3' || v.toLowerCase() === 'help') return 'help';
    console.log(`  ${t.err('?')} ${t.fog('pick 1, 2, or 3')}`);
  }
}

async function showHelp(): Promise<void> {
  console.log(`\n${heading('How it works')}\n`);
  const items: Array<[string, string]> = [
    ['Zero servers', 'Direct peer-to-peer over Tor. No accounts, no logs, no relay we operate.'],
    ['No backdoors', 'X3DH + Double Ratchet. Forward secrecy. Keys live only in volatile memory.'],
    ['Verify out-of-band', 'Read the Safety Number aloud over a separate channel to defeat MITM.'],
    ['Anonymity', 'Embedded Tor expert bundle hides your IP from the peer and the network.'],
    ['Ephemeral', '/quit (or Ctrl-C) destroys the onion service, the keys, and the history.'],
  ];
  for (const [k, v] of items) {
    console.log(`  ${t.accent('▸')} ${t.bold(t.bone(k))}\n     ${t.fog(v)}\n`);
  }
  console.log(t.ink('  press enter to return…'));
  await ask('');
}

async function startMode(): Promise<void> {
  const identity = createIdentity();
  const spk = createSignedPreKey(identity, 1);
  const opk = createOneTimePreKeys(1, 1)[0]!;

  const desiredLocalPort = lanMode && lanPortFlag ? Number(lanPortFlag) : 0;
  const bindHost = lanMode ? lanHost : '127.0.0.1';
  const tempServerPort = await new Promise<number>((resolve, reject) => {
    const probe = netCreateServer();
    probe.once('error', reject);
    probe.listen(desiredLocalPort, bindHost, () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });

  let kind: 'tor' | 'lan';
  let host: string;
  let port: number;
  let torControl: TorControl | null = null;
  let torInst: TorInstance | null = null;
  let onionDestroy: (() => Promise<void>) | null = null;

  if (lanMode) {
    kind = 'lan';
    host = lanHost;
    port = tempServerPort;
  } else {
    try {
      let lastPct = -10;
      torInst = await spawnTor({
        onProgress: (pct, phase) => {
          if (pct - lastPct >= 10 || pct === 100) {
            lastPct = pct;
            console.error(status(`tor bootstrap ${pct}% · ${phase}`));
          }
        },
      });
      torControl = new TorControl('127.0.0.1', torInst.controlPort);
      await torControl.connect();
      await torControl.authenticate(torInst.cookieHex);

      const virtualPort = 80;
      const onion = await torControl.addEphemeralOnion(virtualPort, tempServerPort);
      onionDestroy = onion.destroy;
      kind = 'tor';
      host = onion.serviceId;
      port = virtualPort;
      console.error(status(`onion ready · ${host}.onion`));
    } catch (e) {
      console.error(
        `${badge('FAIL', 'err')} ${t.bone('could not start Tor:')} ${t.fog(scrub((e as Error).message))}`,
      );
      await torInst?.close();
      process.exit(1);
    }
  }

  const code = buildStartCode(kind, host, port, identity, spk, opk);

  console.log(`\n${heading('Invite code')}`);
  console.log(
    `  ${t.fog('share this with your peer through any channel; the code itself is safe to read aloud.')}\n`,
  );
  console.log(`  ${t.bold(t.cool(code))}\n`);
  console.log(status('waiting for peer…'));

  const { conn } = await listenOnce(tempServerPort, bindHost);
  console.error(`${badge('LINK', 'ok')} ${t.bone('peer connected')}`);

  let initialName = presetName;
  if (!initialName) initialName = await ask('display name');

  try {
    const hs = await inviterHandshake(conn, identity, spk, opk);
    const session = new Session(conn, hs.ratchet, hs.ad);
    const safety = safetyNumberFor(identity.signing.publicKey, hs.peerSigningPub);
    await runChat(session, {
      myName: initialName,
      safetyNumber: safety,
      myPub: identity.signing.publicKey,
      peerPub: hs.peerSigningPub,
      canSendImmediately: false,
      idleMinutes,
      cover: coverTraffic,
      stealth: stealthFlag,
      altScreen,
    });
  } finally {
    try {
      await onionDestroy?.();
    } catch {}
    torControl?.close();
    await torInst?.close();
  }
}

async function connectMode(): Promise<void> {
  const code = presetCode ?? (await ask('paste invite code'));
  let payload: ReturnType<typeof parseStartCode>;
  try {
    payload = parseStartCode(code);
  } catch (e) {
    console.error(
      `${badge('FAIL', 'err')} ${t.bone('invalid code:')} ${t.fog(scrub((e as Error).message))}`,
    );
    process.exit(1);
  }
  if (payload.k === 'tor' && lanMode) {
    console.error(`${badge('FAIL', 'err')} ${t.bone('Tor code used in LAN mode')}`);
    process.exit(1);
  }
  if (payload.k === 'lan' && !lanMode) {
    console.error(`${badge('FAIL', 'err')} ${t.bone('LAN code used in Tor mode')}`);
    process.exit(1);
  }

  const identity = createIdentity();
  const bindingSig = signIdentityDhBinding(identity);

  let conn: import('./transport.js').FramedConn;
  let torInst: TorInstance | null = null;

  if (payload.k === 'tor') {
    try {
      let lastPct = -10;
      torInst = await spawnTor({
        onProgress: (pct, phase) => {
          if (pct - lastPct >= 10 || pct === 100) {
            lastPct = pct;
            console.error(status(`tor bootstrap ${pct}% · ${phase}`));
          }
        },
      });
      console.error(status('dialing peer onion via Tor…'));
      conn = await dial(`${payload.h}.onion`, payload.p, {
        socks: { host: '127.0.0.1', port: torInst.socksPort },
      });
    } catch (e) {
      console.error(
        `${badge('FAIL', 'err')} ${t.bone('connect failed:')} ${t.fog(scrub((e as Error).message))}`,
      );
      await torInst?.close();
      process.exit(1);
    }
  } else {
    console.error(status(`dialing ${payload.h}…`));
    conn = await dial(payload.h, payload.p);
  }

  let initialName = presetName;
  if (!initialName) initialName = await ask('display name');

  try {
    const hs = await connectorHandshake(conn, identity, bindingSig, payload);
    const session = new Session(conn, hs.ratchet, hs.ad);
    const safety = safetyNumberFor(identity.signing.publicKey, hs.peerSigningPub);
    await runChat(session, {
      myName: initialName,
      safetyNumber: safety,
      myPub: identity.signing.publicKey,
      peerPub: hs.peerSigningPub,
      canSendImmediately: true,
      idleMinutes,
      cover: coverTraffic,
      stealth: stealthFlag,
      altScreen,
    });
  } finally {
    await torInst?.close();
  }
}

async function main(): Promise<void> {
  while (true) {
    const mode = await chooseMode();
    if (mode === 'help') {
      await showHelp();
      continue;
    }
    if (mode === 'start') await startMode();
    else await connectMode();
    break;
  }
}

main().catch((e) => {
  console.error(`${badge('FATAL', 'err')} ${t.fog(scrub((e as Error).message))}`);
  process.exit(1);
});
