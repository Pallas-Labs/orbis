# Audit, 2026-11-12

## Resume here

The run on Vanta stopped early: the machine was overloaded by other jobs, and the audit moves to another machine. Continue from this branch, `audit/fable-2026-11-12`.

State when it stopped:

- Finding 1 is fixed and its test passes: `CI=true bun test --timeout 60000 src/heavy-rotation-http.test.ts` in `apps/server`, 3 pass.
- The first commit attempt failed in the pre-commit hook. `@orbis/web#test` timed out starting its servers (`vite preview did not listen on port … in 15 s`, 11 of the journeys) while the load average was 65 to 96 on 12 cores. The other 20 tasks passed. The same check passed on the untouched branch an hour before (21 of 21, 59 s), and the change touches no web code, so the cause is load. No hook was skipped.
- If this file is in a commit, a later attempt passed the hook. Run `bun run check` once on the new machine before you trust it.

Next, in this order:

1. Fix finding 2 (queue change, Finish and Listen in one transaction). The failing test and the design are written under the finding.
2. Fix finding 3 (bound `GET /people/:id/listens`), and drop its line from `scripts/bounded-reads.baseline.json` with `node scripts/check-bounded-reads.mjs --update-baseline`.
3. Look for more in sync, where a test can run here: the web player (`apps/web/src/components/player/player.tsx`, journeys in `apps/web/e2e`) and the Rune client (`apps/rune/scripts/check`). Findings 5 and 10 are the leads.
4. Read `apps/server/src/tracklists.ts` and `playlist-importer.ts` for state that status strings and nullable fields hold together (`tracklistState` with `tracklistRunId` and `tracklistRunStartedAt`; `playlistImports.state` with `pageToken` and `failure`). Not read closely yet.
5. Push, then open one PR against `main` whose body summarizes this file. Say in it that no Swift check ran.

Rules that cost time here: run one command at a time when the second reads what the first writes; each commit runs the whole `bun run check`, so batch nothing but expect minutes for each commit.

## Scope

Listening data (Listens, Listening Time, Heavy Rotation) and sync between the apps and the backend, then whatever those led to.

This machine is Linux with no Xcode. Server, web, API and Rune checks can run here. No Swift check ran; every Swift finding is from reading the code and says so.

Status words: **fixed** (a commit on this branch, with a test that failed first), **planned** (evidence in hand, fix not written), **left** (real, not changed here, with the reason), **rejected** (looked wrong, is not).

## Findings

### 1. Listening Time undercounts every client's ordinary playback — fixed

`listenedBetween` (`apps/server/src/heavy-rotation.ts`) credited `min(step, round(elapsed))`. Positions are whole seconds and the time between saves is not, so the cap cut a second from every step longer than the rounded time, and nothing gave it back.

Evidence, through `createApp` over HTTP with the clock moved by the test:

| Client rhythm | Played | Credited before | After |
| --- | --- | --- | --- |
| Phone: a save each 5 s plus a 0.3 s round trip | 593 s | 560 s (-5.6%) | 593 s |
| Browser: a save each 15 s on the next 0.25 s tick | 595 s | 585 s (-1.7%) | 595 s |

A one-hour probe of the phone rhythm (not committed) credited 3,555 s at a 0.05 s round trip, 3,490 s at 0.15 s, 3,390 s at 0.3 s, 3,295 s at 0.45 s and 3,589 s at 0.6 s, of 3,595 s. The loss depends on the network, so a Set heard on the phone ranked below the same time heard in the browser, and the two-minute day floor and a Collection's least time were harder to reach on the phone.

Fix: a step that matches the time since the last save counts whole. The match (within `slackSeconds`) is the bound, so a step counts at most 3 s more than the time. Test: `transcript: a client's save rhythm credits every second it played` in `heavy-rotation-http.test.ts`.

Not changed: Listening Time already stored is not recomputed. The lost seconds were never recorded, so there is nothing to recompute from.

### 2. A queue change, its Finish and the next Listen were separate writes — fixed

`Queue.complete` (`apps/server/src/queue.ts`) reset the position, committed the queue, ran `presence.afterCommit` and `library.release` for each Set that left the queue, and only then called `stats.recordFinish` and `stats.recordListen`. `play` and `replaceWithSets` had the same order. A failure after the queue commit answered 500, and the retry did nothing by design (the Set is no longer active), so the Finish was lost for good and the next Set was active with no Listen. Its later Finish then found no open Listen, or closed an older abandoned Listen of that Set.

"The active entry is the Listen" was a state nobody wrote down: `queue_entries.is_active` and the open `listens` row were tied only by the order of calls at three call sites. ADR 0019 already says "Queue and Stats currently write separately; implementation must combine their related Queue, Listen, and Finish updates under one transaction".

Evidence: `transcript: a completion that fails after the queue moved still records its Finish and the next Listen` in `queue-listen-http.test.ts`. It gives `createApp` a real audio folder where `a.ogg` is a folder with a file in it, so `MediaStore.removeFiles` fails after the queue commits. Before the fix:

```
complete a, its audio cannot be removed (500)  -> [b*] | a open
complete a again (200)  -> [b*] | a open
```

After: `[b*] | a finished, b open` on both lines.

Fix: one writer, `Queue.change`. It reads the stored queue inside the transaction that writes it, asks a pure decision (`played`, `inserted`, `replaced`, `completed`) what the queue becomes, and writes the entries, the Finish and the new Listen together. One rule replaces three call sites: a Set that becomes active opens a Listen, and a completion closes the Listen of the Set it removes. Audio is released after the commit, as before. `stats.ts`, the `Stats.forPerson` wiring in `app-core.ts` and the unused `Queue.layer` and `Queue.scopedLayer` are gone.

