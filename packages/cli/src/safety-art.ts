/**
 * Render a deterministic visual fingerprint from the safety-number bytes.
 *
 * Each byte → (shape, color) pair. We display a 4×4 grid (16 bytes = 128
 * bits of fingerprint, derived from the same BLAKE2b digest the textual
 * safety number is). Two peers that share a session will see the *same*
 * grid; mismatched grids are an unmistakable visual MITM signal.
 *
 * Only BMP, monospace-friendly glyphs are used so the grid renders
 * reliably across xterm, gnome-terminal, alacritty, kitty, iTerm2, and
 * Windows Terminal.
 */

import { t } from './theme.js';

const SHAPES: ReadonlyArray<string> = [
  '●',
  '◯',
  '◆',
  '◇',
  '▲',
  '△',
  '▼',
  '▽',
  '■',
  '□',
  '◐',
  '◑',
  '★',
  '☆',
  '◢',
  '◣',
];

// 16 perceptually distinct truecolor RGBs.
const COLORS: ReadonlyArray<[number, number, number]> = [
  [240, 80, 100], // crimson
  [255, 140, 70], // orange
  [255, 210, 90], // amber
  [180, 230, 100], // lime
  [100, 220, 130], // green
  [80, 220, 200], // teal
  [100, 200, 255], // sky
  [110, 150, 255], // azure
  [150, 110, 255], // violet
  [200, 110, 240], // magenta
  [255, 120, 200], // pink
  [220, 200, 180], // sand
  [180, 180, 200], // pearl
  [120, 180, 160], // sage
  [200, 160, 110], // bronze
  [170, 130, 220], // lavender
];

function rgbAnsi(r: number, g: number, b: number): string {
  if (process.env.NO_COLOR) return '';
  if ((process.env.COLORTERM ?? '').toLowerCase().includes('truecolor') || !process.stdout.isTTY) {
    return `\x1b[38;2;${r};${g};${b}m`;
  }
  // 6×6×6 cube fallback
  const q = (v: number) => Math.round((v / 255) * 5);
  return `\x1b[38;5;${16 + 36 * q(r) + 6 * q(g) + q(b)}m`;
}

const RESET = '\x1b[0m';

export interface SafetyArtOpts {
  /** Number of grid columns (default 4). */
  cols?: number;
  /** Number of grid rows (default 4). */
  rows?: number;
}

/**
 * Render a 16-byte fingerprint as a colored-shape grid.
 * `digestBytes` should be at least cols*rows long.
 */
export function renderSafetyArt(digestBytes: Uint8Array, opts: SafetyArtOpts = {}): string {
  const cols = opts.cols ?? 4;
  const rows = opts.rows ?? 4;
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const byte = digestBytes[i] ?? 0;
      const shape = SHAPES[byte & 0x0f]!;
      const [rr, gg, bb] = COLORS[(byte >> 4) & 0x0f]!;
      cells.push(`${rgbAnsi(rr, gg, bb)}${shape}${RESET}`);
    }
    lines.push(cells.join(' '));
  }
  return lines.map((l) => `  ${l}`).join('\n');
}

/**
 * Convert the spaced-hex safety number (e.g. "a1b2c d4e5f …") back to
 * raw bytes so we can derive the visual fingerprint from the same digest.
 */
export function safetyNumberToBytes(safety: string): Uint8Array {
  const hex = safety.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Wrap a label around the grid. */
export function safetyBlock(safety: string): string {
  const bytes = safetyNumberToBytes(safety);
  const grid = renderSafetyArt(bytes);
  return `${grid}\n  ${t.ink('shape grid · compare visually')}`;
}
