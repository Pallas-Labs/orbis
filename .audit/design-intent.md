# Candidate: desired playback vs observed engine (native player)

Candidate design only. No production code changed. Grounded on `AudioPlayer.swift`, `AppModel.swift` (playback section, lines 748–1080), `Transport.swift`, `SetDetailScreen.swift`, `PositionReporting.swift`, `apps/server/src/queue.ts` (`play`, `playPlaylist`), ADR 0001 and ADR 0011, the glossary, and the uncommitted red tests in `OrbisTests/PlaybackReliabilityTests.swift` and `OrbisUITests/PlaybackUITests.swift`.

## Problem

`AudioPlayer.state` holds two different facts in one value: what the person asked for (sound or quiet, which Set, which position) and what AVFoundation did (session up, item ready, seek landed, rate). The player reads intent back from observations (`rateChanged`, `stallChanged`). Each confirmed fault comes from this mix or from a second copy of the same fact:

| Finding | Cause in today's code |
| --- | --- |
| A cold Cue in the last 5 s restarts at 0 | `play(startAt:)` applies `startPosition`, the resume near-end rule, to every start. A Cue is an exact request, not a resume. `AudioPlayer.swift:324` |
| Sound starts before the initial seek lands | `play()` calls `startPlayback()` right after it sets `pendingSeek`. `player.play()` can sound from 0 before `itemStatusChanged` hops to the main actor and calls `applyPendingSeek`. `pause()`+`resume()` while the item is still loading has the same gap. `AudioPlayer.swift:327,403,496` |
| A warm Cue does not cancel a pending `playSet` | `play(_:from:)` seeks without touching `playGeneration`, so the later `PUT queue/active` response calls `audioPlayer.play` and replaces the Cue. `AppModel.swift:818-831` |
| Play does nothing after an item failed | `resume()` returns early on a failed item. Only `AppModel.togglePlayback()` restarts the Set. Transport, the Set page button, the Lock Screen, and CarPlay call `player.resume()` directly. A stream that broke (`failedToPlayToEndTime`) keeps item status `.readyToPlay`, so `resume()` plays a dead item and shows a spinner. `AudioPlayer.swift:486-500`, `Transport.swift:126-134`, `SetDetailScreen.swift:130-136` |
| A cold Play has no intent while the queue request runs | Nothing in the player changes until `PUT queue/active` answers. Pause cannot act on the request, the page still shows Play, and the old Set plays on. `AppModel.swift:771-795` |

Other faults found during grounding, in the same family:

- `PUT queue/active` requests can reach the server out of order. Two quick plays can leave the server's active Set different from the local one. Nothing serializes them.
- `finishedPlaying` waits for `refreshLibraryQuietly()` before it starts the next Set, which adds one library fetch to every queue advance. `AppModel.swift:962-964`
- A replaced Set's last position (up to 5 s) is never reported. The reporter is cancelled when the next Set starts. `AppModel.swift:1003`
- A Queue screen tap on the active Set calls `playSet`, which reloads the Set from the server's resume position. That position can be up to 5 s stale, so the tap moves the audio back by 1–5 s. `QueueScreen.swift:78`
- Rapid skips issue one exact seek each, and each exact seek flushes the buffer.

These are the constraints:

- Every Listen activation goes through the Listening Queue on Vanta (ADR 0001 and the `AppModel.playSet` comment). A repeat `PUT queue/active` for the active Set records no new Listen (`queue.ts:179-181`).
- Pause and resume stay inside one Listen (glossary).
- One player and no second queue (ADR 0011).
- Lock Screen and car commands share the phone's commands (ADR 0011).
- The near-end rule applies to a saved resume position only.
- The parent's red tests call `AudioPlayer.play(set:baseURL:token:startAt:)`, `seek`, `pause`, `resume`, `AppModel.playCue`, `playSet`, and `togglePlayback`. Keep these signatures.

