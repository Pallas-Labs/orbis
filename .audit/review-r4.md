# Playback review, round 4

This is a read-only review of the working tree at about 20:20Z. The base is HEAD `91d3b90` plus uncommitted changes. I read `docs/development.md`, the workflow, rounds 1 to 3, the responses, `playback.tsv`, `playback-report.md`, the whole diff, and the evidence in `~/.cache/orbis-playback-evidence/2026-10-18`. I changed no source and ran no build or test. The final native run was still in progress during this review, and no result from it had reached the evidence root at 13:19 PDT.

The current tree matches `accepted-source-manifest.sha256`. I checked all 17 entries with `sha256sum -c`. `docs/development.md` is not in the manifest. It is a document only.

## Verdict

**Source correctness: no HIGH or MEDIUM objection remains.** The new completion rule is correct for every case that the evidence shows. I accept the round-3 retraction: the real Ogg end probe disproved my prediction. Two LOW items remain (findings 1 and 2). Neither blocks a merge.

**Acceptance is a separate item and is still open.** No run covers the final `AudioPlayer.swift` (13:16:50 PDT). Physical iPhone playback is not verified.

## The completion rule

Code: `AudioPlayer.swift:812-832`.

- **Shorter known length.** `duration` is the item length if it is finite and greater than 0. Otherwise it is `serviceDuration`, which `play` filters to values greater than 0 (`:716-726`, `:347`). So `min` never sees 0 or NaN. If the item length is not known, `min` uses the service length. If neither is known, the end is a Finish, as before. If the current time is not finite, the end is also a Finish, as before.
- **Direction of the error.** `min` can only accept more ends as a Finish. It cannot reject an end that the old rule accepted. The only cost: an early end within 2 s of the shorter length counts as a Finish. For Ogg, an early end at 598–600 s (player time) in a Set that really continues to about 603 s would finish the Set about 3–5 s early. That loss is small, and it is better than a Set that never finishes.
- **The 16 s early end still fails the check.** `16.05 < min(603.86, 600) - 2`, so the Ogg recovery gate keeps its meaning.
- **One Finish per item.** `completionReported` is set on the main queue before `onFinished` runs, and `stop()` resets it. Every `play()`, retry and next-entry activation goes through `stop()`. An early end does not set the flag, so the real end later can still finish. This closes round-3 finding 3: a second notification can no longer start a second `finishedPlaying` task.
- **Probe result.** `ogg-end-before/console.log:232`: `First playing … actual=590.000000` at 13:15:57.672, then `Item ended … actual=602.993500 duration=603.860000` at 13:16:10.790. The old rule accepted this end (`602.99 ≥ 601.86`). The new rule also accepts it (`≥ 598`). The probe protects natural completion. It cannot tell the two rules apart. The 20:16:50Z row states this correctly. The new rule is a precaution, not a fix for a failure that a test showed.

## Findings, most severe first

### 1. Low. A failed completion request cannot be retried from the same item

- **Path.** A natural end sets `completionReported` and calls `finishedPlaying`. If `reportCompletion` fails (offline, or Tailscale drops at the end of the Set), `finishedPlaying` sets `setFailure` and keeps the item (`AppModel.swift:1157-1163`). The item is at its end, and `rateChanged` moved the state to `.loading`. A later Play goes through `playIfReady` or `startPlayback` and calls `play()` on the ended item. If AVPlayer posts the end again, the guard drops it.
- **Before this change.** The state at the end was `.interrupted`. Play called `play()` at the end, and the next end notification retried `finishedPlaying`. The once flag removes this retry. This is an inference. I did not see AVPlayer post a second end in any run.
- **Effect.** The Listen is not finished, and the queue does not advance. The server state stays consistent: the Set is still active and is not falsely finished. The person sees the error and can choose another Set.
- **Smallest fix, if wanted.** Reset `completionReported` when the person asks for sound again, in `resumePlayback()` for `.paused` and `.interrupted`, or on a seek in `move(to:)`. `finishedPlaying` still blocks a duplicate while its request is in flight (`guard pendingActivation == nil`). Otherwise, record this as a known limit.

