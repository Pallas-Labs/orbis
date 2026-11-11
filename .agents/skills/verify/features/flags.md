# Feature flags

A UI change can merge behind an off flag. `flags.json` declares each flag; `bun run flags generate` writes the Swift and TypeScript accessors; every build reads the declared state, and a Debug Apple build launched with `-flags all-on` reads every flag as on. [docs/development.md, "Feature flags"](../../../../docs/development.md#feature-flags) has the steps.

## Sub-features

- `flags-check` fails on a malformed or non-canonical `flags.json`, a stale generated file, or a declared flag no code reads.
- `flags-lint` refuses a `getBooleanValue` call outside `flags.gen.ts` (`orbis/no-flag-read-by-string`).
- `flags-all-on` makes a Debug Apple build read every flag as on.

## How to get to it (user POV)

- `bun run flags:check`, alone or inside `bun run check` and `bun run ci`.
- `bun run lint`.
- Launch a Debug build with the arguments `-flags all-on`.

## Driving it with bun

Preconditions:

- The baseline in [README.md](./README.md). These steps edit files: run them in a scratch copy, or restore with `git checkout -- flags.json flags.schema.json apps/apple/Flags apps/web/src` afterwards.

- **Clean.** Run `bun run flags:check`. Exit `0`, `flags check: ok`.
- **Hand edit.** Add a flag to `flags.json` by hand without generating. `bun run flags:check` exits `1` and names `flags.json is not in its canonical form` and the stale generated files.
- **Unread flag.** Run `bun run flags generate`, then `bun run flags:check`. Exit `1`: `flag <key> is declared, but no code reads <accessor>`.
- **Read by key.** Add `client.getBooleanValue("<key>", false)` in `apps/web/src`. `bun run lint` reports `orbis/no-flag-read-by-string`.

## Gotchas

- No rule reads a date: `flags:check` never fails because a `removeBy` day has passed (factory v2 spec §7, objection 4). The factory files the removal issue and its 48 h rule reports it late.
- `internal` is refused: Orbis's server does not know who views a flag.
- The generated Swift lives in `apps/apple/Flags/`, not `apps/apple/Orbis/`, so `native:format` does not lint it.
