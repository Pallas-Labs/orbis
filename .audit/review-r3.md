# Playback review, round 3

This is a read-only review of the working tree at about 20:12Z. The base is HEAD `91d3b90` plus uncommitted changes. I read the whole diff of the native sources, tests, fixture, server and docs, and the three new test files. I read `docs/development.md`, the workflow, rounds 1 and 2, the responses, `playback.tsv`, and the evidence in `~/.cache/orbis-playback-evidence/2026-10-18`, including `final-native/`, which appeared during this review. I changed no source and ran no build or test.

## Verdict

A source correctness objection remains. The fix for the round-2 early end uses a 2-second margin against the item's own length. For Ogg, AVPlayer reports a length that is longer than the real audio. A real end of an Ogg Set can then look early, so the Listen never finishes. Production audio is mostly Ogg. Fix this before shipping.

Native acceptance is a separate open item: the UI journeys have no result after the fixes, the AAC probe is still red, and physical iPhone checks have not run.

## Findings, most severe first

### 1. Blocking. A real end of an Ogg Set can be treated as early, and then the Set never finishes

- **Code.** `observeCompletion` (`AudioPlayer.swift:816-826`) treats the end as early when `actual < duration - 2`. `duration` comes from `durationChanged` (`:714-723`), which uses the item's reported length when it is finite and greater than zero. It uses `serviceDuration` only when the item reports no length.
- **Evidence that the item length is too long.** The fixture is exactly 600 s long (`seed-lane-audio.mjs`, `ffmpeg … -t 600`, and `duration_seconds = 600`). The player reports a different length in every Ogg run. Examples: `after/all-native-after/console.log:806` and `:813` (`Length changed from 600.0s to 603.9s`, `Item ready; length 603.9s, service says 600.0s`), `:952` (`duration=603.860000`), and `final-native/console.log` at 13:10:10. AAC reports 600.0 (`before/repro-aac-buffer/console.log:227`).
- **Result.** If the player's time at a real end is near 600 s, then 600 < 603.86 − 2 = 601.86. The code logs `Premature item end`, sets `.loading`, and never calls `onFinished`. Nothing advances the queue, and no Finish is recorded. The loaded-range retry and an explicit Play call `play()` again on an item that is at its end. Each new end is again treated as early, so the person sees a loading Set until they choose another Set. A seek is limited to the reported 603.86 s (`boundedPosition`), so a scrub past the real end gives the same result. The duration observer can correct `duration` after the notification, but it hops through a `Task`, and nothing checks the end again.
- **Scope.** This is not an edge case. 26 of the 28 retained files in `~/Developer/orbis-service-data/audio` are `.ogg`. The server records `duration_seconds` from ffprobe (`media-store.ts:160-188`), so the service length is the accurate value.
- **Inference, not verified.** The 0.643 % error (603.86 / 600) matches the overhead of Ogg page headers. This suggests that AVFoundation estimates the length from file size and nominal bitrate, while it takes the playback time from the granule positions. If so, the error grows with length: about 46 s on a 2-hour Set. No run has shown the player's time at a real Ogg end. Prove this with a probe, not by argument.
- **Why the tests miss it.** The late Cue journey and `testAColdExplicitCueNearTheEndKeepsItsTimestamp` use the 30 s M4A fixture, where both lengths are 30.0. The statement in `review-responses.md` that "natural completion remains covered by the late Cue UI journey" is true for M4A only.
- **Action.** Compare the end against the shorter of the two known lengths, `min(item, serviceDuration)` when both are known. A relative margin is a second choice. Add one real-player probe: play the 600 s Ogg fixture over the production route from about 590 s, set `onFinished`, require exactly one call within about 20 s, then wait 3 s more and require that the count stays at one. Log the actual time and both lengths at the end.

### 2. Medium. The AAC recovery probe is still red, and the Ogg probe does not record which stop it measured

