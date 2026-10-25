# Development

Source ownership, local setup, and verification.

## Find the implementation

| Task | Start here |
| --- | --- |
| Routes, request shapes, and derived clients | [`packages/contracts/src/http-api.ts`](../packages/contracts/src/http-api.ts) |
| Shared HTTP handlers | [`apps/server/src/app-core.ts`](../apps/server/src/app-core.ts) |
| Disposable SQLite API dependencies | [`apps/server/src/app.ts`](../apps/server/src/app.ts) and [`scripts/fixture.ts`](../scripts/fixture.ts) |
| Production Cloudflare Group | [`apps/api/src/group.ts`](../apps/api/src/group.ts) and [API README](../apps/api/README.md) |
| Vanta audio-node startup and protocol | [`apps/server/src/node.ts`](../apps/server/src/node.ts), [`audio-node.ts`](../apps/server/src/audio-node.ts), and [operation guide](../deploy/orbis-server/README.md) |
| Audio HTTP listener and API forwarding | [`node-http.ts`](../apps/server/src/node-http.ts) |
| Download selection and retained files | [`download-backends.ts`](../apps/server/src/download-backends.ts) and [`media-store.ts`](../apps/server/src/media-store.ts) |
| Identity, trust storage, and administration | [`identity.ts`](../apps/server/src/identity.ts), [`trust-storage.ts`](../apps/server/src/trust-storage.ts), and [`admin.ts`](../apps/server/src/admin.ts) |
| Web routes and player | [`apps/web/src/routes`](../apps/web/src/routes) and [`player.tsx`](../apps/web/src/components/player/player.tsx) |
| Apple client and project specification | [`apps/apple/Orbis`](../apps/apple/Orbis) and [`project.yml`](../apps/apple/project.yml) |
| Native fixture setup and HTTP client | [`scripts/native-lanes.mjs`](../scripts/native-lanes.mjs), [`seed-lane-audio.mjs`](../scripts/seed-lane-audio.mjs), and [`LaneService.swift`](../apps/apple/OrbisUITests/LaneService.swift) |
| Domain terms and decisions | [GLOSSARY.md](../GLOSSARY.md) and [ADRs](adr) |

Resolve a filename with `rg --files <directory>` before reading it. Server HTTP tests live beside the implementation in `apps/server/src`; native fixture setup lives in the lane runner. Historical plans in `docs/plans` record earlier build sequences and are not current setup instructions.

## Setup

Requires Bun 1.4.1 and Node.js 24. TypeScript 7 is pinned and patched with Effect diagnostics by the install preparation script. The audio node and disposable HTTP fixtures run on Bun.

```sh
bun install
bun run dev
```

