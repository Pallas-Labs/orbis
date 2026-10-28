# PAL-847 verification record

Branch `agent/pal-847`. Each Mac run used `factory lease run --needs simulator --needs xcode --device "iPhone 17 Pro"`, which ran on host `mac` (Parth's MacBook Pro) on a cloned `lease-` iOS 27 simulator.

| Run | Commit | Command | Simulator | Result |
| --- | --- | --- | --- | --- |
| Red (old watches, new tests) | `3f438fc` | `node scripts/native-lanes.mjs --udid <lease> --only OrbisTests/AudioDownloadTests` | `226573E8-6863-43D9-B8AF-3771561E1445` | 2 of 12 failed, as intended ([log](red/AudioDownloadTests.log)) |
| Green | `37d6026` | same | `E4C0E600-B51D-4C53-8575-C0F9DD3C3925` | 13 of 13 passed ([log](green/audio/AudioDownloadTests.log)) |
| Green, related unit suites | `37d6026` | `--only OrbisTests/SetPageTests --only OrbisTests/SetPresentationTests --only OrbisTests/SupersessionTests` | same | 22 of 22 passed ([log](green/related-unit/SetPage-SetPresentation-Supersession.log)) |
| Green, download and Tracklist journeys | `37d6026` | `--only OrbisUITests/PlaybackUITests/testCancelsAndRetriesADownload --only OrbisUITests/PlaybackUITests/testRefreshKeepsAReadyTracklist` | same | 2 of 2 passed ([log](green/journeys/PlaybackUITests.log)) |
| Local CI | `37d6026` | `bun run ci` | cortex for the macOS steps | passed, posted `local-ci=success` ([summary](local-ci-37d6026.txt)) |

Red failures on `3f438fc`:

- `AudioDownloadTests.swift:338` `testQueuedSetsWithNoPageOpenCostAFewRequestsAMinute`: requests per minute, minutes 2 to 10: `[482, 541, 414, 351, 318, 289, 256, 247, 233]`; limit 6.
- `AudioDownloadTests.swift:372` `testAPendingTracklistIsReadOnlyWhileAScreenWantsIt`: 60 Tracklist reads in five minutes; limit 20.

The full result bundles (`result-*.xcresult`) are on Vanta at `~/.cache/orbis-evidence/pal-847/run-red2` and `run-green2`.

Two earlier `bun run ci` runs on the same code failed only in `apps/web` Playwright journeys (`live-queue`, then `devices`, `sign-in`, `live-queue`, `journey`) with 15 s timeouts while Vanta's load average was about 20. This branch changes no web code; the third run passed.
