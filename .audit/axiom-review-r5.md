# Axiom follow-up review, round 5 (independent, read-only)

Claude Opus 5.5. This round 5 report was written after the trail had already recorded round 5 as failed (`axiom-review-attempts.md`) and closed on round 7. It does not replace round 7. It adds one evidence finding that round 7 missed.

Scope: the 24 production lines in `AudioPlayer.observeInterruptions` (`AudioPlayer.swift:1202-1225`) and the 52 test lines in `PlaybackReliabilityTests.swift:152-202`, on base `a018f19`. I read `axiom-playback-networking.md`, `axiom-reset-failures.md`, `axiom-review-attempts.md`, `axiom-review-r7.md`, `axiom-review-responses.md`, the new `playback.tsv` rows, the full `AudioPlayer.swift`, the `AppModel.swift` hooks, playback and position reporting code (`:760-830`, `:856-971`, `:1190-1235`), `PositionReporting.swift`, and the Axiom 27.3.0 media skill (`avfoundation-ref.md`, `now-playing.md`). I ran no build, test or SSH command, changed no source and started no child agents.

Working-tree hashes match `axiom-source-manifest.sha256` and `axiom-reset-after/source-manifest.sha256` (`AudioPlayer.swift 340e64ed…`, `PlaybackReliabilityTests.swift fd7d3b20…`).

## Verdict

**Source: no high or medium objection.** The reset handler's order is correct. The reset finds no source defect. It does reveal a gap between the evidence and a core claim (finding 1), plus one low source item (finding 2).

**Evidence: one medium gap.** Both probes reset at the start position, so they do not prove that the player keeps the position it had reached when the reset arrived.

**Acceptance: still open.** A real media-daemon reset, Lock Screen and AirPods commands after a reset, and Wi-Fi/cellular handover are untested. The original audible 1–2 s jumps and repeats remain unexplained.

## Findings, most severe first

### 1. Medium (evidence vs claim). The probes cannot detect a lost reset position

- **Observation.** Both retained artifacts record the start position, not a reached position: `axiom-reset-after/shots/media-services-reset-playing.json` and `…-paused.json` both contain `"positionBeforeReset": 12, "resumedPosition": 12`. The test starts at 12 s (`PlaybackReliabilityTests.swift:169`). In the playing probe, the reset arrives 8 ms after the first sound (`axiom-reset-after/console.log`: `First playing … actual=12.000000` at 13:33:32.894, `Media services reset` at 13:33:32.902). The paused probe pauses at the first sound and then resets.
- **Why it matters.** `play()` already sets `elapsed = start` (`AudioPlayer.swift:349-350`). Suppose a change deleted `capturePosition()` from the handler, or reloaded from the original start position. Both probes would still pass. The probes prove the Set is retained, the player is quiet, the player is replaced and the stream advances again. They do not prove that `capturePosition()` keeps the position playback had reached. That is requirement 1 in `axiom-reset-failures.md`, and a wrong position on resume is the same kind of fault the user reported.
- **Claims that overstate it.** `axiom-playback-networking.md` says the probes "verify … retained position". Round 7 says the probes "cover requirements 1, 2 and 5 (… position retained …)". `playback.tsv` row `axiom-verified` says the adapters "now preserve position".
- **Source reading.** The handler is correct on this point. `capturePosition()` runs before `pause()` and before `player = nil`. While a seek is pending or in flight, `settledPosition` is nil, but `seek(to:)` and `applyPendingSeek()` have already written the target to `elapsed` (`:600`, `:745`).
- **Smallest closure.** Narrow the three claims to "Set retained; position path by source review". Or, before posting the reset, wait until `currentTime()` is at least `start + 1`. Then assert that the resumed position matches that reached position and differs from 12.

### 2. Low. A reset never reports its settled position

- **Path.** The handler sets `player = nil` (`:1218`). `settledPosition` then returns nil (`:78-83`). The position reporter skips each tick while it is nil (`AppModel.swift:1205-1206`), so it never sends the `.failed` settled report. The server keeps the last report made during playback, which can be up to 5 s old (`PositionReporting.interval`). The Library row is not republished.
- **Effect.** If the person never presses Play again on this device, the other device and the row or detail Play (`AppModel.swift:919-924`) resume up to about 5 s before the reset point. The listener hears up to 5 s again. Round 7 #4 called this pre-existing because the item-failure path also goes through `playSet`. That path keeps the player, so the reporter can still read and settle a position. The loss of the settled report comes from this change.
- **Smallest closure, if wanted.** Report `elapsed` while the player is gone and a Set is loaded, or send one settled report from the handler. Otherwise, add "the reset position is not reported" to the round 7 #4 limit.

### 3. Info. A Play queued one main-actor hop before the reset can sound afterwards

