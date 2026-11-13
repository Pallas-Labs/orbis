"""Tempo curve and sections from beat times.

The BPM curve fits a line through the beats of each 30 s window. beat_this reports beats on a
20 ms grid, so a median beat interval rounds 133 BPM to 130.4; the slope of beat time against beat
number recovers 133.0. Method from the 2026-11-11 audio research (Forge
projects/orbis/audio-intelligence-research-2026-11-11.md, section 3.2).
"""

import numpy as np

WINDOW = 30
# A window needs this many beats and this share of steady intervals; otherwise it has no
# steady beat (ambient, a break, a talk-over) and the curve leaves a gap.
MIN_BEATS = 9
MIN_STEADY = 0.75
SMOOTHING = 5
SPLIT_BPM = 2.0
MIN_SECTION_SECONDS = 120


def bpm_curve(beats):
    """BPM per 30 s window as (window start seconds, bpm), skipping windows with no steady beat."""
    beats = np.asarray(beats, dtype=np.float64)
    out = []
    end = float(beats[-1]) if len(beats) else 0.0
    for t in range(0, int(end), WINDOW):
        w = beats[(beats >= t) & (beats < t + WINDOW)]
        if len(w) < MIN_BEATS:
            continue
        ibi = np.diff(w)
        steady = np.abs(ibi - np.median(ibi)) < 0.1 * np.median(ibi)
        if steady.mean() < MIN_STEADY:
            continue
        seed = float(ibi[steady].mean())
        n = np.round((w - w[0]) / seed)
        n, keep = np.unique(n, return_index=True)
        w = w[keep]
        x = n - n.mean()
        period = float((x * (w - w.mean())).sum() / (x * x).sum())
        out.append((t, 60.0 / period))
    return out


def smooth(curve):
    """A centred median over 5 windows of the curve, by position in the curve, so gaps are skipped."""
    values = [bpm for _, bpm in curve]
    half = SMOOTHING // 2
    return [
        (t, float(np.median(values[max(0, i - half) : i + half + 1])))
        for i, (t, _) in enumerate(curve)
    ]


def _runs(smoothed):
    """Split the smoothed curve where the tempo moves more than 2 BPM from the run's level and holds.

    "Holds" means the next window is also more than 2 BPM away, so one stray window does not split.
    """
    runs = [[smoothed[0]]]
    for i in range(1, len(smoothed)):
        level = float(np.median([bpm for _, bpm in runs[-1]]))
        moved = abs(smoothed[i][1] - level) > SPLIT_BPM
        following = smoothed[i + 1][1] if i + 1 < len(smoothed) else smoothed[i][1]
        holds = abs(following - level) > SPLIT_BPM
        if moved and holds:
            runs.append([smoothed[i]])
        else:
            runs[-1].append(smoothed[i])
    return runs


def sections(curve, duration):
    """Sections of steady tempo, each a dict of start, end and bpm, covering 0 to duration."""
    if not curve:
        return []
    runs = _runs(smooth(curve))
    # A change happens inside the first window of the new run, so the boundary is that window's
    # middle. The first section starts at 0 and the last ends at the end of the audio.
    spans = []
    for i, run in enumerate(runs):
        start = 0.0 if i == 0 else float(run[0][0]) + WINDOW / 2
        end = float(runs[i + 1][0][0]) + WINDOW / 2 if i + 1 < len(runs) else float(duration)
        spans.append(
            {
                "start": start,
                "end": end,
                "covers": run[-1][0] + WINDOW - run[0][0],
                "values": [bpm for _, bpm in run],
            }
        )
    # Merge each run that covers less than 2 minutes of windows into the neighbour nearest its
    # tempo, shortest first. The windows, not the boundaries, measure a run, so a last run is not
    # cut short by where its boundary falls.
    while len(spans) > 1:
        short = [i for i, s in enumerate(spans) if s["covers"] < MIN_SECTION_SECONDS]
        if not short:
            break
        i = min(short, key=lambda j: spans[j]["covers"])
        level = float(np.median(spans[i]["values"]))
        neighbours = [j for j in (i - 1, i + 1) if 0 <= j < len(spans)]
        j = min(neighbours, key=lambda k: abs(float(np.median(spans[k]["values"])) - level))
        a, b = sorted((i, j))
        spans[a] = {
            "start": spans[a]["start"],
            "end": spans[b]["end"],
            "covers": spans[a]["covers"] + spans[b]["covers"],
            "values": spans[a]["values"] + spans[b]["values"],
        }
        del spans[b]
    found = [
        {"start": s["start"], "end": s["end"], "bpm": round(float(np.median(s["values"])), 1)}
        for s in spans
    ]
    median = float(np.median([bpm for _, bpm in curve]))
    return _name(found, median)


def _name(found, median):
    """Name sections by their tempo against the Set's median tempo and the fastest section.

    "Faster" and "slower" than the median mean by more than 2 BPM, the same margin that splits
    sections, so a section 1 BPM off the median is not a Peak or a Close.
    """
    names = [None] * len(found)
    at_median = [i for i, s in enumerate(found) if abs(s["bpm"] - median) <= SPLIT_BPM]
    if at_median:
        names[max(at_median, key=lambda i: found[i]["end"] - found[i]["start"])] = "Locked in"
    peak = max(range(len(found)), key=lambda i: found[i]["bpm"])
    if names[peak] is None and found[peak]["bpm"] > median + SPLIT_BPM:
        names[peak] = "Peak"
        if peak > 0 and names[peak - 1] is None and found[peak - 1]["bpm"] < found[peak]["bpm"]:
            names[peak - 1] = "Lift"
        after = peak + 1
        if after < len(found) and names[after] is None and found[after]["bpm"] < found[peak]["bpm"]:
            names[after] = "Come down"
    last = len(found) - 1
    if names[last] is None and found[last]["bpm"] < median - SPLIT_BPM:
        names[last] = "Close"
    return [
        {
            "name": names[i] or f"Section {i + 1}",
            "startSeconds": round(s["start"], 1),
            "endSeconds": round(s["end"], 1),
            "bpm": s["bpm"],
        }
        for i, s in enumerate(found)
    ]
