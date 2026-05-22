import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/markdown.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences
const ANSI = /\x1b\[[0-9;]*m/g;

describe('renderMarkdown', () => {
  it('passes plain text through unchanged', () => {
    expect(renderMarkdown('hello world')).toBe('hello world');
  });

  it('renders **bold** with ANSI bold codes', () => {
    const out = renderMarkdown('a **bold** word');
    expect(out).toContain('\x1b[1m');
    expect(out.replace(ANSI, '')).toContain('bold');
  });

  it('renders `inline code`', () => {
    const out = renderMarkdown('try `npm install` first');
    // some color escape must appear around the code
    expect(out).toMatch(ANSI);
    expect(out.replace(ANSI, '')).toContain('npm install');
  });

  it('renders fenced code blocks as a left-bordered block', () => {
    const out = renderMarkdown('before\n```\nfoo\nbar\n```\nafter');
    const stripped = out.replace(ANSI, '');
    expect(stripped).toContain('│ foo');
    expect(stripped).toContain('│ bar');
    expect(stripped).toContain('before');
    expect(stripped).toContain('after');
  });

  it('renders > quoted lines with a left bar', () => {
    const out = renderMarkdown('> quoted thought');
    expect(out.replace(ANSI, '')).toContain('▎ quoted thought');
  });

  it('does not introduce ANSI on a string without any markdown', () => {
    const s = 'just a plain message with: colons, parens, & symbols.';
    expect(renderMarkdown(s)).toBe(s);
  });
});
