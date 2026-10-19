# Playback review, round 1

This is a read-only review of the uncommitted diff. The parent changed the files during the review, so the AAC fixture finding below was resolved before this report was written. Line numbers refer to the working tree at about 19:50Z.

## What I checked

I read the diff of `AppModel.swift`, `AudioPlayer.swift`, `SetDetailScreen.swift`, `ZoomTransition.swift`, `app.ts`, `audio.test.ts`, the fixture, `LaneService.swift`, `PlaybackUITests.swift`, and the three new test files. I read the design verdict, the decision trail, the failure inventories, and the four streaming attachments. I compared the queue code with `queue.ts`.

I ran `bun test src/audio.test.ts` and all 13 tests passed. I did not run the full set of 17 server tests that the brief mentions. I did not compile or run anything native, because that needs the Mac.

## Findings, most severe first

### 1. High. A buffer underrun stops playback, and the code does not restart it

This is the strongest candidate for "Play does not work", and the current diff does not fix it.

- Evidence. In `repro-streaming-attachments/CA5D0175…json`, the sampled state goes from `playing` (tcs 2, rate 1) straight to `interrupted` (tcs 0, rate 0, reason `none`) at 16.73 s, with media at 16.0535 s. It then holds for about 30 s. No sample shows `waitingToPlayAtSpecifiedRate`. AVPlayer itself dropped the rate, because no app code calls `pause()` on a stall.
- Code. `rateChanged` (`AudioPlayer.swift:989`) maps rate 0 while `.playing` to `.interrupted`. The `playbackStalledNotification` handler (`:845`) only logs. Nothing calls `play()` again when bytes return. The person must press Play, and that also goes through a session restart.
- Action. Find the cause before you change code (`timeControlStatus` path, `automaticallyWaitsToMinimizeStalling`, Ogg compared with AAC). A likely fix is this: when a stall happens or the rate drops while `wantsSound`, keep `.loading`, then call `play()` again from a KVO on `isPlaybackLikelyToKeepUp` or `isPlaybackBufferEmpty`. That would also keep the `.loading` assertion in the underrun test valid. The release phase of this test has never run, so recovery and the "no jump after recovery" check have no evidence yet. Do not claim this is fixed.

### 2. High. Toggle during a pending activation does the opposite of what the screen shows

- Path. `playSet` pauses the old Set A (`AppModel.swift`, inside `playSet`) and stores `pendingActivation(B, wantsSound: true)`. While the request is in flight, the mini player shows A paused (`OrbisApp.swift:196` reads `player.state == .playing`), so the button says Play. A tap calls `togglePlayback()` (`AppModel.swift:1259`), which flips `wantsSound` from true to false. B then attaches paused. Lock Screen, headphone, and CarPlay `togglePlayPause` do the same through `onCommand(.toggle)` (`:791`), because Now Playing also shows A paused.
- Impact. This is the reported "play/pause does not work" symptom on a slow PUT (cellular or Tailscale), and the tests do not cover it. `testPausingAPendingSelectionDoesNotActivateItAgain` covers only the detail button, which reads `playbackWantsSound`.
- Action. Make every surface show the pending intent: the mini player and Transport `isPlaying`, and `publishNowPlaying(isPlaying:)` while a request is pending. The other option is to resolve `.toggle` from the state the person can see. Add one journey: start B, use the mini player toggle while the PUT is held, and assert the final player state.

### 3. Medium. A seek whose latest completion returns `finished == false` now fails the item