The 1–2 s skips have no confirmed cause. Production range parsing is correct (`node-audio-http.ts:25-49`). Stream grants last 24 h. The design makes the skip observable, removes the two skip sources the app itself causes (sound before the seek, stale resume reload), and does no codec or buffer tuning.

## Usage (caller's view)

The API does not change for views. The behavior changes behind it.

```swift
// Set page, Transport, Now Playing, TV, Lock Screen: one control, every state.
player.togglePlayPause()   // pause while sound is wanted; otherwise resume,
                           // and a failed or broken item asks the model to reload it.

// Cue row, cold or warm, Set page or CarPlay.
Task { await model.playCue(cue, in: set.id) }   // exact position, never the near-end rule

// Play on another Set: the old Set stops now, the new one reads as loading,
// and Pause during the queue request is kept.
Task { await model.playSet(set.id) }
player.pause()   // the response attaches the item paused
```

Inside `AppModel`, one decision covers every activation:

```swift
func playSet(_ id: String, from start: StartPoint = .saved) async {
  guard let client else { return }
  if audioPlayer.canContinue(id) {          // loaded, playable, no request pending
    audioPlayer.go(to: start)               // warm: seek if exact, then sound
    return
  }
  let outgoing = audioPlayer.settledPosition()   // (setId, seconds) of the Set being replaced
  let ticket = audioPlayer.select(knownSet(id) ?? .placeholder(id), start: start)
  stopReportingPosition()
  if let outgoing { Task { await reportPosition(outgoing.id, seconds: outgoing.seconds, settled: true) } }
  do {
    let loaded = try await queueRequests.run { try await client.playSet(id) }   // FIFO
    guard audioPlayer.owns(ticket) else { return }
    queue = .loaded(loaded)
    guard let playing = loaded.entries.first(where: { $0.id == id }) else {
      return audioPlayer.abandon(ticket, reason: "This Set is not in the queue.")
    }
    audioPlayer.attach(playing, source: AudioSource(client), ticket: ticket)
    attachTracklist(to: playing)
    startReportingPosition(id)
  } catch {
    guard audioPlayer.owns(ticket) else { return }
    audioPlayer.abandon(ticket, reason: "Could not start this Set.")
    setFailure = ...   // as today
  }
}

func playCue(_ cue: Cue, in id: String) async {
  guard let s = cue.startSeconds else { return }
  await playSet(id, from: .exact(s, .cue))
}
func playFromBeginning(_ id: String) async { await playSet(id, from: .exact(0, .fromBeginning)) }

private func wirePlayer() {
  audioPlayer.onFinished = { [weak self] id in Task { await self?.finishedPlaying(id) } }
  // One retry path for every Play surface.
  audioPlayer.onReloadNeeded = { [weak self] id, seconds in
    Task { await self?.playSet(id, from: .exact(seconds, .retry)) }
  }
}
```

`playPlaylist` and `finishedPlaying` do not know the next Set before the response, so they reserve a ticket and do not select:

```swift
let ticket = audioPlayer.reserve()        // later commands supersede this response
let loaded = try await queueRequests.run { try await client.playPlaylist(id) }
guard audioPlayer.owns(ticket) else { return }
playActiveEntry(of: loaded, from: client, ticket: ticket)   // attach, or stop when empty
```

`finishedPlaying` attaches the next Set first, then calls `refreshLibraryQuietly()`.

## Shape

### Data (new `apps/apple/Orbis/PlaybackPlan.swift`: pure, no AVFoundation objects)