`bun run dev` runs workspace development tasks. The server workspace starts the production audio node and requires its node environment. Web API configuration is in the [web README](../apps/web/README.md#develop). Browser and native journeys start `scripts/fixture.ts` with disposable SQLite and keyed loopback HTTP.

### Server logs

The server writes one structured event per request when the request settles: request id, method, path with the query string removed, status, outcome, and elapsed time. An `Effect.log*` call made while handling a request is folded into that event instead of a second line.

Background work writes one event per job, named by its `job` field, such as `audio-download`, `download-canary`, or `tracklist`. A standalone event, such as a node link change, has an `event` field instead. An `Effect.log*` call made outside a request or a job becomes its own event. The [operation guide](../deploy/orbis-server/README.md#where-to-look-when-a-download-fails) lists the node, Group, and canary events.

The level tells a person whether to look:

- `error` marks a failed download, a failed playlist import, a canary source with no working backend, a node that failed to reconnect five times in a row, and a request that failed with a 5xx status.
- `warn` marks work that degraded but was handled, such as a lost backend or a lost node link, and a request refused with a 4xx status.
- `info` marks everything else, including a cancelled request or download.

An alert on any `error` from service `orbis` stays useful only while new code follows these levels.

A request that dies records `cause`: the error name and its message with query strings, bearer tokens, and credential-named pairs removed. A typed failure records its name only. Audio requests add an `audio` record; [the operation guide](../deploy/orbis-server/README.md#where-to-look-when-a-set-does-not-play) lists its fields.

Authorization headers, cookies, request bodies, source links, stream grants, and raw error stacks are never recorded, and credential-shaped values are redacted before output. Redaction follows key names, so a credential written as free text can still reach a line: treat logged free text as public.

`NODE_ENV` sets the event `environment`, which defaults to `development`. In production each event is one JSON line, where `info` goes to standard output and `warn` and `error` go to standard error; development prints readable lines. The wiring lives in `apps/server/src/logging.ts`. `createApp({ logging })` overrides the environment, quiets output (`silent`), or receives every event (`onEvent`), which the tests use.

`logging.otlp` also sends every event, after redaction, to an OTLP/HTTP collector such as SigNoz. Its `url` is the full logs URL, `component` sets the `orbis.component` resource attribute to `node`, `group`, or `canary`, and `headers` adds request headers. Every event has `service.name=orbis`. The node and the canary read the collector URL from `ORBIS_OTLP_LOGS_URL`, and the Group builds it from its SigNoz bindings. When no collector is set, events go only to the console, as in tests. Events wait in evlog's drain pipeline and go out in batches of up to 50, at least every 5 seconds. The Group passes `ctx.waitUntil` as `waitUntil`, so it stays awake until the queue is empty. A process that exits on its own calls `flushLogs()` first, so its queued events reach the collector.

## Checks

Run `bun run check` locally or in CI for cached lint, formatting, TypeScript, tests, and Effect diagnostics. Turbo runs independent tasks in parallel, bounded by the available CPU count, and builds shared contracts before consumers. `bun run check:force` bypasses task-cache reads. `bun run fix` applies Ultracite fixes; it is never cached.

GitHub Actions cancels superseded runs and runs React Doctor alongside the quality job. Bun downloads and Turbo results use separate caches; each workflow run saves a new Turbo snapshot. Cache restores stay within the same OS and CPU architecture. No remote-cache account is required. Typechecks use separate incremental files so they do not race with builds.

The quality workflow also runs the Swift style check and `swift test` for `OrbisDesign` on a macOS runner, so the Swift package is verified even when no Mac is present.

Lint also runs seven rules from the t3code oxlint plugin, vendored in [`lint-plugins/t3code`](../lint-plugins/t3code) and scoped in [`oxlint.config.ts`](../oxlint.config.ts). A suppression comment needs a reason, a test registers cases with `test.each`, and a test sets no per-test timeout (the server test script sets one ceiling).

Individual checks and packaging remain available:

```sh
bun run typecheck
bun run test
bun run build
bun run format:check
```

## Gardening sensor

`bun run garden` runs `scripts/garden.mjs`, which measures the working tree of the current checkout and prints one schema-1 JSON record: the commit, the time, `metrics`, `skipped`, and `findings`. It needs no network, secrets, or env files and takes a few seconds on Vanta. A metric whose tool is missing or that needs macOS goes in `skipped` with a reason and never fails the run.

| Metric | What it counts |
| --- | --- |
| `lint.errors`, `lint.warnings` | oxlint diagnostics with the repo's configuration |
| `deadcode.unused` | oxlint unused-code diagnostics (`no-unused-vars` and its kin); TypeScript's `noUnusedLocals` runs in the gate |
| `suppressions` | `eslint-disable`, `oxlint-disable`, `biome-ignore`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `@effect-diagnostics`, `oxfmt-ignore`, `prettier-ignore`, `swiftlint:disable`, `swift-format-ignore`, `periphery:ignore`, and `shellcheck disable` comments |
| `typescript.assertions` | each `as` cast other than `as const`, and each `!` non-null assertion, in TypeScript code |
| `swift.force-operations` | each `try!`, `as!`, and force unwrap in Swift code |
| `tests.skipped`, `tests.focused` | `.skip`, `.todo`, and `.only` tests, `XCTSkip`, and `.disabled` traits in test files |
| `docs.stale-refs` | backticked repository paths and `bun run` scripts in Markdown that no longer exist; gitignored build output is not stale, and the repo has no Makefile |
| `markers` | `TODO`, `FIXME`, `HACK`, and `XXX` markers followed by a colon or a parenthesis |
| `history.reverts`, `history.workarounds` | commits in the 14 days before `HEAD` whose subject starts with "Revert" or names a workaround or a flaky test |
| `swift.format` | swift-format lint warnings; macOS only, and skipped when swift-format exits nonzero with no diagnostics |
| `gate.<task>.seconds`, `gate.failures` | with `--with-gate`, the wall time of each `bun run check` task run alone with `--force`, and the tasks that failed |

`swift.unused` is always skipped, because the repo configures no Swift dead-code tool. The source scans are line patterns, so they can miss or misread unusual code; the counts are for comparing runs, not proof. The scans skip `.audit`, `docs/plans`, `docs/audits`, `docs/research`, generated route trees and shadcn components, and the sensor and its test.

A finding's `id` hashes its kind, file, and normalized text, so a finding that only moves keeps its id; identical findings in one file are numbered in line order. `--compare <previous.json>` prints a Markdown table of metric changes, then the new, repeated, and resolved findings; `--out <file>` also saves the JSON for the next run.

## Verification lanes

Build shared contracts before running a focused lane from the repository root:

```sh
	bun run --filter @orbis/contracts build
```

| Change | Command from repo root | Evidence and prerequisites |
| --- | --- | --- |
| Bun HTTP handlers | `bun run --filter @orbis/server test` | Real database HTTP tests in `apps/server/src`; retain command output for failures |
| Cloudflare Group and audio node | `bun run --filter @orbis/api test` | Workerd journeys write `.cache/api-group`, `.cache/audio-node`, `.cache/api-grants`, and `.cache/api-recovery`; requires ffmpeg and ffprobe |
| Group data transfer | `bun run --filter @orbis/api test:transfer` | See [data transfer](data-transfer.md) for restore and comparison artifacts |
| Web client | `bun run --filter @orbis/web test` | Production browser journeys and artifacts listed in [web verification](../apps/web/README.md#verify-the-migration); install Chromium with `bun x playwright install chromium` |
| Apple client | `bun run native:lanes --journeys` | Simulator journeys; see [native clients](#native-clients) for outputs and required tools. Add `--tvos` for the Apple TV journey |

These local checks use disposable storage. Record production acceptance separately on the issue.

### Retain verification evidence

Before rerunning a lane, copy its logs, result JSON, screenshots, and result bundles to a unique directory for that run. Native runs replace `apps/apple/DerivedData/result.xcresult` and the screenshot output directory. Preserve the xcresult and console output even when a failed run exports no screenshots.

Record the commit, exact command, target platform and simulator ID, result, and artifact path together. For a failure, include the failed test and source line from the log or result bundle. Link this record from the issue or PR so the next agent can find it without reading the session history. Keep credentials out of artifacts.

## Native clients

`apps/apple/Orbis` builds one SwiftUI app for iOS, macOS, and tvOS from an xcodegen specification. The generated project and derived data are not tracked. Native lanes require macOS, Xcode, xcodegen, and an available simulator. Use the configured device host when working from Linux.

```sh
bun run native:lanes                     # unit tests and native journeys against a temporary service
bun run native:lanes --unit              # unit tests only
bun run native:lanes --tvos --journeys   # the Apple TV journey on the Apple TV simulator
bun run native:lanes --tvos --unit       # unit tests on the Apple TV simulator
```

A lane starts a temporary Orbis service with its own database and trust store, pairs a device, generates the project with that address and token, runs the tests, and exports the screenshots the journeys attached. Open the generated `apps/apple/Orbis.xcodeproj` in Xcode. Build output and `result.xcresult` live under `apps/apple/DerivedData`.

The `Orbis` scheme is iOS and macOS; the `OrbisTV` scheme builds the same app for tvOS with `OrbisTests` and the `OrbisTVUITests` journey, which drives the TV with the Siri Remote. The TV's screens live under `apps/apple/Orbis/TV`, and the phone and Mac screens the TV replaces are listed in `project.yml` under `EXCLUDED_SOURCE_FILE_NAMES[sdk=appletv*]`. A `--tvos` lane seeds silent audio and terminates the app when it ends, so a playback check never sounds in the room; playback is proven by the screen's own state.

Full and unit lanes run `bun run native:format` first. Journeys-only and `--only` runs leave that check to unit lanes and CI. The style command checks Swift sources with the Xcode toolchain's swift-format against `apps/apple/.swift-format`. swift-format ships with Xcode, so the native style gate needs no install. The check writes nothing; to fix drift, run `xcrun swift-format format --in-place` on the changed files.

Playback reliability checks use real AVPlayer instances, a real HTTP service, and a generated ten-minute Ogg file. They require ffmpeg. Repeat `--only` to select several suites in one run:

```sh
node scripts/native-lanes.mjs --only OrbisTests/PlaybackReliabilityTests --only OrbisTests/StreamingPlaybackTests --out ~/.cache/orbis-playback-evidence/run
```

The streaming fixture can withhold and release response bytes. Its tests retain raw player time, monotonic time, buffer ranges, and playback state as JSON attachments. They check actual seek landing and recovery in both directions on the media timeline. The recovery UI journeys also remove and restore Retained Audio before retrying Play from Set detail and Now Playing.

`AudioPlayer` plays a Set through a `PlaybackEngine`: `AVPlayerEngine` for Retained Audio, and `MusicKitEngine` for an Apple Music Set ([ADR 0021](adr/0021-apple-music-mixes.md)). The MusicKit engine queues the album's songs in `ApplicationMusicPlayer` and reports one clock for the whole mix; `ApplicationMusicPlayer` then owns Now Playing and the remote commands. MusicKit catalog reads and playback do not run in the simulator. `OrbisTests/AppleMusicPlaybackTests` checks the mix-time arithmetic and the engine handover with a fake engine, and the `AppleMusicUITests` journey checks the access prompt and the Open in Apple Music fallback; playing a real mix needs a device with an Apple Music subscription.

The player writes what it does to the unified log under subsystem `app.orbis`, category `player`: each play with its start and the service's length, item readiness and failures with the stream's error log, waits with their reason, stalls, and every seek with where it landed. A Set's id is hashed and titles, addresses and the token are never written. Follow it on a Mac, or a device attached to one, with:

```sh
log stream --level debug --predicate 'subsystem == "app.orbis" AND category == "player"'
```

For a reported jump or repeat, compare `Command seek`, `Seek completed`, `Time jumped`, and `Timeline discontinuity` with the numeric buffer and access records. A generation identifies one player item and a seek number identifies an app-requested seek. A discontinuity compares actual media time with monotonic time during uninterrupted playback. These records can distinguish requested seeks from unexplained timeline movement; they cannot prove that the audio file contains no repeated sound.

### Playback reports

On iPhone or Mac, open Settings and choose Copy Playback Report after a playback problem. The action builds JSON at tap time, including a fresh player snapshot and recent typed playback events from the current app run. Closing Orbis loses the report. Signing out clears it.

The report holds up to 256 entries in chronological order and states how many entries were evicted or omitted at export. Routine samples are evicted before command and incident records. If the complete UTF-8 output exceeds 256 KiB, export removes routine samples, then keeps the largest newest suffix of the other records that fits. There is no fixed time window. Each entry has wall time, monotonic uptime, player generation, seek number, normalized state and waiting reason, actual and displayed media time, audio-session readiness, pending seek state, up to eight finite buffer ranges, and the latest numeric access-log counters. The tap-time snapshot has its own wall and monotonic timestamps so it can be compared with server logs even when playback has been paused for a long time.

Commands record `app`, `systemRemote`, or `internalOperation` only when the caller is known. `systemRemote` covers the system command center and does not identify the Lock Screen, Control Center, a headset, or a car. Activation entries show the model generation, desired sound, optional media target, outcome, and request duration without naming a Set. A seek command followed by a matching seek result shows an app-requested move. A time jump or timeline discontinuity without that seek evidence is a player or stream observation, not proof of an audible skip.

The existing half-second media-time observer adds a periodic snapshot at most once every five seconds. AVPlayer may stop that observer while media time is paused or waiting, so these samples are best effort rather than a wall-clock heartbeat. Waiting and stall transitions are recorded when their callbacks arrive, and Copy always adds the current snapshot without a second timer.

The schema accepts fixed enums, booleans, counts, and finite numbers. Unknown numbers encode as `null`. The snapshot carries the playing Set id and nothing else that names content. It excludes titles, service addresses, tokens, device or account names, SDK error descriptions, error comments, and failure messages. Errors use a fixed domain category and numeric code. App version, build, OS name, and OS version are the only report metadata.

While signed in, Orbis also sends playback diagnostics automatically through the authenticated `/api/diagnostics/playback` relay to SigNoz. It polls the existing ring every five seconds, sends at most 32 entries or 64 KiB, and holds one request at a time. Each session uses a new run UUID. Signing out cancels delivery before clearing the report. Delivery failure does not change playback or add a playback error. Pending data stays in memory, so app exit loses it; timeouts can cause duplicate records identified by run UUID and sequence.

The relay validates the full fixed Codable shape, rejects unknown fields, and bounds the streamed body. Its exporter allows two active requests per app instance with no queue and gives the collector five seconds. SigNoz receives resource attributes `service.namespace=orbis`, `service.name=orbis-apple`, `service.version`, `app.build_id`, `os.name`, `os.version`, and `deployment.environment.name` (`production` on the Worker, `development` on the fixture server). Each record has `session.id` (the run UUID), `orbis.sequence`, `event.name`, `orbis.set_id` when known, the snapshot's `playback.*` fields, event-specific `playback.*` attributes such as `playback.seek.duration`, `error.type` as `<domain>:<code>`, and a fixed JSON body containing the decoded snapshot and event. A `playback.loss` record counts unacknowledged sequence history, which can include ambiguous delivery. Collector credentials stay on the server; [Worker configuration](../apps/api/README.md#worker-configuration) names its bindings.

Run the focused native probes with:

```sh
node scripts/native-lanes.mjs --only OrbisTests/PlaybackDiagnosticsSenderTests --only OrbisTests/PlaybackDiagnosticsTests --out ~/.cache/orbis-playback-evidence/signoz-native-$(date +%Y%m%d-%H%M%S)
```

The sender probes use real URLSession HTTP, exercise cancellation and refusal behavior, and play the real Ogg fixture while an upload is blocked. They retain `native-http-playback-upload.json` and `playback-upload.json` as JSON attachments. Replace `apps/server/src/fixtures/playback-upload.json` with the actual HTTP attachment after the lane, update its provenance in `.audit/signoz-failures.md`, then run:

```sh
bun run --filter @orbis/contracts build
bun test --timeout 60000 apps/server/src/playback-diagnostics.test.ts
bun run --filter @orbis/api test:playback
```

For a protected live collector check without deployment, start `scripts/fixture.ts` with a fresh `ORBIS_FIXTURE_DATA_DIR` and the three server-only `ORBIS_FIXTURE_SIGNOZ_OTLP_*` values from a secure environment. POST the actual native attachment to that fixture's `/diagnostics/playback` route with its disposable bearer. Use the fixture address and disposable token from its ready record, then retain the numeric receipt and query SigNoz by the attachment's `runId`:

```sh
curl --fail-with-body "$FIXTURE_ADDRESS/diagnostics/playback" \
  --header "Authorization: Bearer $FIXTURE_TOKEN" \
  --header "Content-Type: application/json" \
  --data-binary "@$NATIVE_UPLOAD"
```

This checks the shared authenticated relay and exporter; deployed Worker and physical device checks require separate execution.

The runner prints its screenshot directory, defaulting to `orbis-lane-shots` in the host's system temporary directory. Set `--out <unique-directory>` to choose it. Successful exports include `xcodebuild.log`, `lane.json`, attachments, and worker manifests. Follow [evidence retention](#retain-verification-evidence) before another run replaces the result bundle. For manual checks, read [UI verification](agents/ui-verification.md).

## Releases

A release is a version tag with generated notes. It has no binaries: signing, notarization, and installers are not set up.

1. Merge the changes to `main` and wait for CI to pass.
2. Tag the commit and push the tag. Use `vMAJOR.MINOR.PATCH`; a suffix such as `-rc.1` marks a pre-release.

```sh
git switch main && git pull
git tag v0.1.0
git push origin v0.1.0
```

The `Release` workflow refuses a tag that is not on `main`, then creates the GitHub Release with notes built from the merged pull requests. Delete a wrong tag with `git push origin :refs/tags/<tag>` and `gh release delete <tag>`.
