"""Write `<set id>.analysis.json` for every Retained Audio file that has none.

Usage: python -m orbis_analysis.backfill <audio dir> [<library-run results dir>]

A Set with stored 2026-11-11 library-run results (`<id>.beatthis.beats.npy` and
`<id>.loudness.json`) is imported: its BPM curve comes from the stored beats with the same line fit.
Any other Set runs `orbis-analyze` at nice 19, one at a time. The node reports the files to the
Group on its next connect. Prints one JSON line per Set and a summary line with the counts and the
wall time.
"""

import json
import os
import subprocess
import sys
import time

import numpy as np

from . import result

FORMATS = ("ogg", "mp3", "m4a")
TIMEOUT_SECONDS = 3 * 60 * 60


def retained(audio_dir):
    """Set id to audio path, one file per Set."""
    found = {}
    for name in sorted(os.listdir(audio_dir)):
        stem, _, ext = name.rpartition(".")
        if ext in FORMATS and stem not in found:
            found[stem] = os.path.join(audio_dir, name)
    return found


def duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        capture_output=True,
        text=True,
        check=True,
    )
    return float(out.stdout.strip())


def imported(stored, set_id, path):
    beats = np.load(os.path.join(stored, f"{set_id}.beatthis.beats.npy"))
    with open(os.path.join(stored, f"{set_id}.loudness.json")) as f:
        loud = json.load(f)
    samples = [(p["t"], p["lufs_s"]) for p in loud["short_term_10s"]]
    return result.build(beats, loud["integrated_lufs"], samples, duration(path))


def main():
    if len(sys.argv) not in (2, 3):
        sys.exit("Usage: python -m orbis_analysis.backfill <audio dir> [<library-run results dir>]")
    audio_dir = sys.argv[1]
    stored = sys.argv[2] if len(sys.argv) == 3 else None
    analyze = os.path.join(os.path.dirname(sys.executable), "orbis-analyze")
    counts = {"imported": 0, "analysed": 0, "failed": 0, "skipped": 0}
    started = time.time()
    for set_id, path in retained(audio_dir).items():
        out = os.path.join(audio_dir, f"{set_id}.analysis.json")
        t0 = time.time()
        line = {"set": set_id}
        if os.path.exists(out):
            outcome = "skipped"
        elif stored and all(
            os.path.exists(os.path.join(stored, f"{set_id}.{suffix}"))
            for suffix in ("beatthis.beats.npy", "loudness.json")
        ):
            try:
                result.write(imported(stored, set_id, path), out)
                outcome = "imported"
            except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
                outcome, line["reason"] = "failed", str(error)
        else:
            try:
                subprocess.run(
                    ["nice", "-n", "19", analyze, path, out],
                    check=True,
                    timeout=TIMEOUT_SECONDS,
                    capture_output=True,
                    text=True,
                )
                outcome = "analysed"
            except subprocess.CalledProcessError as error:
                outcome, line["reason"] = "failed", error.stderr.strip()[-500:]
            except subprocess.TimeoutExpired:
                outcome, line["reason"] = "failed", "timed out"
        counts[outcome] += 1
        line.update(outcome=outcome, seconds=round(time.time() - t0, 1))
        print(json.dumps(line), flush=True)
    print(json.dumps({"summary": counts, "sets": sum(counts.values()), "wallSeconds": round(time.time() - started)}))


if __name__ == "__main__":
    main()
