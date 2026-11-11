---
name: verify
description: Verify an Orbis commit and post its `verify` commit status. Runs the Orbis gate (`bun run ci`, Linux checks here and macOS checks on a leased Mac), keeps the log, and reads the `local-ci` and `verify` statuses back from GitHub. Use it on every Orbis PR head after a push, as a worker or a reviewer, and when a factory step says Orbis has no `verify` on a head. The feature map also says how to check a flag and the Apple UI journeys.
---

# Verify Orbis

The factory merges an Orbis PR only after the commit status `verify` on its head is `success`. Orbis runs no GitHub Actions, so `bun run ci` is its CI: when every step passes on a clean, pushed commit, it posts `local-ci` and `verify` on that commit. A failed run posts nothing. This skill runs that command, keeps the evidence, and proves the statuses landed.

Today `verify` means CI build plus unit tests (factory v2 spec §4.5). Simulator UI journeys do not gate yet; [features/ui-journeys.md](features/ui-journeys.md) says how to run them by hand.

## Launch

There is no server to start. The gate runs on the checkout itself:

1. Check out the commit to verify, clean, and push it. `bun run ci` refuses a dirty tree, and GitHub refuses a status on a commit it does not have.
2. Run `bun install --frozen-lockfile` once in a fresh worktree, so the lefthook hooks exist. `bun run ci` installs again itself.

Ready means `helpers/doctor` prints no `FAIL`.

## Doctor

```sh
.agents/skills/verify/helpers/doctor
```

Read-only. One `PASS` or `FAIL` line each for: a clean tree, HEAD on a remote branch, `bun`, `gh` (signed in), `ffprobe` (the HTTP download tests need it), and, off a Mac, the factory CLI for the Mac lease. Exit 1 on any `FAIL`. Run it first whenever anything looks off.

## Drive

```sh
.agents/skills/verify/helpers/gate                 # run bun run ci, post, read back
.agents/skills/verify/helpers/gate --no-status     # run only: posts nothing
.agents/skills/verify/helpers/gate --mac-host mac  # other flags go to bun run ci
```

`gate` runs `doctor`, then `bun run ci`:

- Linux lane, here: `bun install --frozen-lockfile`, Playwright's Chromium, `bun run check` (Oxlint with the fence rules, oxfmt, design tokens, `flags:check`, the bounded-read ratchet, the fence tests, tsgo, tests, Effect diagnostics, React Doctor's task), then React Doctor on `apps/web` against `origin/main`.
- macOS lane, at the same time: `bun run native:format` and `swift test` for `OrbisDesign`, through `factory lease run --needs xcode` (Cortex or the MacBook). The lease can wait for a free Xcode slot; let it wait.

The run takes about 10 minutes when the Mac slot is free. Run it in the background and wait on it; do not start a second copy on the same checkout.

## Evidence

`gate` writes to `$VERIFY_OUT`, else `~/.cache/agent-scratch/verify-orbis/<sha7>-<epoch>/`:

- `ci.log`: the whole `bun run ci` output, both lanes, with each step's time.
- `statuses.json`: the newest `local-ci` and `verify` status on the commit, read back from GitHub after the post.
- `summary.json`: `{ sha, exit, posted, log }`.

Proof standard: the log ends `local-ci: passed. Posted local-ci=success and verify=success on ParthMmm/orbis@<sha>.`, and `statuses.json` shows both contexts at `success` for that same SHA. A post that `statuses.json` does not show did not happen. Quote the SHA, the exit code and both states in the PR or review; link the commit's status page, `https://github.com/ParthMmm/orbis/commit/<sha>`.

## Cleanup

`bun run ci` cleans up after itself: the Mac lease ends with the command. If you stop a run, stop the `bun run ci` process you started (by its PID, never by name); the factory releases the lease when its command ends. Never delete the evidence folder in cleanup. It lives under `~/.cache/agent-scratch`, which removes it after 14 days unchanged.

## Helpers

- `helpers/doctor`: the checks above. No arguments.
- `helpers/gate [bun run ci flags]`: doctor, the gate, the evidence. Exits with `bun run ci`'s code.

## Feature map

[features/README.md](features/README.md) lists what the gate covers and how to prove each part.
