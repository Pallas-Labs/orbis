# Axiom round 7 dispositions

DeepSeek V4.1 Flash Free independently accepted the reset adapter with no high or medium source objection. It changed no source. All five low findings remain visible in `axiom-review-r7.md`.

1. Item notification tokens remain until the next Play, Stop or deinit. Accept the bounded cleanup delay. Generation checks reject old callbacks, the adapter cannot resume the old player, and the next reload removes all tokens. No observed crash or growing registration count justifies splitting the existing observer collection in this patch.
2. Reset during an in-flight activation or seek has source review only. The two probes exercise settled playing and paused states. The failure-case document and networking report now state this limit explicitly.
3. Preserve the append-only trail. Its historical round 6 path was a planned artifact that the failed provider never produced. The later attempts row already supersedes it; the closure row now points to the actual round 7 report and this response. The reset policy is in both `axiom-playback-networking.md` and `axiom-reset-failures.md`. The before result bundle exists at the evidence root as `axiom-reset-before.xcresult.tgz`, outside the log directory. There is no contemporaneous before source hash, so the before contrast relies on the failed test log. The after source is hash-pinned.
4. Exact local resume applies to the tested mini player toggle and remote Play reload path. Row/detail Play can use the server's last reported position. Accept this existing interaction limit and narrow the audit claim. A Lock Screen scrub after reset also waits for Play because the invalid player has been discarded.
5. The reset probes rely on notification delivery ordering and a 0.3-second position tolerance. Accept the possible flake as an unobserved test limit. Both passed in the full run; no extra pass is claimed. Future timing failures should synchronize on the resulting state before changing the tolerance.

Physical media-daemon recovery, Lock Screen/AirPods delivery and Wi-Fi/cellular handovers remain unverified. The original ordinary-streaming audible jumps and repeats remain unexplained. The two low completion/queue limits accepted in round 4 also remain.

The final diff adds no code comments. The review found no comment removal needed. The final local cleanup checked wording, source hashes, formatting and whitespace; no production or test bytes changed after native verification or review.