- **AAC.** In `final-native/console.log:565-567` (13:10 PDT, after the last source change at 13:04:38), the AAC case fails earlier than before: `The controlled stream must first advance` times out at 30 s. Several `HTTPRequest signalled err=-1001` (timeout) lines follow at `:671-737`. With 4096 bytes every 250 ms (about 131 kbit/s for a 96 kbit/s file), the AAC item never started. AAC has not yet reached starvation in any run, so the format comparison has no result. This is a problem with the test, not evidence of a product fault. Do not leave the probe red in the shipped suite. Mark it as a manual probe, or change the pacing so that the stream can start and then starve.
- **Pacing provenance.** `seed-lane-audio.mjs` was last changed at 12:45:42, and the reliability suite in `all-native-after` started at 12:45:39.9. That run therefore used the earlier pacing, which agrees with the brief. `final-native` is the first run with the 250 ms pacing.
- **Ogg.** The test accepts any non-playing state as starvation. In `all-native-after` (`:950-956`), the stop was an early end of the item after a URL timeout (`err=-1001`, then `FigFilePlayer err=-12864`, then `Item ended … actual=16.053500`). In `final-native` (around 13:10:21), it was a real stall (`MEDIA_PLAYBACK_STALL`, `Playback stalled at 10.0s`), and the case passed in 19.5 s. Both runs passed for different reasons. Record which event happened (an end notification, or waiting with an empty buffer), so that a pass shows which recovery it proves. The name "buffer underrun" fits the latest run only.

### 3. Low. A second Finish is not fully excluded, and the journey cannot detect one

- `finishedPlaying` (`AppModel.swift:1133-1134`) blocks a repeat while `pendingActivation` is set, and it returns when another Set is current. When the queue is empty, `playActiveEntry` calls `stop()`, and `currentSetId` becomes nil. An `onFinished` task that was queued before that call and runs after it passes `if let current …, current != id`, and it reports a second completion. The window is narrow (one main-actor ordering race). The nil case exists only so that `QueueTests.swift:189` and `:207` can call the method without a player. A guard that the item is still current, which those tests can satisfy, closes the window.
- `testAColdCueNearTheEndStartsAtItsTimestamp` exits the loop at the first Finish (`if finishes > 0 { break }`) and then asserts `== 1`, so it never observes a second Finish. Wait 2–3 s after the first Finish before the assertion.

### 4. Low. Controls during the completion request act on the Set that just ended

- While `reportCompletion` is in progress, `pendingActivation` has `setId: nil`. `playbackWantsSound(for:)` then returns false for every Set, so the ended Set's detail button shows Play while the mini player shows Pause (`.loading`). A tap calls `togglePlayback(id)`, then `supersedePendingActivation()`. This cancels the move to the next entry, sends `PUT /queue/active` for the Set that just finished, and then pauses it. A Lock Screen scrub does the same through `onCommand(.seek)`. The window is one request, so the effect is small. Record it, or have `onCommand` and `togglePlayback(id)` ignore a pending completion.

### Accepted, no objection

- A failed seek stays `.failed` until Play retries it. This is the recorded low-priority choice, and the retry path is correct (`resumePlayback` → `.failed` → `applyPendingSeek` → `startPlayback`).

## Round-2 findings checked against the source

| Round 2 | State now |
| --- | --- |
| 1. Early end reports a Finish | The guard is in place and the probe asserts zero `onFinished` calls. The margin is wrong for Ogg (finding 1). |
| 2. `.loading` while sound plays | Fixed. `playIfReady` calls `stallChanged(player.timeControlStatus)` after the gates pass (`:482-488`). |
| 3. Play during `.loading` does nothing | Fixed. `resumePlayback` `.loading` calls `playIfReady()` (`:568-569`), so the same gates apply. |
| 4. tvOS page skips pending intent | Fixed. `TVSetPage.swift:150-153` uses `playbackWantsSound` and `togglePlayback(set.id)`. |
| 5. Failed seek stays failed | Accepted choice (see above). |
| 6. Assertion timing | Fixed. The recovery wait requires `player.state == .playing`. The AAC case is still red (finding 2). |

