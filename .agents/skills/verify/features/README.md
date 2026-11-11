# Orbis verification map

This directory is the maintained source for verifying an Orbis commit. Read this index first, then use the matching feature file as the recipe.

## Baseline preconditions

- A clean checkout of the commit to verify, pushed to `ParthMmm/orbis`.
- `bun install --frozen-lockfile` has run once in the checkout.
- `.agents/skills/verify/helpers/doctor` prints no `FAIL`.
- Run one gate per checkout at a time. Two `bun run ci` runs on one checkout race on `node_modules` and the Turbo cache.

## Driving conventions

- Run every command from the repo root.
- Run the gate through `helpers/gate`, not bare `bun run ci`, so the evidence is kept.
- Run every Xcode or simulator step through `factory lease run`, never over a bare `ssh` (AGENTS.md, "Simulator and Xcode tests on a Mac host").
- Never edit the checkout while the gate runs: `bun run ci` then posts nothing.

## Proof and skip reporting

- Gate proof is `ci.log`, `statuses.json` and `summary.json` from one `helpers/gate` run, all naming the same SHA.
- Flag proof is the command, its output and its exit code.
- Report a lane that could not run (for example, a Mac lease that exited 75) with its printed reason. A run that did not post `verify` is not verified.

## Feature entry contract

Each feature file has an H1 title and one paragraph, then four H2 sections in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`, `Gotchas`.

## Features

- [Gate and verify status](./gate.md): `bun run ci` on a head, and the `local-ci` and `verify` statuses it posts.
- [Feature flags](./flags.md): `flags.json`, the generated accessors, `flags:check` and the lint rule.
- [Apple UI journeys](./ui-journeys.md): the simulator journeys, by hand. They do not gate yet.
