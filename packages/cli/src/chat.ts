import { createInterface } from 'node:readline';
import { crypto as c } from 'veilchat-protocol';
import { renderMarkdown } from './markdown.js';
import { safetyBlock } from './safety-art.js';
import { sanitize } from './sanitize.js';
import type { ControlMessage, Session } from './session.js';
import { badge, colorForName, heading, t } from './theme.js';

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fingerprint(pub: Uint8Array): string {
  // Short key fingerprint: BLAKE2b-8 of the signing pubkey, hex grouped 4-4.
  const h = c.blake2b(pub, 8);
  const hex = c.toHex(h);
  return `${hex.slice(0, 4)} ${hex.slice(4, 8)} ${hex.slice(8, 12)} ${hex.slice(12, 16)}`;
}

export interface ChatOptions {
  myName: string;
  safetyNumber: string;
  myPub: Uint8Array;
  peerPub: Uint8Array;
  /**
   * Whether we may send immediately. The X3DH responder (inviter) cannot
   * send until they've received the connector's first frame. If false,
   * outbound frames queue until the first inbound message arrives.
   */
  canSendImmediately: boolean;
  /** Auto-quit after this many idle minutes. 0 disables. */
  idleMinutes?: number;
  /** Send opaque cover-traffic frames at jittered 30-90s intervals. */
  cover?: boolean;
  /** Start in stealth mode (mask names) — toggle with /stealth. */
  stealth?: boolean;
  /** Use alternate screen buffer so chat leaves no scrollback on exit. */
  altScreen?: boolean;
}

const HELP_LINES = [
  ['/name <new>', 'change your display name'],
  ['/whois', 'show safety number, grid, and key fingerprints'],
  ['/clear', 'wipe terminal scrollback (no effect on session)'],
  ['/copy', 'copy the safety number to the clipboard (OSC52)'],
  ['/stealth', 'toggle masking of names — for screen sharing'],
  ['/panic', 'WIPE screen + drop session immediately'],
  ['/typing on|off', 'opt-in typing indicator (default off)'],
  ['/receipts on|off', 'opt-in read receipts (default off)'],
  ['/sendfile <path>', 'offer a file to peer (caps at 16 MiB)'],
  ['/files', 'list files received this session'],
  ['/save <id> [path]', 'save a received file to disk'],
  ['/sha <id>', 'show SHA-256 of a received file (audit before /save)'],
  ['/help', 'this help'],
  ['/quit', 'end session and wipe state'],
];

