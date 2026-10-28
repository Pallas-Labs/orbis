# PAL-1043 verification record

Branch `agent/pal-1043`, head `3fee6b2e2a3c0a8d17bf6b54327e303be7a7d6ef`.

## Native lane: ApprovalUITests

- Host: Parth's MacBook Pro (`ssh mac`), Xcode at `/Applications/Xcode.app`.
- Simulator: `PAL-1043 Orbis Lanes`, iPhone 17 Pro, iOS 27.0, UDID `97AE7A57-79FD-4F53-A2D3-44109EF4AD10`.
- Command, run in a `git archive` copy of each commit:

  ```sh
  bun install --frozen-lockfile
  bun run --filter @orbis/contracts build
  node scripts/native-lanes.mjs --only OrbisUITests/ApprovalUITests \
    --udid 97AE7A57-79FD-4F53-A2D3-44109EF4AD10 --out <dir>
  ```

| Run | Commit | Tree | Result |
| --- | --- | --- | --- |
| Red | `1a9bc84` (origin/main `b22dd38` + the new test) | test only | New test fails at `ApprovalUITests.swift:131`, "Settings must list the TV without reopening". The other three pass. [red-results.txt](red-results.txt) |
| Green | `3fee6b2` (test + fix) | branch head | All four pass, `** TEST SUCCEEDED **`, lane 156.8 s. [green-results.txt](green-results.txt), [green-shots/](green-shots) |

Screenshots:

- [before-settings-after-link.png](before-settings-after-link.png): last frame of the red run's screen recording. Settings is still open, and the TV is missing from Devices.
- [after-sheet-over-settings.png](after-sheet-over-settings.png): green `approval-10-sheet-over-settings`. The link's sheet opens over Settings.
- [after-settings-after-link.png](after-settings-after-link.png): green `approval-09-settings-after-link`. The TV is listed under Add a Device, above This Device.

### Note on `XCUIApplication.open(_:)`

The first version of the test opened the link with `app.open(url)`. That call relaunches the app, so Settings had closed before the sheet appeared, and the test failed at the `settings-done` check on both red and green (screen recording: black frame, then the sheet over Home). The test now uses `XCUIDevice.shared.system.open(url)`, which gives the link to the running app as a scanned QR code does.

## Local CI

`bun run ci` on `3fee6b2`: passed, posted `local-ci=success` at 2026-10-28T11:09:54Z.

Two earlier runs failed in `@orbis/web` e2e journeys with 401 answers (`POST /sets answered 401`). In both, another worktree's local CI was running its web e2e at the same time. The journeys use fixed ports (`apps/web/e2e/live-queue.mjs`: API 4511, web 3411), so this run's requests reached the other run's server, which has a different key. Confirmed with `ss -ltnp`: `vite preview --port 3411` came from `agent-pal-1042`. The change is Swift-only and does not touch the web app.

## Retained artifacts

On Vanta at `~/.cache/orbis-evidence/pal-1043`: both result bundles (`red-result.xcresult.tgz`, `green-result.xcresult.tgz`), both console logs, the red screen recording, and the green screenshot export.
