# Playback design verdict

## Recommendation

Use `design-local` as the base for ownership and scope. Graft the explicit start-position policy, shared retry entry point, and bounded jump diagnostics from `design-intent`. Keep the current `AudioPlayer` state model and public `play`, `seek`, `pause`, and `resume` APIs. Do not introduce `PlaybackPlan`, `Desired`/`Observed`, or rewrite every observation handler in this change.

The supported failures are specific: cold exact cues near the end are mapped through the saved-resume rule; audio can begin before an initial seek settles; a warm Cue does not invalidate an in-flight `playSet`; pause/play intent is absent until HTTP returns; and some surfaces cannot recover a failed item. The 1–2 second spontaneous jumps remain unexplained. Fix the confirmed ordering faults and add evidence for the unexplained jumps. Do not tune buffering or codecs yet.

## Scores

Scores use 1–5, where 5 is strongest. Criteria are queue and Listen semantics plus existing test API compatibility; narrowness against confirmed faults; unified retry and pending-command ownership; latest command precedence across HTTP, session, and seek; useful private diagnostics; and a maintainable interface with little added machinery.

| Candidate | Queue/API | Scope | Ownership | Latest wins | Diagnostics | Interface | Total |
| --- | --: | --: | --: | --: | --: | --: | --: |
| `design-local` | 4 | 5 | 3 | 3 | 4 | 4 | 23/30 |
| `design-intent` | 4 | 2 | 5 | 5 | 5 | 3 | 24/30 |

The totals are close, but `design-local` is the better base because this change should not replace the entire player state machine to fix a few confirmed races. `design-intent` gives the stronger concurrency model and telemetry. Graft the specific contracts below, not its full reducer architecture.

## Minimal implementation contract

1. `AppModel` owns an activation generation and one pending activation record: Set id, requested start policy, and wanted sound. Set it before awaiting `PUT /queue/active`. Check the generation on both success and failure before changing the visible queue, player, or error state. Pause and Play during the request update that pending sound intent; they do not start another activation request. On attach, transfer intent once into the player.
2. Serialize mutations of the Listening Queue through one FIFO request chain. A local generation alone cannot order server writes: an older request can commit after a newer one even if its response is ignored. Keep the generation as the local response-ownership check; these mechanisms solve different races. Do not serialize unrelated reads.
3. Every later user command that supersedes a pending activation invalidates its response. For a warm Cue on the retained Set, keep the current Listen and seek locally. If an already-sent queue request can change the server's active Set, enqueue one activation of the now-current Set after it settles. The server's `play` operation leaves queue order intact and records no new Listen when that Set is already active. If the pending request changed the active Set first, restoring the user's latest Set is a real subsequent activation. Do not silently discard the stale response and leave server and device state divergent.
4. Distinguish saved resume from exact position at the player boundary. Apply the near-end restart rule only to saved resume positions. Clamp exact Cue, From Beginning, scrub, and retry positions to finite `0...duration` values when duration is known. Preserve the existing `play(set:baseURL:token:startAt:)` entry point as an exact-position compatibility wrapper for the current native tests; route production saved starts through an explicitly named resume path.
5. Start sound only after the current session is ready, the item is ready when a nonzero/explicit seek is pending, and the newest seek completes successfully. A newer seek owns the completion; an older completion cannot clear the barrier. Pause changes wanted sound immediately and remains effective when session or seek callbacks arrive. Reuse the existing session queue and generation guards.
6. Route Play/Toggle from detail, Transport, Lock Screen, and CarPlay through one model retry policy. Keep direct Pause and seek behavior where it does not cross a pending activation; user timeline commands during an activation must invalidate or supersede that activation through one narrow callback or model command path. Retry failed/broken audio from the latest raw position, not the older server resume position. Do not duplicate retry branches in views.
7. Extend the existing private `app.orbis/player` logs only enough to distinguish user actions from unexplained movement: log command origin and generation, seek target and actual landing, `timeJumpedNotification` matched to the in-flight seek or `none`, and raw media-time versus monotonic-time gaps only while continuously playing with no seek/interruption. Log first audible start and pause completion timing. Keep Set ids hashed and omit URLs, tokens, titles, and response bodies. Treat a time jump as evidence, not proof of audible loss.
8. Keep queue advance immediate: attach the next entry before refreshing the library. Preserve settled Playback Position reporting when replacing a Set. These are small existing queue/reporting behavior fixes that fit this work, but avoid changing when `.loading` counts as settled without a concrete failing journey.

## Candidate risks

`design-local` does not serialize queue writes and its warm-Cue cancellation can leave the server active on the superseded Set. Its suggested `onTimelineCommand` is a useful containment point only if it also causes the required queue reassert; invalidating a generation alone is insufficient. Its pending control state must not become a second persistent copy of sound intent after the item attaches.

`design-intent`'s `PlaybackPlan` expands the change across every observation, state derivation, screen reader, and test seam. Several action rules are underspecified for cancellation: a failed seek must not release the play barrier, a session failure should not be reset by observations alone, and interruption-end behavior must preserve a deliberate pause. Its proposed queue reassert on warm Cue is necessary when an older activation has reached the server, but should happen only after the older FIFO mutation settles. The compatibility `play(startAt:)` wrapper must have explicit semantics; treating it as exact is safe for current tests, while production resume must use `.saved`.

Both candidates propose broad diagnostic counters and test-only diagnostic rings. Start with structured private logs and retained native journey attachments. Add counters only if the lane cannot reliably assert the behavior from logs. The fixture's HTTP response must match each request's Set; an always-return-B stub can make a stale-response test pass for the wrong reason.

## Architecture HOW

`AppModel` is the native app's playback coordinator at the product level. It activates Sets and Playlists through the Listening Queue, owns the current queue data, attaches the returned active Set to the player, starts and stops Playback Position reporting, and handles queue completion. Its generation guards prevent stale HTTP responses from taking over locally.

`AudioPlayer` owns one `AVPlayer` and its AVFoundation lifecycle. It creates the Retained Audio request, observes item readiness, duration, rate, waiting, seek completion, end and failure, manages the audio session, and registers Lock Screen commands. Its `state` and `elapsed` values feed Now Playing and the shared Transport. The current gap is that `state` mixes user intent with engine observations, and several views choose their own recovery policy.

`Transport` is shared by Set detail and Now Playing. It reads the player timeline and sends play, pause, seek, and skip commands. `SetDetailScreen` also offers cold Set play, From Beginning, and Cue selection through `AppModel`. Keep queue activation in the model and AVFoundation work in the player; route policy-bearing toggles through one model-owned action.

The server's `queue.ts` owns the authoritative Listening Queue. A Set activation makes that Set active while preserving the queue behind it; activating the already-active Set changes no Listen count. Playlist activation replaces the queue. Natural completion removes the finished Set, records its Finish, and activates the next Set. The phone's local generation cannot order these server mutations, so the native client needs FIFO writes plus local stale-response checks.

`PositionReporting` syncs the current playback position back to the service. It follows the active Set and must settle the outgoing Set before a replacement cancels its reporter. The development guide maps native work to `apps/apple/Orbis`, the queue service to `apps/server/src/queue.ts`, and native verification to the Mac simulator lane; Linux cannot verify AVFoundation behavior.

## Verification boundary

This is a read-only design verdict. No production files were changed and no tests were run. The parent supplied the native baseline results: the requested start at 12 first played at 0; delayed B replaced a newer Cue A; and the HTTP fixture's suffix parsing was invalid and has been fixed. Those results confirm the seek, response ownership, and fixture findings above. Spontaneous jumps during steady playback still need native logs before changing stream buffering or encoding.
