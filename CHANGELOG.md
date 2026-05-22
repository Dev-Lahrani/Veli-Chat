# Changelog

## 0.4.0 — overnight god-tier pass

This release is a single autonomous burn that hardens the wire, polishes
the surface, and adds every chat feature that fits inside the
"serverless · ephemeral · zero-disk" promise. Every change was gated on
the existing E2E LAN smoke test plus a new file-integrity round-trip
test (256 KiB random payload, SHA-256 verified at the receiver).

### Wire-level security

- **Padded transport.** Every TCP frame is now exactly one of six fixed
  bucket sizes (256 B / 1 KiB / 4 KiB / 16 KiB / 64 KiB / 256 KiB).
  An on-path observer sees no information about the real payload size:
  whether you typed `hi` or sent a 200 KiB file, the byte counts on the
  wire come from the same set. The inner header carries the real
  length; the rest is `crypto.randomBytes` padding, indistinguishable
  from ciphertext.
- **Cover traffic** (`--cover`). Optional opaque encrypted noop frames
  fired at jittered 30–90 s intervals to obscure conversation timing.
  Peer silently drops noops.
- **Sanitized error pipeline.** A `scrub()` helper redacts onion
  addresses, `veil1:` invite blobs, long hex, and long base64 from any
  string that reaches the user via stderr. Pasting a stack trace into a
  bug tracker can no longer leak host or key material.

### Identity verification

- **Visual safety fingerprint.** A 4×4 grid of colored geometric
  shapes (16 shapes × 16 hues = 256 cells) derived from the same
  BLAKE2b digest the textual safety number is. Eye-comparable across a
  video call. BMP-only glyphs render correctly on every modern
  terminal — no emoji width gambles.
- **`/whois`** in chat prints the safety number, the visual grid, and
  short BLAKE2b-8 fingerprints of both signing keys.

### Anti-shoulder-surfing

- **`--stealth` / `/stealth`** — masks display names with `peer` and
  `you` so you can pair-program over screen share without leaking
  identifiers.
- **`--alt-screen`** — runs the chat in the terminal's alternate screen
  buffer. On `/quit` the original screen is restored and the entire
  chat scrollback vanishes.
- **`/clear`** — wipes the visible buffer and scrollback (`\x1b[3J`)
  without ending the session.
- **`/panic`** + **Ctrl-C in chat** — clears scrollback, signals `bye`
  to the peer, kills the session, restores the screen. One keystroke
  to nuke.

### In-band features (encrypted, opt-in where they reveal anything)

- **Markdown rendering** — `**bold**`, `*italic*` / `_italic_`,
  `` `inline` ``, ```` ```fenced``` ```` code blocks, and `> quotes`.
  Applied **after** sanitize, so a peer cannot smuggle ANSI.
- **File transfer** — `/sendfile <path>` offers the file; the receiver
  sees the offer, can `/save <id> [path]` (writes 0o600) or
  `/reject <id>`. **Never** auto-writes. 16 MiB cap. Filenames
  sanitized (no path separators, no control chars). Files held in
  memory only until saved or rejected.
- **Typing indicator** — `/typing on|off` (default off). Throttled to
  one ping per 2 s, encrypted in-band.
- **Read receipts** — `/receipts on|off` (default off). Peer learns
  only the count of messages read.
- **`/copy`** — copies the safety number to the clipboard via OSC-52
  (terminal-native, never touches the system clipboard via a shell
  helper). The safety number is public information by definition, so
  this is the only thing `/copy` will exfil.
- **Tab completion** for every slash command.

### Lifecycle / UX

- **`--idle-minutes N`** — auto-quits after N minutes of two-way
  silence with a 60 s grace warning and an Enter-to-cancel.
- **End-of-session summary** — sent / received counts and duration on
  `/quit`. No content is logged anywhere.
- **Tor bootstrap progress** — every 10 % milestone streams through the
  themed status line (`tor bootstrap 30% · loading_relay_descriptors`).
- **God-tier theme** — auto-detected truecolor / 256-color / NO_COLOR.
  Violet-to-cyan gradient logo, `▎ BADGE ` capsules for status / link /
  warn / err, themed prompts and headings.
- **New ASCII logo** — VEILCHAT block letters with per-character
  gradient when the terminal supports it; compact glyph-row fallback on
  narrow terminals.

### File-transfer audit trail

- **`/sha <id>`** computes SHA-256 of an in-memory received file *before*
  you choose to `/save` it. Lets you read the hash to your peer over the
  same OOB channel you used for the safety number, so a tampered chunk
  (or a confused-deputy peer) can't sneak through.

### More polish

- **Per-name colors.** Display names hash through djb2 to a fixed
  palette so peer and you visually differ in the chat view, even before
  verification.
- **Lint clean.** Biome has zero findings against the source tree.
- **11 new CLI unit tests** for the padded transport (round-trip,
  bucket selection, malformed-header rejection, multi-frame chunks)
  and the markdown renderer (bold, code, fences, quotes, idempotence).

### Project hygiene

- Renamed packages: root `veilchat`, CLI `veilchat`
  (bin: `veil` and `veilchat`), protocol `veilchat-protocol`. Both
  publishable. Code prefix moved from `nox1:` to `veil1:`; old prefixes
  still parse for any in-flight invites.
- Removed unused dead code from `index.ts`.
- Fixed CLI `vitest run` failing on an empty test directory.
- Added byte-perfect file round-trip integrity to local smoke runs.
- Tor cache moved to `~/.veilchat`, log prefix to `[veil]`, tmpdir to
  `veil-tor-*`.

### Nothing changed about the threat model

The cryptographic core is untouched. X3DH + Double Ratchet via
`@noble/*`, sealed sender, in-memory only, ephemeral v3 onion service,
RFC1918-only LAN dialing. No new network calls. No telemetry. Nothing
written to disk except (a) the optional Tor binary cache and (b) files
the user explicitly `/save`s.
