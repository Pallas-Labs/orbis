# Playback reliability audit

Tracking issue https://github.com/ParthMmm/orbis/issues/277.

The reported symptom is a 1–2 second jump ahead or repeat during ordinary iOS streaming. Play/Pause and Cue selection also sometimes fail or act late. The ordinary audible symptom has not been reproduced on a physical iPhone or established as fixed.

## Findings and changes

- A requested initial position could start sounding at zero before its seek completed. One start gate now waits for the audio session and latest initial seek. Explicit Cue positions keep their exact target; only saved resume positions use the existing near-end restart policy.
- A delayed activation could replace a newer Cue on the retained Set. Pending intent and generation checks keep the latest command. FIFO server queue mutations also restore server agreement when an older activation is already in flight.
- Failed AVPlayer items could not resume from detail or Now Playing. The shared retry callback replaces the failed item at the current position. Pause during pending selection remains effective.
- A controlled Ogg response produced end-of-item at 16.0535 seconds of a reported 603.86-second timeline. The app previously forwarded that as a Finish. Early end notifications now preserve the Listen. Fresh loaded ranges retry Play through the same start gate. An explicit Play during loading can also retry that gate.
- A ready seek can receive its playing observation before completion. The cleared seek gate now reconciles current engine status.
- The disposable HTTP fixture had a suffix-range bug. Production range handling was already correct. Real HTTP/database checks now compare returned bytes for suffix ranges.

The player logs numeric command generations, seek targets and actual landing, buffer ranges and flags, access summaries, premature ends and timeline discontinuities against monotonic time. These records omit new stream addresses, titles and credentials. A media timeline check cannot detect repeated sound already encoded in a file.

## Evidence

Evidence root on Vanta is `/home/parth/.cache/orbis-playback-evidence/2026-10-18`. The starting source revision is `91d3b90`. The final manifest records the source patch digest, native commands, simulator and artifacts.

| Check | Observed result |
| --- | --- |
| Baseline real AVPlayer probes | Initial 12-second start first played at zero. Delayed Set B replaced newer Cue A. Two of four tests failed. |
| Near-final six reliability probes | All six passed in `after/all-native-after/console.log`. This predates final review corrections. |
| Near-final full native run | 125 tests, two failures within the AAC starvation probe. Standalone Ogg recovered, but the probe then lacked its Finish assertion. This is not a green suite. |
| Real server HTTP/database checks | 17 passed in `http-final.log`. Exact suffix bytes, reversed ranges, forwarding and production HTTP ranges. |
| Retained Ogg packet inspection | Five recently streamed files, 1,360,480 packets, no timestamp discontinuities over 80 ms and no ffprobe errors. Does not prove audible continuity. |
| Final-source whole native suite | 125 passed in `accepted-native/console.log`. Source hashes match the worktree. Natural Ogg completion fires once; two premature ends at 16.0535 seconds do not finish; recovery and timeline checks pass. |
| UI retry and Cue acceptance | All eight playback and recovery journeys passed in `final-ui/console.log`. The strengthened late-Cue journey passed again after the final guard, including three seconds of duplicate-Finish observation. |

## Remaining acceptance

The final whole native suite and strengthened late-Cue journey passed. The earlier eight UI journeys passed. Their screenshots, logs, timeline JSON and result bundles are retained. The attempted AAC comparison never reached a comparable starvation condition. Its source and failed traces remain in the evidence root. It is excluded from the default regression suite and supports no encoding change.

Physical iPhone acceptance stays open. Listen during ordinary foreground/background streaming, play/pause, rapid Cue selection and network changes. Correlate any audible jump or repeat with the command, seek, raw media time and buffer records. This work does not establish reconnect-at-byte-offset behavior or waveform continuity.

The known-duration end check uses a two-second allowance against the shorter known item/service length. The actual Ogg end probe passed before and after this policy change. The predicted false early-end failure was not reproduced. Unknown-duration completion retains existing behavior. Incorrect metadata can still misclassify completion. During the short completion request, controls can refer to the just-ended Set, and a new selection supersedes automatic queue advance. A failed seek error stays visible until Play retries it, even if a later scrub succeeds quietly. If the completion HTTP request fails, the per-item Finish flag may prevent retry through another end notification; selecting a different Set remains available. That low limit is inferred, not reproduced. Cue-to-waveform accuracy on long Ogg files is unverified because the observed player timeline differs from the measured file length.

## Decision trail

The workflow is [playback-workflow.md](playback-workflow.md). Decisions are in [playback.tsv](playback.tsv). Independent design alternatives and review responses remain alongside this report. Claude Opus5.5 round4 found no high or medium source objection. Final native acceptance passed after that review began. Physical acceptance remains open. See [review-r4.md](review-r4.md) and [review-responses.md](review-responses.md).

## Axiom follow-up

The user requested Axiom for Apple playback and networking. The [follow-up review](axiom-playback-networking.md) found a missing media-services reset handler. It now discards the old player, preserves position and waits for explicit Play before reloading. Both new notification probes failed before the handler. The updated source passed 127 native tests and three focused recovery/Cue UI journeys. These probes post the public notification; a real system media-daemon reset remains unverified. The networking source review found no reason to replace URLSession or add reachability checks.

DeepSeek V4.1 Flash Free independently found no high or medium source objection. The [five low findings and dispositions](axiom-review-responses.md) include unmeasured reset races and the existing row/detail Play path using the server position rather than the retained local position. The source hashes still match the verified run.