```swift
/// Where a start asks to begin. `.saved` is a resume and obeys the near-end rule; `.exact` is a
/// person's choice (a Cue, a scrub, a skip, From Beginning, a retry) and is only clamped to the
/// audio's length.
enum StartPoint: Equatable {
  case saved(TimeInterval? = nil)     // nil: use the queue response's resumePosition
  case exact(TimeInterval, SeekOrigin)
  static var saved: StartPoint { .saved(nil) }
}

enum SeekOrigin: String { case cue, scrub, systemScrub, skip, cueSkip, fromBeginning, retry, resume }

/// One per selection or reservation. A response carrying an older ticket does nothing.
struct Ticket: Equatable { fileprivate let value: Int }

/// What the person asked for. Written only by AudioPlayer's command methods.
struct Desired: Equatable {
  var setId: String
  var wantsSound: Bool
  /// A position the engine has not confirmed. Cleared when the newest seek finishes.
  var target: StartPoint?
  var stage: Stage
  enum Stage: Equatable { case requesting, attached, abandoned(String) }
}

/// What AVFoundation reported. Written only by observation handlers.
struct Observed: Equatable {
  var session: Session = .down          // .down, .starting, .up, .failed, .interrupted
  var item: Item = .none                // .none, .loading, .ready, .failed(String), .broken(String)
  var control: Control = .paused        // .paused, .waiting(String), .playing
  var seek: (number: Int, to: TimeInterval)?   // the newest seek in flight
  var position: TimeInterval = 0        // last periodic tick or landed seek
  var duration: TimeInterval?           // item's own, else service's
  /// The rate dropped while sound was wanted and no command asked for it. Cleared by a command.
  var systemStopped = false
  /// What was last asked of the engine, so the plan emits deltas only.
  var askedRate: Float = 0
}

enum EngineAction: Equatable {
  case startSession, endSession
  case seek(TimeInterval, number: Int)
  case play, pause
}

enum PlaybackPlan {
  /// The engine actions that move `observed` toward `desired`. Pure and idempotent: called
  /// again with the same inputs it returns [].
  static func actions(_ desired: Desired?, _ observed: Observed, nextSeek: Int) -> [EngineAction]

  /// The state screens and PositionReporting read. Derived, never stored.
  static func state(_ desired: Desired?, _ observed: Observed) -> AudioPlayer.PlaybackState

  /// The position the bar shows: the pending target, else the engine's.
  static func elapsed(_ desired: Desired?, _ observed: Observed) -> TimeInterval

  /// A target as a position on this item. `.saved` applies the near-end rule
  /// (`startPosition`); `.exact` clamps to 0...duration only.
  static func resolve(_ target: StartPoint, resume: TimeInterval, duration: TimeInterval?) -> TimeInterval
}
```

### Plan rules (`PlaybackPlan.actions`)

1. `desired == nil` → `pause` if `askedRate > 0`. `stop()` ends the session as it does today.
2. `wantsSound`, `stage != abandoned`, session `.down` or `.failed` (only after a new command clears `.failed`) → `startSession`. This also runs in `.requesting`, so the session starts while the queue request is in flight.
3. `stage == .abandoned` → `endSession` once, so other apps get their audio back.
4. `target != nil`, item `.ready`, and the resolved target differs from `seek?.to` → `seek(resolved, nextSeek)`. A newer seek supersedes AVPlayer's older one. Only the newest completion clears `target`.
5. `play` only when all hold: `wantsSound`, `!systemStopped`, session `.up`, `target == nil`, `seek == nil`, item `.loading` or `.ready`, and `askedRate == 0`. This fixes the start-before-seek gap. A start from 0 has no target and still plays before the item is ready, so it gets no slower.
6. `!wantsSound && askedRate > 0` → `pause`. The pause runs at once, during a seek or a session start too.
7. Item `.failed` or `.broken` → no action. The derived state is `.failed`. Rule 8 handles recovery.

### Derived state (`PlaybackPlan.state`), keeping today's enum

`nil` → `.idle`. `abandoned(r)`, item failed or broken, or session failed → `.failed(message)`. `!wantsSound` → `.paused`. Session `.interrupted` or `systemStopped` → `.interrupted`. Control `.playing` with no target and no seek → `.playing`. Otherwise `.loading`. `elapsed` is derived the same way, so the six writes of `elapsed = …` in `play`, `seek`, `applyPendingSeek`, and `move` go away.

### AudioPlayer (shell)

