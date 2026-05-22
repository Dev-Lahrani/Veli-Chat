import { t } from './theme.js';

/**
 * Tiny, safe markdown renderer for chat messages.
 *
 * IMPORTANT: input MUST already be sanitized (no ANSI, no control chars).
 * We only re-introduce ANSI styling for the markdown spans we recognize.
 *
 * Supported (intentionally minimal):
 *   - **bold**
 *   - *italic*  /  _italic_
 *   - `inline code`
 *   - ```fenced code blocks```  (rendered as a left-bordered block)
 *   - > quoted line
 *   - links are NOT auto-rendered as clickable; the URL text is just shown.
 */
export function renderMarkdown(s: string): string {
  let out = s;
  // Fenced code blocks (multi-line). Process first so internal punctuation
  // doesn't get mangled by inline rules.
  out = out.replace(/```([\s\S]*?)```/g, (_m, inner) => {
    const lines = String(inner).replace(/^\n/, '').replace(/\n$/, '').split('\n');
    return `\n${lines.map((l) => `${t.ink('│')} ${t.cyan(l)}`).join('\n')}\n`;
  });

  // Process line by line so '>' quotes work.
  out = out
    .split('\n')
    .map((line) => {
      if (/^\s*>\s?/.test(line)) {
        const body = line.replace(/^\s*>\s?/, '');
        return `${t.ink('▎')} ${t.fog(body)}`;
      }
      return line;
    })
    .join('\n');

  // Inline code first so bold/italic markers inside don't apply.
  out = out.replace(/`([^`\n]+)`/g, (_m, code) => `${t.cyan(String(code))}`);

  // Bold (greedy non-newline).
  out = out.replace(/\*\*([^*\n][^*\n]*?)\*\*/g, (_m, body) => t.bold(String(body)));

  // Italic — *foo* or _foo_, but don't catch ** runs already consumed.
  out = out.replace(
    /(^|[^*])\*([^*\n]+?)\*(?!\*)/g,
    (_m, lead, body) => `${lead}${t.dim(t.bold(String(body)))}`,
  );
  out = out.replace(
    /(^|[^_])_([^_\n]+?)_/g,
    (_m, lead, body) => `${lead}${t.dim(t.bold(String(body)))}`,
  );

  return out;
}
