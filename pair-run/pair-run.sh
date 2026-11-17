#!/bin/sh
# PAL-2443: one 2-worker run of only SearchUITests and FilterUITests on Cortex, silent.
# Runs from the lease copy; the repository is not changed.
set -u
# The journeys play the lane's fixture audio, and Cortex's output has no software volume, so
# the copy's fixture becomes 30 s of silence in the same format (AAC, mono, 44.1 kHz).
fixture=scripts/fixtures/ready-set.m4a
python3 - <<'EOF' || exit 1
import wave
with wave.open("/tmp/pal2443-silence.wav", "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100)
    w.writeframes(b"\0\0" * 44100 * 30)
EOF
afconvert -f m4af -d aac /tmp/pal2443-silence.wav "$fixture" || exit 1
echo "fixture: $(afinfo "$fixture" | grep -E 'estimated duration' | tr -s ' ')"
# The lane uses 2 workers only for a run without --only. This run keeps 2 workers for 2 classes.
sed -i "" "s/journeysOnly \&\& !macos \&\& !tvos \&\& !unitOnly \&\& !onlyTest;/journeysOnly \&\& !macos \&\& !tvos \&\& !unitOnly;/" scripts/native-lanes.mjs
echo "parallel with --only: $(grep -c 'journeysOnly && !macos && !tvos && !unitOnly;' scripts/native-lanes.mjs)"
bun install --frozen-lockfile >/dev/null && bun run --cwd packages/contracts build >/dev/null || exit 1
echo "=== pair start $(date -u +%FT%TZ)"
node scripts/native-lanes.mjs --journeys --udid "$LEASE_SIMULATOR_UDID" --out "$LEASE_OUT/shots" \
  --only OrbisUITests/SearchUITests --only OrbisUITests/FilterUITests > "$LEASE_OUT/pair.log" 2>&1
s=$?
echo "=== pair end $(date -u +%FT%TZ)"
echo "memory: $(memory_pressure | tail -1)"
grep -E "^Test suite '.*' started on" "$LEASE_OUT/pair.log" | sed -E "s/ - OrbisUITests-Runner.*//"
grep -E "^Test case '.*' (passed|failed|skipped) on" "$LEASE_OUT/pair.log" | sed -E "s/ - OrbisUITests-Runner.*//"
p=$(grep -cE "^Test case '.*' passed on" "$LEASE_OUT/pair.log")
f=$(grep -cE "^Test case '.*' failed on" "$LEASE_OUT/pair.log")
k=$(grep -cE "^Test case '.*' skipped on" "$LEASE_OUT/pair.log")
echo "=== pair exit $s: $p passed, $f failed, $k skipped"
exit $s
