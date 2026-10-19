# Local command ownership candidate

## Problem

The app already has the right two owners. `AppModel` owns activation of a Listen through the Listening Queue, and `AudioPlayer` owns AVFoundation. Keep both owners and their existing generation checks. Add an explicit pending activation to the model and one seek transaction to the player. Do not add a coordinator service or replace the playback state machine.

Code evidence supports several independent faults. These faults do not yet prove the cause of the reported spontaneous audio skips.

- `AppModel.playSet` waits for the queue request before publishing playback intent at `apps/apple/Orbis/AppModel.swift:771`.
- A warm Cue seeks without increasing `playGeneration` at `apps/apple/Orbis/AppModel.swift:818`. A preceding queue response can replace that Cue selection.
- The shared cold-start `startAt` goes through the saved-position end heuristic at `apps/apple/Orbis/AudioPlayer.swift:324`. That heuristic resets any request in the final five seconds at `apps/apple/Orbis/AudioPlayer.swift:634`.
- Session activation calls `AVPlayer.play()` without waiting for the item or the initial seek at `apps/apple/Orbis/AudioPlayer.swift:439`. Initial seeks start independently at `apps/apple/Orbis/AudioPlayer.swift:604`.
- Detail and transport Play buttons call `resume()` directly at `apps/apple/Orbis/SetDetailScreen.swift:135` and `apps/apple/Orbis/Transport.swift:121`. `resume()` ignores a failed item at `apps/apple/Orbis/AudioPlayer.swift:487`.
- The model already retries failed playback at `apps/apple/Orbis/AppModel.swift:1058`. Use that existing policy everywhere.

## Usage

Each control asks the model to act. Views keep reading the player for the timeline, but derive selected Set and Play/Pause state from the model while activation is pending.

```swift
// Set detail and library rows.
Button(model.playbackWantsSound(for: set.id) ? "Pause" : "Play") {
  model.togglePlayback(set.id)
}

// Now Playing's Transport receives one policy-bearing action.
Transport(
  player: model.audioPlayer,
  fallbackDuration: set.durationSeconds.map(TimeInterval.init),
  togglePlayback: { model.togglePlayback(set.id) }
)

// Existing Cue call remains valid. The model invalidates older activation work.
Task { await model.playCue(cue, in: set.id) }

// Cold start chooses its position policy explicitly.
audioPlayer.play(set: playing, baseURL: client.address, token: client.token,
                 start: .position(cue.startSeconds!))
audioPlayer.play(set: playing, baseURL: client.address, token: client.token,
                 start: .resume(playing.resumePosition))
```

Remote Play, Pause, and Toggle must ask the same model policy rather than calling player primitives. Keep remote registration in `AudioPlayer`, where its lifetime is already correct. Inject a small `TransportActions` value during `wirePlayerToQueue()`. Item observations and interruption recovery remain internal player events and do not pass through these user-command actions.

```swift
audioPlayer.transportActions = .init(
  play: { [weak self] in self?.resumePlayback() },
  pause: { [weak self] in self?.pausePlayback() },
  toggle: { [weak self] in self?.togglePlayback() }
)
```

## Shape

The public APIs remain task-oriented. The new data shapes are internal implementation details, except the position policy passed between model and player.

```swift
enum PlaybackStart: Equatable {
  case resume(TimeInterval)
  case position(TimeInterval)
}

@MainActor final class AppModel {
  private struct PendingActivation {
    let generation: Int
    let setID: String
    let start: PlaybackStart
    var wantsSound: Bool
  }

  private var pendingActivation: PendingActivation?
  private var playGeneration: Int

  func togglePlayback(_ id: String) { fatalError("not implemented") }
  func togglePlayback() { fatalError("not implemented") }
  func resumePlayback() { fatalError("not implemented") }
  func pausePlayback() { fatalError("not implemented") }
  func playbackWantsSound(for id: String) -> Bool { fatalError("not implemented") }
  func playbackIsSelected(_ id: String) -> Bool { fatalError("not implemented") }

  func playSet(_ id: String, start: PlaybackStart? = nil) async {
    fatalError("not implemented")
  }
  func playCue(_ cue: Cue, in id: String) async { fatalError("not implemented") }
  func playFromBeginning(_ id: String) async { fatalError("not implemented") }
}

@MainActor final class AudioPlayer {
  struct TransportActions {
    var play: () -> Void
    var pause: () -> Void
    var toggle: () -> Void
  }
  var transportActions: TransportActions?

  private enum SeekState {
    case none
    case waiting(target: TimeInterval)
    case moving(id: Int, target: TimeInterval)
  }

  private var seekState: SeekState = .none
  private var sessionReady = false

  func play(set: SavedSet, baseURL: URL, token: String,
            start: PlaybackStart = .position(0), wantsSound: Bool = true) {
    fatalError("not implemented")
  }
  private func playIfReady() { fatalError("not implemented") }
  private func move(to target: TimeInterval) { fatalError("not implemented") }
}
```

`wantsSound` on a pending activation belongs to a request that has no player yet. Once the response installs an item, clear the pending value and transfer that one intent into the player's existing `.loading` or `.paused` state. There must be no retained second copy for an installed item. This distinction applies Model the Domain without replacing the whole state machine.

