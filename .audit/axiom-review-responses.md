# Axiom round 7 dispositions

DeepSeek V4.1 Flash Free independently accepted the reset adapter with no high or medium source objection. It changed no source. All five low findings remain visible in `axiom-review-r7.md`.

1. Item notification tokens remain until the next Play, Stop or deinit. Accept the bounded cleanup delay. Generation checks reject old callbacks, the adapter cannot resume the old player, and the next reload removes all tokens. No observed crash or growing registration count justifies splitting the existing observer collection in this patch.
2. Reset during an in-flight activation or seek has source review only. The two probes exercise settled playing and paused states. The failure-case document and networking report now state this limit explicitly.
3. Preserve the append-only trail. Its historical round 6 path was a planned artifact that the failed provider never produced. The later attempts row already supersedes it; the closure row now points to the actual round 7 report and this response. The reset policy is in both `axiom-playback-networking.md` and `axiom-reset-failures.md`. The before result bundle exists at the evidence root as `axiom-reset-before.xcresult.tgz`, outside the log directory. There is no contemporaneous before source hash, so the before contrast relies on the failed test log. The after source is hash-pinned.
4. Exact local resume applies to the tested mini player toggle and remote Play reload path. Row/detail Play can use the server's last reported position. Accept this existing interaction limit and narrow the audit claim. A Lock Screen scrub after reset also waits for Play because the invalid player has been discarded.
5. The reset probes rely on notification delivery ordering and a 0.3-second position tolerance. Accept the possible flake as an unobserved test limit. Both passed in the full run; no extra pass is claimed. Future timing failures should synchronize on the resulting state before changing the tolerance.

Physical media-daemon recovery, Lock Screen/AirPods delivery and Wi-Fi/cellular handovers remain unverified. The original ordinary-streaming audible jumps and repeats remain unexplained. The two low completion/queue limits accepted in round 4 also remain.

The final diff adds no code comments. The review found no comment removal needed. The final local cleanup checked wording, source hashes, formatting and whitespace; no production or test bytes changed after native verification or review.

## Delayed round 5 response

Claude Opus 5.5 resumed after its initial rate limit and delivered `axiom-review-r5.md` after publication. It found no high or medium source objection. Its medium evidence finding is valid. Both reset artifacts record 12 seconds before and after, the initial timestamp, so they cannot prove capture of a position reached after playback advances. The current report and coverage document now claim Set retention, quiet recovery, replacement and resumed advancement only. Local position capture has source review, not measured acceptance. This supersedes the position coverage claims in round 7 and the historical `axiom-verified` trail row.

The low reporting finding is also valid. Once the player is discarded, `settledPosition` is nil and the position reporter skips the final settled report. The server can remain up to the five-second reporting interval behind. The row/detail path already uses the server position, but this missed report is a new reset limitation. Accept it explicitly rather than calling it wholly pre-existing. The toggle and remote Play use local elapsed time by source reading. A later change should measure a reset after timeline advancement and settle the retained position to the server.

The reset policy comes from Apple's documentation. Axiom 27.3.0 supplied concurrency/isolation patterns and networking checks; it contains no media-services reset guidance. The failure document now credits the sources separately, and a new trail row supersedes the earlier combined attribution. No production or test source changed and no new run is claimed.
