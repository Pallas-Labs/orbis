# Axiom playback and networking review

Follow-up to PR #278 after the explicit request to use Axiom for Apple player and networking work. Reviewed source starts at `a018f19`.

Applied Axiom 27.3.0 media, networking, networking auditor, concurrency, isolation-inheritance diagnostics and Now Playing guidance. Relevant reference files are `avfoundation-ref.md`, `now-playing.md`, `networking-discipline.md`, `networking-diag.md` and `assume-isolated.md`. API details were checked in the installed iOS 27 SDK and Apple's documentation.

## Networking architecture map

- `OrbisClient` uses async URLSession for authenticated HTTPS API requests. The only accepted cleartext addresses are loopback fixture addresses.
- `orbisAPI` waits for connectivity and has a 60-second resource deadline; each ordinary request has a 15-second inactivity deadline. Cancellation maps to a separate cancelled outcome.
- A separate URLSession carries the Presence event stream with a 60-second heartbeat deadline. It is not the audio transport.
- AVURLAsset and AVPlayer own the progressive HTTP audio stream, buffering and network connection. URLSession fetches artwork separately.
- No app-owned TCP/UDP socket, reachability preflight, manual DNS resolution or custom HTTP stack was found.
- Existing generation checks reject stale HTTP, item, seek and session callbacks. Native tests cover byte starvation and restored data. Physical network handovers remain unverified.

## Pattern scan and networking health

Ran the networking auditor's individual framework, deprecated API, reachability, protocol, socket and handler searches across production Swift/ObjC/header files. All matches were read in context. `send(` names the app's async HTTP method, not a socket call. The only IPv4 literal is the loopback validation allowlist.

| Check | Result |
| --- | --- |
| Deprecated networking APIs | None found among the listed patterns |
| Reachability-before-request | None found |
| Blocking sockets/manual DNS | None found |
| Hardcoded non-loopback connection IP | None found |
| TLS policy | HTTPS required for non-loopback client addresses |
| Custom connection cleanup/waiting handlers | Not applicable; URLSession and AVFoundation own connections |
| Framework selection | Appropriate for HTTP; no Network.framework rewrite needed |
| Physical Wi-Fi/cellular transition coverage | Not measured; remains open |

This is a source review, not a percentage score for connection handovers or a new physical-network acceptance result. No networking rewrite, custom reachability gate or speculative buffer setting is warranted by these observations.

## Player and concurrency checks

The session uses non-mixable `.playback`, with the audio background mode present. Activation precedes sound, deactivation follows stopping, and session work is serialized. iOS 27 uses asynchronous activation/deactivation; the older blocking APIs run in a `@concurrent` helper. This matches Axiom's isolation guidance.

KVO callbacks hop to MainActor and re-read current values behind generation checks. Synchronous assumeIsolated calls are used only by observers registered on the main queue. Pending HTTP activation and seeks retain current-command ownership across suspension. Artwork decode and its immutable request handler are created off MainActor. No new unsafe isolation escape is needed.

Remote command tokens are retained and removed individually. Metadata publishes elapsed position and rate together at state changes, rather than on every timer tick. A pending seek publishes its requested target until it settles. The existing manual MediaPlayer path remains valid for the iOS 26 deployment target; Axiom does not require replacing it with the iOS 27-only NowPlaying framework.

## Findings

### Medium. Missing media-services reset recovery

`observeInterruptions` handles interruption and route loss but did not observe mediaServicesWereResetNotification. An old player can survive in app state after the system invalidates audio objects. Ordinary Resume cannot establish that it remains usable.

[Apple's reset policy](https://developer.apple.com/documentation/avfaudio/avaudiosession/mediaserviceswereresetnotification) requires reinitializing audio objects and session configuration. It also requires waiting for another user action before restarting playback. The correction must invalidate old callbacks, preserve the exact current position, silence pending activation intent, discard the old player and use the existing model reload path on explicit Play.

The new probes use real HTTP and AVPlayer, posting the reset notification from outside MainActor. They verify playing and paused cases, Set retention, silence after reset, replacement on explicit Play through the mini player toggle and actual resumed timeline advancement. Both reset at the initial 12-second timestamp, so they do not prove preservation of a reached position. The toggle uses local elapsed time by source reading. Row/detail Play can instead use the server's last reported position. Discarding the player also prevents the reporter from publishing a final settled reset position, leaving the server up to one reporting interval behind. Posting the notification proves the app adapter, not recovery from a real system daemon restart. No shared media service is reset by these tests.

### Follow-up. iOS 27 interruption API migration

The installed SDK deprecates legacy interruption payload types in favor of inactive/resumption notifications, matching [Apple's documentation](https://developer.apple.com/documentation/avfaudio/avaudiosession/interruptiontype). The compatibility handler still supports iOS 26 and passed interruption-ordering probes on iOS 27. This is a migration item, not evidence that it caused the reported skips. Do not replace this path without exercising real interruption/resumption on both supported OS versions.

## Remaining acceptance

Real media-daemon restart, Lock Screen/AirPods command delivery, phone-call interruptions, route loss and physical Wi-Fi/cellular transitions remain device checks. The earlier simulator passes establish the tested application state transitions, not those physical-system events. The exact cause of ordinary audible skips or repeats is still unproven.

## Verification results

Both new reset probes failed before the handler at PlaybackReliabilityTests.swift:178. The updated full suite then passed 127 native tests, including both reset probes, against matching AudioPlayer and test source hashes. Evidence is `/home/parth/.cache/orbis-playback-evidence/2026-10-18/axiom-reset-after/`, with the preserved before run in `axiom-reset-before/`. Both bundles are retained as `.xcresult.tgz` files. Swift style and the updated tvOS simulator build passed. All three focused playback UI journeys also passed. Their screenshot and result artifacts are in `axiom-reset-ui/`.

The reset probes post the public notification; they do not terminate the system's media daemon. The existing physical-device acceptance limits remain.

Independent DeepSeek V4.1 Flash Free round 7 found no high or medium source objection. Its five low findings and their dispositions are in `axiom-review-r7.md` and `axiom-review-responses.md`. Reset during an in-flight activation or seek remains unmeasured; the generation and pending-intent checks have source review only. No production or test source changed after the verified run.

Claude Opus 5.5 round 5 resumed after the earlier rate limit and returned after publication. It also found no high or medium source objection, but identified a medium evidence overclaim about reached-position preservation. The narrowed claims above close that documentation finding without claiming another test run. Its report is `axiom-review-r5.md`; the appended response records the lost settled report as a new low reset limitation. Apple's documentation supplied the reset policy; Axiom supplied the concurrency/isolation and networking review guidance.
