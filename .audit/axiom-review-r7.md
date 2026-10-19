# Playback review, round 7 (independent, read-only)

Fresh replacement reviewer for the Axiom follow-up on top of PR #278. Source base `a018f19` plus the working-tree changes: `AudioPlayer.swift` (+24), `PlaybackReliabilityTests.swift` (+52), `.audit/playback.tsv` (+2 rows), new `.audit/axiom-playback-networking.md` and `.audit/axiom-reset-failures.md`. I read `docs/development.md`, `.audit/review-r4.md`, `.audit/review-responses.md`, `.audit/axiom-playback-networking.md`, `.audit/axiom-reset-failures.md`, `.audit/axiom-review-attempts.md`, the two new `playback.tsv` rows, the full diff, `AudioPlayer.swift`, `AppModel.swift` around playback/queue/reporting, `OrbisClient.swift`, the new tests, and the retained evidence under `~/.cache/orbis-playback-evidence/2026-10-18/`. I changed no source, ran no build, test, or SSH command, and had no children.

Rounds 5 (Claude) and 6 (Gemini) failed before any review and produced no findings and no approval (`.audit/axiom-review-attempts.md`). This is the first completed independent pass on the reset change.

## Verification I could actually perform (static + evidence, no execution)

- **The reviewed source is the tested source.** `sha256sum` of the working tree matches `axiom-source-manifest.sha256` and `axiom-reset-after/source-manifest.sha256` exactly (`AudioPlayer.swift 340e64ed…`, `PlaybackReliabilityTests.swift fd7d3b20…`), and `axiom-reset-after/source-match.log` records `OK` for both. No source line changed after the run that backs this review.
- **Before/after claim holds.** `axiom-reset-before/console.log` shows both probes failing at `PlaybackReliabilityTests.swift:178` ("A media-services reset must require an explicit Play to recover") with no reset handling. `axiom-reset-after/console.log:401-450` shows both probes passing and `:820` shows `Executed 127 tests, with 0 failures` for the whole `OrbisTests` suite on the pinned hashes.
- **Adjacent gates.** `axiom-reset-ui/console.log:379,443` (3 UI journeys, 0 failures) and `axiom-tvos-build/console.log:153` (`BUILD SUCCEEDED`).
- **Networking audit spot-checked.** `OrbisClient.swift:738-743` sets `waitsForConnectivity` and a 60 s resource deadline; per-request deadlines exist (`OrbisClient.swift:666`, `:348`); cancellation maps to `OrbisError.cancelled` (`:353`, `:676`). `rg` finds no `Network.framework`, `NWPathMonitor`, `SCNetworkReachability`, or manual DNS use, and the only cleartext addresses are loopback. The document's networking section is an accurate description of the source, not a claim about physical handovers.
- **Diff contains 0 new comments**, as expected. The only style note is below.

## Verdict

**Source correctness: no HIGH and no MEDIUM objection.** The reset adapter is correct on every path I could trace statically: it invalidates the old session, seek, KVO, periodic-time and artwork callbacks through one generation bump; it quiets sound and the model's pending sound intent; it preserves the Set, position, duration, cues and metadata; it discards the old player; and recovery is reachable only from an explicit Play. Five LOW items remain (two evidence gaps, two trail/robustness items, one pre-existing resume-source nuance). None blocks a merge.

**Acceptance is separate and still open.** The simulator evidence is source-pinned and good. A real media-daemon reset, device handover, Lock Screen/AirPods delivery and Lock Screen commands after a reset are not verified. The original audible 1–2 s jumps/repeats remain unexplained; nothing here claims otherwise.

## Findings, most severe first

### 1. Low. Item-scoped notification tokens outlive the item in the reset path