### 2. Low (known interaction, still present). Controls during the completion request act on the Set that just ended

- `finishedPlaying` sets `pendingActivation(setId: nil)`. `togglePlayback(id)` (`AppModel.swift`, the `pendingActivation?.setId == id` branch) does not match, so it calls `supersedePendingActivation()`. This cancels the move to the next entry and acts on the ended item. A Lock Screen scrub does the same through `onCommand(.seek)`. The window is one request. Round 3 recorded this. Record it as a low known interaction.

### Checked and found correct

- **Same-Set pending activation at a natural end.** `playSet` pauses the old item before it creates a pending activation, so a retained item cannot reach its end while an activation of another Set is pending. A warm activation of the current Set creates no pending activation, so `finishedPlaying` is not blocked. A retry acts on a failed item, which cannot end. The new `guard pendingActivation == nil` blocks only the duplicate during the completion request.
- **Round-3 items 2 and 4.** The fixture is back to 50 ms per 4096-byte chunk (`seed-lane-audio.mjs:125`). The AAC comparison and its generator are out of the default suite, and copies are in the evidence root. This matches the responses.
- **Accepted earlier.** A failed seek stays `.failed` until Play retries it. No objection.

## Attention flags for the decision trail

- **Claim that no evidence supports yet.** `playback-report.md` (13:18:44) says: "The actual Ogg end probe passed before and after this policy change." At 13:19 the evidence root holds only `ogg-end-before`. No log contains `testANaturalOggEndFinishesExactlyOnce` after `accepted-source-manifest.sha256` (13:18:02). Change the text to "pending" until the final run lands and is copied, or cite that run.
- **The late Cue journey with the 3 s duplicate wait has no result.** `final-ui/console.log` closed at 13:15:21. `PlaybackUITests.swift` changed at 13:16:51. The 8 passes at `final-ui/console.log:215-804` used the earlier version of that journey and the earlier completion rule. The 20:16:01Z row says this correctly.
- **`final-native` predates the final source.** The 20:12:51Z row (47 of 48) used `AudioPlayer.swift` hash `1e7158…` from `source-manifest.sha256`. The accepted hash is `2e019d…`. The row is correct. Do not cite it for the final rule.
- **`manifest.md` is out of date.** It still says "Result pending bundle closure" and names only `source-manifest.sha256` and the 13:10 patch. Add the accepted manifest and the final run.
- **Errors near the end of the probe.** `FigFilePlayer err=-12864` occurs at 13:16:10.754, 35 ms before `Item ended`. The same line also occurs at item start (13:15:57.659, .661, .691) and after the test (13:16:13.884, .895). The probe has no `err=-1001` and no failed request. Do not tie the error to the end.
- **Player time and service time differ for Ogg (an observation, not a finding).** The fixture is Opus, `-t 600`, and the database says 600 s. The player started at 590.0 and ended at 602.99, after 13.12 s of wall time. So either the seek to 590 landed about 3 s early in the real audio, or AVPlayer's Ogg timeline runs longer than the service length. No run measured which. If the timeline is scaled, an exact Cue on a long Ogg Set can land some seconds away from its tracklist timestamp. The diff does not cause this and does not claim to fix it. Record it as not covered, next to waveform continuity.
- **Wording is correct.** No row and no report line says that the spontaneous 1–2 s jumps or repeats are fixed. Keep it so.

## Still open, apart from source correctness

- The final native suite and the late Cue journey on the accepted tree. Copy their logs, xcresult and attachments into the evidence root, then update the report and the manifest.
- Physical iPhone acceptance: audible jumps or repeats during ordinary streaming, waveform continuity, reconnection at a byte offset, and AAC starvation. All are not verified.
- Findings 1 and 2: fix them, or record them as known limits.
