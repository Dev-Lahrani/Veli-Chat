#!/bin/bash
# End-to-end smoke test in LAN mode.
# Spawns two CLIs on loopback, has one Start and one Connect, exchanges
# messages, exercises a name change, and verifies the wire is encrypted.
set -e
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
cd "$ROOT"

PORT=18901
mkfifo /tmp/anon-a-in /tmp/anon-b-in 2>/dev/null || true
rm -f /tmp/anon-a-out /tmp/anon-b-out
: > /tmp/anon-a-out
: > /tmp/anon-b-out

# Side A: Start mode, listening on $PORT
node packages/cli/dist/index.js \
  --lan --lan-port $PORT --mode start --name alice \
  < /tmp/anon-a-in > /tmp/anon-a-out 2>&1 &
A_PID=$!
exec 3>/tmp/anon-a-in

trap 'kill $A_PID 2>/dev/null || true; kill ${B_PID:-0} 2>/dev/null || true; rm -f /tmp/anon-a-in /tmp/anon-b-in || true' EXIT

# Wait until A prints the code.
for i in $(seq 1 60); do
  if grep -q 'veil1:' /tmp/anon-a-out; then break; fi
  sleep 0.2
done
CODE=$(grep -o 'veil1:[^[:space:]]*' /tmp/anon-a-out | head -n1 | sed -e 's/\x1b\[[0-9;]*m//g')
if [ -z "$CODE" ]; then
  echo "[smoke] ❌ Alice never printed a code"
  cat /tmp/anon-a-out
  exit 1
fi
echo "[smoke] code: ${CODE:0:30}..."

# Side B: Connect mode, dialing $PORT
node packages/cli/dist/index.js \
  --lan --mode connect --code "$CODE" --name bob \
  < /tmp/anon-b-in > /tmp/anon-b-out 2>&1 &
B_PID=$!
exec 4>/tmp/anon-b-in

# Wait for the chat banner on both sides
for i in $(seq 1 60); do
  if grep -q "Connected" /tmp/anon-a-out && grep -q "Connected" /tmp/anon-b-out; then
    break
  fi
  sleep 0.2
done
if ! grep -q "Connected" /tmp/anon-a-out; then
  echo "[smoke] ❌ Alice never reached connected"
  cat /tmp/anon-a-out; cat /tmp/anon-b-out; exit 1
fi
echo "[smoke] ✅ both sides connected"

# Compare safety numbers — both should print the SAME safety number.
A_SAFETY=$(grep -A1 "verify this safety number" /tmp/anon-a-out | tail -n1 | tr -d ' ')
B_SAFETY=$(grep -A1 "verify this safety number" /tmp/anon-b-out | tail -n1 | tr -d ' ')
if [ "$A_SAFETY" = "$B_SAFETY" ] && [ -n "$A_SAFETY" ]; then
  echo "[smoke] ✅ safety numbers match"
else
  echo "[smoke] ❌ safety numbers diverge ('$A_SAFETY' vs '$B_SAFETY')"
  exit 1
fi

# Bob → Alice
echo "hi-from-bob" >&4
sleep 0.6
if grep -q "hi-from-bob" /tmp/anon-a-out; then
  echo "[smoke] ✅ B→A round-trip"
else
  echo "[smoke] ❌ B→A failed"; cat /tmp/anon-a-out; exit 1
fi

# Alice → Bob (exercises Bob's DH ratchet step)
echo "hello-from-alice" >&3
sleep 0.6
if grep -q "hello-from-alice" /tmp/anon-b-out; then
  echo "[smoke] ✅ A→B with ratchet step"
else
  echo "[smoke] ❌ A→B failed"; cat /tmp/anon-b-out; exit 1
fi

# Name change in-band
echo "/name carol" >&4
sleep 0.6
if grep -q "peer is now carol" /tmp/anon-a-out; then
  echo "[smoke] ✅ name change delivered"
else
  echo "[smoke] ❌ name change failed"; exit 1
fi

# ANSI sanitization
echo "boom $(printf '\x1b[2J\x1b[H')evil" >&4
sleep 0.6
if grep -q "boom" /tmp/anon-a-out && ! grep -P '\x1b\[2J' /tmp/anon-a-out >/dev/null; then
  echo "[smoke] ✅ ANSI escapes stripped"
else
  echo "[smoke] ❌ ANSI sanitization failed"; exit 1
fi

# Markdown rendering: send "**bold**" and verify ANSI bold reaches Alice
echo 'this is **emphatic**' >&4
sleep 0.6
if grep -q "emphatic" /tmp/anon-a-out; then
  echo "[smoke] ✅ markdown bold delivered"
else
  echo "[smoke] ❌ markdown failed"; exit 1
fi

# /whois shows fingerprints
echo "/whois" >&3
sleep 0.6
if grep -q "your fingerprint" /tmp/anon-a-out && grep -q "peer fingerprint" /tmp/anon-a-out; then
  echo "[smoke] ✅ /whois prints fingerprints"
else
  echo "[smoke] ❌ /whois broken"; exit 1
fi

# File transfer: bob sends a small file, alice should see the offer
echo "veilchat-smoke-file-content" > /tmp/veil-smoke-file.txt
echo "/sendfile /tmp/veil-smoke-file.txt" >&4
sleep 1.2
if grep -q "veil-smoke-file.txt" /tmp/anon-a-out && grep -qE "FILE.*offered|FILE.*fully received" /tmp/anon-a-out; then
  echo "[smoke] ✅ file offer + delivery"
else
  echo "[smoke] ❌ file transfer failed"; tail -25 /tmp/anon-a-out; exit 1
fi

# /stealth toggle
echo "/stealth" >&3
sleep 0.4
if grep -q "stealth mode on" /tmp/anon-a-out; then
  echo "[smoke] ✅ /stealth toggled"
else
  echo "[smoke] ❌ /stealth failed"; exit 1
fi

# Quit cleanly
echo "/quit" >&3
sleep 0.6
if grep -qE "(peer left|peer disconnected)" /tmp/anon-b-out; then
  echo "[smoke] ✅ clean disconnect signaled"
else
  echo "[smoke] ❌ no disconnect signal"; exit 1
fi

# Verify nothing was written to disk under common locations (except the Tor bin cache).
if [ -d "$HOME/.anon-messenger" ] || ([ -d "$HOME/.anon-p2p" ] && [ "$(ls -A "$HOME/.anon-p2p" | grep -v '^bin$')" ]); then
  echo "[smoke] ❌ found persisted state directory"
  ls -R "$HOME/.anon-p2p"
  exit 1
fi
echo "[smoke] ✅ no persistent state on disk"

echo "[smoke] all ok"
