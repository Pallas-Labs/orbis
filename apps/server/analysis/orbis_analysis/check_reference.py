"""Check orbis-analyze against the four reference Sets of the 2026-11-11 audio research.

Usage: python -m orbis_analysis.check_reference <audio dir> <out dir>

Runs orbis-analyze at nice 19 on each reference Set whose `<out dir>/<id>.analysis.json` is missing,
then checks the median BPM of three Sets against the values three independent methods agreed on,
and the Rinse FM Set's sections against the About This Set prototype. Exits 1 on any miss.
"""

import json
import os
import subprocess
import sys

BPM_TOLERANCE = 1.5
SECTION_TOLERANCE_SECONDS = 60
MEDIAN_BPM = {
    "d882bdce-9290-4901-8658-033c58a41dab": ("Barry Can't Swim, Brooklyn", 133.0),
    "862df75b-2a5c-42a3-8f00-452cddde71ca": ("Elly, Nujabes vinyl", 95.8),
    "85ad1fe4-329e-42f7-b885-0a6d02fea7ce": ("CLANKerless", 160.7),
}
RINSE_FM = "eb72e847-75ff-4d8e-be4d-e8b731db4112"
SECTIONS = [
    ("Locked in", 0),
    ("Lift", 1 * 3600 + 41 * 60 + 30),
    ("Peak", 1 * 3600 + 44 * 60 + 30),
    ("Come down", 1 * 3600 + 51 * 60 + 30),
    ("Close", 1 * 3600 + 57 * 60 + 45),
]


def clock(seconds):
    s = round(seconds)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}"


def analysis(audio_dir, out_dir, set_id):
    out = os.path.join(out_dir, f"{set_id}.analysis.json")
    if not os.path.exists(out):
        audio = next(
            os.path.join(audio_dir, f"{set_id}.{ext}")
            for ext in ("ogg", "mp3", "m4a")
            if os.path.exists(os.path.join(audio_dir, f"{set_id}.{ext}"))
        )
        analyze = os.path.join(os.path.dirname(sys.executable), "orbis-analyze")
        subprocess.run(["nice", "-n", "19", analyze, audio, out], check=True)
    with open(out) as f:
        return json.load(f)


def main():
    if len(sys.argv) != 3:
        sys.exit("Usage: python -m orbis_analysis.check_reference <audio dir> <out dir>")
    audio_dir, out_dir = sys.argv[1:3]
    misses = 0
    for set_id, (title, expected) in MEDIAN_BPM.items():
        got = analysis(audio_dir, out_dir, set_id)["medianBpm"]
        ok = got is not None and abs(got - expected) <= BPM_TOLERANCE
        misses += not ok
        print(f"{'ok  ' if ok else 'MISS'} {title}: median {got} BPM, expected {expected} ± {BPM_TOLERANCE}")
    found = analysis(audio_dir, out_dir, RINSE_FM)["sections"]
    if len(found) != len(SECTIONS):
        misses += 1
        print(f"MISS Rinse FM: {len(found)} sections, expected {len(SECTIONS)}")
    for (name, start), section in zip(SECTIONS, found):
        ok = section["name"] == name and abs(section["startSeconds"] - start) <= SECTION_TOLERANCE_SECONDS
        misses += not ok
        print(
            f"{'ok  ' if ok else 'MISS'} Rinse FM: {section['name']} at {clock(section['startSeconds'])} "
            f"({section['bpm']} BPM), expected {name} at {clock(start)} ± 1 min"
        )
    sys.exit(1 if misses else 0)


if __name__ == "__main__":
    main()
