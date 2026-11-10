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
| Rune desktop client | [`apps/rune`](../apps/rune) and its [README](../apps/rune/README.md) |
| Native fixture setup and HTTP client | [`scripts/native-lanes.mjs`](../scripts/native-lanes.mjs), [`seed-lane-audio.mjs`](../scripts/seed-lane-audio.mjs), and [`LaneService.swift`](../apps/apple/OrbisUITests/LaneService.swift) |
| Domain terms and decisions | [GLOSSARY.md](../GLOSSARY.md) and [ADRs](adr) |

Resolve a filename with `rg --files <directory>` before reading it. Server HTTP tests live beside the implementation in `apps/server/src`; native fixture setup lives in the lane runner. Historical plans in `docs/plans` record earlier build sequences and are not current setup instructions.

## Setup

Requires Bun 1.4.4 and Node.js 24. TypeScript 7 is pinned and patched with Effect diagnostics by the install preparation script. The audio node and disposable HTTP fixtures run on Bun.

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

Run `bun run check` for cached lint, formatting, the bounded-read ratchet, the fence's own tests, TypeScript, tests, Effect diagnostics, and React Doctor. Its `test` task also runs the Rune client's gate, `apps/rune/scripts/check` (rustfmt, clippy, tests and scene goldens), which needs rustup and, on Linux, the `libxkbcommon` and `wayland` development files. Turbo runs independent tasks in parallel, bounded by the available CPU count, and builds shared contracts before consumers. `bun run check:force` bypasses task-cache reads. `bun run fix` applies Ultracite fixes; it is never cached.

React Doctor is the `doctor` task of `apps/web`: `bunx react-doctor@0.9.18 . --scope changed --base origin/main --blocking error`, the command, version and blocking level the `Code quality` workflow's React Doctor action ran for `apps/web`. It reports only the errors the checkout adds against `origin/main`, so `origin/main` must be fetched. The task is never cached, because its result depends on that ref.

Typechecks use separate incremental files so they do not race with builds.

### The fence

The fence (PAL-1543) puts rat-stack's first five principles into the checks, so the easy path is the right one. Each part runs in `bun run check`, so `bun run ci` runs it too.

- Hooks. `bun install` runs `prepare`, which patches TypeScript and Oxlint with `@effect/tsgo` and runs `lefthook install`. [`lefthook.yml`](../lefthook.yml) runs `bun run check` on each commit and the bounded-read ratchet on each push. [`scripts/agent-guard.mjs`](../scripts/agent-guard.mjs), a Claude Code `PreToolUse` hook in `.claude/settings.json`, refuses `--no-verify` (also quoted, escaped or abbreviated), `git commit -n`, `LEFTHOOK=0` and `core.hooksPath`. It reads the command as shell words, so only the values of message options such as `-m` and `--body`, and heredoc bodies, count as text. When a hook fails, fix the failure or report it; never skip the hook.
- Bounded reads. [`scripts/check-bounded-reads.mjs`](../scripts/check-bounded-reads.mjs) (`bun run bounded-reads`) fails a database read in `apps/server/src` or `apps/api/src` with no row bound that [`scripts/bounded-reads.baseline.json`](../scripts/bounded-reads.baseline.json) does not list: a Drizzle `.select()` with no `.limit()` or `.get()`, or a raw `SELECT` with no `LIMIT`. Aggregate-only reads pass, and so do subqueries: a select that ends in `.as()` or is an argument of `inArray`, `notInArray`, `exists` or `notExists`. A wrapper that runs the read, such as `execute(...)`, does not exempt it. A listed read that is gone also fails until `--update-baseline` drops it, so the baseline only shrinks. Mark a read bounded another way with `// bounded-read: <why>` on its line or the line above.
- Lint. [`lint-plugins/orbis/index.mjs`](../lint-plugins/orbis/index.mjs), copied from the factory's PAL-1542 plugin, adds `orbis/fetch-needs-timeout`, `orbis/bounded-concurrency`, `orbis/no-shared-pending-cache`, `orbis/no-module-level-mutable-state` (the last two ported from rat-stack) and `orbis/directive-needs-reason`. Every lint or Effect diagnostic override names its rule and ends with ` -- <reason>`. An `Effect.cached` or `Cache.make` override names PAL-1546, which decides between them and rat-stack's completed-value cache.
- Type-aware lint. Oxlint runs with type information and the `@effect/tsgo` `correctness` and `antipattern` presets, at error with `--deny-warnings`. `oxlint.config.ts` lists two ledgers that only shrink: Ultracite's type-aware rules that report today (PAL-1681), and Effect preset findings in older server files (PAL-1679).
- Effect diagnostics. `tsconfig.base.json` sets `ignoreEffectWarningsInTscExitCode: false`, so an Effect warning fails the typecheck, and lists the unstable Effect modules Orbis uses in `allowedUnstableApis`.
- [`scripts/fence.test.mjs`](../scripts/fence.test.mjs) (`bun run fence`) runs real Oxlint on `lint-plugins/orbis/fixtures`, plants unbounded reads and hook bypasses, and type-checks a planted Effect warning.