## The listed considerations

- **Order of the early-end notification.** The notification runs on the main queue. The rate and time-control changes arrive later through a `Task`. All orders end in the same state: a wanted Set ends `.loading`, a paused Set stays `.paused`, an interrupted Set stays `.interrupted`, and the session flag is not changed. `rateChanged(0)` and `stallChanged(.paused)` do not change `.loading`. The loaded-range retry runs only in `.loading` and passes every `playIfReady` gate. These paths are correct, apart from the margin in finding 1.
- **Retry callbacks.** `onReloadNeeded` captures `playGeneration` and goes through `playSet`. A second retry for the same Set joins the pending request. A scrub during a retry changes its target. A retry that fails leaves `itemNeedsReload` set, so the next Play retries again. These are correct.
- **FIFO queue state.** Writes run one at a time. A superseded `playSet` or `playPlaylist` that has not been sent fails its generation check inside the operation. `reportCompletion` is always sent, which is correct. After sign-out, every caller's `CancellationError` reaches a generation or token check and does nothing. `queue` changes only when `revision == queueMutationGeneration`. These are correct.

## Attention flags for `playback.tsv`

- **No row for the 2 s end margin.** The 20:05:11Z row records the decision to reject early ends. It does not record the margin or compare it with the `603.9s` reported length in the same log. Add a row for finding 1.
- **20:05:11Z.** The evidence for the early end also shows its cause in the log: `err=-1001` at `:950` and `FigFilePlayer err=-12864` at `:951`, 6 s before `Item ended`. Add this. It is the first local evidence that a URL timeout ends an Ogg item early. Do not tie it to the user's reports without device evidence.
- **No row for `final-native` (13:09–13:10 PDT).** Record it: 48 hosted tests, all six reliability tests pass, the Ogg probe recovers after a real stall at 10.0 s, the late Ogg seek passes, and the AAC probe fails at its first-advance gate. The run started after the last source change (13:04:38). Whether the Mac copy matched this tree is not verified.
- **20:05:12Z `native-results`.** This row cites `all-native-after`. State that this run used the earlier fixture pacing, because the fixture changed 2 s after the suite started.
- **20:05:12Z `environment`.** The result reads "checks running". No row closes it.
- **Mac-only paths.** The rows at 19:21:14Z (baseline), 19:23:15Z, 19:41:14Z (environment), 19:45:42Z and 20:05:12Z (environment) cite Mac home paths (`~/…`). Local copies exist for baseline, repro-native and repro-aac-buffer under `before/`. No local copy exists for `repro-all-native` or `install-sample.txt`.
- **Paths that expire.** The rows at 19:21:14Z (ranges), 19:31:00Z and 19:41:14Z (streaming-repro) cite `~/.cache/agent-scratch/orbis-playback/…`. Those folders are deleted after 14 days without changes. Point them at the copies in `~/.cache/orbis-playback-evidence/2026-10-18`.
- **19:57:19Z `verification`** and `review-responses.md`. The late Cue gate proves a real Finish for M4A only. Do not cite it as proof of natural completion for Ogg.
- **No UI journey result after the fixes.** `after/focused-native-after/console.log` contains only the lane address. `final-native` ran hosted tests only. `PlaybackRecoveryUITests`, the late Cue journey and the mini-player journeys have no result after the fixes.
- **Not covered (state each as a row, not as a pass):** physical iPhone playback, audible waveform continuity, reconnection at a byte offset, AAC starvation, and a natural end of an Ogg Set.
- **Wording is correct.** No row says that the spontaneous 1–2 s jumps or repeats are fixed. Keep it so.

## What remains open apart from source correctness

- A native run of the final tree that includes the UI journeys.
- A natural-end Ogg probe (finding 1), which must run after the fix.
- A decision on the AAC probe (finding 2).
- Physical iPhone acceptance, recorded separately.
