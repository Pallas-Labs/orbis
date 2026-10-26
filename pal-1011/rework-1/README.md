# PAL-1011 rework round 1

The review at `7e14285` sent the PR back for 2 React Doctor errors in the web `/pair` route. This round fixes them, merges `main` (#309, PAL-1013) to clear a conflict, and repairs the 2 journey steps that the merge broke. Code tree verified: `9b9967f`.

| Check | Host | Command | Result |
| --- | --- | --- | --- |
| Repo gate | Vanta | `bun run check` | 15 of 15 tasks pass at `5dfa913` and at the merge `43b30cd`; the pair journey passes 10 steps (`web-pair-result.json`, `web-pair-sheet.png`) |
| React Doctor, local | Vanta | `npx react-doctor@0.9.18 apps/web --scope changed --base origin/main` | 100/100, no issues |
| React Doctor, CI | GitHub | `React Doctor` job at `43b30cd` and `9b9967f` | pass, 0 errors, 0 warnings |
| Swift style | MacBook | `bun run native:format` | pass |
| iOS journeys | MacBook, iPhone 18 Pro sim, iOS 27.0 (`BC8BCCA1`) | `bun run native:lanes --journeys --udid … --only OrbisUITests/ApprovalUITests --only OrbisUITests/SignInUITests` | 8 of 8 pass at `9b9967f` |
| iOS unit | same simulator | `bun run native:lanes --unit --udid …` | 167 + 5 + 5 tests, 0 failures |

At `43b30cd`, the first journey run failed 3 tests. Two came from the merge and are fixed in `9b9967f`: the approval journey waited on the code field after the last key, which now submits the form and removes the field; the sign-in journey read the shown code after it left Add a Device. The third, `testTheHostManagesThePasscodeAndPeople`, tapped the Allow Joining switch without a change; its test code matches `main`, and it passed on the next run. The first unit run at `43b30cd` stopped before any test, because the simulator did not launch the app; the rerun passed.

`ios-add-device-merged.png` shows Add a Device after the merge: the Sign-in Code in slots (PAL-1013) and the footer "I Have a Sign-in Code".
