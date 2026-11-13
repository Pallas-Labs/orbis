"""The analysis document the node stores as `<set id>.analysis.json` and reports to the Group.

Its fields are the `SetAnalysis` schema in packages/contracts/src/http-api.ts.
"""

import json
import os

import numpy as np

from . import loudness, tempo


def build(beats, integrated_lufs, loudness_samples, duration_seconds):
    curve = tempo.bpm_curve(beats)
    return {
        "durationSeconds": round(float(duration_seconds), 1),
        "medianBpm": round(float(np.median([bpm for _, bpm in curve])), 1) if curve else None,
        "integratedLufs": integrated_lufs,
        "bpmCurve": [{"seconds": t, "bpm": round(bpm, 1)} for t, bpm in curve],
        "loudnessCurve": [{"seconds": t, "lufs": lufs} for t, lufs in loudness.curve(loudness_samples)],
        "sections": tempo.sections(curve, duration_seconds),
    }


def write(document, out):
    """Write atomically, so the node never reads half a file."""
    tmp = f"{out}.tmp"
    with open(tmp, "w") as f:
        json.dump(document, f, separators=(",", ":"))
    os.replace(tmp, out)
