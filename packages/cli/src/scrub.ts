/**
 * Scrub potentially-sensitive substrings from text before it reaches the
 * user's terminal: onion addresses, long base64 invite codes, and
 * suspiciously hex-y key fragments.
 *
 * The goal is "if the user pastes a stack trace into a public bug
 * tracker, no host or key material leaks."
 */
export function scrub(s: string): string {
  if (!s) return s;
  return (
    s
      // v3 .onion (56-char base32 + .onion)
      .replace(/[a-z2-7]{56}\.onion/gi, '[onion]')
      // veil1: invite payloads
      .replace(/veil1:[A-Za-z0-9+/=_-]{20,}/g, 'veil1:[redacted]')
      // long hex (>=32 hex chars: keys, fingerprints)
      .replace(/\b[a-f0-9]{32,}\b/gi, '[hex]')
      // long base64 blobs
      .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[b64]')
  );
}
