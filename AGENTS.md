## Navigation

Before locating a subsystem or choosing a verification lane, read the source and artifact map in `docs/development.md`.

## The fence

`bun install` installs lefthook hooks: each commit runs `bun run check`, and each push runs the bounded-read ratchet. Never use `--no-verify` or another way to skip a hook; `scripts/agent-guard.mjs` refuses them. When a hook fails, fix the failure or report it. Every lint or Effect diagnostic override names its rule and ends with ` -- <reason>`. [The fence](docs/development.md#the-fence) lists each check.

## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.

## Testing

- Never write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact.
- If you must test a system in isolation, first write down all the ways it could fail, then write the code.

The E2E suites are the UI journeys in `apps/apple/OrbisUITests` (`node scripts/native-lanes.mjs --journeys`, which exports screenshots) and the server tests that drive `createApp` over HTTP with a real database.

The server's expect tests print a flow as text, one `request  -> answer` line per step, into a `toMatchInlineSnapshot()` beside the steps; `transcript` in `apps/server/src/test-http.ts` renders the lines. When a behavior change is intended, accept the new text with `bun run --filter @orbis/server test:update`, then read the snapshot diff before you commit it. `CI=true bun run --filter @orbis/server test` fails on any snapshot that is not committed.

## Simulator and Xcode tests on a Mac host

From any worker host, run every simulator or Xcode step on a Mac host (Cortex or the MacBook) through the factory's lease wrapper, and drive a simulator only through the T3 device hub on a held lease. Never boot a simulator or run `xcodebuild` or `swift test` there over a bare `ssh cortex` or `ssh mac`. `factory` is `~/.local/share/factory/bin/factory` on Vanta. On Anvil, update `~/Developer/factory` to `origin/main`, run `bun install` there, and use `FACTORY_LEASE_LOG=vanta bun ~/Developer/factory/apps/observer/src/cli/main.ts`.

```sh
~/.local/share/factory/bin/factory lease run --needs simulator --device "iPhone 17 Pro" -- \
  sh -c 'bun install --frozen-lockfile && bun run --cwd packages/contracts build && node scripts/native-lanes.mjs --journeys --only OrbisUITests/PeopleUITests --udid "$LEASE_SIMULATOR_UDID"'
```

- Which journeys: run `factory journeys` in the checkout first. It reads `simulator-scope.json` and names the journey classes the diff reaches. Run each with `--only`; run none when it says `No simulator needed`, and the full suite only when it names the whole `OrbisUITests` target. Add a rule to `simulator-scope.json` when you add a journey class or an app file. `node scripts/check-simulator-scope.mjs`, which `bun run fence` runs, fails when a rule leaves out the tests of another rule whose files use a type its files declare; give the declaring file its own rule with those tests. `factory lease run` asks no lease for a diff the map says needs none, and does not run a command again on a tree where it already passed (PAL-2063).
- The base device is `iPhone 17 Pro`, or `iPhone Duo` on the MacBook. Never an iPad or another iPhone: `factory lease run` refuses them, though the app still builds for iPad. `LayoutUITests/testMainScreensInLandscape` runs only on an iPad, so it skips on these devices. The wrapper clones it as a `lease-` simulator, so pass the clone with `--udid "$LEASE_SIMULATOR_UDID"`. A host without the base device gets one.
- The wrapper waits for a free simulator slot. A second test waits; it does not boot a second simulator. After 30 min it exits 75 and prints why it waited: report that reason on the issue.
- It copies the checkout's tracked and unignored files, uncommitted changes included, to the issue's `~/.cache/agent-scratch/sat-orbis-<issue>/` folder on the Mac host, runs the command from the same directory, streams the output, removes the simulator, and exits with the command's code. The folder, its build folders and its DerivedData stay until the PR merges, so the next step builds warm. The first copy has no `node_modules` or `dist`, so the command runs `bun install` and builds `@orbis/contracts`, which the lanes' temporary service imports.
- `--out <dir>` gives the command an empty folder in `$LEASE_OUT` and copies what it writes there, such as an `.app`, an `.xcresult` or logs, back to `<dir>`.
- A full `--journeys` run tests on two clones of the simulator in parallel; run it only when `factory journeys` names the whole target. On the 8 GB Cortex, run one journey class at a time with `--only`.
- For an Xcode build or test with no simulator, such as `--unit --macos` or `swift test`, use `--needs xcode`. It boots nothing. `bun run ci` runs its macOS checks this way.
- For a UI check by hand, hold the simulator instead: `factory lease run --hold --needs simulator --device "iPhone 17 Pro"` in the background prints `{ lease, host, hubHostId, udid }`. Run each build or `simctl` step with `factory lease run --lease <lease> [--out <dir>] -- <command>`, drive the app with `device_open` on that `hubHostId` and `udid`, and end with `device_close` and `factory lease release <lease>`. `docs/agents/ui-verification.md` has the steps.
- Cortex takes Xcode steps only. Simulators go to the MacBook, which holds 2 booted simulators at most, Parth's own included. `--host cortex` or `--host mac` pins the host. The MacBook takes tests only from 23:00 to 09:00 America/Los_Angeles, or when Parth opens it.

## Feature flags and `verify`

- A UI change in `apps/apple`, `apps/web` or `apps/raycast` can merge behind an off flag. Declare it in `flags.json` with `state: "off"`, run `bun run flags generate`, and read it only through its generated accessor. Never turn a flag on: the factory opens the flip PR and Parth merges it. [Feature flags](docs/development.md#feature-flags) has the steps.
- The factory merges an Orbis PR only when the commit status `verify` on its head is `success`. `bun run ci` posts it with `local-ci`. To run it and keep the evidence, use the verify skill: `.agents/skills/verify/SKILL.md`.

## Local Effect Source

The Effect source repository is available at `~/.local/share/effect-solutions/effect` for reference. Use it to explore APIs, find usage examples, and understand implementation details when the documentation is not enough.

## Apple documentation

On the Mac, read Xcode's bundled Apple docs first (the `axiom-apple-docs` skill). On Vanta, which has no Xcode, fetch Apple API docs, the Human Interface Guidelines, and WWDC transcripts as Markdown with `bunx @nshipster/sosumi fetch <developer.apple.com path or URL>`, or find a page with `bunx @nshipster/sosumi search "<query>"`.

## Agent skills

### Issue tracker

Use Linear (team Pallas, project Orbis). Before reading or publishing specs and tickets, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. Before applying triage labels, read `docs/agents/triage-labels.md`.

### Domain docs

Use a single root glossary and ADR directory. Before exploring domain behavior, read `docs/agents/domain.md`.

## Verifying the Mac UI

Three tools, quietest first:

- **agent-device** reads a macOS or iOS app through accessibility. Its snapshot answers most questions.
- **agent-browser** drives web pages through the executor MCP. Run it headless.
- **Codex computer use** acts on the visible screen. Four integrations carry it and only `codex-computer-use` holds the full set, including `set_value` and `scroll`; reach it with `tools.search` from the executor's `execute` tool.

Before driving a real build by hand, read `docs/agents/ui-verification.md`. It records the traps that cost time or produce a wrong conclusion: choosing the platform and session, ref lifetime, and the system alerts that make a screenshot unusable as evidence.

- If using XcodeBuildMCP, use the installed XcodeBuildMCP skill before calling XcodeBuildMCP tools.

## Gardening

The scheduled gardening run measures the repo with `bun run garden`, which runs `garden sense` and prints one schema-2 JSON report. `garden` is the garden-cli app of Pallas-Labs/factory. It has no release yet, so Orbis pins no package: `scripts/garden` runs `$GARDEN_BIN` when it is set, or else the `garden` on `PATH`, and exits 2 with build steps when it finds neither. On Vanta, both come from the factory checkout's `main`. `garden.config.json` sets what each probe reads; [Gardening sensor](docs/development.md#gardening-sensor) lists the probes.

- In a fresh worktree, run `bun install --frozen-lockfile` before `bun run garden`. Without it, `lint.oxlint` and `deadcode.oxlint` skip as a missing tool.
- `bun run garden --with-gate` also runs each `bun run check` task alone and records its time. `--out <dir>` also writes the report to a new UTC-named file in that directory.
- `bun run garden --compare <previous.json>` keeps the report on stdout and writes the comparison to stderr. `scripts/garden compare --format markdown <before> <after>` compares two saved reports. A finding whose probe was skipped, failed, or changed scope on either side is `unverified`, never resolved.
- `scripts/garden report --finding <ID> --history <dir> --baseline <before> <current>` drafts one finding's PR evidence: where it is, how long it has repeated, and the fix options with their costs. It never picks a fix.
- The schema-2 baseline is the report of `7b7b9c9`, which PAL-875 links. Schema-1 reports from before it compare only with `scripts/garden compare --legacy-repo orbis`, and every change reads `unverified`.
- A finding ID is `g2:` and a SHA-256 of its repo, probe, rule, path, and normalized text, not its line. A missing tool or a macOS-only probe on Linux skips; missing observations never count as zero.
- Gardening PRs carry the GitHub label `gardening` and wait for Parth's review. Never merge one yourself.
- Only one gardening PR may be open at a time.
- Linear issue PAL-875 ("Gardening buffer") is the loop's memory. Its "Standing feedback" section wins over a run's own judgment.

## Diagnosing the service on Vanta

Before diagnosing a failed download or a service fault on Vanta, read "Where to look when a download fails" in `deploy/orbis-server/README.md`. On Vanta the checkout is `~/Developer/orbis-service` and the data is `~/Developer/orbis-service-data`, so the nightly download canary's latest result is `~/Developer/orbis-service-data/canary/last.json`.