- `move` completion (`AudioPlayer.swift:787`) sets `itemNeedsReload` and `.failed("The audio could not move to that position.")`, and replaces a deliberate `.paused`. Older interrupted seeks are filtered by `latestSeek`, so only the latest seek reaches this branch. We have no evidence of which events cause it (the item failing, `cancelPendingSeeks`, or "any other operation" in Apple's documentation). A false positive gives a visible error, a new `PUT /queue/active`, and a new item.
- Action. Fail only when `item.status == .failed`, or let the failure observers handle it. Otherwise clear `isSeeking` and call `playIfReady()`, or send the seek again. If you keep the branch, log it and get evidence first.

### 4. Medium. Every seek while playing now pauses, waits for an exact seek, then plays and buffers again

- `seek(to:)` and `move` (`AudioPlayer.swift:585` and `:749`) call `player.pause()` and set `.loading`. `play()` waits for the zero-tolerance seek to complete. This affects ±15/30 s skips, Cue taps, Lock Screen scrubs, and AirPods next/previous. The barrier was needed for the initial `pendingSeek` (the baseline start-at-12 failure). In-play seeks had no confirmed fault.
- Nobody has measured the extra latency. `First playing` logs only once per item. `Seek completed duration` stops at seek completion, not at audible output.
- Action. Log seek-request to `.playing` per seek, and measure an Ogg seek past the buffered range on the stream fixture. If the cost is noticeable, limit the pause to a seek that has not started or a seek before the first play.

### 5. Medium. The tests cover only part of the reported symptom

- The underrun test checks only a forward jump after release (`advanced <= wallTime + 0.3`). A repeat after recovery, which is half the user's symptom, passes. Check the delta of each sample through the release, as the ordinary test does (`>= -0.15`).
- The ordinary 10 s Ogg pass uses the production route over loopback. The whole file arrives at line speed, so AVPlayer never needs a second range request. It is weak evidence against jumps in real streaming. Add one scenario where the fixture closes the response in the middle of the stream, so AVPlayer must reconnect at a byte offset. Ogg page resync on reconnect is a plausible cause of 1–2 s jumps or repeats. This is a guess and has no evidence yet.
- `testAColdCueNearTheEndStartsAtItsTimestamp` (UI). The `elapsed in 26...29` wait passes trivially, because `elapsed` is set to the target at once. The real check is the stored position after Pause. That check has a race: the fixture ends at 30 s, the test swipes up to three times before it taps, and completion sets the position to 0. If Pause lands while the seek is still in progress, `settledPosition` is nil and no report is sent. Expect flakes. A more robust check is the time from tap to natural finish (no more than about 5 s), or the queue completion record.
- `testAColdExplicitCueNearTheEndKeepsItsTimestamp`. The first `elapsed == 26` assertion is trivial for the same reason. The later `currentTime` assertion is the real one.
- `testACueOnTheCurrentSetSupersedesADelayedPlayOfAnotherSet`. The stub reads the global `StubProtocol.lastBody` and falls back to `"b"`. This is correct today only because FIFO keeps the PUTs one at a time. The verdict warned about this pattern. Make the stub answer from the request's own body. Also assert the PUT order (b, then a), not only the final `activeSetId`.

### 6. Low. Edge cases in the new ownership code

- **Seek during a retry.** `onReloadNeeded` calls `playSet`, which makes a pending activation. A scrub then supersedes it, the reload is lost, and the Set stays failed. The person must press Play again.
- **Duplicate retry PUTs.** The short-circuit at the start of `playSet` applies only when `startAt == nil`. A retry always passes a position, so a double tap on Play for a failed item sends two activations. They do not record a new Listen, but they are not needed. Short-circuit when `pendingActivation?.setId == id`, and update the start position.
- **Failed tap stops audio.** A failed or offline activation now leaves the old Set paused. Before this change, it kept playing. Decide whether this is intended.
- **Swallowed errors.** `deleteSet` and `queueSet` use the revision guard on failure (`AppModel.swift:1481`, `:1046`). A real delete failure is hidden if any queue write was queued after it.
- **Unordered position report.** `settlePositionBeforeReplacement` sends its position PUT outside the FIFO. It can reach the server after B's activation. Check whether presence (`presenceWindowMs`) can then show the old Set as listening.
- **Shuffle on the loaded Set.** If the first random Set is the loaded one, `playSet` now resumes it locally and does not send `PUT /queue/active`. The server can keep another Set active.
- **Zero duration.** `AudioPlayer.startPosition` with `durationSeconds == 0` always returns 0, because AppModel now passes `durationSeconds` without the old `> 0` filter. The server clamps positions to the duration, so the effect is probably nil. Add the filter anyway.
- **Pause log.** `Pause applied duration=` measures the synchronous `player.pause()` call, which is about 0. It does not measure the time to silence or to rate 0, so it is not the "pause completion timing" that verdict item 7 asks for.
- **Fixture blocking.** `longOgg()` and `longAac()` run ffmpeg synchronously inside the fixture's request handler, which blocks the fixture event loop on the first call.

### 7. Low. The server range fix does not change production

- Production Vanta audio is served by `node-audio-http.ts` `parseRange` (`node-http.ts` imports it), and that code already handled `bytes=-N` correctly. The `app.ts` fix changes the Bun `createApp` path, which the native lanes and fixture use. Do not tie the user's symptoms to this bug.
- The two parsers now differ on a malformed header: `app.ts` returns 200 for the full file, and the node parser returns 416. A reversed range returns 416. RFC 9110 lets a server ignore an invalid range and send 200. AVPlayer never sends one, so this does not matter in practice.

### Resolved during review

`testAnAACBufferUnderrunHoldsPositionAndRecoversWithoutSkipping` needed `ready-aac` and a stream route for each format. The fixture now provides `ready-(ogg|aac)`, a 600 s 96 kbps AAC file, and the correct content type for each format. Check this when the tests run.

## Checked and found correct

- **FIFO queue writes.** `enqueueQueueMutation` chains on the main actor and does not cancel the request before it. Each write checks the token before it is sent. `revision` gives local "last write wins" for `queue`. `loadQueue` reads are not serialized, as the verdict requires. A bump of `queueGeneration` at enqueue and at completion drops stale reads.
- **Sign-out.** `signOut` bumps every generation and clears the pending activation. A queued write fails its token check. A response that arrives after sign-out fails its generation check, and the `defer` in `playSet` then does nothing.
- **Seek and session barrier.** `playIfReady` requires the session, `wantsSound`, no `pendingSeek`, no `isSeeking`, and no `itemNeedsReload`. It runs from both the session completion and the seek completion, so play waits for whichever finishes last. A pause while waiting is kept. Older seek completions are dropped by `latestSeek`.
- **Shared retry.** `resumePlayback` sends `itemNeedsReload` or a failed item to `onReloadNeeded` with the latest `elapsed`. `capturePosition` takes `elapsed` from the settled player time on a failure. Every surface (Transport, TV, Lock Screen, detail) reaches it through `resume` or `togglePlayPause`.
- **Lifetimes.** The new closures capture `self` weakly. The new observers (`timeJumped`, `newAccessLogEntry`) are in `observers` and are removed in `stop()`. The logs keep Set ids out of public fields.
- **Server agreement.** A warm supersede sends `playSet(current)` again behind the FIFO. When the pending request was never sent, this does nothing on the server. When it was sent, this is the subsequent activation that the verdict requires.

## Decision trail: points to check

- `playback.tsv` has no rows for these items: the implementation decisions (pause on every seek, an unfinished seek causing a failure, the settle report on replacement, the local resume at the start of `playSet`, moving `finishedPlaying` to attach before the refresh), the starvation probe result, the change to the underrun gate from "waiting" to "not playing", and adding the AAC comparison. Add them before the final report cites them.
- The native fixes are not compiled. Every native behavior claim is unverified until the Cortex run.
- The four attachments in `repro-streaming-attachments` come from the old test version. They have no `bufferEmpty`, `likelyToKeepUp`, or ranges keys. They are baseline evidence only.
- The baseline rows for start-at-12 and delayed B cite `/Users/parthmangrola/...` paths on the Mac. I could not read them from Vanta, so I did not verify those claims myself.
- The 1–2 s jumps are still unexplained. The diff adds only diagnostics for them. The final report must not call them fixed, and must not call the range fix their cause (see finding 7).
- The test counts differ. I confirmed 13 of 13 in `audio.test.ts`. The "17 server HTTP tests pass" claim covers a set I did not run again.
