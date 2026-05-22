# Security model

This document describes what an attacker can and cannot do against this
software, given the design choices: no server, no persistence, ephemeral
keys per session, and Tor for transport.

## Adversary capabilities assumed

- **Active network attacker.** Sees, modifies, drops, replays any packets on
  the wire. Has unbounded resources.
- **Tor relay operator.** Operates one or more relays, including possibly
  guard, middle, or exit positions on the circuit.
- **Malicious peer.** The other side of the chat is hostile and tries to
  fingerprint the user, exploit the client, or correlate identities.
- **Disk-image attacker.** Steals the laptop or backup after the session ends.

## What the system protects

| Goal | Mechanism |
|---|---|
| Confidentiality of message content | Double Ratchet AEAD (XChaCha20-Poly1305) keyed by session derived from X3DH |
| Forward secrecy | Symmetric chain rotates per message; DH ratchet on every reply |
| Post-compromise security | DH ratchet — compromise of current keys doesn't decrypt future messages once one DH ratchet step has run |
| MITM detection | Out-of-band safety-number verification (both peers compute the same string from their identity-signing keys) |
| Code authenticity | Identity-DH binding signature inside the code; connector verifies before X3DH |
| Server compromise / log seizure | **No server.** Nothing to compromise, nothing to subpoena. |
| IP exposure | Tor onion services on both ends — neither peer's IP is exposed to the other or to any infrastructure operator. The .onion address is the only "identifier." |
| Storage compromise | **Nothing on disk.** Identity keys, ratchet state, conversation history exist only in process memory and die with the process. |
| Identifier-based correlation | Identity is regenerated for every session. No usernames, phone numbers, accounts, or stable IDs. The .onion address is itself ephemeral (lives only for the session, torn down by Tor when the control channel closes). |
| Terminal injection from peer | ANSI/control-char stripping on every received message |
| Single-peer enforcement | The TCP listener is one-shot — first connection wins, subsequent connections refused |
| Wire-size traffic analysis | Padded transport: every TCP frame is exactly one of six fixed bucket sizes (256 B / 1 KiB / 4 KiB / 16 KiB / 64 KiB / 256 KiB). The bytes on the wire reveal nothing about the real payload size. Padding bytes are `crypto.randomBytes` and indistinguishable from ciphertext. |
| Wire-timing traffic analysis (opt-in) | `--cover` sends jittered encrypted noop frames at 30–90 s intervals to obscure the conversation envelope. Peer drops noops silently. |
| Sensitive material in error messages | `scrub()` redacts onion addresses, `veil1:` invite blobs, long hex, and long base64 from any string that reaches the user via stderr |
| Post-session screen recovery | `--alt-screen` runs the chat in the terminal's alternate buffer; on /quit the original screen is restored and chat scrollback is gone |
| Shoulder-surfing during screen share | `--stealth` / `/stealth` masks display names with `peer` and `you` |
| Identity-stable visual MITM check | A 4×4 grid of colored geometric shapes (16 shapes × 16 hues) derived from the same BLAKE2b digest as the textual safety number — eye-comparable across a video call |
| Filesystem leakage from file-sharing | Files received from peer are held in memory only; never auto-written; `/save <id>` writes with mode 0o600 and a 16 MiB cap, with sanitized filenames |

## What is out of scope

These are real concerns that the architecture does *not* solve:

1. **Endpoint compromise.** If your machine is compromised, end-to-end
   encryption can't help you. Memory is dumpable; keys live there.
2. **Tor traffic-analysis adversaries.** A sufficiently global passive
   observer of Tor (or a sophisticated active adversary) can in principle
   correlate flows. This is the long-standing Tor threat model — outside the
   control of this software.
3. **Tor's own logs.** Local Tor processes may log `[notice]`-level events.
   Configure `Log notice null` in `torrc` for fully silent operation. The
   control protocol does not record session data, but ephemeral onion
   creation may appear in debug logs if enabled.
4. **Out-of-band code distribution.** This is the human side of trust. If
   the channel you use to share the code is observed (or impersonated), the
   attacker can intercept and connect first, becoming your peer. **Verify
   safety numbers** the moment you connect — they catch this.
5. **Physical / coercion attacks.** No software defense.
6. **Memory inspection.** JavaScript runtimes do not let user code reliably
   zero memory. Sensitive bytes linger until GC.
7. **Timing-based traffic analysis.** Message-send timing can still leak
   conversation pacing to a global passive adversary. The `--cover` flag
   sends jittered noop frames at 30–90 s intervals to mask the
   conversation envelope when it's worth the bandwidth, but this is not
   protection against an attacker with full timing observation across the
   Tor network.
8. **Denial of service.** A peer can flood you with frames once connected.
   The framed transport caps single-frame size; per-second rate is not
   enforced. Ctrl-C is your friend.

## Code-handoff threat

The "start" code is a small base64 string that contains:

- The destination `.onion` (Tor mode) or `IP:port` (LAN mode)
- The inviter's ephemeral identity signing pub
- The inviter's ephemeral identity DH pub
- A signature over the DH pub by the signing pub (binding)
- A signed pre-key + signature
- A one-time pre-key

If an attacker captures the code AND can race the legitimate connector to
the onion service first, they "win" the session — they connect, the code
is consumed, and the legitimate user is locked out. Mitigations:

- **Ephemerality limits the window.** The onion exists only as long as the
  inviter waits. Treat codes as one-shot and time-sensitive.
- **Safety number verification is mandatory.** The inviter and the connector
  see a derived safety number. If it doesn't match the connector you
  *intended*, the inviter `/quits` immediately and the attacker is left with
  a useless session.
- **Don't post codes anywhere they can be replayed.** OOB channels with
  short shelf-life are best (Signal, in-person, voice call).

## LAN mode caveats

`--lan` binds to `127.0.0.1` and the code carries the literal IP/port. This
mode:

- Provides **no** location anonymity. The peer learns your IP.
- Is intended for two devices on the same trusted network or for tests.
- Refuses to use a destination outside loopback / RFC1918 ranges (the
  connect path enforces this — see `transport.ts`).
- Should not be used over the public internet; use Tor mode.

## Verification ritual (do this every session)

1. Both peers see the safety number after the chat banner.
2. Read it aloud (or via any pre-existing trusted channel).
3. If they match, the X3DH handshake bound to *this* peer's keys, not an
   attacker's. Continue.
4. If they don't match, `/quit` immediately and use a different OOB channel
   to share the next code.

## Cryptography

- **X25519** for DH (noble's `@noble/curves/ed25519`)
- **Ed25519** for identity signatures
- **XChaCha20-Poly1305** for AEAD
- **HKDF-SHA256** for key derivation
- **HMAC-SHA256** for chain-key derivation
- **BLAKE2b** for fingerprints

All primitives are constant-time (per noble's audit) and side-channel-aware
within the limits of JavaScript.

## Disclosure

This is a learning project. The protocol composition has not been audited.
Found a real issue? Open a GitHub issue with `[security]` in the title.