`AudioPlayer.play` accepts the initial sound intent to prevent the model from installing a playing item and pausing it afterward. A paused cold request must never briefly play. Use a small initial-intent enum instead of the Boolean if it reads better in implementation.

The start policy is explicit. `.resume` applies `startPosition`, and `.position` only validates finite input and bounds it to the available duration. This removes the policy mistake at the point that caused it, per Fix Root Causes. `playActiveEntry` uses `.resume`; Cue selection and Play from Beginning use `.position`. Reject nonfinite seek input before creating `CMTime`.

## Command and async outcome contracts

1. A cold Set selection increments `playGeneration`, stores `PendingActivation`, and makes the selected control show Pause before awaiting HTTP. The old player's sound pauses immediately while the activation is pending. Its item can remain loaded so a newer warm Cue for that Set can reuse it.
2. Pause during that request sets `pendingActivation.wantsSound = false` and pauses the loaded player. The request can still complete and update the authoritative Listening Queue. Installation creates a paused item.
3. Play during the same request sets `wantsSound = true` without issuing a second activation request. Toggle flips that value.
4. A newer cold Set selection replaces the pending request with a new generation. Both success and failure handling must check the generation before writing queue, failure, or player state. The current error handlers at `AppModel.swift:788` also need that check.
5. A warm Cue or Play from Beginning increments `playGeneration` and clears the pending activation before seeking. It uses the retained item and keeps the same Listen. This invalidates an older response even when the new action needed no network request.
6. If the remote user seeks or skips while a different Set is pending, the new timeline command must invalidate that pending activation too. Either route these user commands through model methods or add an `onTimelineCommand` callback to invalidate pending work before the player changes position. Do not add callback notifications to internal pending-seek application. Prefer routing all remote user commands through the model if this hook starts to spread.
7. A failed item Play goes through `resumePlayback`, which invokes a new activation with an explicit current position. An audio-session failure with a still-playable item can use the existing `resume()` path. Do not reset a failed stream's last known position to the server's older saved position.
8. Signing out clears pending activation and increases the existing generation before stopping the player.

This candidate preserves direct player timeline controls initially. A timeline command invalidates pending activation through one player callback. This adds one policy-bearing boundary rather than rewriting every scrubber and skip control. If callback routing proves hard to follow, use a model command enum as a separate candidate rather than adding more callbacks one by one.

## Seek barrier

The player may start sound only when the current session activation succeeded, the current item is ready, the newest seek has settled successfully, and the existing state still wants sound.

`startPlayback()` keeps its existing serial audio-session work. Clear `sessionReady` for each new start and set it only for the current successful activation. Then call `playIfReady()` instead of `player.play()`. Item readiness and successful newest-seek completion call the same method. `stop()` clears `sessionReady` and the seek transaction. This readiness value records a framework fact, not a second sound intent.

On each seek, publish the target immediately and transition the seek transaction to waiting or moving. If sound was wanted, change `.playing` to `.loading` before pausing the raw player so a queued rate drop cannot mark the deliberate seek pause as an interruption. A paused Set remains paused throughout the seek. Complete only the current transaction under the current `playbackGeneration`. A callback for an older seek is an observed cancellation, not failure of the newest seek.

A newest seek that completes with `finished == false` must not quietly release the initial barrier and start from the old location. Record it and show a retryable failure. A narrow retry can be added only after evidence establishes a transient failure that it resolves. No automatic item recreation on ordinary buffering.

## Module map and interface depth

- `AppModel.swift` owns pending activation, latest-user-command precedence, queue mutation, and failed-item retry policy. Existing public methods remain available for other callers.
- `AudioPlayer.swift` owns the position policy application, session/item/seek start barrier, AVFoundation observations, and telemetry. Its transport action adapter moves no AVFoundation details into the model.
- `Transport.swift` consumes a policy-bearing toggle callback instead of choosing retry versus resume. Scrubber target validation remains in the player.
- `SetDetailScreen.swift` uses the same toggle and derived pending state instead of repeating its own current-item state switch.
- Other Transport callers supply the model callback. Existing model callers retain their task-oriented methods.

The small model methods hide pending request precedence and retry policy. The player hides the order in which framework readiness arrives. Callers no longer need to choose a separate recovery path for failed audio. This is the main interface-depth gain. Laziness Protocol keeps the existing model/player split and generation mechanism.

## Telemetry

Extend the existing `app.orbis/player` log. Do not infer an audio skip from `elapsed`, because that value also displays an optimistic seek target at `AudioPlayer.swift:522`. Observe raw `AVPlayer.currentTime()` samples together with monotonic wall time and player rate. Keep sampling local and emit only anomalies or state changes.

Each item has the existing playback generation. Each seek has a sequence number. Record generation, seek ID, requested position, raw pre-seek position, raw final position, `finished`, elapsed monotonic time, and whether a newer command superseded it. Classify explicit seeks separately from unexplained timeline changes. Log item-ready, session-ready, first real playback, buffering start/end, loaded range covering the playhead, `isPlaybackBufferEmpty`, `isPlaybackLikelyToKeepUp`, `timeControlStatus`, and `reasonForWaitingToPlay` with raw position.