- **Path.** The handler calls `dropPlayerObservers()` then `player = nil` (`AudioPlayer.swift:1217-1218`). `dropPlayerObservers()` (`:1065-1080`) removes only the time observer and the five KVO observations. The notification tokens registered per play — `didPlayToEndTime`, `failedToPlayToEndTime`, `playbackStalled`, `newErrorLogEntry`, `timeJumped`, `newAccessLogEntry` (`:804-919`) — stay in `observers` while the `AVPlayerItem` they were registered against is released with the player. They are only removed by the next `stop()` (`:669-673`), `play()`, or `deinit`.
- **Why it is new.** The item-failure path (`:698-706`) keeps the player, so the item stays alive; only this path frees it with registrations outstanding. Behavior is unaffected: every one of those blocks re-checks `playbackGeneration == generation`, which the bump at `:1212` invalidates, and the `newErrorLogEntry` block only logs. The residual is a registration whose `object:` reference is no longer alive, held until the next play, stop, or deinit. `NSNotificationCenter` does not retain the `object:` it filters on, so this is a latent dangling-registration risk rather than a proven fault. I did not observe a crash; the two probes end by playing again, which removes the tokens.
- **Smallest closure, if wanted.** Remove the item-scoped tokens (or all of `observers`) before `player = nil`, and keep the interruption/route/reset registrations by re-adding them. Otherwise record it as a known limit.

### 2. Low. Two documented policy requirements have no probe

`axiom-reset-failures.md` states four requirements. The probes cover requirements 1, 2 and 5 (playing and paused Sets go quiet, position retained, fresh player and real advancement after Play). They do not cover:

- **Requirement 3** — "an in-flight session activation, seek completion or item callback must not restart the invalid player after reset". No probe posts the reset while a session activation (`AudioPlayer.swift:455-481`) or a seek (`:757-799`) is in flight. The mechanism is the generation guard (`:466`, `:774`), which I read as correct, but nothing measured it.
- **Requirement 4** — "if another Set activation is pending, the reset must clear its sound intent". In both probes `model.playSet(...)` has already returned (`PlaybackReliabilityTests.swift:169`), so `pendingActivation == nil` when the reset lands and the model branch that clears intent (`AppModel.swift:782-790`) is never executed. The handler's `pause()` reaches it correctly, but the policy is unverified by evidence.

Not a source defect; it is a gap between the written policy and the retained proof. Either add a third probe (reset while a `playSet` HTTP request is held) or mark requirements 3 and 4 as unmeasured.

### 3. Low. Two trail pointers are wrong or dangling

- `.audit/playback.tsv:32` cites `.audit/axiom-review-r6.md` as its evidence. That file does not exist; line 34 confirms the r6 report was never produced. The row is superseded by `axiom-review-attempts.md` but still points at a nonexistent path. Point it at `axiom-review-attempts.md`.
- `.audit/playback.tsv:31` (the reset row) names `.audit/axiom-playback-networking.md` as the document that establishes the reset policy; the reset policy and failure cases are in `.audit/axiom-reset-failures.md`. Keep both only if both are intended.
- `axiom-reset-before/` retains only `console.log` — no source manifest and no `.xcresult`. The "before" state is therefore inferred from the failure at `PlaybackReliabilityTests.swift:178` rather than hash-pinned, unlike every other run in the root. One `sha256sum` line would close it.

### 4. Low (partly pre-existing). "Exact position" holds on the toggle path, not the row/detail Play path

The Lock Screen Play and the mini player go through `resume()` → `resumePlayback()` → `onReloadNeeded?(currentSetId, elapsed)` (`AudioPlayer.swift:552-556`, `AppModel.swift:774-781`), which resumes at the position captured at the reset. The Set detail / row Play goes through `playSet(id)`, whose `.failed` branch (`AppModel.swift:881-883`) falls to the cold path and resumes at the **server's** `resumePosition` (`AppModel.swift:919-924`). That value is as fresh as the last position report, so a detail Play after a reset can land a few seconds away from the exact local position. Same code already applies to the item-failure path, so this is not introduced here, but "preserved exact position" should not be read as covering every Play affordance.

### 5. Low (test robustness). The probes rely on main-queue hop ordering and a 0.3 s tolerance

`assertMediaServicesResetRecovery` asserts `guard case .failed` and `oldEngine.rate == 0` immediately after `await Self.postMediaServicesReset()` (`:176-181`). That holds because the notification block is enqueued on the main queue before the awaiting continuation resumes; it is ordering, not synchronization. Likewise `XCTAssertEqual(player.elapsed, position, accuracy: 0.3)` (`:183`) reads `position` before the reset and captures it again inside the handler, so a stalled main thread widens the gap. Both probes passed in the retained run (`axiom-reset-after/console.log:401-450`) and the later 200 ms re-assertion gives a second chance, so this is a latent flake rather than a present failure.

## Checked and found correct

