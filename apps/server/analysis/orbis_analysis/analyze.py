"""orbis-analyze: tempo and loudness of one Set's audio.

Usage: orbis-analyze <audio> <out.json>
Env: ORBIS_ANALYZE_CHECKPOINT (required) is the beat_this `final0` checkpoint file; its SHA-256
must match CHECKPOINT_SHA256. ORBIS_FFMPEG names ffmpeg (default `ffmpeg` on PATH).
ORBIS_ANALYZE_THREADS caps torch's CPU threads (default 4).
"""

import hashlib
import os
import subprocess
import sys

import numpy as np

from . import loudness, result

# beat_this `final0` (CPJKU, MIT), as published at
# https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt.
CHECKPOINT_SHA256 = "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331"
RATE = 22050
# 10-minute chunks keep RAM near 1 GB on a 3-hour Set (the whole file took 9.4 GB). Each chunk
# starts with the last 10 s of the one before, and beats in that lead-in belong to the earlier chunk.
CHUNK_SECONDS = 600
LEAD_SECONDS = 10


def checkpoint():
    path = os.environ.get("ORBIS_ANALYZE_CHECKPOINT", "")
    if path == "":
        sys.exit("ORBIS_ANALYZE_CHECKPOINT is required.")
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    if digest.hexdigest() != CHECKPOINT_SHA256:
        sys.exit(f"{path} is not the pinned beat_this final0 checkpoint (SHA-256 {digest.hexdigest()}).")
    return path


def chunks(path, ffmpeg):
    """Decode to mono float32 at 22.05 kHz and yield 10-minute chunks."""
    proc = subprocess.Popen(
        [ffmpeg, "-v", "error", "-i", path, "-ac", "1", "-ar", str(RATE), "-f", "f32le", "-"],
        stdout=subprocess.PIPE,
    )
    size = RATE * CHUNK_SECONDS * 4
    while True:
        buf = proc.stdout.read(size)
        if not buf:
            break
        yield np.frombuffer(buf, dtype=np.float32).copy()
    if proc.wait() != 0:
        sys.exit(f"ffmpeg could not decode {path}.")


def beats(path, ffmpeg, checkpoint_path):
    """Beat times in seconds and the decoded length."""
    import torch
    from beat_this.inference import Audio2Beats

    torch.set_num_threads(int(os.environ.get("ORBIS_ANALYZE_THREADS", "4")))
    model = Audio2Beats(checkpoint_path=checkpoint_path, device="cpu", dbn=False)
    found = []
    tail = np.zeros(0, dtype=np.float32)
    samples = 0
    for i, chunk in enumerate(chunks(path, ffmpeg)):
        x = np.concatenate([tail, chunk])
        offset = i * CHUNK_SECONDS - len(tail) / RATE
        b, _ = model(x, RATE)
        found += [offset + t for t in b if offset + t >= i * CHUNK_SECONDS]
        tail = chunk[-LEAD_SECONDS * RATE :]
        samples += len(chunk)
    return found, samples / RATE


def main():
    if len(sys.argv) != 3:
        sys.exit("Usage: orbis-analyze <audio> <out.json>")
    audio, out = sys.argv[1:3]
    ffmpeg = os.environ.get("ORBIS_FFMPEG", "ffmpeg")
    found, duration = beats(audio, ffmpeg, checkpoint())
    integrated, samples = loudness.measure(audio, ffmpeg)
    result.write(result.build(found, integrated, samples, duration), out)


if __name__ == "__main__":
    main()
