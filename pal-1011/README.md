# PAL-1011 verification record

Pair a TV, slice 2: approve on the iPhone and the web. Code tree verified: `3de312b` (the PR head `7e14285` has the same tree; the commits were folded).

| Check | Host | Command | Result |
| --- | --- | --- | --- |
| Repo gate | Vanta | `bun run check` | 15 of 15 tasks pass (11 from the Turbo cache with unchanged inputs) |
| Web `/pair` journey | Vanta | `bun run --filter @orbis/contracts build && cd apps/web && bun x vite build && node e2e/pair.mjs` | pass, 10 steps (`web-pair-result.json`) |
| iOS unit + Swift style | MacBook, iPhone 18 Pro sim, iOS 27.0 (`0C53D03B`) | `bun run native:lanes --unit --udid 0C53D03B-3793-4185-85EF-4558B63341F3` | 168 of 168 pass, including the 4 `ApprovalLinkTests`; `native:format` passes |
| iOS journeys | same simulator | `bun run native:lanes --journeys --udid … --only OrbisUITests/ApprovalUITests --only OrbisUITests/SignInUITests` | 8 of 8 pass: the 3 `ApprovalUITests` and the 5 `SignInUITests` |
| tvOS unit | MacBook, Apple TV 4K sim, tvOS 27.0 | `bun run native:lanes --tvos --unit --udid BCD0909E-…` | 164 of 164 pass |
| macOS unit | MacBook | `bun run native:lanes --unit --macos` | not run: signing stops on "Provisioning profile 'iOS Team Provisioning Profile: app.orbis.client' doesn't include the Associated Domains capability" (the local development profile predates the capability) |
| macOS compile | MacBook | `xcodebuild -scheme Orbis -destination platform=macOS CODE_SIGNING_ALLOWED=NO build` | BUILD SUCCEEDED |
| Before (main `36cb096`) | same simulator | `--journeys --only OrbisUITests/SignInUITests/testANewPersonJoinsWithThePasscodeAndAddsADevice` | pass; `before-ios-settings-devices.png` |

Journey step records: `approve-link.json`, `approve-cancel-expired.json`, `approve-after-sign-in.json`. Full logs stay on the MacBook under `~/.cache/agent-scratch/pal-1011/` and on Vanta under the same path.

The journeys open `orbis://pair#<code>`; a simulator cannot verify the `orbis.p11a.xyz` domain. The production association file and the Camera opening the app need a deploy and a TestFlight build.