`onReloadNeeded` starts a `Task` (`AppModel.swift:774-781`). If a reset arrives after a failed-state Play queues that task, but before `playSet` creates `pendingActivation`, the reset's `pause()` finds no pending activation (`:783`). The task then plays with sound. A Play pressed during the HTTP request is cancelled by the reset instead (`:788-790`). The two cases differ, but both start from a user's Play, and the window is a single hop. No change is needed. Record it only if the policy wording "until another explicit user action" must be exact.

## Checked and found correct

- **Order.** `capturePosition` → `pause` → generation bump. `pause()` runs synchronously. A rate KVO that `player.pause()` fires only queues a `Task`, which runs after the bump and is dropped (`:399-405`). `onCommand(.pause)` always returns `false` (`AppModel.swift:788-790`), so `pausePlayback()` always quiets the old player and clears `soundRequestedAt`.
- **Pending HTTP activation.** `pendingActivation.wantsSound = false`, so the later `play(…, autoplay: false)` installs a quiet player. A second reset during the reload HTTP request also cancels that Play's sound. This matches Apple's policy.
- **Session, seek, KVO and artwork callbacks.** The generation guards drop all of them (`:466`, `:774`, `:373-421`, `:513`). The seek completion also fails `let player = self.player`. The session chain stays serialized: the reload's `stop()` queues `endSession` behind any pre-reset activation, and `startSession()` sets the category again (`:292`).
- **No automatic recovery.** `.failed` is not `wantsSound`. Interruption `.began` is gated by `wantsSound` and `.ended` by `state == .interrupted` (`:1240`, `:1247`). A route change only calls `pause()`. Remote Play and toggle reach `onReloadNeeded` with `elapsed` (`:553-555`). `playSet` treats `.failed` as not in the player (`AppModel.swift:875-883`).
- **Repeated resets and other states.** A second reset finds `player == nil`, so `capturePosition()` does nothing and `pausePlayback()` leaves `.failed` unchanged. The handler is idempotent. A reset while `.interrupted` becomes `.paused` and then `.failed`, so a later `.shouldResume` does not play. `.idle` cannot be reached while the observer is registered, because `stop()` removes it (`:669-673`).
- **Observer lifetime.** `isObservingInterruptions` registers one reset observer per play cycle. `stop()` and `deinit` remove it. It holds `[weak self]`. Registering with `queue: .main` and calling `assumeIsolated` matches the existing observers, and the probe posts from a `@concurrent nonisolated` function. The shared comment at `:1160-1162` still describes the new block accurately.
- **Comments.** The delta adds no comments in the production or test code.
- **Networking.** Nothing in this delta touches URLSession. The old `AVURLAsset` connection is released along with the player. I agree that no networking rewrite is warranted.

## Evidence vs claims

| Claim | Evidence | Status |
| --- | --- | --- |
| Both probes failed before the handler | `axiom-reset-before/console.log:274,288` (`:178` failures) | Holds. The before source is not hash-pinned, as the trail states. |
| 127 native tests passed on the reviewed source | `axiom-reset-after/console.log:820`; hashes match the working tree | Holds. My brief said the suite was still running. The retained run has since finished and passed. |
| Old engine is quiet; replaced only after Play; recovered stream advances | Probe asserts and JSON `replacedPlayer: true` | Holds for a posted notification |
| Position preserved across the reset | JSON shows 12 → 12 at the start position | **Not shown** (finding 1). Supported by source reading only. |
| Pending activation, in-flight seek and session reset races | No probe | Source review only, as the trail states |
| Reset policy comes from Axiom guidance | Axiom 27.3.0 has no `mediaServicesWereResetNotification` text anywhere | **Overstated**. Apple's documentation is the only source of the policy. |
| No shared OS daemon reset | Test posts the notification itself | Holds |

## Attention flags for the trail

- **Round 5 status.** `axiom-review-attempts.md` and the `review-fallback` row in `playback.tsv` say round 5 produced no findings. This file now exists, and it postdates the `axiom-review-closed` row. Append a row that records it and its finding 1. Do not rewrite the earlier rows.
- **Attribution.** `axiom-reset-failures.md` ("Axiom media, networking and concurrency guidance plus Apple's … documentation establish the expected policy") and the `playback.tsv` `axiom-reset` row ("Axiom media guidance and Apple reset policy require …") credit Axiom with the reset policy. A search of every Axiom 27.3.0 file finds no reset guidance. The policy comes only from Apple's documentation. Axiom's own contributions are the concurrency and isolation patterns and the networking scan.
- **Position claims.** Narrow the three "preserves position" claims listed under finding 1, or add a probe that resets after playback has advanced.
- **Round 7 #4.** Its "pre-existing" label does not cover the lost settled report (finding 2).
- **Unchanged limits.** The two accepted round 4 low limits, round 7 #1–#5, the iOS 27 interruption migration follow-up and all physical-device acceptance remain open. This round does not address them.
