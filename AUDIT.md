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

### 3. `GET /people/:id/listens` returned every Listen a Person ever made — fixed

`friendListens` in `app-core.ts` had no row bound (it was in `scripts/bounded-reads.baseline.json`) and each Listen carries a whole Set. The Apple app uses the first 12 distinct Sets (`PeopleModel.swift`); the web page lists them all.

Measured through `createApp` before the fix (median of 7, not committed):

| Listens | Answer | Time   |
| ------- | ------ | ------ |
| 200     | 122 KB | 12 ms  |
| 3,000   | 1.8 MB | 58 ms  |
| 9,000   | 5.5 MB | 165 ms |

The old Host database on Vanta held 36 Listens after 10 days, so about 650 after six months for one Person, more with a queue that plays on.

Fix: the newest 200 Listens (`LISTEN_HISTORY_LIMIT`). The shape of the answer does not change, and the read left the bounded-reads baseline (56 to 55). Test: `transcript: a friend's Listen History is the newest 200 Listens` in `friend-listens-http.test.ts`; before the fix its second line read `200 250 Listens, 04:09 to 00:00`. After, `bun scripts/bench-friend-listens.ts` answers 119 KB in 4.5 ms for 1,000 Listens, the same as for 200.

Not changed: the web profile shows no "older Listens" control, so Listens past the newest 200 are not reachable from a client. They stay in the database. A page cursor is an API addition; owner decides.

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

### 10. Web: a position save could land after the completion that reset it — fixed

`player.tsx` did not await a position save, and `finish` sent a save of 0 and then the completion while earlier saves could still be out. A Set that ends is not a rare case for this: Chrome fires `pause` before `ended`, so every Set that plays out on the web saves its last second (`seconds` = the length) at the moment it finishes. A save that lands after the completion leaves the finished Set at its end. The next play of that Set starts there, ends at once, and counts a Listen and a Finish nobody heard.

Evidence: the `live-queue` journey (`apps/web/e2e/live-queue.mjs`) now holds each save of the First set other than 0 for 1.5 s, seeks to 0.3 s before the end and lets the Set end. Before the fix:

```
AssertionError: a save that left late (29.714658, 30 s) landed after the completion
30 !== 0
```

The two late saves are the seek and the pause at the end. After the fix the step passes with the same two saves (`.cache/web-player/result.json`).

Fix: position saves and the completion go out one at a time, in the order the player made them, as Rune's `writes` queue does. The save of 0 before the completion is gone, because `Queue.complete` resets the position itself.

How likely it was without the 1.5 s hold: the late save must be slower than the two requests after it by more than one round trip. Rare on a good network; the result when it happens is a Set that skips itself.

Found while here and fixed next: finding 15.

### 11. `docs/development.md` asks for Node.js 24; Vanta runs 22.23.2 — left

`bun run check` passed on 22.23.2. Either the doc or the machine is out of date. DataGhost, where the audit continued, runs 24.22.1.

### 12. A Tracklist whose run was lost stayed "Finding tracklist…" for good — fixed

`sets.tracklist_state` has four values, and `pending` held three states that only `tracklist_run_id` and `tracklist_run_started_at` told apart: waiting (no run), running (a run inside its 5-minute lease) and lost (a run past its lease). Nobody wrote that down. A restart during a run leaves the Tracklist waiting; a worker that dies with its claim (a Durable Object reset by a deploy) leaves it lost. The service could resume both, but only through `POST /sets/:id/tracklist/retry`, and no client sends that for a pending Tracklist: the web page hides Refresh while pending (`tracklist.tsx`), the Apple app shows only "Finding tracklist…" (`SetDetailScreen.swift`), and Rune has no retry call. All three poll `GET /sets/:id/tracklist` instead. So the Tracklist stayed pending until someone ran the backfill script by hand.

Evidence: `transcript: a pending Tracklist whose run was lost is found again when someone reads it` in `tracklists-http.test.ts`. Before the fix, after a restart and after a dead worker's claim passed its lease:

```
restart, read the Tracklist twice  -> pending | pending, no run, 0 Cues, 1 Versos requests
that claim is past its lease, read twice  -> pending | pending, a run, 0 Cues, 1 Versos requests
```

After: `ready | ready, no run, 2 Cues`, with one more Versos request each. A live claim of another worker still starts nothing.

Fix: reading a pending Tracklist claims it and starts the run (`resumeTracklist` in `app-core.ts`). The existing claim keeps it to one run. It starts nothing for an Apple Music Set, before the Set's details are read, or when Versos is not set up (`VersosService.configured`, so a poll does not log a warning each time). A run that fails leaves the Tracklist failed, which a read does not restart, so there is no loop. The three states are written above `RUN_LEASE_MS` in `tracklists.ts`.

Decision made without the owner: a `GET` now starts background work. The other choice was a Retry control for a pending Tracklist in three clients, two of which cannot be tested here. Undo: remove the `resumeTracklist` call in the `tracklist` handler.