```swift
@MainActor @Observable final class AudioPlayer {
  private(set) var desired: Desired?
  private var observed = Observed()
  var state: PlaybackState { PlaybackPlan.state(desired, observed) }
  var elapsed: TimeInterval { PlaybackPlan.elapsed(desired, observed) }
  var duration: TimeInterval? { observed.duration }
  var currentSetId: String? { desired?.setId }

  @ObservationIgnored var onFinished: ((String) -> Void)?
  /// Called when Play meets an item that cannot play again, with the last good position.
  @ObservationIgnored var onReloadNeeded: ((String, TimeInterval) -> Void)?
  @ObservationIgnored private(set) var diagnostics = PlaybackDiagnostics()

  // Selection: AppModel only.
  func select(_ set: SavedSet, start: StartPoint) -> Ticket      // tears down the old item now
  func reserve() -> Ticket                                       // supersedes, selects nothing
  func owns(_ ticket: Ticket) -> Bool
  func attach(_ set: SavedSet, source: AudioSource, ticket: Ticket)   // no-op on a stale ticket
  func abandon(_ ticket: Ticket, reason: String)
  func canContinue(_ id: String) -> Bool   // attached, same Set, item not failed/broken, no request pending
  func go(to start: StartPoint)            // warm: set target if exact, wantsSound = true
  func settledPosition() -> (id: String, seconds: Int)?

  // Transport: every surface.
  func pause()
  func resume()          // failed or broken item → onReloadNeeded(id, lastGood); else wantsSound = true
  func togglePlayPause()
  func seek(to: TimeInterval, origin: SeekOrigin = .scrub)
  func skip(by: TimeInterval)              // relative to `elapsed`, so a pending target is the base
  func skipToNextCue(); func skipToPreviousCue()
  func setCues(_ cues: [Cue])
  func stop()

  /// Kept for the red tests and the single-player tests: select + attach under a fresh ticket.
  func play(set: SavedSet, baseURL: URL, token: String, startAt: TimeInterval = 0)

  /// Every observation handler ends here. Internal so a test can feed what the system did.
  func observe(_ change: Observation)       // replaces rateChanged/stallChanged
  private func reconcile()                  // for action in PlaybackPlan.actions(...) { execute(action) }
  private func execute(_ action: EngineAction)
}

struct AudioSource { let baseURL: URL; let token: String }   // AppModel builds it from OrbisClient
```

`Observation` is an internal enum: `.session(Observed.Session)`, `.item(Observed.Item)`, `.duration(Double)`, `.control(Control, rate: Float)`, `.seekFinished(number: Int, landed: TimeInterval, finished: Bool)`, `.tick(TimeInterval)`, `.interruption(began: Bool, shouldResume: Bool)`, `.routeLost`, `.ended`, `.broke(String)`. The KVO and notification wiring stays as it is (generation guard, main-actor hop), but each handler now does one thing: `observe(...)`. The existing `latestStart` and `latestSeek` counters become `Observed.seek.number` and a session-ask number that the plan reads, so it keeps one counter per fact.

The session queue (`sessionWork`) stays. It is correct today and keeps a late deactivation from undoing a newer activation. `execute(.startSession)` appends to it and reports `.session(.up/.failed)` with the generation guard.

Interruption policy is unchanged, but it no longer reads intent from rate. When an interruption begins, `observed.session = .interrupted` and `askedRate = 0`, and `desired` stays as it was. When it ends with `shouldResume`, the session goes to `.down`, and the plan starts the session and plays. When it ends without `shouldResume`, `desired.wantsSound = false`: the system decided, the person did not. Route loss calls `pause()`.

### Ownership map

| Fact | Single writer | Readers |
| --- | --- | --- |
| Which Set is wanted, sound or quiet, the target position | `AudioPlayer` command methods (`desired`) | `state`, `elapsed`, `currentSetId`, plan |
| Session, item, seek, rate, and position as observed | `AudioPlayer.observe` (`observed`) | plan, `state` |
| Which response may act | `AudioPlayer` ticket (`select`, `reserve`) | `AppModel` (`owns`) |
| The server's queue order | `AppModel.queueRequests` (FIFO chain) | — |
| Warm or cold, retry by re-activation | `AppModel.playSet(_:from:)` | every play surface |
| Playback Position reports | `AppModel` reporter and settle-on-replace | server |

