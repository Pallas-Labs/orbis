# Playback report design

User request: add logging to diagnose ordinary streaming jumps, repeats and unreliable Play, Pause and Cue actions. Base `02dc037` already has detailed unified debug logs, but no report available from the affected iPhone.

## Grounding

The independent how pass traced `AudioPlayer.swift` and `AppModel.swift`. AudioPlayer owns the real player, session serialization, item generation, latest seek and half-second timeline observer. It logs commands, waits, loaded ranges, numeric access counters and media-time versus monotonic-time discontinuities. AppModel owns pending activation, queue writes and the generation that rejects old HTTP responses. Its intent changes are currently absent from the logs. Existing failure-copy UI carries no playback history. Raw SDK error descriptions/comments in public unified logs are another privacy gap.

The existing real-player and HTTP tests in `PlaybackReliabilityTests.swift` and `StreamingPlaybackTests.swift` provide the verification lane. Native UI journeys use `LibraryJourney` and export screenshots and JSON attachments. Source review does not prove physical audible continuity.

## Candidates

Two independent architect candidates converged on bounded typed app memory rather than parsing OSLogStore. Candidate A proposed an AppModel-owned injected recorder, per-command IDs and detailed origin threading. Candidate B proposed an AudioPlayer-owned recorder shared through one recording method, with fixed events and a small Settings copy action.

Both compared unified-log-only export. That avoids a second store but relies on OS retention and debug settings and needs a separate query/format path. Apple documents debug logs as normally not persisted. Source: https://developer.apple.com/documentation/os/generating-log-messages-from-your-code.

## Rubric

Score each candidate from zero to two for useful iPhone collection, schema-enforced privacy, causal timeline/activation context, bounded playback overhead and a small interface. Reject raw SDK strings, waveform-continuity claims, new transport logic, timer polling, telemetry upload and inferred distinctions between Lock Screen, Control Center and headset events.

## Proposed contract

The intended user action is Settings, then Copy Playback Report after an incident. Generate the report at tap time and show Copied afterward. State that it contains recent activity from this app run and resets when the app closes. Do not claim a fixed time window. No settings toggle, disk writer, server upload or OS-log scraping is needed.

One main-actor recorder holds at most 256 typed entries. Fixed enums, booleans and finite numbers are the only playback payloads. No title, Set ID, token, address, raw error comment or failure message enters this store. Report metadata is restricted to app version/build and OS version. Each entry has a sequence, wall time and monotonic uptime. Item generation, model activation generation and seek number correlate the two existing owners. No new command-ownership state is needed.

Keep AudioPlayer as the recorder owner. Its snapshot contains normalized state and waiting reason, actual media time, displayed time, rate, session readiness, held/in-flight seek, up to eight finite buffer ranges and numeric access counters. Reuse its existing observer rather than adding a timer. Record periodic snapshots at most every five seconds, including while waiting, so history is not flooded by range KVO. Always retain commands, state transitions, seeks, stalls, discontinuities and activation outcomes subject to the explicit ring cap. A copied report includes an up-to-date snapshot and states how many old records were evicted. Rendering must be bounded to 256 KiB and preserve chronological order of the retained newest entries.

AppModel submits typed activation begin, pending-intent change, accepted, superseded and failed outcomes using its existing generation, desired sound, optional target and monotonic latency. Player entry points distinguish app versus system remote commands only where actually known. Existing playback signatures may use a default app origin; no UI-wide origin plumbing is required. Capture session/interruption/route/reset and item-end/error numeric facts at existing callbacks. Use a fixed mapping of SDK waiting and error-domain values.

Keep unified logs for attached live diagnosis. Remove public raw error descriptions/comments in favor of known error domains and numeric codes. Do not promote all high-volume debug events to disk-persisted notice logs.

## Throughput checkpoint

- Blocking first steps. Finish grounding, two candidate designs and an independent cross-judge before code. Write failure cases and verification probes before implementation.
- Independent workstreams. One isolated implementation checkout owns recorder, hooks, Settings action and tests. Parent owns Mac execution and evidence after the delegate stops.
- Shared mutable state. A single AudioPlayer/main-actor recorder owns runtime history. Each writing agent gets its own Git worktree; no concurrent builds share a result bundle.
- Smallest safe decomposition. Use one code owner because the typed schema, capture sites and report UI must agree. Keep production, tests and native evidence as one verifiable unit rather than adding a telemetry service.

## Acceptance

Real HTTP/AVPlayer probes must export a valid, useful report after playback advances, Pause and Seek, and while data is starved. Verify pending-activation intent/outcomes, ring eviction and finite-number encoding. Seed private title, token, address and Set ID and verify absence. A new Settings UI journey must observe the copy action and retain a screenshot; do not claim clipboard contents from its label alone. Native tests must inspect the actual report payload. Preserve JSON, logs, xcresult, exact source hashes and app binary digest. No physical device acceptance or audible-skip fix is implied.

## Accepted sketch and independent verdict

The independent GPT-6-Luna cross-judge preferred B over A on the five rubric dimensions, with scores 9/10 and 8/10. It approved the synthesis after requiring distinct next-Cue and previous-Cue command events. Preserve that intent before those commands delegate to seek. System remote is the most specific reliable origin; do not label it as a particular physical remote surface.

The caller asks `audioPlayer.playbackReport()` at the Settings button's action. AppModel calls `audioPlayer.recordActivation(phase, generation: ..., wantsSound: ..., target: ..., latency: ...)` at existing state transitions. AudioPlayer's private `record(event)` captures its own snapshot and submits one typed value to `PlaybackDiagnostics`. The recorder owns its capped sequence and JSON rendering; consumers do not coordinate eviction or encoding.

The new file holds `PlaybackDiagnostics`, a fixed `Event` enum, `Snapshot`, `Entry` and scalar payload records for activation, seek, timeline, buffer, access and normalized errors. `Snapshot` has no AVFoundation objects or arbitrary strings. `record` stamps wall time and uptime once. `report(current:)` includes the current snapshot and evicted count, keeps newest events in chronological order, and enforces the final UTF-8 byte cap. Use a simple bounded array rather than a generic telemetry framework.

No runtime verification result is claimed yet. The code-writing owner must write failure cases and tests before implementation and leave execution to the parent on the Mac. One candidate's suggestion to skip running tests misread the repository rule and was rejected. The rule forbids writing tests after code, not executing them.
