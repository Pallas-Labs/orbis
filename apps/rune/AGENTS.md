# AGENTS.md

The Orbis desktop client in Rune, for Parth on his Linux desktop. It talks to the Orbis API (`packages/contracts/src/http-api.ts`) with a device key and plays Retained Audio through mpv. `README.md` describes every feature, its scenes and its commands; read the section for the part you change. Rune patterns live in the `rune-app` skill.

## Boundaries

- Parth's Library, queue and key are off limits. The app goes online only on a plain launch or `--native`; every `--scene` and `--snap` renders made-up data on a frozen clock.
- For a live window, run `apps/rune/scripts/stand-in` and point the app at it with a scratch `XDG_CONFIG_HOME`. Its audio is silence, so nothing sounds in the room. Open one window at a time and close it when done.
- The server's rules (queue order, Finishes, Playback Position) belong to the server. The app's optimistic changes in `Queue::activate` and `Queue::advance` copy ADR 0001 and give way to what Orbis sends back.

## Shape of the code

- `apps/rune/src/api.rs` is the one door: every call goes through `request`, which answers from `api::fixture` in tests. `apps/rune/src/audio.rs` is the only code that starts a process.
- One module per screen in `apps/rune/src`: `library.rs`, `queue.rs` and `playing/` (state and logic in `mod.rs`, the views in `view.rs`). `apps/rune/src/main.rs` holds the shell, `Screen` and the keys.
- `playing::State::generation` counts each Set started. Every landing and player event checks it, so a late answer for an old Set changes nothing.

## Working here

1. Work in your own worktree; cargo keeps its target folder in `apps/rune/target`.
2. While you work, run `cargo test <filter>`. Before you commit, run `apps/rune/scripts/check`; the commit hook runs it again through `bun run check`.
3. Render every scene your change shows (`--snap out.png --scene <name> --at 1.5`) and read each image. Rewrite goldens only for a change you meant, and commit them with it. Re-render `apps/rune/shots/` when a scene's look changes.
