# Models

TLA+ models of three Orbis protocols, checked by [everystate](https://github.com/mattzcarey/everystate) (`everystate@0.4.1`, a TLA+ model checker with no Java). `bun run check` runs them in the `@orbis/server` tests:

- `src/models.test.ts` checks each configuration below and fails when a verdict changes. It also fails when a committed chart no longer matches its model.
- `src/download-trace.test.ts` records the Download moves of a real run (HTTP requests and the download worker, on a real SQLite database) and checks the log against `SetDownload.tla` with `everystate conform`. It also checks that conform refuses the same log with one step removed. It writes the trace and both reports to `.cache/everystate/`.
- `src/position-trace.test.ts` plays two devices against a real server over HTTP: each saves and reads one Set's Playback Position. It records each step with the stored position the server answered, and checks the log against `PlaybackPosition.tla` (`PlaybackPositionTrace.cfg`) with `everystate conform`. The test scripts the client steps; the trace checks the server's last-save-wins answers, not the Apple or web clients. Conform must refuse the log with the backward save removed, and the log where that save reads what a server that keeps the largest save would answer. It writes the trace and the three reports to `.cache/everystate/`.

```sh
bun test --timeout 60000 apps/server/src/models.test.ts apps/server/src/download-trace.test.ts apps/server/src/position-trace.test.ts
node_modules/.bin/everystate -config SetDownloadBroken.cfg SetDownload.tla   # from this folder: one check, TLC output
bun run statecharts                                                          # redraw the charts after a model change
```

A pass covers the model at the bounds in its `.cfg`, not the code. The conform tests are the link to the code: each shows that one recorded run is a behaviour of its spec.

## Configurations

| Configuration | Verdict CI expects | Why it exists |
| --- | --- | --- |
| `SetDownload.cfg` | pass | The Download moves keep every rule. |
| `SetDownloadBroken.cfg` | `ReadyHasAudio` breaks | Negative check: `finish` without its state check, so a finish after a release marks a Set ready with no file. |
| `SetDownloadReleaseGap.cfg` | `ReadyHasAudio` breaks | Known gap; see [Findings](#findings). |
| `PlaybackPosition.cfg` | pass | On a network that delivers every request, a resume finds the other device's pause. |
| `PlaybackPositionLossy.cfg` | pass | A device can go offline, so a request or its answer is lost. A report with no answer is sent again, so a resume still finds the other device's pause. Closed finding 2; see [Findings](#findings). |
| `PlaybackPositionDevice.cfg` | (chart only) | One device, so the chart shows one device's steps. |
| `PlaybackPositionTrace.cfg` | (trace only) | Positions 0 to 2 and no symmetry, so `position-trace.test.ts` can name each device and record a save that goes back. |
| `PlayNextQueue.cfg` | pass | Every `Queue.change` decision keeps the queue and its open Listen whole. |
| `PlayNextQueueActiveInsert.cfg` | `ActiveInsertUnchanged` breaks | Negative check: `inserted` without its active-Set guard moves the playing Set behind the others. `ActiveIsFirst` breaks in the same state. |
| `PlayNextQueueStaleCompletion.cfg` | `StaleCompletionUnchanged` breaks | Negative check: `completed` without its `isActive` check finishes a Set that is not playing. |

A configuration expected to break must break on the named rule with exit status 12. A parse error (150 or 151) fails the test.

## `SetDownload.tla`

One Set's Download (`sets.download_state`) and its Retained Audio on the audio node. Bounds: one Set, one download at a time on the node, at most 2 node restarts.

| Action | Code |
| --- | --- |
| `Queue`, `Claim`, `Fail`, `Finish`, `Cancel`, `Drop`, `Release`, `Requeue`, `Adopt`, `Lose` | The move of the same name in `DownloadMoves` (`src/download-state.ts`). `moveDownload` reports each changed row to `DownloadMoveObserver` under this name. |
| `Keep`, `Unkeep` | A Person saves the Set, or the last Person who keeps it removes it (`Library.remove`). |
| `Store` | `MediaStore.storeDownloaded`, in `DownloadWorker.downloadOne`. |
| `FailLate`, `Discard` | `fail` or `finish` changes no row because a cancel, drop or release landed first. `Discard` removes the stored file. |
| `RemoveFiles` | `releaseAudio`'s `removeFiles`, after its transaction. |
| `Restart`, `Boot` | The node process dies; on start, `resetStuckDownloads` runs. |
| `NodeRelease`, `Reconciled` | The Group's inventory pass (`reconcile` in `apps/api/src/node.ts`) sends `release`, or changes nothing. |

Rules:

- `ReadyHasAudio`: a Set the Group calls ready has its file on the node.
- `NoOrphanAudio`: a file without a ready Download exists only while a step that settles it is still to come.
- `ReadyIsNeverFetched`: a retry never fetches a ready Download again.

Assumptions:

- A release's file removal reaches the node before the node starts the next download of the same Set.
- With `ReleaseAtOnce`, no other step runs between a removal or a finish and the release that follows it.

## `PlaybackPosition.tla`

One Person's Playback Position for one Set, shared by two devices. Bounds: two devices (symmetric), positions 0 to 1.

- The server keeps the last save that arrives (`Library.setPlaybackPosition`).
- Each device sends one report at a time, in order (`AppModel.startReportingPosition`; `write` in the web `player.tsx`), and sends a report again when it gets no answer: the request failed or the answer was lost, which the device cannot tell apart. The new report carries the player's position at that time.
- On resume, a device moves to the stored position only when it differs from the last one it heard (`AppModel.newerSavedPosition`).

Rule `HandoffResumes`: when every save has landed and the stored one is a pause from another device, a resume starts at that pause.

## `PlayNextQueue.tla`

One Person's Listening Queue (`queue_entries`) and the Listen it keeps open. Bounds: 3 Sets (symmetric), every order of every group of them as a replacement queue.

| Action | Code |
| --- | --- |
| `Play` | `played`, from `Queue.play` (`PUT /queue/active`). |
| `Insert` | `inserted` with placement `next` (Play Next) or `end` (Add to Queue), from `Queue.insert`. |
| `Replace` | `replaced`, from `replaceWithPlaylist`, `replaceWithCollection` and `replaceWithHeavyRotation`. |
| `Complete` | `completed`, from `Queue.complete` (`POST /queue/completion`). |

Each action is one `Queue.change` transaction: the entries, the Finish of the completed Set's Listen, and the Listen of a Set that becomes active. A decision that returns `null` is a step that changes nothing.

Rules:

- `NoDuplicates`: no Set is in the queue twice.
- `ActiveIsFirst`: the active Set is the first entry, so the queue holds only what lies ahead (PAL-2128).
- `ActiveHasOpenListen`: no queue is stored without the Listen it stands for. The active Set has the newest Listen, and that Listen has no Finish.
- `ActiveInsertUnchanged`: Play Next or Add to Queue on the active Set changes nothing.
- `StaleCompletionUnchanged`: a completion of a Set that is not active changes nothing, so a retried signal is safe.

The model does not say the active Set has the only Listen without a Finish. That is false by design: playing another Set leaves the old Listen with no Finish (`finishedAt` stays null), because it did not reach the end. No reader takes a null `finishedAt` to mean "playing now"; the web profile shows it as "Listened to".

Not modelled: the playable check, the release of a Set that leaves the queue (after the commit), and the position reset before a completion.

## Findings

Neither finding is reproduced on the running service. Each is a counterexample in the model, and CI keeps an open one visible: when the code closes the gap, the expected verdict must change.

1. `SetDownloadReleaseGap`: a Person who does not keep a Set asks for its Download (ADR 0010 allows it). The download finishes, and the node restarts before the release that follows the finish. The Group's inventory pass then sends `release` for the file, because nobody keeps the Set, while the row still reads `ready`. The next inventory pass moves it to `none` (`lose`). The same gap exists between `Library.remove` and its `release`.
2. Closed (PAL-3192). `PlaybackPositionLossy`: a device pauses while offline. The settled report fails and is never sent again. The other device resumes from the older stored position and pauses there. When the first device resumes, the stored position equals the one it last heard, so it plays on from its own place and skips the other device's pause. The fix sends a report again until it gets an answer. Resending only a failed request is not enough: a save that lands but whose answer is lost leaves the device's known position old, and a later pause by the other device at that old position is then skipped.

## Statecharts

`SetDownload.mmd`, `PlaybackPosition.mmd` and `PlayNextQueue.mmd` are drawn from each model's full state graph (`everystate -dump dot`) by `src/models.ts`. Each chart state groups the model states that look the same to a reader. Steps that stay inside one chart state are not drawn.

Last confirmed against the code at the commit that added these models (PAL-3179), and for `PlayNextQueue.tla` and the Position trace, PAL-3193.