### Local CI

Orbis runs no GitHub Actions. The `Code quality` and `Release` workflows stay in `.github/workflows` but are disabled. CI is one local command on a clean checkout of the commit to check:

```sh
bun run ci                  # Linux checks here, macOS checks on cortex over ssh
bun run ci --mac-host mac   # macOS checks on another ssh host
bun run ci --no-status      # run the checks, post no status
```

[`scripts/local-ci.mjs`](../scripts/local-ci.mjs) runs what the `Code quality` workflow ran:

- `bun install --frozen-lockfile`, Playwright's Chromium, and `bun run check`. The HTTP download tests need `ffprobe` on `PATH`.
- React Doctor on `apps/web`, failing on an error that the commit adds against `origin/main` (`--base` changes the ref).
- At the same time, `bun run native:format` and `swift test` for `OrbisDesign` on a Mac. From Linux, it copies `apps/apple` at `HEAD` to `~/.cache/orbis-local-ci/<sha>` on the host and removes it afterward. On a Mac with no `--mac-host`, it uses the checkout itself.

When every step passes, it posts the commit status `local-ci` = `success` on `HEAD`, so push the commit first. A green `local-ci` status is the "checks green" signal for review and merge. A failed run posts nothing.

Lint also runs seven rules from the t3code oxlint plugin, vendored in [`lint-plugins/t3code`](../lint-plugins/t3code) and scoped in [`oxlint.config.ts`](../oxlint.config.ts). A suppression comment needs a reason, a test registers cases with `test.each`, and a test sets no per-test timeout (the server test script sets one ceiling).

Individual checks and packaging remain available:

```sh
bun run typecheck
bun run test
bun run build
bun run format:check
```

## Gardening sensor

`bun run garden` runs `scripts/garden sense`, which starts the `garden` CLI (see AGENTS.md "Gardening") on the current checkout and prints one schema-2 JSON report: the run context, then one entry per probe that is `complete`, `skipped` with a reason, or `error`. It needs no network, secrets, or env files and takes a few seconds on Vanta. `garden.config.json` enables these probes:

| Probe | What it counts |
| --- | --- |
| `lint.oxlint` | oxlint diagnostics with the repo's configuration |
| `deadcode.oxlint` | oxlint unused-code diagnostics (`no-unused-vars` and its kin); TypeScript's `noUnusedLocals` runs in the gate |
| `source.suppressions` | `eslint-disable`, `oxlint-disable`, `biome-ignore`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `@effect-diagnostics`, `oxfmt-ignore`, `prettier-ignore`, `swiftlint:disable`, `swift-format-ignore`, `periphery:ignore`, and `shellcheck disable` comments |
| `source.unsafe-operations` | each `as` cast other than `as const`, and each `!` non-null assertion, in TypeScript code; each `try!`, `as!`, and force unwrap in Swift code |
| `source.skipped-tests`, `source.focused-tests` | `.skip`, `.todo`, and `.only` tests, `XCTSkip`, `withKnownIssue`, and `.disabled` traits in test files |
| `source.markers` | `TODO`, `FIXME`, `HACK`, and `XXX` markers followed by a colon or a parenthesis |
| `docs.stale-refs` | backticked repository paths whose parent directory exists but which do not, and `bun run` scripts that no `package.json` defines; the gitignored Xcode project and DerivedData are not stale |
| `history` | commits in the 14 days before `HEAD` that revert a commit, or whose subject or body names a workaround or a flaky test |
| `format.swift-format` | the `native:format` command's diagnostics; macOS only, so Vanta reports it skipped |
| `gate` | with `--with-gate`, the time and exit code of each `bun run check` task run alone with `--force` |

The source probes read comments, code, and syntax by language, so prose, strings, and examples do not count. They skip `.audit`, `docs/plans`, `docs/audits`, `docs/research`, the shadcn components that `oxlint.config.ts` also ignores, and garden's default exclusions: dependencies, fixtures, generated files, and lock files. `scripts/garden-launcher.test.mjs` keeps the swift-format command and the gate steps equal to `native:format` and `check` in `package.json`.

## Verification lanes

Build shared contracts before running a focused lane from the repository root:

```sh
	bun run --filter @orbis/contracts build
```