export async function runChat(session: Session, opts: ChatOptions): Promise<void> {
  let myName = opts.myName;
  let peerName = '(anonymous)';
  let canSend = opts.canSendImmediately;
  let stealth = opts.stealth ?? false;
  let typing = false;
  let receipts = false;
  let sentCount = 0;
  let recvCount = 0;
  const startedAt = Date.now();
  const pending: ControlMessage[] = [];

  const idleMs = (opts.idleMinutes ?? 0) * 60_000;
  let idleTimer: NodeJS.Timeout | null = null;
  let warnedIdle = false;
  const resetIdle = () => {
    warnedIdle = false;
    if (idleTimer) clearTimeout(idleTimer);
    if (idleMs <= 0) return;
    idleTimer = setTimeout(
      () => {
        if (!warnedIdle) {
          warnedIdle = true;
          process.stdout.write(
            `\r\x1b[K${t.warn('* idle — auto-closing in 60s; press Enter to keep alive')}\n`,
          );
          rl.prompt(true);
          idleTimer = setTimeout(() => {
            process.stdout.write(`\r\x1b[K${t.warn('* idle — closing session')}\n`);
            finish();
          }, 60_000);
        }
      },
      Math.max(60_000, idleMs - 60_000),
    );
  };

  const trySend = (m: ControlMessage) => {
    if (canSend) session.send(m);
    else pending.push(m);
  };
  const flushPending = () => {
    if (!canSend) return;
    while (pending.length) session.send(pending.shift()!);
  };

  const showName = (n: string) => (stealth ? 'peer' : n);
  const showMyName = () => (stealth ? 'you' : myName || '(anonymous)');

  console.log(`\n${heading('Connected')}\n`);
  console.log(
    `  ${t.fog('verify this safety number AND grid with your peer through a separate channel:')}`,
  );
  console.log(`  ${t.bold(t.cool(opts.safetyNumber))}\n`);
  console.log(safetyBlock(opts.safetyNumber));
  console.log();
  console.log(`  ${t.warn('if the numbers OR shapes do not match, /quit immediately.')}\n`);
  console.log(`  ${t.ink('type')} ${t.bold(t.bone('/help'))} ${t.ink('for commands')}`);
  console.log(`  ${t.ink('anything else is sent to the peer.')}\n`);

  if (opts.altScreen) process.stdout.write('\x1b[?1049h\x1b[H');
  if (myName) trySend({ type: 'name', name: myName });

  const COMMANDS = [
    '/name ',
    '/whois',
    '/clear',
    '/copy',
    '/stealth',
    '/panic',
    '/typing on',
    '/typing off',
    '/receipts on',
    '/receipts off',
    '/sendfile ',
    '/files',
    '/save ',
    '/reject ',
    '/help',
    '/quit',
  ];
  const completer = (line: string): [string[], string] => {
    if (!line.startsWith('/')) return [[], line];
    const hits = COMMANDS.filter((c) => c.startsWith(line));
    return [hits.length ? hits : COMMANDS, line];
  };
  const rl = createInterface({ input: process.stdin, output: process.stdout, completer });
  rl.setPrompt(`${t.accent('❯')} `);
  rl.prompt();

  let done = false;
  let coverTimer: NodeJS.Timeout | null = null;

  const finish = () => {
    if (done) return;
    done = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (coverTimer) clearTimeout(coverTimer);
    try {
      session.close();
    } catch {}
    rl.close();
    if (opts.altScreen) process.stdout.write('\x1b[?1049l');
  };

  const panic = () => {
    // Clear screen + scrollback, then close.
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    finish();
  };

  const printSummary = () => {
    const dur = Math.round((Date.now() - startedAt) / 1000);
    const m = Math.floor(dur / 60);
    const s = dur % 60;
    process.stdout.write(
      `\n${heading('Session ended')}\n  ${t.fog(`sent: ${sentCount}  received: ${recvCount}  duration: ${m}m ${s}s`)}\n  ${t.ink('all keys and history are gone.')}\n`,
    );
  };

  const scheduleCover = () => {
    if (!opts.cover || done) return;
    const ms = 30_000 + Math.floor(Math.random() * 60_000);
    coverTimer = setTimeout(() => {
      if (done) return;
      try {
        if (canSend) session.send({ type: 'noop' });
      } catch {}
      scheduleCover();
    }, ms);
  };

  // Files held in memory only. Map id → { name, size, mime, chunks: Buffer[] }.
  type RxFile = {
    id: string;
    name: string;
    size: number;
    mime: string;
    got: number;
    chunks: Buffer[];
    from: string;
    complete: boolean;
  };
  const rxFiles = new Map<string, RxFile>();
  // Outbound file streams in progress.
  const txFiles = new Map<string, { name: string; size: number }>();

  resetIdle();
  scheduleCover();

  const reader = (async () => {
    try {
      while (!done) {
        const msg: ControlMessage | null = await session.recv();
        if (!msg) {
          process.stdout.write(
            `\r\x1b[K\n${badge('LINK', 'warn')} ${t.fog('peer disconnected')}\n`,
          );
          finish();
          return;
        }
        if (!canSend) {
          canSend = true;
          flushPending();
        }
        resetIdle();

        process.stdout.write('\r\x1b[K');

        switch (msg.type) {
          case 'msg': {
            recvCount += 1;
            const safe = sanitize(msg.text);
            const rendered = renderMarkdown(safe);
            const nameClr = stealth ? t.accent : colorForName(peerName);
            process.stdout.write(
              `${t.ink(`[${fmtTime(Date.now())}]`)} ${t.bold(nameClr(showName(peerName)))}${t.ink(':')} ${rendered}\n`,
            );
            if (receipts) trySend({ type: 'read', upTo: recvCount });
            break;
          }
          case 'name': {
            const next = sanitize(msg.name).trim() || '(anonymous)';
            process.stdout.write(
              `${t.ink(`[${fmtTime(Date.now())}]`)} ${t.fog(`* peer is now ${stealth ? 'peer' : next}`)}\n`,
            );
            peerName = next;
            break;
          }
          case 'typing': {
            process.stdout.write(`${t.ink(`* ${showName(peerName)} is typing…`)}\n`);
            break;
          }
          case 'read': {
            process.stdout.write(`${t.ink(`* peer read up to message ${msg.upTo}`)}\n`);
            break;
          }
          case 'noop':
            // Cover traffic; ignore.
            break;
          case 'file-offer': {
            const safeName = sanitize(msg.name).replace(/[\\/]/g, '').slice(0, 96) || 'file';
            const rec: RxFile = {
              id: msg.id,
              name: safeName,
              size: msg.size,
              mime: sanitize(msg.mime).slice(0, 48),
              got: 0,
              chunks: [],
              from: peerName,
              complete: false,
            };
            rxFiles.set(msg.id, rec);
            const sizeKb = (msg.size / 1024).toFixed(1);
            process.stdout.write(
              `${badge('FILE', 'info')} ${t.bold(t.bone(safeName))} ${t.ink(`(${sizeKb} KiB)`)} ${t.fog(`offered. /save ${msg.id} to write to disk; /reject ${msg.id} to drop.`)}\n`,
            );
            break;
          }
          case 'file-chunk': {
            const rec = rxFiles.get(msg.id);
            if (!rec || rec.complete) break;
            const buf = Buffer.from(msg.data, 'base64');
            if (rec.got + buf.length > rec.size + 64) {
              rxFiles.delete(msg.id);
              process.stdout.write(
                `${badge('FILE', 'err')} ${t.fog(`peer over-sent; dropping ${msg.id}`)}\n`,
              );
              break;
            }
            rec.chunks.push(buf);
            rec.got += buf.length;
            break;
          }
          case 'file-end': {
            const rec = rxFiles.get(msg.id);
            if (!rec) break;
            rec.complete = true;
            process.stdout.write(
              `${badge('FILE', 'ok')} ${t.fog(`${rec.name} fully received (${rec.got} B). /save ${rec.id} <path>`)}\n`,
            );
            break;
          }
          case 'bye':
            process.stdout.write(`${t.fog('* peer left the chat')}\n`);
            finish();
            return;
        }

        if (!done) rl.prompt(true);
      }
    } catch (e) {
      if (!done) {
        process.stdout.write(`\r\x1b[K\n${badge('ERR', 'err')} ${t.fog((e as Error).message)}\n`);
      }
      finish();
    }
  })();

  // Throttle outgoing typing indicators.
  let lastTypingAt = 0;
  process.stdin.on('keypress', () => {
    if (!typing || done) return;
    const now = Date.now();
    if (now - lastTypingAt < 2000) return;
    lastTypingAt = now;
    try {
      if (canSend) session.send({ type: 'typing' });
    } catch {}
  });

  rl.on('SIGINT', () => {
    process.stdout.write(`\r\x1b[K${t.warn('* SIGINT — panic wipe')}\n`);
    panic();
  });

  rl.on('line', async (raw) => {
    const line = raw.trim();
    if (done) return;
    resetIdle();
    try {
      if (line === '/quit') {
        finish();
        return;
      }
      if (line === '/panic') {
        panic();
        return;
      }
      if (line === '/clear') {
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
        rl.prompt();
        return;
      }
      if (line === '/help' || line === '/?') {
        process.stdout.write(`${heading('Commands')}\n`);
        for (const [cmd, desc] of HELP_LINES) {
          process.stdout.write(`  ${t.bold(t.accent(cmd!.padEnd(20)))} ${t.fog(desc!)}\n`);
        }
        rl.prompt();
        return;
      }
      if (line === '/whois') {
        process.stdout.write(`${heading('Identity')}\n`);
        process.stdout.write(`  ${t.ink('safety number')}  ${t.bold(t.cool(opts.safetyNumber))}\n`);
        process.stdout.write(
          `  ${t.ink('your fingerprint')}  ${t.bold(t.bone(fingerprint(opts.myPub)))}\n`,
        );
        process.stdout.write(
          `  ${t.ink('peer fingerprint')}  ${t.bold(t.bone(fingerprint(opts.peerPub)))}\n`,
        );
        process.stdout.write(`${safetyBlock(opts.safetyNumber)}\n`);
        rl.prompt();
        return;
      }
      if (line === '/copy') {
        const b64 = Buffer.from(opts.safetyNumber, 'utf8').toString('base64');
        process.stdout.write(`\x1b]52;c;${b64}\x07`);
        process.stdout.write(
          `${t.fog('* safety number copied to clipboard via OSC52 (terminal must support it)')}\n`,
        );
        rl.prompt();
        return;
      }
      if (line === '/stealth') {
        stealth = !stealth;
        process.stdout.write(
          `${t.fog(`* stealth mode ${stealth ? 'on (names masked)' : 'off'}`)}\n`,
        );
        rl.prompt();
        return;
      }
      if (line.startsWith('/typing ')) {
        const v = line.slice('/typing '.length).trim();
        typing = v === 'on';
        process.stdout.write(`${t.fog(`* typing indicator ${typing ? 'on' : 'off'}`)}\n`);
        rl.prompt();
        return;
      }
      if (line.startsWith('/receipts ')) {
        const v = line.slice('/receipts '.length).trim();
        receipts = v === 'on';
        process.stdout.write(`${t.fog(`* read receipts ${receipts ? 'on' : 'off'}`)}\n`);
        rl.prompt();
        return;
      }
      if (line.startsWith('/sendfile ')) {
        const path = line.slice('/sendfile '.length).trim();
        await sendFile(path, trySend, txFiles, () => {
          sentCount += 1;
        });
        rl.prompt();
        return;
      }
      if (line === '/files') {
        if (!rxFiles.size) {
          process.stdout.write(`${t.fog('* no files received yet')}\n`);
        } else {
          for (const f of rxFiles.values()) {
            const status = f.complete ? 'ready' : `${Math.round((f.got / f.size) * 100)}%`;
            process.stdout.write(
              `  ${t.bold(t.bone(f.id))} ${t.ink('·')} ${f.name} ${t.ink(`(${f.size} B, ${status})`)}\n`,
            );
          }
        }
        rl.prompt();
        return;
      }
      if (line.startsWith('/save ')) {
        const parts = line.slice('/save '.length).trim().split(/\s+/);
        const id = parts[0]!;
        const dest = parts[1];
        await saveFile(rxFiles, id, dest);
        rl.prompt();
        return;
      }
      if (line.startsWith('/sha ')) {
        const id = line.slice('/sha '.length).trim();
        const f = rxFiles.get(id);
        if (!f) {
          process.stdout.write(`${badge('FILE', 'err')} ${t.fog(`no such id ${id}`)}\n`);
        } else if (!f.complete) {
          process.stdout.write(`${badge('FILE', 'warn')} ${t.fog(`${id} still receiving`)}\n`);
        } else {
          const { createHash } = await import('node:crypto');
          const h = createHash('sha256');
          for (const c of f.chunks) h.update(c);
          process.stdout.write(`  ${t.ink('sha256')}  ${t.bold(t.cool(h.digest('hex')))}\n`);
        }
        rl.prompt();
        return;
      }
      if (line.startsWith('/reject ')) {
        const id = line.slice('/reject '.length).trim();
        if (rxFiles.delete(id)) process.stdout.write(`${t.fog(`* dropped ${id}`)}\n`);
        rl.prompt();
        return;
      }
      if (line.startsWith('/name ')) {
        myName = line.slice('/name '.length).trim() || '';
        trySend({ type: 'name', name: myName });
        process.stdout.write(`${t.fog(`* you are now ${showMyName()}`)}\n`);
        rl.prompt();
        return;
      }
      if (line.startsWith('/')) {
        process.stdout.write(`${t.fog('(unknown command — try /help)')}\n`);
        rl.prompt();
        return;
      }
      if (line.length > 0) {
        trySend({ type: 'msg', text: line });
        sentCount += 1;
      }
    } catch (e) {
      process.stdout.write(`${badge('ERR', 'err')} ${t.fog((e as Error).message)}\n`);
    }
    if (!done) rl.prompt();
  });

  await reader;
  printSummary();
}

