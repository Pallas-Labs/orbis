# Gate and verify status

The factory merges an Orbis PR only when `verify` on its head is `success`. `bun run ci` runs the Linux and macOS checks on a clean, pushed commit and, when every step passes, posts `local-ci` and `verify` on it.

## Sub-features

- `gate-pass` posts `local-ci=success` and `verify=success` on the SHA the run started on.
- `gate-fail` posts nothing when a step fails.
- `gate-moved` posts nothing when the checkout changed or HEAD moved during the run.
- `gate-dirty` refuses to start on a dirty tree.

## How to get to it (user POV)

- A worker or reviewer runs `.agents/skills/verify/helpers/gate` on a PR head after a push.
- `bun run ci` by hand runs the same gate without keeping evidence.

## Driving it with helpers/gate

Preconditions:

- The baseline in [README.md](./README.md).

- **Pass.** Run `.agents/skills/verify/helpers/gate`. Exit code `0`; `ci.log` ends `local-ci: passed. Posted local-ci=success and verify=success on ParthMmm/orbis@<sha>.`; `statuses.json` lists `local-ci` and `verify`, both `success`.
- **Read back by hand.** Run `gh api repos/ParthMmm/orbis/commits/<sha>/status --jq '.statuses[] | "\(.context) \(.state)"'`. Both contexts read `success`.
- **Dirty tree.** With an uncommitted edit, run `bun run ci --no-status`. Exit code `1` and `local-ci: the working tree has changes.`; nothing posts.
- **Run only.** Run `.agents/skills/verify/helpers/gate --no-status`. The checks run; `summary.json` reads `"posted":false` and `statuses.json` is `[]`.

## Gotchas

- `helpers/doctor` fails before the run when HEAD is on no remote branch; push first.
- The macOS lane waits for a free Xcode slot on Cortex or the MacBook. After 30 min a lease asks again; when the factory gives up it exits 75 with its reason. Report that reason; do not count the run.
- `scripts/local-ci.test.mjs` does not stub the factory CLI, so running it starts real Mac leases. `bun run check` does not run it.
