## Navigation

Before locating a subsystem or choosing a verification lane, read the source and artifact map in `docs/development.md`.

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

## Local Effect Source

The Effect source repository is available at `~/.local/share/effect-solutions/effect` for reference. Use it to explore APIs, find usage examples, and understand implementation details when the documentation is not enough.

## Apple documentation

On the Mac, read Xcode's bundled Apple docs first (the `axiom-apple-docs` skill). On Vanta, which has no Xcode, fetch Apple API docs, the Human Interface Guidelines, and WWDC transcripts as Markdown with `bunx @nshipster/sosumi fetch <developer.apple.com path or URL>`, or find a page with `bunx @nshipster/sosumi search "<query>"`.

## Agent skills

### Issue tracker

Use GitHub Issues in ParthMmm/orbis. Before reading or publishing specs and tickets, read `docs/agents/issue-tracker.md`.

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

The scheduled gardening run measures the repo with `bun run garden`, which prints one schema-1 JSON record and needs no network or secrets. Add `--with-gate` to also run and time each `bun run check` task, `--out <file>` to save the JSON, and `--compare <previous.json>` to print a Markdown summary of metric changes and new, repeated, and resolved findings. [Gardening sensor](docs/development.md#gardening-sensor) lists what it counts.

- Gardening PRs carry the GitHub label `gardening` and wait for Parth's review. Never merge one yourself.
- Only one gardening PR may be open at a time.
- Linear issue PAL-875 ("Gardening buffer") is the loop's memory. Its "Standing feedback" section wins over a run's own judgment.

## Diagnosing the service on Vanta

Before diagnosing a failed download or a service fault on Vanta, read "Where to look when a download fails" in `deploy/orbis-server/README.md`. On Vanta the checkout is `~/Developer/orbis-service` and the data is `~/Developer/orbis-service-data`, so the nightly download canary's latest result is `~/Developer/orbis-service-data/canary/last.json`.