Not changed here: a Tracklist that waits on details that failed or were lost. See finding 13.

### 13. A Set whose details read failed showed a pending Tracklist for good — fixed; a lost read is left

A Tracklist run starts only after the Set's details are read, because Versos scans the description. A details read that failed set `details_state` to `failed` and left `tracklist_state` at `pending`, which every client shows as "Finding tracklist…" with no retry (finding 12). The details read fails whenever yt-dlp cannot reach the source, such as while the audio node is away.

Evidence: `transcript: a Set whose details read failed shows a failed Tracklist, and a retry finds it` in `tracklists-http.test.ts`. Before the fix its first line read `pending, 0 Cues | details failed, 1 reads`.

Fix: `recordDetailsFailure` (`library.ts`) moves a pending Tracklist with no run to `failed` in the same write. The clients then show "Tracklist unavailable" with Try again, and that retry already reads the details again.

Left: a details read lost to a restart (`details_state` pending with nothing reading it) still shows a pending Tracklist for good. Resuming it on a read needs a guard against two details reads of one Set, and each read is a yt-dlp call, which YouTube already refuses at times ("Sign in to confirm you're not a bot" in the test logs). The window is the few seconds of one yt-dlp call. `bun run --filter @orbis/server backfill:details` repairs it by hand.

### 14. A release that cannot delete its files leaves them on disk for good — left

Seen in the test for finding 2. `releaseAudio` commits the release in the database (`download_state` none, jobs and Cues deleted) and then removes the files. When the removal fails, the request answers 500, and nothing tries again: the Set no longer counts as holding audio. Cost: disk on the audio node. A node inventory sweep that deletes files no Set claims would cover it; not built here.

### 15. Web: playing another Set lost the place of the Set that was playing — fixed

The web player saves a place every 15 s, on pause and on seek. Playing another Set removes the `<audio>` element of the one playing with no `pause` event, so that Set kept its last periodic save: it resumed up to 15 s early, and the seconds since that save earned no Listening Time. Rune saves at this point ("when another Set starts").

Evidence: the `live-queue` journey plays the Second set for 3 s and then plays the First set from the Library. Before the fix the step failed with `playing another Set did not save the place of the Set that was playing` (the saved place was 0). After, it passes.

Fix: `activate` in `player.tsx` saves the place of the Set that is playing before another Set takes the player. The save goes through the same ordered queue as finding 10.

### 16. Web: one dropped completion stopped the queue — fixed

The service counts a completion once, by whether the Set is still the active one, so that a client can send it again (`queue.ts`: "what makes a retried signal from the other device do nothing"). No client does. On the web, `finish` sent one completion; a request that got no answer showed "Orbis could not be reached" and nothing played next. "Retry audio" then played the finished Set again from where the player had first resumed it.

Evidence: the `live-queue` journey drops the first `POST /queue/completion` when the First set ends. Before the fix the next step timed out: `waiting for getByRole('region', { name: 'Audio player' }).getByText('Second set')`. After, the Second set plays.

Fix: `completeSet` (`apps/web/src/lib/player.ts`) sends a completion again after 1 s, 2 s and 4 s when it got no answer, a 429 or a 5xx, then gives up as before. A 4xx is not sent again.

Decision made without the owner: three more tries over 7 s. Undo: empty `COMPLETION_WAITS_MS`.

Left: the Apple app (finding 6) and Rune have the same gap. Rune plays the next Set at once and says "Orbis didn't hear that the Set ended" (`completed` in `apps/rune/src/playing/mod.rs`), so the service keeps the finished Set active, with no Finish and no Listen for the next one, until the person plays something. Not changed here: the Rune fix needs a retry timer in its write queue and a press test, and the Apple one needs a Mac.

## Rejected

- Queue and Listen counts drift under ordinary use. A 400-step random run of play, Play Next, Add to Queue and completion over HTTP matched a model at every step (queue order, active Set, `listenCount`, `finishCount`). Not committed.
- Two completions at once record two Finishes. See finding 2.
- Download state is an unwritten state machine. `download-state.ts` already names every move. Presence has `decide` in `presence.ts`, and the web player has `PRESENCE_MOVES`.

## Decisions made without the owner

- Finding 1: chose "the step counts whole" over "cap at the time rounded up". Rounding up still drops a second when network jitter passes a second, and the cap protected only against a forward seek of under 3 s between two saves, which no client's controls make (they skip 15 s or 30 s). Undo: restore the `Math.min` in `listenedBetween`.
- Finding 2 (when done): keep the repo's own way of writing a state machine, a table of moves or a `decide` function, as `download-state.ts` and `presence.ts` do. Orbis has no XState, and adding it is a dependency choice for the owner.
- Finding 3 (when done): 200 Listens. Undo: change the constant.