`AppModel.playGeneration` is deleted. The ticket replaces it, so one counter owns the right to change the player. Sign-out calls `audioPlayer.stop()`, which clears `desired` and bumps the ticket.

### Call sites that change

- `Transport.playButton` and `SetDetailScreen.playButton`: replace the `pause()`/`resume()` branch with `player.togglePlayPause()`. A failed item now reloads through `onReloadNeeded`. `start()` for a Set not in the player stays.
- `AppModel.togglePlayback()`: the `.idle, .failed` branch collapses into `audioPlayer.togglePlayPause()`. `.idle` with no Set does nothing.
- `AppModel.play(_:from:)`: deleted. `playCue` and `playFromBeginning` call `playSet(_:from:)`.
- `AppModel.playActiveEntry(of:from:)`: gains `ticket`, uses `attach` with `.saved`.
- Remote commands in `setupCommands` stay as they are. `.play` and `.toggle` go through `resume()`, so they get the reload path too. `changePlaybackPosition` passes `origin: .systemScrub`. Skips pass `.skip`, and next/previous pass `.cueSkip`.
- `PositionReporting.settles`: report as settled on `.paused`, `.idle`, `.failed`, `.interrupted`. Do not report `.loading` as settled, so a seek or buffer wait does not trigger a library publish. This is a one-line change; leave it out if the parent wants zero behavior drift there.
- `QueueScreen` row tap on the active Set: unchanged code. `playSet` now takes the warm path through `canContinue` and sends no request, so the 1–5 s jump back goes away.

### Deliberately not done

No `AVQueuePlayer`, no local queue, no optimistic audio before `PUT queue/active` answers, no buffer, tolerance, codec, or HLS changes, and no change to the server, ADRs, or glossary terms.

### Interface depth

Views keep the same seven transport verbs. AppModel gains `select/attach/abandon/reserve/owns/canContinue/go` and loses `playGeneration`, `play(_:from:)`, and the failed special case. The plan hides the ordering rules (session before play, seek before play, pause wins, newest seek wins, retry at last good position) behind one pure function. Today these rules are spread over `startPlayback`, `applyPendingSeek`, `rateChanged`, `stallChanged`, and `resume`.

## Telemetry

The subsystem `app.orbis` and category `player` stay the same, with the same privacy rules (hashed Set id, no addresses or token).

1. `Command <verb> origin=<SeekOrigin|surface> ticket=<n> → desired=<wants,target,stage>`, one line per command.
2. `Plan <actions>`, at debug level, only when non-empty.
3. `Seek #n to X (<origin>) landed Y|stopped Y in <ms>`.
4. `Time jumped to Y; ours=#n|none` from `AVPlayerItem.timeJumpedNotification`. A jump with `ours=none` is the player's or the stream's, not the app's. This line separates the two causes of a 1–2 s skip.
5. `Clock gap media=+A wall=+W at Y` from the periodic tick, when the control is `.playing`, no seek is in flight, and |A − W| > 0.75 s. It catches a skip that shows no time jump.
6. `Access stalls=n observed=…bps indicated=…bps bytes=… transfer=…s requests=n` from `newAccessLogEntryNotification`. It joins with the node's per-request `range` and `bytes` events by timestamp (`deploy/orbis-server/README.md`).
7. `Waited <reason> for <ms> at Y`, logged when waiting ends, not only when it begins.
8. `Start ticket=n request=<ms> session=<ms> ready=<ms> seek=<ms> audible=<ms>`, timed from `select` to the first `.playing`. `Pause ticket=n audible-off=<ms>`, timed from `pause()` to rate 0. These lines answer "delayed play" and "pause does not work" with numbers.

