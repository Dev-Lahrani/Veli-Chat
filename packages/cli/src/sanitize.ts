/**
 * Strip ANSI escapes / control characters before printing peer-controlled
 * text. Without this, a malicious peer could send `\x1b[2J\x1b[H...` and
 * paint a fake login prompt over the user's terminal.
 */
export function sanitize(text: string): string {
  // Strip ANSI escapes, control chars (except \n, \t), and BiDi overrides.
  const stripped = text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional
    /[\x00-\x08\x0B-\x1F\x7F-\x9F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g,
    '',
  );
  // Indent any newlines so they are clearly part of a message block and cannot
  // be used to forge top-level UI elements (like fake safety numbers).
  return stripped.replace(/\n/g, '\n  ');
}