async function sendFile(
  path: string,
  trySend: (m: ControlMessage) => void,
  txFiles: Map<string, { name: string; size: number }>,
  onSent: () => void,
): Promise<void> {
  const { readFile } = await import('node:fs/promises');
  const { basename } = await import('node:path');
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (e) {
    process.stdout.write(
      `${badge('FILE', 'err')} ${t.fog(`cannot read: ${(e as Error).message}`)}\n`,
    );
    return;
  }
  const MAX = 16 * 1024 * 1024;
  if (buf.length > MAX) {
    process.stdout.write(`${badge('FILE', 'err')} ${t.fog(`file > ${MAX} B; refusing`)}\n`);
    return;
  }
  const id = `f${Math.floor(Math.random() * 1e6).toString(36)}`;
  const name = basename(path).slice(0, 96);
  txFiles.set(id, { name, size: buf.length });
  trySend({ type: 'file-offer', id, name, size: buf.length, mime: 'application/octet-stream' });
  // Chunk size kept well under transport bucket-1 to avoid jumping to the next bucket per chunk.
  const CHUNK = 48 * 1024;
  for (let off = 0; off < buf.length; off += CHUNK) {
    const slice = buf.subarray(off, Math.min(off + CHUNK, buf.length));
    trySend({ type: 'file-chunk', id, data: slice.toString('base64') });
  }
  trySend({ type: 'file-end', id });
  onSent();
  process.stdout.write(
    `${badge('FILE', 'ok')} ${t.fog(`offered ${name} (${buf.length} B) as ${id}`)}\n`,
  );
}

async function saveFile(
  rxFiles: Map<
    string,
    { id: string; name: string; size: number; chunks: Buffer[]; complete: boolean; got: number }
  >,
  id: string,
  dest?: string,
): Promise<void> {
  const f = rxFiles.get(id);
  if (!f) {
    process.stdout.write(`${badge('FILE', 'err')} ${t.fog(`no such id ${id}`)}\n`);
    return;
  }
  if (!f.complete) {
    process.stdout.write(
      `${badge('FILE', 'warn')} ${t.fog(`${id} still receiving (${f.got}/${f.size})`)}\n`,
    );
    return;
  }
  const { writeFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const out = resolve(process.cwd(), dest ?? f.name);
  const data = Buffer.concat(f.chunks);
  if (data.length !== f.size) {
    process.stdout.write(`${badge('FILE', 'err')} ${t.fog('size mismatch; dropping')}\n`);
    rxFiles.delete(id);
    return;
  }
  await writeFile(out, data, { mode: 0o600 });
  rxFiles.delete(id);
  process.stdout.write(
    `${badge('FILE', 'ok')} ${t.fog(`wrote ${out} (${data.length} B, mode 600)`)}\n`,
  );
}
