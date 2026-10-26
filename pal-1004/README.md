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