- **Generation invalidation is complete.** One `playbackGeneration += 1` (`:1212`) drops: the in-flight session start (`:466`), a seek completion (`:774`), every KVO hop (`:373`, `:383`, `:392`, `:401`, `:408`), the periodic-time observer (`:421`), and a late artwork fetch (`:513`). The periodic observer is also removed outright by `dropPlayerObservers()`.
- **Sequence is right.** `capturePosition()` runs before `pause()`, so the Now Playing metadata published by `pausePlayback()` carries the preserved position; `state = .failed(...)` comes after, so the final state is the quiet failure. `pause()` funnels through `onCommand?(.pause)`, whose `.pause` branch returns `false` (`AppModel.swift:788-790`), so `pausePlayback()` always runs and the player is actually stopped — the model branch only clears sound intent.
- **No automatic recovery.** `resumePlayback()` is reached only from `resume()`, `togglePlayPause()` and `applyInterruption(.ended, …)`. After a reset the state is `.failed`, so the interruption route is gated out (`:1247`), and the `state == .interrupted` guard holds. `playSet` treats `.failed` as "not in player", so a warm reassert cannot rebuild audio.
- **Session race is serialized.** `startPlayback()` chains behind `sessionWork` (`:461-464`) and `stop()` chains `endSession()` behind the same task (`:677-682`), so the reload's deactivate → activate cannot be reordered by a pre-reset activation still running. `startSession()` reconfigures the category on every activation (`:292`), which is what Apple's reset policy asks for.
- **Sound intent.** `wantsSound` is false in `.failed`; `soundRequestedAt` is cleared by `pausePlayback()`; a pending activation for another Set has `wantsSound = false`, so its eventual `play(..., autoplay: false)` installs a paused player and no sound.
- **Seek race.** A pending, unapplied seek has already written its target into `elapsed` (`AudioPlayer.swift:600-606`), so clearing `pendingSeek` at `:1215` does not lose the position; the reload uses `elapsed`.
- **Observer dedup.** `observeInterruptions()` is guarded by `isObservingInterruptions` (`:1156-1157`), which `stop()` resets while removing every token (`:669-673`), so the reload cannot stack a second reset observer.
- **Isolation.** The new block is registered with `queue: .main` and uses `MainActor.assumeIsolated`, the same pattern as the existing notification observers, and the probe deliberately posts from a `@concurrent nonisolated` context (`PlaybackReliabilityTests.swift:161-163`) to exercise that adapter. `@concurrent nonisolated` matches the file's existing use at `:286`/`:322`.
- **Cues, duration, metadata, reporter.** `cues` and `duration` are left intact, so the seek bar keeps its marks until the reload reattaches the tracklist; `publishNowPlaying(isPlaying: false)` keeps the title/artist/artwork. The position reporter simply skips while `settledPosition` is nil (`AppModel.swift:1205-1206`) instead of reporting a stale value.
- **A Lock Screen scrub after the reset is ignored** (`seek(to:)` returns at `:595-598` with `player == nil`) while an in-app scrub reloads (`AppModel.swift:961-971` treats `.failed` as "not in player"). That is a defensible reading of "wait for a user action" and no worse than the pre-change behavior of seeking an invalid player. Recording it as an interaction limit, not a defect.
- **iOS 27 interruption deprecation** is documented as a migration follow-up supporting iOS 26 (`axiom-playback-networking.md`), not as a cause of the reported skips. Agreed; nothing in this diff touches that path.

## Attention flags for the decision trail

- **Physical acceptance still open and must not be read into this pass.** No real daemon reset, no device handover, no Lock Screen/AirPods command delivery after a reset. The probes post a public notification with a real HTTP fixture and real `AVPlayer`, which proves the app adapter only.
- **Timestamp vs hash.** Local `AudioPlayer.swift` mtime (13:33:53) is later than the start of the 127-test suite (13:33:30), which is explained by the remote→local copy of the working tree. The binding evidence is the hash pin, not the timestamps; do not cite mtimes as run provenance.
- **`.audit/playback.tsv:31-32` and the missing `axiom-review-r6.md`** (finding 3) should be corrected before this trail is cited again, since the current trail names a document that never existed.
- **`axiom-reset-before/` has no source manifest** (finding 3); the before/after contrast is a log inference, not a hash-pinned pair.
- **The two accepted low limits from round 4** (completion-HTTP retry, controls during pending completion) are untouched by this diff and remain accepted limits, not new findings.
