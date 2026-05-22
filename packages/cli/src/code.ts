import {
  type Identity,
  type OneTimePreKey,
  type SignedPreKey,
  crypto as c,
  signIdentityDhBinding,
} from 'veilchat-protocol';

/**
 * The "invite" code: a single string the inviter shares OOB. Encodes the
 * destination (onion or LAN host:port) plus a fresh X3DH pre-key bundle.
 *
 * Format: `veil1:<base64url(JSON)>` — version-tagged so we can evolve later.
 */

export interface StartCodePayload {
  v: 1;
  /** Destination kind: 'tor' for .onion; 'lan' for plain TCP. */
  k: 'tor' | 'lan';
  /** Hostname. .onion (without the .onion suffix) for `tor`; IP for `lan`. */
  h: string;
  /** Port. */
  p: number;
  /** Identity signing pub (base64). */
  s: string;
  /** Identity DH pub (base64). */
  d: string;
  /** Identity-DH binding signature (base64). */
  bs: string;
  /** Signed pre-key id, pub, signature. */
  spkId: number;
  spkPub: string;
  spkSig: string;
  /** Single one-time pre-key id, pub. */
  opkId: number;
  opkPub: string;
}

export function buildStartCode(
  kind: 'tor' | 'lan',
  host: string,
  port: number,
  identity: Identity,
  spk: SignedPreKey,
  opk: OneTimePreKey,
): string {
  const payload: StartCodePayload = {
    v: 1,
    k: kind,
    h: kind === 'tor' ? host.replace(/\.onion$/, '') : host,
    p: port,
    s: c.toBase64(identity.signing.publicKey),
    d: c.toBase64(identity.dh.publicKey),
    bs: c.toBase64(signIdentityDhBinding(identity)),
    spkId: spk.id,
    spkPub: c.toBase64(spk.keypair.publicKey),
    spkSig: c.toBase64(spk.signature),
    opkId: opk.id,
    opkPub: c.toBase64(opk.keypair.publicKey),
  };
  const json = JSON.stringify(payload);
  return `veil1:${c.toBase64(new TextEncoder().encode(json))}`;
}

export function parseStartCode(code: string): StartCodePayload {
  // Strip ANSI escape codes and whitespace
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional
  let trimmed = code.replace(/\x1b\[[0-9;]*m/g, '').trim();

  if (trimmed.startsWith('veil1:')) {
    trimmed = trimmed.slice('veil1:'.length);
  } else if (trimmed.startsWith('nox1:')) {
    trimmed = trimmed.slice('nox1:'.length);
  } else if (trimmed.startsWith('anon1:')) {
    trimmed = trimmed.slice('anon1:'.length);
  }

  try {
    const json = new TextDecoder().decode(c.fromBase64(trimmed));
    const p = JSON.parse(json) as StartCodePayload;
    if (p.v !== 1) throw new Error('unsupported code version');
    if (p.k !== 'tor' && p.k !== 'lan') throw new Error('unknown destination kind');
    return p;
  } catch (e) {
    throw new Error('invalid or corrupted chat code');
  }
}