`PlaybackDiagnostics` holds counters (seeks by origin, unowned jumps, clock gaps, stalls, reloads, superseded responses) and a ring of the last 64 lines. Tests read it and attach it as JSON.

## Test plan

Per CLAUDE.md, the failure modes come first. The plan is pure, so a table test of it is allowed. E2E and lane runs stay the main proof.

### Failure modes (write these before any code)

1. Sound before an initial or held seek lands.
2. An exact target bent by the near-end rule.
3. A `.saved` target in the last 5 s that does not restart.
4. A stale queue response that replaces a newer selection or warm Cue.
5. A Pause during a queue request, session start, or seek that is lost.
6. Play on a failed or broken item from any surface that does nothing or spins.
7. A retry that starts from the server's resume position instead of the last good one.
8. Two `PUT queue/active` requests that reach the server out of order.
9. A plan that re-issues `play` or `seek` on every reconcile (not idempotent).
10. An interruption end that resumes a Set the person paused, or a rate drop that becomes a fake pause.
11. Next queue entry delayed by a library refresh.
12. The replaced Set's final position never reported.
13. A warm re-tap of the active Set that reloads it and jumps back.

### Plan table (`OrbisTests/PlaybackPlanTests.swift`)

One row per mode 1, 2, 3, 5, 9, 10: `(Desired, Observed) → [EngineAction]` and `→ PlaybackState`. Each row runs twice to assert `[]` the second time (mode 9).

### Real HTTP and real AVPlayer (`PlaybackReliabilityTests`, the parent's lane-gated file)

The existing five tests must pass unchanged: modes 1, 2, 5, 6/7, 4. Add these:

- `testAPauseDuringTheQueueRequestIsKept`: `StubProtocol` holds `PUT queue/active` 0.5 s. Call `playSet(b)`, then `pause()`. Assert state `.paused`, rate 0, `currentSetId == b` before and after the response (mode 5).
- `testPlaysReachTheServiceInTheOrderPressed`: `RequestLog` with a hold on the first request. Call `playSet(a)`, then `playSet(b)`. Assert the log order is a then b, and the local Set is b (mode 8).
- `testTheSessionStartsWhileTheQueueRequestRuns`: `SessionGate` start count is 1 before the held response is released.
- `testABrokenStreamResumesFromTheLastGoodPosition`: feed `observe(.broke)` at about 10 s, then `togglePlayPause()`. Assert `PUT queue/active` is sent and the player plays at 10 s or later (modes 6, 7).
- `testRetappingTheActiveSetSendsNoRequest`: assert no request and an unchanged position (mode 13).
- QueueTests: `testFinishingASetStartsTheNextEntry` asserts the next item attaches before `GET /sets` (mode 11). A new test asserts a settled `PUT …/position` for the outgoing Set when another is selected (mode 12).

Each test attaches `diagnostics` JSON (start spans, seeks by origin, superseded count) as its artifact.

### E2E journeys (`node scripts/native-lanes.mjs --journeys`)

- `testAColdCueNearTheEndStartsAtItsTimestamp` (exists, red today) goes green.
- `testPlaysAndSeeksFromTracklistCues` and `testPlaysFromBeginningInsteadOfResuming` pass unchanged. Together they guard the Listen and queue behavior.
- New `testPauseRightAfterPlayStaysPaused`: tap Play, then Pause within one run loop. Wait 3 s and assert the label is Play and the slider value holds. Screenshot plus diagnostics.
- New `testPlaysTwentySecondsWithoutAJump`: play the 30 s fixture for 20 s. Attach diagnostics and assert `unownedJumps == 0 && clockGaps == 0`. This is the loopback baseline for mode "skip".

### Device protocol for the 1–2 s skips (Mac or iPhone, not Vanta)

Run `log stream --level debug --predicate 'subsystem == "app.orbis" AND category == "player"'` during one hour of a long Set over Tailscale, and in parallel run the README `journalctl … funnel-audio` query. Read each skip as follows:

| What the logs show at the skip | Cause |
| --- | --- |
| `Seek … origin=scrub/systemScrub/skip` | Unwanted input from the UI or system. Fix the input path. |
| `Time jumped ours=none` with a new node `range` request | Stream or transport. Investigate before any buffer change. |
| `Clock gap` with a `Waited` line | Buffering. Network capacity. |
| Nothing logged | Decoder or file. Run `ffprobe` on that Set's retained file. |

Record the commit, device, Set id hash, and log excerpts on the issue, as `docs/development.md` requires.

## Tradeoffs accepted

- We accept that a cold Play stops the old Set at the tap, before the server confirms. In return the player has one wanted Set, Pause works during the request, and the screen shows loading at once.
- We accept that a refused cold Play leaves the new Set `.failed` rather than restoring the old one. Restoring it would need a second wanted Set.
- We accept a session activation during the queue request, which can silence another app about 100 ms before our sound starts. In return the session is no longer serial with the request.
- We accept serialized queue requests, which make a burst of plays wait for each other. In return the server's active Set matches the local one. The responses that lose drop at the ticket.
- We accept `.loading` during a seek where `.playing` showed before. The spinner then shows real rebuffering.
- We accept a cold re-activation (a new Listen) when a warm Cue lands while a playlist or another request is pending. In return the server agrees with the local player.

## Alternatives considered

- **Point patches in the current shape.** Add an `explicit` flag to `startAt`, gate `startPlayback` on `pendingSeek`, bump `playGeneration` in the warm path, copy the failed branch into Transport and the Set page, and add a `pendingPlayId` to AppModel. This is the smallest diff, but it adds four flags to a machine that already reads intent from rate drops. The retry rule would live in three places and the pending intent in two owners, and the next fault of the same kind would need a fifth flag. It is the fallback if the parent wants a minimal patch.
- **Keep the old Set playing until the new one is confirmed, plus a separate `pendingRequest`.** This keeps today's audio behavior during the request, but two Sets are then "current" (mini player versus Set page). Pause and Lock Screen commands need a rule to say which Set they act on, and the wanted state has two owners.
- **Optimistic local start before the queue answers.** This is the fastest possible start, but the audio plays before the Listen exists on Vanta (ADR 0001) and uses a resume position the server may correct. Session warm-up gets part of the speed without this.
- **A reducer or state-machine library, or a separate playback actor.** Too heavy for a small-scale app. AVPlayer threading already lands on the main actor.
- **`AVQueuePlayer` for the Listening Queue.** It is a second queue. ADR 0011 rejects it.
- **Buffer or codec tuning (`preferredForwardBufferDuration`, `automaticallyWaitsToMinimizeStalling`, HLS).** No evidence yet. Telemetry lines 4–7 decide whether it is needed.

## Open questions and risks

- Should a cold Play stop the old Set at the tap (proposed), or keep it until the server confirms?
- When a cold Play is refused, should the player go back to the previous Set paused? The proposal says no.
- Is the `PositionReporting.settles` change wanted now, or does it go in a separate change?
- The parent's `testACueOnTheCurrentSetSupersedesADelayedPlayOfAnotherSet` passes under this design for a different reason. `playSet(b)` tears down `a`, so the Cue becomes a cold play of `a` that supersedes `b` by ticket. The stub's `/queue/active` always answers with `b`, so `a` ends up `abandoned`, while `currentSetId == "a"` and `elapsed == 12` still hold. Should the stub answer per request instead, so the test proves the real path?
- Risk: `timeJumpedNotification` also fires for our own seeks. The `ours=#n` match must use the in-flight seek number and its landing time, not wall time.
- Risk: tvOS and macOS session paths differ. macOS `startSession` returns true at once, so the warm-up costs nothing there.
- iOS, macOS, and tvOS checks need the Mac. Nothing here was run.

## Next implementation step

Write the failure-mode list above into `PlaybackPlanTests.swift` as red table rows. Then implement `PlaybackPlan.swift` (types, `actions`, `state`, `elapsed`, `resolve`) before you touch `AudioPlayer`.