| Change | Command from repo root | Evidence and prerequisites |
| --- | --- | --- |
| Bun HTTP handlers | `bun run --filter @orbis/server test` | Real database HTTP tests in `apps/server/src`; retain command output for failures |
| Orbis Link page and preview image | `bun scripts/share-preview.ts --out <directory>` | Writes the PNG, page HTML, and render times for a fixture Set; add `--serve` to keep it answering for curl |
| Cloudflare Group and audio node | `bun run --filter @orbis/api test` | Workerd journeys write `.cache/api-group`, `.cache/audio-node`, `.cache/api-grants`, and `.cache/api-recovery`; requires ffmpeg and ffprobe |
| Group data transfer | `bun run --filter @orbis/api test:transfer` | See [data transfer](data-transfer.md) for restore and comparison artifacts |
| Web client | `bun run --filter @orbis/web test` | Production browser journeys and artifacts listed in [web verification](../apps/web/README.md#verify-the-migration); install Chromium with `bun x playwright install chromium` |
| Rune desktop client | `apps/rune/scripts/check` | Press tests and scene goldens in `apps/rune/goldens`; for a live window, `apps/rune/scripts/stand-in` (see the [Rune README](../apps/rune/README.md#against-a-stand-in-orbis)) |
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

The `Orbis` scheme is iOS and macOS; the `OrbisTV` scheme builds the same app for tvOS with `OrbisTests` and the `OrbisTVUITests` journey, which drives the TV with the Siri Remote. The TV's screens live under `apps/apple/Orbis/TV`, and the phone and Mac screens the TV replaces are listed in `project.yml` under `EXCLUDED_SOURCE_FILE_NAMES[sdk=appletv*]`. A `--tvos` lane seeds silent audio and terminates the app when it ends, so a playback check never sounds in the room; playback is proven by the screen's own state. Its service gives an Approval Request 12 seconds instead of 2 minutes (`ORBIS_FIXTURE_APPROVAL_LIFETIME_MS`), so `TVSignInJourney` sees the signed-out TV replace an expired code, and approves the new one through the lane service.

Full and unit lanes run `bun run native:format` first. Journeys-only and `--only` runs leave that check to unit lanes and `bun run ci`. The style command checks Swift sources with the Xcode toolchain's swift-format against `apps/apple/.swift-format`. swift-format ships with Xcode, so the native style gate needs no install. The check writes nothing; to fix drift, run `xcrun swift-format format --in-place` on the changed files.

Playback reliability checks use real AVPlayer instances, a real HTTP service, and a generated ten-minute Ogg file. They require ffmpeg. Repeat `--only` to select several suites in one run:

```sh
node scripts/native-lanes.mjs --only OrbisTests/PlaybackReliabilityTests --only OrbisTests/StreamingPlaybackTests --out ~/.cache/orbis-playback-evidence/run
```

The streaming fixture can withhold and release response bytes. Its tests retain raw player time, monotonic time, buffer ranges, and playback state as JSON attachments. They check actual seek landing and recovery in both directions on the media timeline. The recovery UI journeys also remove and restore Retained Audio before retrying Play from Set detail and Now Playing.

`AudioPlayer` plays a Set through a `PlaybackEngine`: `AVPlayerEngine` for Retained Audio, and `MusicKitEngine` for an Apple Music Set ([ADR 0021](adr/0021-apple-music-mixes.md)). The MusicKit engine queues the album's songs in `ApplicationMusicPlayer` and reports one clock for the whole mix; `ApplicationMusicPlayer` then owns the audio session, Now Playing, and the remote commands. MusicKit plays out of process, and its start interrupts an active audio session of Orbis's, so `AudioPlayer` brings up no session of its own for an Apple Music Set (PAL-1160). MusicKit catalog reads and playback do not run in the simulator. `OrbisTests/AppleMusicPlaybackTests` checks the mix-time arithmetic and the engine handover with a fake engine, the `AppleMusicUITests` journey checks the access prompt and the Open in Apple Music fallback, and `TVJourney` checks the same prompt on the TV, where the Set page says to open Apple Music instead; playing a real mix needs a device with an Apple Music subscription.

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

While signed in, Orbis also sends playback diagnostics automatically through the authenticated `/api/diagnostics/playback` relay to SigNoz. Delivery keeps its own queue of unsent entries, separate from the report's ring, so a sample the ring evicts on arrival is still sent. Every five seconds it sends the oldest unsent entries, at most 32 entries or 64 KiB, and holds one request at a time. Each session uses a new run UUID. Signing out cancels delivery before clearing the report. Delivery failure does not change playback or add a playback error.

Delivery is at least once. An entry stays queued until the Group answers 200. After a transport failure, a timeout, a response that is not a receipt, or 408, 429, 502, 503 or 504, the same entries are sent again, after a wait that doubles from five seconds to a minute (or the `Retry-After`, if longer). A batch the collector stored without the app hearing back therefore arrives twice; the run UUID and sequence identify the copies. Any other status refuses the batch for good, and 401, 403, 404 or a `Retry-After` over 300 seconds stops delivery. Entries are lost only in two cases, and the app names each one in the `lost` ranges of a later batch, once: the Group refused their batch, or the queue held more than 1,024 unsent entries and evicted the oldest. The queue stays in memory, so app exit loses it, unnamed.

The relay validates the full fixed Codable shape, rejects unknown fields, and bounds the streamed body. Its exporter allows two active requests per app instance with no queue and gives the collector five seconds. SigNoz receives resource attributes `service.namespace=orbis`, `service.name=orbis-apple`, `service.version`, `app.build_id`, `os.name`, `os.version`, and `deployment.environment.name` (`production` on the Worker, `development` on the fixture server). Each record has `session.id` (the run UUID), `orbis.sequence`, `event.name`, `orbis.set_id` when known, the snapshot's `playback.*` fields, event-specific `playback.*` attributes such as `playback.seek.duration`, `error.type` as `<domain>:<code>`, and a fixed JSON body containing the decoded snapshot and event. The relay writes one `playback.loss` WARN record for each range the app declares lost, with `playback.after_sequence`, `playback.through_sequence` and `playback.lost_count`; the range is `(after, through]`. It never infers loss from a gap between batches, because such a gap can be a batch the collector stored without the app hearing back. Deploy a Group that accepts `lost` before an app build that sends it: an older Group refuses a batch that names a loss. Collector credentials stay on the server; [Worker configuration](../apps/api/README.md#worker-configuration) names its bindings.

Each snapshot's `bufferRanges` copies AVPlayer's [`loadedTimeRanges`](https://developer.apple.com/documentation/avfoundation/avplayeritem/loadedtimeranges) as AVPlayer reports them, finite ranges only, up to eight. For Ogg Opus, which Retained Audio uses, these ranges are not a buffer measure. On the lanes' 600-second Ogg fixture, while the file was still downloading, AVPlayer reported one zero-length range that starts near the play position, such as `[4.17, 0]`, in all 207 samples of ordinary streaming. After a seek it reported a range with a fixed duration of 611.98 seconds whatever its start, so the range runs past the item's end (`[479.94, 611.98]`), or no range at all. No lane downloads the whole file. In production, samples cover the whole file only after the download completes: 39 of 8,293 samples from 2026-10-19 to 2026-10-28. Use `access.bytesTransferred` for how much of the file has arrived.

Run the focused native probes with:

```sh
node scripts/native-lanes.mjs --only OrbisTests/PlaybackDiagnosticsSenderTests --only OrbisTests/PlaybackDiagnosticsTests --only OrbisTests/StreamingPlaybackTests --out ~/.cache/orbis-playback-evidence/signoz-native-$(date +%Y%m%d-%H%M%S)
```

The sender probes use real URLSession HTTP against the lane fixture. Its `/diagnostics-control` route sets a `status`, a `fault` (`close-before-body` drops the connection before reading the batch; `close-after-body` keeps the batch, then drops the connection without a response), and `times`, the number of requests the status or fault applies to. `/diagnostics-state` returns what the relay would have written: every delivered sequence and every loss range, through the relay's own `playbackLosses`. The probes cover transport failure, a stored but unacknowledged batch, 429 and 503, HTTP 400, a ring full of incidents followed by samples, and the 1,024-entry bound, and assert that every recorded sequence arrives or lies in a declared loss range. They also exercise cancellation and refusal behavior, and play the real Ogg fixture while an upload is blocked. `StreamingPlaybackTests` checks at each timeline sample that the report's `bufferRanges` equal `loadedTimeRanges`. They retain `native-http-playback-upload.json` and `playback-upload.json` as JSON attachments. Replace `apps/server/src/fixtures/playback-upload.json` with the actual HTTP attachment after the lane, update its provenance in `.audit/signoz-failures.md`, then run:

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

1. Merge the changes to `main` with a green `local-ci` status.
2. Tag the commit and push the tag. Use `vMAJOR.MINOR.PATCH`; a suffix such as `-rc.1` marks a pre-release.

```sh
git switch main && git pull
git tag v0.1.0
git push origin v0.1.0
```

The `Release` workflow is disabled, so create the GitHub Release yourself. Check that the tag is on `main`, then build the notes from the merged pull requests:

```sh
git merge-base --is-ancestor v0.1.0 origin/main && gh release create v0.1.0 --verify-tag --generate-notes --title v0.1.0
```

Add `--prerelease` for a tag with a suffix. Delete a wrong tag with `git push origin :refs/tags/<tag>` and `gh release delete <tag>`.
