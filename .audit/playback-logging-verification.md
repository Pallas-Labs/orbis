# Playback report verification

This follow-up adds reports for issue #277 and PR #278. It does not establish the cause of the physical iPhone's audible skips or repeats.

## Source and host

The implementation starts at `5b8ef57` after design commit `7618776`. Final source corrections are commit `eebbad8`. The exact input manifest covers 120 Swift files in Orbis, OrbisTests, OrbisUITests and OrbisDesign. Its SHA-256 is `a50f80eb153615c63f991aeb6f7ae149dd9737c8922a735e768daca979a07c41`. Each file matched on the Mac before and after the final native run. The manifest and a digest of the compiled `Orbis.debug.dylib` output after the native run live with the evidence. That digest alone does not identify the loaded test process.

The Mac checkout is `~/.cache/agent-scratch/orbis-playback-after-t3-9f35`. The owned iOS 27 simulator is `09C1B8C9-E33F-4E63-B3F0-AF92DD1E9517`. T3 opened it for visible verification. No physical iPhone or macOS app run is claimed.

All native lanes ran serially. A private wrapper records the current xcodebuild inventory and adds `-jobs 2 -parallel-testing-enabled NO -collect-test-diagnostics never ONLY_ACTIVE_ARCH=YES ARCHS=arm64`. The Axiom build helper was unavailable on the Mac, so complete xcodebuild logs and result bundles provide the fallback evidence. No other simulator or build job was stopped.

## Commands and results

Run from the Mac checkout with its private `serial-bin` first on PATH.

```sh
node scripts/native-lanes.mjs --udid 09C1B8C9-E33F-4E63-B3F0-AF92DD1E9517 --only OrbisTests --out "$PWD/evidence/logging-native-final/shots"
node scripts/native-lanes.mjs --udid 09C1B8C9-E33F-4E63-B3F0-AF92DD1E9517 --only OrbisUITests/PlaybackReportUITests --only OrbisUITests/PlaybackRecoveryUITests --only OrbisUITests/PlaybackUITests/testAColdCueNearTheEndStartsAtItsTimestamp --out "$PWD/evidence/logging-ui/shots"
xcrun simctl pbpaste 09C1B8C9-E33F-4E63-B3F0-AF92DD1E9517
bun run native:format
```

The final native run passed all 131 tests at 23:51:53 UTC. This includes real HTTP and AVPlayer behavior, report privacy and finite-number handling, activation intent, waiting-stream snapshots, and sample-first incident retention. The dense report attachment contains 256 command entries in 246,248 UTF-8 bytes. The playback report contains 20 entries in 12,784 bytes. The held-stream report contains six entries in 3,278 bytes.

All four UI journeys passed at 23:48:58 UTC. The retained Settings screenshot shows Copied and the app-run lifetime text. A separate clipboard read returned valid schema-version-1 iOS JSON in 533 bytes, with a current snapshot and zero events. Its `generatedAt` of 23:48:33 UTC falls inside the copy journey's 23:48:22.356 through 23:48:35.783 UTC window. This proves copying an idle report, not playback history after an audible incident. The initial UI run has no pre-run source manifest, so matching production and UI-test input was inferred from the recorded edit sequence. The second UI run passed all four journeys at 23:58:06 UTC with all 120 source files matching before and after. Its actual installed library and compiled output both hash to `7150c98e66044d66002e607f91032e03cb7fab98733c48afd82a1693669f3b26`, also matching the recorded native output digest. The final clipboard holds 537 bytes of valid idle schema-1 JSON generated at 23:57:40 UTC, inside the copy journey at 23:57:29.483 through 23:57:42.889 UTC. Its format log explicitly records exit 0. The later withheld-Ogg unit-test clarification is covered by the final full native manifest.

Swift formatting and the tvOS simulator build passed. The build ran from `apps/apple` with the same private wrapper and `xcodebuild -project Orbis.xcodeproj -scheme OrbisTV -destination "generic/platform=tvOS Simulator" CODE_SIGN_IDENTITY=- -derivedDataPath DerivedData build`. This is a build check, not a tvOS runtime journey.

