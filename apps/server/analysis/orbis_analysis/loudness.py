"""EBU R128 loudness with ffmpeg's ebur128 filter."""

import subprocess

SAMPLE = 10
WINDOW = 30
# Short-term loudness below the R128 absolute gate is silence, not a quiet passage.
FLOOR_LUFS = -70.0


def measure(path, ffmpeg="ffmpeg"):
    """Integrated loudness and short-term loudness every 10 s, as (seconds, LUFS) pairs.

    The filter logs momentary, short-term and integrated loudness every 100 ms; the reading at each
    multiple of 10 s is kept, the same sampling the 2026-11-11 library run stored.
    """
    run = subprocess.run(
        [ffmpeg, "-v", "verbose", "-nostats", "-i", path, "-af", "ebur128=framelog=verbose", "-f", "null", "-"],
        capture_output=True,
        text=True,
        check=True,
    )
    samples = []
    integrated = None
    for line in run.stderr.splitlines():
        if "Parsed_ebur128" in line and " S:" in line and " t:" in line:
            try:
                t = float(line.split(" t:")[1].split()[0])
                s = float(line.split(" S:")[1].split()[0])
            except (IndexError, ValueError):
                continue
            if abs(t - round(t / SAMPLE) * SAMPLE) < 0.05:
                samples.append((round(t), s))
        elif line.strip().startswith("I:") and "LUFS" in line:
            integrated = float(line.split()[1])
    return integrated, samples


def curve(samples):
    """Short-term loudness per 30 s window as (window start seconds, LUFS): the mean of its samples.

    A sample at t measures the 3 s before t, so window [k, k + 30) takes the samples in (k, k + 30].
    Silent samples are left out; a window with none is left out.
    """
    windows = {}
    for t, lufs in samples:
        if lufs < FLOOR_LUFS:
            continue
        windows.setdefault((t - 1) // WINDOW * WINDOW, []).append(lufs)
    return [(start, round(sum(v) / len(v), 1)) for start, v in sorted(windows.items())]