What did not reproduce, so no race is claimed: two completions of the same Set at once (a Bun probe and a workerd probe of 100 rounds of 6 concurrent `POST /queue/completion` through Miniflare recorded no second Finish), and 7 concurrent Add to Queue requests for 20 rounds on Bun (no add lost). The reads and writes of one request run without yielding, so two requests do not interleave today. The read now sits inside the transaction, so that no longer depends on it.

Not changed: `library.setPlaybackPosition(id, 0)` still runs in its own transaction before the queue moves. A request that stops between the two leaves the Set active at position 0, and the retry completes it.

### 3. `GET /people/:id/listens` returns every Listen a Person ever made — planned

`friendListens` in `app-core.ts` has no row bound (it is in `scripts/bounded-reads.baseline.json`) and each Listen carries a whole Set. The Apple app uses the first 12 distinct Sets (`PeopleModel.swift`); the web page lists them all.

Measured through `createApp` (median of 7, not committed; `scripts/bench-friend-listens.ts` measures the same route):

| Listens | Answer | Time   |
| ------- | ------ | ------ |
| 200     | 122 KB | 12 ms  |
| 3,000   | 1.8 MB | 58 ms  |
| 9,000   | 5.5 MB | 165 ms |

The old Host database on Vanta held 36 Listens after 10 days, so about 650 after six months for one Person, more with a queue that plays on.

Planned fix: the newest 200 Listens. The shape of the answer does not change. Test: seed 250 Listens, expect 200, newest first.

### 4. The Listening Queue only grows — left

No route removes an entry. `play` puts a new Set before the active one and keeps the rest, so every Set a Person starts and does not finish stays queued until a Playlist, Heavy Rotation or a Collection replaces the queue. A queued Set also keeps its Retained Audio and stays visible after its Library Entry is removed. Each queue change deletes and inserts every row and answers with every Set.

Measured: 150 entries make each queue answer 81 KB and a play 21 ms; 300 entries make it 162 KB and 65 ms (5 entries: 3 KB, 8 ms).

Left because the fix is a product choice and a new route (remove one entry, clear the queue, or drop what lies before the active Set). Owner decides.

### 5. A paused player overwrites a newer Playback Position from another device — left

By reading. The web player resumes its `<audio>` element at its own time and reports it; the Apple app's `playSet` for the Set already loaded calls `audioPlayer.resume()` without reading the position again. A phone that moved the Set from 10:00 to 30:00 loses that place when the Mac resumes at 10:00. The service cannot tell a stale save from a seek back, because a save carries no device and no base position.

Left because the fix changes the API (a save that names what it replaces) or every client (read the position before resuming after a pause). Owner decides. A web journey could prove the web half.

### 6. Apple: a failed completion stops the queue and loses the Finish — left

By reading `finishedPlaying` in `AppModel.swift`. One `reportCompletion` with no retry; on failure it shows the error, the Set stays active on the service and nothing plays next. `waitsForConnectivity` covers a lost connection, not a 5xx. Needs a Mac to test.

### 7. Each start, resume and seek loses up to one save interval of Listening Time — left

The first save after a start or a resume has no matching earlier save, so it credits nothing: up to 5 s on Apple (it reports only on its 5 s tick), none on the web for a resume (it saves at once). Under 1% of an hour-long Set. A client change (save when playback starts); Swift, so not done here.

### 8. A UTC day splits an afternoon in Los Angeles — left

Listening Time is by UTC day (GLOSSARY.md), and a day under two minutes of a Set does not count. Midnight UTC is 16:00 PST, so three minutes of a Set across it can count as nothing. The glossary defines the day; owner decides.

### 9. `sets` keeps columns from before per-Person state — left, not verified in full

`listen_count`, `finish_count`, `last_listened_at` and `playback_position_seconds` on `sets` look unread outside migrations (a grep of `apps/server/src` and `apps/api/src`; `sets.tags` is still read as a fallback). Dropping a column deletes data, so owner decides. Check the transfer scripts before trusting the grep.

### 10. Web: a position save can land after the completion that reset it — left

By reading `player.tsx`: position reports are not awaited, and `finish` sends position 0 and the completion while an earlier report may be in flight. Rune sends its writes one at a time for this reason. Low odds (a report is in flight for about 0.3 s of each 15 s). A candidate for step 3 above.

### 11. `docs/development.md` asks for Node.js 24; Vanta runs 22.23.2 — left

`bun run check` passed on 22.23.2. Either the doc or the machine is out of date.

## Rejected

- Queue and Listen counts drift under ordinary use. A 400-step random run of play, Play Next, Add to Queue and completion over HTTP matched a model at every step (queue order, active Set, `listenCount`, `finishCount`). Not committed.
- Two completions at once record two Finishes. See finding 2.
- Download state is an unwritten state machine. `download-state.ts` already names every move. Presence has `decide` in `presence.ts`, and the web player has `PRESENCE_MOVES`.

## Decisions made without the owner

- Finding 1: chose "the step counts whole" over "cap at the time rounded up". Rounding up still drops a second when network jitter passes a second, and the cap protected only against a forward seek of under 3 s between two saves, which no client's controls make (they skip 15 s or 30 s). Undo: restore the `Math.min` in `listenedBetween`.
- Finding 2 (when done): keep the repo's own way of writing a state machine, a table of moves or a `decide` function, as `download-state.ts` and `presence.ts` do. Orbis has no XState, and adding it is a dependency choice for the owner.
- Finding 3 (when done): 200 Listens. Undo: change the constant.
