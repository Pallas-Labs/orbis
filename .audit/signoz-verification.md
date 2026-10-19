# Automatic playback delivery verification

Playback diagnostics now upload automatically while signed in. AppModel owns a cancellable sender, the existing 256-entry ring remains the only rolling history, and one frozen batch crosses URLSession to the authenticated API. The shared handler validates fixed fields and exports OTLP through production Group wiring. Copy Playback Report remains available.

## Source and commands

Implementation commits run from `eeb98c4` through `53a1620`. Parent integration `3145cb4` bounds timestamps to OTLP's unsigned nanosecond range and formats the Swift slice. `bc07f86` replaces the adapted replay with actual Swift HTTP output and adds the numeric receipt to the existing OpenAPI sample check.

Durable evidence on Vanta is `/home/parth/.cache/orbis-playback-evidence/2026-10-18/signoz`. The Mac checkout is `/Users/parthmangrola/.cache/agent-scratch/orbis-playback-after-t3-9f35`. Its owned iOS 27 simulator is `09C1B8C9-E33F-4E63-B3F0-AF92DD1E9517`. Xcode runs serially through the existing `serial-bin/xcodebuild` wrapper. Swift style uses Xcode's formatter. The final Linux checks use pinned Bun 1.4.1; the implementation owner's earlier Linux checks used 1.4.0.

```sh
PATH=/home/parth/.local/share/mise/installs/bun/1.4.1/bin:$PATH bun run check
PATH="$PWD/serial-bin:$PATH" node scripts/native-lanes.mjs --udid 09C1B8C9-E33F-4E63-B3F0-AF92DD1E9517 --only OrbisTests/PlaybackDiagnosticsSenderTests --only OrbisTests/PlaybackDiagnosticsTests --out "$PWD/evidence/signoz-focused/attachments"
PATH="$PWD/serial-bin:$PATH" node scripts/native-lanes.mjs --udid 09C1B8C9-E33F-4E63-B3F0-AF92DD1E9517 --unit --out "$PWD/evidence/signoz-all/attachments"
```

## Observed results

| Check | Result and evidence |
| --- | --- |
| Baseline route | Authenticated, initialized HTTP request received 404 instead of 200. `owner-linux/expected-404.log`. |
| Timestamp validation | HTTP probe expected 400 and received 200 above OTLP's timestamp range. Corrected maximum passes. `timestamp-before.log`, `http-final.log`. |
| Whole repository | 15 tasks succeeded, eight cached. Includes 219 server tests, Workerd journeys and nine web journeys. `check-final.log`, `linux-artifacts/`. |
| Native focused | All 12 passed, including real URLSession, bounded serialization, blocked upload cancellation, retries and advancing real AVPlayer playback during a blocked upload. `native-focused/`. |
| Native whole suite | All 140 passed, plus 40 design-package tests and Swift style. All 79 scoped Swift inputs match root and both pre/post manifests. `native-all/`. |
| Actual native replay | All 19 focused playback/OpenAPI HTTP tests passed with the actual native fixture. `replay-final.log`. |
| Live Group relay | Local Workerd ran production Group/shared handler/exporter against protected public OTLP. Two records accepted, zero rejected, and both stored. `live-group-v2/result.json`, `stored-records.jsonl`. |

The original whole check failed because the new endpoint lacked a response sample and increased the endpoint count from 46 to 47. After updating that existing HTTP check, the whole check passed. The first timestamp command lacked rebuilt contracts and is not the red/green evidence. Both setup and assertion failures remain in the retained logs.

## Live collector proof

The raw native attachment has SHA256 `b72453320cf3e792ef7c6b791d9a74827405efc6b648027ef17b6d7d4f4ac8cc`, 1,089 bytes and run ID `8C3B475C-7087-47B4-9B19-A52A70DA76A0`. The Swift probe constructs a seek command and stall, encodes them, and sends them over real HTTP. These are constructed events, not captured audible skips. The committed replay differs only in whitespace, as checked in `fixture-provenance.json`.

`verify-live-group.mjs` sent those exact bytes through the production Group class in local Miniflare/Workerd to `https://otlp.parthm.me/v1/logs`. It read the existing Access credentials privately into process memory. It saved the Worker bundle digest, input digest, numeric receipt and collector query. No secret value was printed, committed or copied into the Apple app. The queried records have service `orbis.apple.playback`, an INFO `playback.command` and WARN `playback.stalled`, with typed event, snapshot and uptime bodies. Correlate in SigNoz with `orbis.run_id` and order by `orbis.sequence`.

The first live verification stopped before its authenticated POST because it expected 401 for a missing bearer and the API's local-app gate correctly returned 403. The next run accepted either denial status. A separate query initially returned zero because its UUID parser lowercased the identifier, while Swift emits uppercase. Preserving the validated input case found both existing records. No duplicate live POST was necessary. The initial failed artifacts remain intact.

## Limits

No deployed Worker, Worker secret provisioning, installed physical iPhone build, audible continuity, background suspension delivery or performance overhead measurement is proven here. Runtime evidence covers local production Group code and the real protected collector separately from native URLSession and sender tests. Production rollout needs the updated Worker, its two Access secrets and an updated Apple build.

Memory-only buffering loses pending history on exit and may lose old records while delivery is unavailable. Timeouts can produce duplicates. Run ID and sequence identify duplicates, and a `playback.loss` record counts unacknowledged history without claiming the collector lost it. A partial collector receipt is terminal. Playback controls never wait for delivery.

The earlier [playback limitations](playback-logging-verification.md) remain. In particular, physical audible-skip acceptance stays open on issue #277. The withheld-Ogg test does not prove its conditional engine-wait branch executed, discontinuity recording has no injected runtime probe, and media-reset position limits remain documented.

Independent source review, UI journeys and tvOS build results will be recorded before publication.