Detect discontinuities by comparing raw media delta with elapsed monotonic time times rate only across samples with the same generation, no seek transaction, no interruption, and continuous `.playing` time-control state. Reset the baseline on an explicit seek or state transition. A large scheduler gap invalidates the sample rather than proving a skip. Emit previous/current raw times and monotonic delta when a jump exceeds a conservative threshold. The threshold is an anomaly detector, not proof of audible lost content.

Add `AVPlayerItem.timeJumpedNotification` and access-log summaries as supporting evidence. Buffering stalls keep media time still while wall time advances. Timeline jumps move media time unexpectedly. Seek records explain intentional jumps and exact landing errors. Keep URLs, tokens, titles, and response bodies out of these records.

Do not tune `preferredForwardBufferDuration`, disable automatic waiting, loosen seek tolerances, or force constant-rate file conversion based on the current symptom report. Those changes need a measured failing stream. The current code already explains control failures, but not arbitrary audible skips.

## Failure scenarios and verification

Write the journey changes before implementation. Existing Cue coverage at `apps/apple/OrbisUITests/PlaybackUITests.swift:149` allows a wide 10-to-20-second window and checks displayed position. Preserve that journey but add retained player/log artifacts that establish the actual landing and subsequent progression.

- Select a cold Cue inside the final five seconds of the fixture. It must start there rather than at zero, and must not finish before reaching that Cue.
- Hold the queue HTTP response. Tap Play, Pause, Play. There is one activation request. The control responds before HTTP returns, and final sound intent wins.
- Hold a cold B activation while A remains loaded. Tap a Cue in A, then release B. A remains selected at that Cue. B's success and failure cannot overwrite the current UI state.
- Start at a nonzero Cue while audio delivery is slow. Record readiness, seek completion, and first playback. The first actual playback event follows the final successful seek.
- Pause during initial seek. Completion must not start sound. Resume after completion must start at the requested Cue.
- Select several Cues rapidly. Only the final seek controls the display and first resumed playback. Older completion callbacks cannot release the barrier.
- Force a stream item failure, then use detail Play and Now Playing Play. Both issue recovery and resume near the last known raw position. Remote Play follows the same policy.
- Throttle audio long enough to enter buffering. Verify that media time remains still during the wait and later advances continuously. Retain buffering and raw timeline logs.
- Sign out while activation, session activation, or seek is pending. No late result restores identity, sound, or queue state.

The existing `QueueTests.swift:74` proves activation request shape but not races or real playback. Prefer HTTP-driven server fixtures and native UI journeys for these cases. Use player-isolated tests only for deterministic session/seek ordering that cannot be controlled by a real fixture, and enumerate their failure cases before implementing. Linux cannot validate AVFoundation playback or an iOS build. A native lane on the configured Mac remains required under Prove It Works.

## Tradeoffs accepted

- We accept a short model-only pending state in exchange for immediate controls without claiming the queue request succeeded.
- We accept retaining a paused old player during queue activation in exchange for warm Cue cancellation without a new Listen.
- We accept a transport callback adapter in exchange for one retry/pause policy across UI and remote controls. Keep the callback set fixed and small.
- We accept waiting for exact seeks in exchange for never briefly playing the old location after a Cue selection.
- We accept observable failures for the newest failed seek in exchange for avoiding silent playback from the wrong location.

## Alternatives considered

A new `PlaybackCoordinator` actor would collect all commands, queue HTTP, and AVFoundation state. It hides much of the async protocol but adds an owner between two existing owners and changes many call paths. It loses on change size and duplicates model lifetime management.

An `AudioPlayer.prepare(setID:)` stage could own immediate pending intent before queue HTTP returns. It makes remote controls simple but exposes an installation protocol to the model, splits selection metadata from playback installation, and risks resetting an active Listen's item before a warm Cue can reuse it. The pending request naturally belongs with queue activation instead.

Only adding guards to `startPlayback()` and each view leaves pending HTTP selection outside transport intent. It fixes individual cases but retains multiple choices for failed-item Play and stale request ownership.

## Synthesis decision

The parent architect chooses the base. This candidate proposes local model request state and a player readiness barrier. No implementation exists in this artifact.

## Implementation reconciliation

No implementation deviations yet. A change that moves pending selection into `AudioPlayer`, adds a coordinator, or adds independent persistent sound intent requires a revised contract before work proceeds.

## Open questions and risks

Can the fixture hold queue activation and audio delivery independently without changing production request behavior? The implementation should inspect the native fixture controls before selecting the test lane.

Does the currently deployed audio format show raw AVPlayer timeline jumps under throttled playback? The reported skips remain unproven until a native run or captured device logs answer this.

Does a failed stream retry need to preserve the current Listen rather than issue the existing queue activation action? Inspect the HTTP semantics before claiming recovery preserves Listen counts.

## Next implementation step

Extend the native fixture and journey to expose a cold Cue inside the final five seconds, then demonstrate that the current app starts at zero before changing the position policy.
