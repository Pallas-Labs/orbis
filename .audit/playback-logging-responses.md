# Playback logging review dispositions

Claude Opus 5.5 round 1 found no high issue or privacy defect and requested two medium retention corrections. The full report is `playback-logging-review-r1.md`. It reviewed the source separately from runtime acceptance.

## Retention

Both medium requests are accepted. A focused regression probe was written before modifying retention. It failed with `Routine samples must not evict the incident`. Its realistic eight-range/access-metric report exported 128 of 256 entries in 233,991 UTF-8 bytes before correction. The artifact and failure log are under `~/.cache/orbis-playback-evidence/2026-10-18/logging/retention-before/`; the result bundle is retained separately.

The recorder now evicts the oldest periodic sample before command or incident entries. Compact JSON replaces pretty printing. If export still exceeds the byte cap, it omits routine samples and binary-searches the largest newest suffix of the remaining records that fits. This deliberately prioritizes causal records over periodic context under byte pressure. The current snapshot is always included for normal report limits. Documentation now says up to 256 entries, without a guaranteed time window.

## Other dispositions

- Accepted the cancellation gap. A current activation whose task is cancelled after its response arrives now records `cancelled` before returning. Tracklist request cancellation never records an activation outcome. Existing playback decisions remain the same.
- Corrected the two audit notes to say that periodic sampling is best effort when media-time callbacks arrive. No heartbeat is promised while paused or waiting, and no second timer was added.
- Retained the fixed primary error category/code schema. Underlying NSError codes are not included. Error-log numeric events can supplement the item error, but this report does not promise a complete error chain.
- Retained the simple Copied acknowledgement. Every tap generates a fresh report, but a second tap within the same Settings presentation does not change the label or repeat the success haptic. The acknowledgement alone does not prove clipboard contents. After the four-journey run, a separate `simctl pbpaste` check read valid schema-version-1 iOS JSON from the owned simulator. Its generation time, 23:48:33 UTC, falls inside the copy journey, 23:48:22.356 through 23:48:35.783 UTC. This idle report has a current snapshot and zero entries in 533 UTF-8 bytes.
- Kept discontinuity detection limited to uninterrupted playback. A jump across a wait must be assessed from snapshots and `timeJumped`. A jump after a seek completes is not automatically attributed to that seek; its neighboring seek result and snapshot sequence provide context. The numeric threshold cannot prove an audible skip or repeated sound inside the media file.
- Kept fresh buffer/access reads at event capture. No measured overhead claim is made.

Remote-origin delivery, failure/cancellation/supersession diagnostic outcomes, sign-out clearing and discontinuity injection have source review but no dedicated new runtime probe. Existing behavior suites still cover the playback operations. Physical iPhone evidence remains required for the reported audible jumps and repeats.

## Verification record so far

The first full run executed 130 tests with one failure. The new report probe read AVPlayer's raw time before the seek callback had recorded its result. The existing probe now waits for `settledPosition`, which becomes available after completion. The next full run passed all 130 tests. A new retention probe then demonstrated the sample-eviction failure before its production correction. The first 131-test run passed all new logging and retention probes but failed one existing withheld-Ogg assertion. Its trace shows premature end recovery at 16.0535 seconds of a 603.86-second file, followed by AVPlayer reporting playing while the clock remained held. Post-release advancement, position bounds, no skip/repeat and no-Finish assertions all passed. The existing test had overclaimed a true buffer wait. After independent GPT-6-Luna review, it now names withheld Ogg recovery, requires loading when AVPlayer actually reports waiting, and accepts loading or playing as retained sound intent during premature-end retry. It retains every position, no-Finish and recovery check. This does not prove that loading stays visible throughout premature-end recovery. The failed bundle remains under `native-131-first/`. The final run on this clarified test contract passed all 131 tests. Its dense report retained all 256 entries in 246,248 UTF-8 bytes with zero omissions. These results are distinct; the earlier 130-pass run does not verify the retention changes.

The implementation owner wrote the initial failure cases and tests before code. The retention failure cases and focused regression probe also preceded that correction. No new coverage is claimed for the accepted low limits above. The independent comment pass requested deleting new explanatory comments. Four added comment lines and the unused legacy error wrapper were removed. The existing unified-log privacy comment remains. No correctness suppressions or unsafe concurrency escapes were added.

## Round 2 source gate

Claude Opus 5.5 found no remaining high or medium source issue after the retention corrections. It reviewed source and the response notes, not Mac logs, hashes, clipboard, bundles or runtime acceptance. The later withheld-Ogg test clarification has the separate focused GPT-6-Luna judgment above. `evictedCount` includes ring removals and export omissions. Byte pressure can omit all periodic samples. Cancellation logging follows existing catch paths; a plain `CancellationError` in `finishedPlaying` still follows its pre-existing generic failure path.

The final acceptance checks passed on the matching source. All 131 native tests and four iOS UI journeys passed, Swift formatting passed, and the tvOS simulator build succeeded. The parent checked the actual report attachments and idle clipboard payload. See [verification](playback-logging-verification.md) for exact commands, source digest and retained failures. No physical audible-skip acceptance is claimed.

## Final evidence-trail review

The independent Claude Opus 5.5 trail review checked the actual logs, hashes and report files and upheld the native count, report sizes, UI result and clipboard timing. It identified missing pre-run UI hashes, the unexecuted conditional waiting assertion, absent discontinuity injection, and weak binary/style evidence labels. The initial UI source-match claim is now an inference, pending a fresh hash-pinned run. The native binary digest identifies compiled output after the run, not the loaded process. The dense all-command report proves size; the separate passing sample-flood assertion proves incident retention. A fresh style run will record its exit status.

The final withheld-Ogg trace has 19 held-phase samples with AVPlayer paused and app state loading, so the conditional waiting assertion did not execute. The failed run had AVPlayer playing while the media clock held. The cause of this state/timing variation is unresolved. The evidence does not exclude instrumentation timing effects and does not prove that every loading or discontinuity path works at runtime. This remains open on issue #277.

The final hash-pinned UI rerun passed all four journeys. All 120 Swift inputs matched before and after; installed and compiled library digests match the native output digest. The clipboard again contains valid idle JSON generated inside the copy journey. The fresh Swift formatting log records exit 0. These resolve the trail review's missing UI manifest and style-status evidence. No production source changed.