## Preserved failures

The first 130-test run failed the new report test because raw media time arrived before its seek completion diagnostic. Waiting for settledPosition synchronized the test with completion, and the next 130-test run passed.

The focused retention probe failed before the production correction because 300 routine samples evicted an incident. Its dense pretty-printed report retained 128 entries in 233,991 bytes. The corrected sample-first eviction and compact export pass in the final 131-test run.

The first 131-test run passed the new logging probes and failed an existing loading-state assertion during premature Ogg end recovery. Its retained trace shows recovery at 16.0535 seconds of a 603.86-second file. The position held and recovery advanced without a timeline jump or Finish, but AVPlayer reported playing during the retry. After independent GPT-6-Luna judgment, the test names withheld-Ogg recovery and requires loading when AVPlayer reports waiting. Every held-position, no-Finish and post-release continuity check remains. In the final trace, all 19 held-phase samples have AVPlayer status paused and app state loading. The new conditional waiting assertion therefore did not execute in this run. The earlier failed trace had AVPlayer playing while its clock held. The reason for this state/timing variation remains unresolved, and no measurement excludes instrumentation timing effects. The pass proves the narrower held-position and post-release recovery checks. It does not prove loading during an actual engine wait or throughout premature-end retry, nor audible continuity.

## Evidence locations

Durable Linux root: `~/.cache/orbis-playback-evidence/2026-10-18/logging`.

- `source-manifest.sha256` identifies the final native input.
- `before/` and `logging-native-before.xcresult.tgz` retain the first report-probe failure.
- `native-130/` and `logging-native-130.xcresult.tgz` retain the earlier pass before retention correction.
- `retention-before/` and `logging-retention-before.xcresult.tgz` retain the incident-eviction failure.
- `native-131-first/` and `logging-native-131-first.xcresult.tgz` retain the premature-end assertion failure and UUID-named attachments.
- `native-final/` and `logging-native-final.xcresult.tgz` retain the final 131-test pass, reports, source matches and binary digest.
- `ui/` and `logging-ui.xcresult.tgz` retain the first four journeys, screenshots and separately read clipboard JSON.
- `ui-final/` and `logging-ui-final.xcresult.tgz` retain the second four-journey pass, before-and-after source matches, installed-versus-built library hashes, current clipboard JSON and explicit style exit status.
- `tvos/` retains the successful build log.

## Review and limits

[Round 1](playback-logging-review-r1.md) requested two medium retention corrections. [Round 2](playback-logging-review-r2.md) found no remaining high or medium source issue. The source reviewer did not verify runtime artifacts. The parent verified the Mac input hashes, logs, actual report payloads and clipboard separately. The dense all-command file proves size, while the separate passing sample-flood assertion proves incident retention. No retained report contains a synthesized `discontinuity` event. Deliberate seeks produce `timeJumped` and `seekResult`; spontaneous discontinuity recording remains source-reviewed only. [Dispositions](playback-logging-responses.md) distinguish these checks and retain accepted low limits.

Reports exist only in app memory, lose history when the app closes, and clear on sign-out. They have no upload or disk writer. Periodic samples are best effort and can stop during waits. The bounded report can omit samples or old events. It does not carry an NSError underlying chain, prove remote hardware identity, or attribute every jump across a wait or after a seek. No overhead measurement is claimed. Dedicated diagnostic probes for remote delivery, cancellation, supersession, sign-out and discontinuity injection remain absent. The physical iPhone symptom and premature-end loading-indicator continuity remain open acceptance on issue #277.

Model the Domain led to fixed typed events rather than free text. Laziness Protocol kept one AudioPlayer-owned recorder and the existing observer. Prove It Works required actual report JSON and clipboard evidence beyond the Copied label.

The final [independent trail review](playback-logging-trail-review.md) and [dispositions](playback-logging-trail-responses.md) identify the accepted coverage limits. Its missing UI hash and weak style-record findings are resolved by the second run. The owned simulator was shut down after preserving the evidence.
