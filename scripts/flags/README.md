# flags CLI

`flags.bundle` is a JavaScript bundle of the `flags` CLI from `packages/flags` in Pallas-Labs/factory (PAL-1848). Its first comment names the factory commit. The factory repo is private, so a checkout cannot install the package; Orbis commits the bundle and runs it as `bun run flags <command>`:

- `bun run flags generate` writes `flags.json` in canonical form, `flags.schema.json`, `apps/apple/Flags/Flags.gen.swift` and `apps/web/src/flags.gen.ts`.
- `bun run flags:check` fails when `flags.json` is malformed or not canonical, a generated file is stale, or no code reads a declared flag. `bun run check` runs it, so the commit hook and `bun run ci` do too.

The bundle has no code extension such as `.js`, so `flags check` does not read it when it looks for code that reads a flag. With a `.js` name, the CLI's own property names, such as `.name` or `.state`, would count as reads. Bun runs the file as JavaScript all the same.

Do not edit the bundle. To update it, build it from a factory checkout at `origin/main` with its dependencies installed, then run `bun run flags generate` here and commit what changed:

```sh
sha="$(git -C <factory checkout> rev-parse HEAD)"
cd <factory checkout>/packages/flags && bun build src/cli.ts --target=bun --minify \
  --banner "// Bundled from Pallas-Labs/factory packages/flags/src/cli.ts at $sha. Do not edit: see scripts/flags/README.md." \
  --outfile "$OLDPWD/scripts/flags/flags.bundle"
```
