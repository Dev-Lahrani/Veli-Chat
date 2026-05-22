/**
 * Visual theme for the veilchat CLI: ANSI palette + small helpers.
 * Auto-detects truecolor / 256-color / no-color and degrades gracefully.
 */

const COLOR_LEVEL: 0 | 1 | 2 = (() => {
  if (process.env.NO_COLOR) return 0;
  if (!process.stdout.isTTY) return 1;
  const ct = (process.env.COLORTERM ?? '').toLowerCase();
  if (ct.includes('truecolor') || ct.includes('24bit')) return 2;
  return 1;
})();

const RESET = '\x1b[0m';

function rgb(r: number, g: number, b: number): string {
  if (COLOR_LEVEL === 0) return '';
  if (COLOR_LEVEL === 2) return `\x1b[38;2;${r};${g};${b}m`;
  // 6×6×6 cube fallback
  const q = (v: number) => Math.round((v / 255) * 5);
  return `\x1b[38;5;${16 + 36 * q(r) + 6 * q(g) + q(b)}m`;
}

const wrap = (open: string) => (s: string) => (COLOR_LEVEL === 0 ? s : `${open}${s}${RESET}`);

// --- palette -------------------------------------------------------------
// Cool violet → cyan gradient. "Veil" feel: dusk, smoke, glass.
const C = {
  veil1: rgb(120, 90, 220),
  veil2: rgb(150, 110, 235),
  veil3: rgb(180, 130, 245),
  veil4: rgb(170, 165, 255),
  veil5: rgb(140, 200, 255),
  veil6: rgb(110, 230, 240),
  ink: rgb(110, 110, 130),
  fog: rgb(160, 160, 180),
  bone: rgb(225, 225, 235),
  rose: rgb(255, 105, 145),
  mint: rgb(120, 230, 170),
  amber: rgb(255, 190, 90),
};

const BOLD = COLOR_LEVEL === 0 ? '' : '\x1b[1m';
const DIM = COLOR_LEVEL === 0 ? '' : '\x1b[2m';

export const t = {
  reset: RESET,
  bold: (s: string) => (COLOR_LEVEL === 0 ? s : `${BOLD}${s}${RESET}`),
  dim: (s: string) => (COLOR_LEVEL === 0 ? s : `${DIM}${s}${RESET}`),
  ink: wrap(C.ink),
  fog: wrap(C.fog),
  bone: wrap(C.bone),
  accent: wrap(C.veil3),
  cool: wrap(C.veil5),
  cyan: wrap(C.veil6),
  warn: wrap(C.amber),
  err: wrap(C.rose),
  ok: wrap(C.mint),
  /** Apply the violet→cyan gradient across a string, char by char. */
  gradient(s: string): string {
    if (COLOR_LEVEL === 0) return s;
    const stops = [C.veil1, C.veil2, C.veil3, C.veil4, C.veil5, C.veil6];
    let out = '';
    let i = 0;
    for (const ch of s) {
      if (ch === '\n' || ch === ' ') {
        out += ch;
        continue;
      }
      const stop =
        stops[Math.min(stops.length - 1, Math.floor((i / Math.max(1, s.length)) * stops.length))]!;
      out += stop + ch;
      i++;
    }
    return out + RESET;
  },
  /** Gradient applied per-line so vertical art keeps its shape. */
  gradientLines(s: string): string {
    return s
      .split('\n')
      .map((line) => this.gradient(line))
      .join('\n');
  },
};

// --- ASCII art -----------------------------------------------------------

const LOGO_RAW = String.raw`
██╗   ██╗███████╗██╗██╗      ██████╗██╗  ██╗ █████╗ ████████╗
██║   ██║██╔════╝██║██║     ██╔════╝██║  ██║██╔══██╗╚══██╔══╝
██║   ██║█████╗  ██║██║     ██║     ███████║███████║   ██║
╚██╗ ██╔╝██╔══╝  ██║██║     ██║     ██╔══██║██╔══██║   ██║
 ╚████╔╝ ███████╗██║███████╗╚██████╗██║  ██║██║  ██║   ██║
  ╚═══╝  ╚══════╝╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝`;

const LOGO_COMPACT = String.raw`
 ▌ ▌ ▛▀▖ ▀█▀ ▌
 ▌▗▘ ▛▀  ▀▛▘ ▙
 ▘▘  ▘▘▘ ▘▘  ▝▘`;

function term(): { cols: number } {
  return { cols: process.stdout.columns ?? 80 };
}

export function banner(tagline: string, version: string): string {
  const { cols } = term();
  const art = cols >= 64 ? LOGO_RAW : LOGO_COMPACT;
  const lines = art.split('\n');
  const inner = t.gradientLines(art);
  const sub = `${t.dim(t.bone('  ▎'))} ${t.bold(t.bone(tagline))}  ${t.ink(`v${version}`)}`;
  const rule = t.ink(`  ${'─'.repeat(Math.min(58, Math.max(20, cols - 4)))}`);
  return `${inner}\n${sub}\n${rule}`;
}

export function badge(label: string, tone: 'ok' | 'warn' | 'err' | 'info' = 'info'): string {
  const pad = ` ${label} `;
  switch (tone) {
    case 'ok':
      return `${t.bold(t.ok(`▎${pad}`))}`;
    case 'warn':
      return `${t.bold(t.warn(`▎${pad}`))}`;
    case 'err':
      return `${t.bold(t.err(`▎${pad}`))}`;
    default:
      return `${t.bold(t.accent(`▎${pad}`))}`;
  }
}

/** Internal status line, e.g. "[veil] dialing …onion". */
export function status(msg: string): string {
  return `${t.ink('  ◦')} ${t.fog(msg)}`;
}

export function heading(s: string): string {
  return `${t.bold(t.accent('▎'))} ${t.bold(t.bone(s))}`;
}

export function prompt(label: string): string {
  return `${t.accent('❯')} ${t.bold(t.bone(label))} `;
}

// Deterministic per-name color picker so two participants get visually
// distinct labels.
const NAME_PALETTE = [
  C.veil1,
  C.veil2,
  C.veil3,
  C.veil4,
  C.veil5,
  C.veil6,
  C.mint,
  C.amber,
  C.rose,
];
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
export function colorForName(name: string): (s: string) => string {
  if (COLOR_LEVEL === 0) return (s) => s;
  const open = NAME_PALETTE[djb2(name) % NAME_PALETTE.length]!;
  return (s) => `${open}${s}${RESET}`;
}
