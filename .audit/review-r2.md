# Playback review, round 2

Read-only review of the working tree at about 19:58Z. I read the diff, the three new test files, `review-r1.md`, `review-responses.md`, `design-verdict.md`, `playback.tsv`, the copied evidence in `~/.cache/orbis-playback-evidence/2026-10-18`, and the old buffer JSON. I ran no tests and changed no source.

## Verdict

Do not ship yet. One blocking defect: the Ogg "starvation" is a premature end-of-item, and in the app it reports a Finish. The round-1 fixes are otherwise present in the source and mostly correct. The final native evidence is incomplete.

## Findings, most severe first

### 1. Blocking. A stalled Ogg stream posts "ended" at 16 s, and the app treats it as a Finish

- Evidence. `after/all-native-after/console.log:952` and `:956`, in the Ogg recovery test that passed: `Item ended generation=2 actual=16.053500 duration=603.860000`, posted twice. The old buffer JSON (`repro-buffer-attachments/90A07C3D…json`) shows that at the stop, `bufferEmpty=false` and `likelyToKeepUp=true`, and the loaded range is `16.1+16.0`. AVPlayer did not run out of buffer. It reached what it took to be the end of the item. The rate dropped to 0 because `actionAtItemEnd` is `.pause`.
- Code. `observeCompletion` (`AudioPlayer.swift:814`) calls `onFinished` with no position check. In the app, `finishedPlaying` (`AppModel.swift:1131`) sends `reportCompletion`. The server then records a Finish for a Set heard for 16 s, removes it from the queue, and plays the next Set, or stops if the queue is empty. At the same time, the loaded-range observer calls `play()` on the old item, so the person can hear the old Set resume before the next Set replaces it.
- Why the tests pass. `StreamingPlaybackTests` drives a bare `AudioPlayer` with no `onFinished`, so the completion path never runs.
- Action. Treat an end as a Finish only when the current time is within about 1–2 s of the known length (the item's duration, otherwise `serviceDuration`). Otherwise log `premature end`, keep `.loading` while sound is wanted, and let the loaded-range path call Play again. In the recovery test, set `onFinished` and assert that it never fires. A stronger test drives `AppModel` and asserts `finishCount == 0` and an unchanged active Set after recovery.
- Note for the report. This could explain production reports where playback stopped or moved to another Set on a slow link. Do not claim that until you have device or server evidence, for example Finish records whose position is far short of the duration.

### 2. Medium. An in-play seek can leave the state at `.loading` while sound plays

- Path. Ready seeks no longer pause, so a seek past the buffer moves the time-control status from waiting to playing while `isSeeking` is still true. `stallChanged(.playing)` (`:1010`) ignores that change while seeking. The seek completion then calls `playIfReady()`, which does nothing because the rate is already 1. No later status change arrives, so the state stays `.loading` while sound plays.
- Effect. Now Playing publishes rate 0, so the Lock Screen shows Play. A Lock Screen Play does nothing (finding 3). `PositionReporting.settles(.loading)` is true, so every periodic report publishes as settled.
- Both callbacks hop through `Task { @MainActor }`, so their order is not fixed. This is plausible but not observed.
- Action. In `playIfReady()`, when the guards pass and `player.timeControlStatus == .playing`, call `stallChanged(status: .playing)`. The barrier stays the same.

### 3. Medium. Play during `.loading` does nothing, and Now Playing disagrees with the app

- `resumePlayback` returns for `.loading` (`:568`). The app now spends more time in `.loading`: every unexpected rate drop, the end of an item, and the case in finding 2. If the automatic retry misses, for example because no new ranges arrive after a premature end or a fully loaded item, Play from the Lock Screen or the app cannot start the sound.
- The mini player and Transport show Pause for `.loading`, but `publishNowPlaying` sends `isPlaying: false`, so the Lock Screen shows Play for the same state.
- Action (small). In `resumePlayback`, for `.loading`, call `playIfReady()` instead of returning. It is idempotent. Whether Now Playing should show Pause while loading is a scope choice.

### 4. Low. The tvOS Set page skips the pending-intent routing

- `TV/TVSetPage.swift:150-158` still calls `player.pause()` and `player.resume()` directly when the Set is current. While a play of Set B is pending, Play on Set A's TV page sets B's pending intent through `onCommand(.play)`. The person gets B. `SetDetailScreen` was moved to `model.togglePlayback(set.id)`. Make the same change here.

### 5. Low. A failed seek stays failed after a later seek succeeds

- After a latest-seek failure, the state is `.failed` with `pendingSeek` set. A later scrub moves the item, but `playIfReady` needs wanted sound, so the error text and the Play label stay until the person presses Play. This is acceptable if intended. Otherwise, a successful seek on a seek failure (not `itemNeedsReload`) can return the state to `.paused`.

### 6. Low. Test timing and coverage

- `StreamingPlaybackTests.swift:262` asserts `.playing` straight after the engine reports playing. The state changes one main-actor hop later. Wait for `player.state == .playing` in the condition instead.
- The AAC recovery test fails in the suite ("Withheld bytes must exhaust the real player buffer", 65.6 s, `all-native-after/console.log:831`) under the identical pacing. It is still inconclusive. Do not leave a red test in the shipped suite. Diagnose it from its attachment, or mark it as a manual probe. With finding 1, the AAC case may simply be the format without a premature end.
- The ordinary Ogg test still never reconnects at a byte offset (round-1 item 5). This is a scope choice. Record it as not covered.

## Attention flags for `playback.tsv`

- **19:41:14Z `streaming-repro`.** The row says that AVPlayer "legitimately paused instead of entering waiting". The buffer flags and the later `Item ended … actual=16.053500` contradict this. Correct the row to a premature end-of-item, and add a row for finding 1.
- **No rows for the after runs.** Add the results with their local paths:
  - `after/reliability-after` (12:42 PDT): supersession test failed ("older play request must be in flight") before the per-request body change.
  - `after/all-native-after` (12:45–12:52 PDT): 125 unit tests, all 6 reliability tests pass, Ogg recovery passes (standalone player only), and AAC recovery fails.
- **Code drift after the last run.** The last run used the 12:53 snapshot. `AppModel.swift` changed at 12:57 (operation-error guards in `queueSet` and `deleteSet`), and `startPosition` gained `duration > 0`. No native build covers the final tree.
- **No UI journey evidence after the fixes.** `after/focused-native-after/console.log` contains only the lane address, so the run did not happen. `PlaybackRecoveryUITests`, `testAColdCueNearTheEndStartsAtItsTimestamp`, and the mini-player journeys have no post-fix result. The only late-Cue result is the expected failure in `before/repro-late-cue`.
- **Mac paths.** Rows at 19:21, 19:23 and 19:45 cite Mac home paths (`~/…`). Point them at the local copies. `repro-all-native` (Cortex) was not copied.
- **Wording.** No row or report may say that spontaneous 1–2 s jumps or repeats are fixed. The packet check and the timeline diagnostics are evidence, not a fix.

## Checked against the source and found correct

- **Initial seek barrier and exact start.** `play` holds the start in `pendingSeek`. `playIfReady` waits for the session, the latest seek, and wanted sound. Exact positions go through `boundedPosition`, and saved positions go through `startPosition` in `AppModel`. `testInitialSeekFinishesBeforeAudioStarts` and the cold-Cue unit test pass on near-final code.
- **Ready seeks.** Ready in-play seeks no longer pause. Unready seeks keep the barrier.
- **Interruption.** Only `AVAudioSession` `.began` sets `.interrupted` and clears `sessionReady`. An earlier rate drop lands in `.loading`, and `.began` then moves it to `.interrupted`. An end with `.shouldResume` goes through `resumePlayback`.
- **Fresh-data retry.** The loaded-range observer is scoped to the generation, acts only in `.loading`, and goes through every `playIfReady` gate. It reads the current rate, so a late KVO cannot undo a pause.
- **Failed seek.** The latest failed seek keeps its target and keeps the item. Play calls `applyPendingSeek` again. Older seeks are ignored through `latestSeek`.
- **Pending activation.** Activations hold `startAt`. A retry for the same Set coalesces and updates the target. A scrub during a retry updates the target. Global toggle resolves from the shown state. The detail button and `playbackWantsSound` show and change the pending intent. Remote Play and Pause stay absolute.
- **Queue writes.** FIFO plus `queueMutationGeneration` for local ownership. Unsent superseded activations fail their generation check. A warm explicit activation reasserts without rebuilding. A warm Cue reasserts only while a write is pending. Completion shares the pending pause intent. Errors survive later writes through the token check.
- **Server agreement.** The supersession test now answers from each request's own body and asserts the order `["b", "a"]`. The responder runs before the hold, so the test does exercise the in-flight case.
- **Late Cue UI check.** Finishing within 12 s tells exact from restart (restart would take about 30 s). It is a good check, but it has not run since the fix.
