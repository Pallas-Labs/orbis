# Playback verification record

Base revision `91d3b90`. Evidence on Vanta is `/home/parth/.cache/orbis-playback-evidence/2026-10-18`. The Mac source snapshot is `/Users/parthmangrola/.cache/agent-scratch/orbis-playback-after-t3-9f35`.

## Accepted source

`accepted-source-manifest.sha256` identifies every changed native production/test source, fixture script and HTTP source. `accepted-native/source-match.log` proves the Mac inputs match this worktree. The tested app library SHA256 is `57f3b17be3b18631cecd495cc2b583bf59c2ae7bb895d0d022ef4a67891cf3ae`.

The target is iOS27 simulator `09C1B8C9-E33F-4E63-B3F0-AF92DD1E9517`, named Orbis Playback Final20261018. From the Mac snapshot root:

```sh
PATH="$PWD/serial-bin:$PATH" node scripts/native-lanes.mjs --udid 09C1B8C9-E33F-4E63-B3F0-AF92DD1E9517 --only OrbisTests --only OrbisUITests/PlaybackUITests/testAColdCueNearTheEndStartsAtItsTimestamp --out "$PWD/evidence/accepted-native/shots"
```

The private wrapper adds `-jobs 2 -parallel-testing-enabled NO -collect-test-diagnostics never ONLY_ACTIVE_ARCH=YES ARCHS=arm64`. The result is 125 native tests and one late-Cue UI test passing. `accepted-native/console.log`, timeline JSON, screenshots and `accepted-native.xcresult.tgz` retain the run. Natural Ogg completion fires once. Two premature ends at16.0535 seconds do not Finish, and the stream recovers without timeline loss. The late-Cue journey observes the server for another three seconds after its first Finish.

## Other results

- `final-ui/console.log`, `final-ui/shots/` and `final-ui.xcresult.tgz` retain all eight playback/recovery journeys passing before the final duration/duplicate-completion guard. That final guard passed the whole native suite and the strengthened late-Cue journey above.
- `ogg-end-before/console.log` and `ogg-end-before.xcresult.tgz` retain the natural Ogg end probe passing before the final guard. The predicted false early-end failure did not reproduce.
- `http-final.log` records 17 passing tests from `bun test apps/server/src/audio.test.ts apps/server/src/node-audio-http.test.ts apps/server/src/forwarding-http.test.ts` on Vanta. `server-typecheck.log` records the passing TypeScript check. Swift style, JS lint/format and diff checks also passed.
- `tvos-build/console.log` records a successful OrbisTV simulator build. No TV runtime acceptance is claimed.
- `baseline-xcresults.tgz` retains initial native failures, Ogg recovery failure, late-Cue failure and baseline UI evidence. `before/` contains their console logs. `experimental-aac.xcresult.tgz`, `after/all-native-after/` and `final-native/` retain the failed AAC experiments, including exported JSON. AAC never reached a comparable starvation condition and supports no codec conclusion.

## Historical paths

Original Mac baseline and repro paths map under `before/`. Earlier after paths map under `after/`. The short-lived ranges and packet-check scratch files map to this root. The original buffer JSON maps to `repro-buffer-attachments/`. Cortex logs and the xcodebuild sample map under `cortex/`. The simctl-install sample was not produced because installation had finished; no result relies on it. Historical TSV rows remain append-only, with correction rows for these mappings.

The50ms Ogg response caused premature ends near16seconds. The250ms Ogg response instead recorded a real stall near10seconds. Both recovery paths passed on final or near-final source as recorded. Adjacent timeout errors do not establish which request caused an early end.

## Open acceptance

Physical iPhone audible jumps/repeats, waveform continuity, Cue-to-waveform accuracy on long Ogg files, byte-offset reconnect and AAC starvation remain unverified. The observed Ogg player timeline differs from the file's measured length. Issue277 remains open. The final source review has no high or medium objection; its two low interaction/retry limits remain in the audit report.

## Axiom follow-up

After the user requested Axiom for Apple playback and networking, the source review found a missing media-services reset adapter. Source starts at `a018f19`; the follow-up changes only AudioPlayer.swift and PlaybackReliabilityTests.swift. The app library SHA256 is `87e926c3ff8105e08c59f3ef8c7bd7cdc1d1fc54865e6c2cceb52a58ba37064a`. `axiom-source-manifest.sha256` and `axiom-reset-after/source-match.log` identify the exact matching input files.

Both new notification probes failed before the correction, and all 127 native tests passed afterward. `axiom-reset-before/` retains the failure log. `axiom-reset-after/` retains the successful console and JSON evidence. Their `.xcresult.tgz` files at the evidence root retain the result bundles. The before source was not hash-pinned; the after source was. All three focused UI journeys passed on the follow-up source in `axiom-reset-ui/`, with screenshots and a retained bundle. The updated tvOS simulator build and Swift style also passed.

The full native command uses the same simulator and wrapper as above, with `--only OrbisTests --out "$PWD/evidence/axiom-reset-after/shots"`. The focused UI command selects `--only OrbisUITests/PlaybackRecoveryUITests --only OrbisUITests/PlaybackUITests/testAColdCueNearTheEndStartsAtItsTimestamp --out "$PWD/evidence/axiom-reset-ui/shots"`.

These probes post the public reset notification from off MainActor. They do not reset shared media services or prove a physical daemon restart. Networking source scans are retained as `axiom-network-scan.py` and `axiom-network-scan.json` in the evidence root. The review and remaining acceptance are in [axiom-playback-networking.md](axiom-playback-networking.md).

DeepSeek V4.1 Flash Free independently reviewed the tested source and found no high or medium objection. Five low findings remain recorded in [axiom-review-r7.md](axiom-review-r7.md), with dispositions in [axiom-review-responses.md](axiom-review-responses.md). The owned simulator was shut down after evidence retention. No shared services were reset.

The delayed [Claude round 5 review](axiom-review-r5.md) also found no high or medium source objection. It identified that both reset JSON artifacts record the initial 12-second position. They establish Set retention, quiet recovery, player replacement and resumed advancement, not preservation of a position reached later. The narrowed claims and new low missed final position report are in [the late response](axiom-review-responses.md). No source, test or verification result changed.

## Playback report follow-up

Settings now offers Copy Playback Report for recent in-memory playback evidence. The [logging verification record](playback-logging-verification.md) identifies the final 131-test pass, four iOS UI journeys, separately checked clipboard JSON, Swift style and tvOS build. It also retains the failed retention probe and narrowed withheld-Ogg test claim. [Independent review dispositions](playback-logging-responses.md) record the source verdict and remaining limits. Physical iPhone audible-skip acceptance remains open on issue #277.

## SigNoz follow-up

The [automatic delivery verification](signoz-verification.md) records the new native, HTTP, Workerd and actual collector evidence under `/home/parth/.cache/orbis-playback-evidence/2026-10-18/signoz`. It supersedes the earlier clipboard-only scope without changing the retained historical results.
