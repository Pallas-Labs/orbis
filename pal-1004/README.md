# PAL-1004 verification record

PR head: `585fda07b4912a3822205225a8d059ff6f4a2342` (rebased on main `49cb514`).

| Check | Command | Where | Result |
| --- | --- | --- | --- |
| Repo gate | `bun run check` | Vanta, head `585fda07b4912a3822205225a8d059ff6f4a2342` | 15 of 15 tasks pass |
| Server HTTP (share routes, privacy) | `bun run --filter @orbis/server test` (in the gate) | Vanta | 0 fail; `apps/server/src/share-http.test.ts` |
| Workerd journey | `bun run --filter @orbis/api test` (in the gate) | Vanta, Miniflare | pass; `workerd-result.json` |
| Web journeys incl. `share` | `bun run --filter @orbis/web test` (in the gate) | Vanta, Chromium | 12 journeys pass; `web-share-result.json` |
| Apple unit | `bun run native:lanes --unit --udid 36A249F7-9611-47C1-A23F-A5F70130AB1E` | Mac, iPhone 17 Pro, iOS 27.0, Swift at `a585c83` | 176 of 176 |
| Apple journeys | `node scripts/native-lanes.mjs --journeys --only OrbisUITests/OrbisLinkUITests --udid 36A249F7-9611-47C1-A23F-A5F70130AB1E` | same | 4 of 4 |
| tvOS unit | `bun run native:lanes --tvos --unit --udid DDA27B37-BA12-4DA7-A6BF-5FE224993AB0` | Mac, Apple TV 4K (3rd gen), tvOS 27.0 | 172 of 172 |

The Swift sources at `a585c83` and at the PR head are identical; the rebase onto main changed server files only.

curl transcripts come from the Bun server with a fixture Set (`scripts/share-preview.ts`), so `og:url` and `og:image` name the loopback origin. In production they name `https://orbis.p11a.xyz/s/<id>` and `https://orbis.p11a.xyz/api/share/sets/<id>/image.png`; the workerd journey asserts that shape.

## Rework: rebase onto main `e852678` (2026-10-28)

PR head: `2042c900b4c4bf6c1e2314391978822bba8fb851`. Files: `rework-2042c90/`.

| Check | Command | Where | Result |
| --- | --- | --- | --- |
| Local CI | `bun run ci` | Vanta, macOS checks on cortex, head `2042c90` | 16 of 16 tasks pass; posted `local-ci=success` |
| Apple unit | `bun run native:lanes --unit --udid 01120C2B-546B-43E9-B76D-91A2D9288769` | Mac, iPhone 17 Pro, iOS 27.0, Swift at `80d2782` | 180 of 180 |
| Apple journeys | `node scripts/native-lanes.mjs --journeys --only OrbisUITests/OrbisLinkUITests --only OrbisUITests/ApprovalUITests --udid 01120C2B-546B-43E9-B76D-91A2D9288769` | same | 7 of 7 (4 Orbis Link, 3 Approval) |
| tvOS unit | `bun run native:lanes --tvos --unit --udid CFDB9A87-9AD4-4BF6-A2EB-EC78A543F560` | Mac, Apple TV 4K (3rd gen), tvOS 27.0 | 176 of 176 |

The Swift sources at `80d2782` and `2042c90` are the same; the later commits change web journey tests and rebase onto a main that changed no Apple files.

Five earlier `bun run ci` runs failed in different web journeys (`earlier-ci-failures.txt`): requests got 401, or the `pair` journey read an AASA file without `/s/*`. Another checkout ran the same journeys at the same time on the same fixed ports (`foreign-journeys-during-ci-5.txt`: `review-pal-999-…`). Run 6 waited until no other checkout ran journeys for 3 minutes and passed.
