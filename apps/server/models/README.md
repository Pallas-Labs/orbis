# Models

TLA+ models of two Orbis protocols, checked by [everystate](https://github.com/mattzcarey/everystate) (`everystate@0.4.1`, a TLA+ model checker with no Java). `bun run check` runs them in the `@orbis/server` tests:

- `src/models.test.ts` checks each configuration below and fails when a verdict changes. It also fails when a committed chart no longer matches its model.
- `src/download-trace.test.ts` records the Download moves of a real run (HTTP requests and the download worker, on a real SQLite database) and checks the log against `SetDownload.tla` with `everystate conform`. It also checks that conform refuses the same log with one step removed. It writes the trace and both reports to `.cache/everystate/`.

```sh
bun test --timeout 60000 apps/server/src/models.test.ts apps/server/src/download-trace.test.ts
node_modules/.bin/everystate -config SetDownloadBroken.cfg SetDownload.tla   # from this folder: one check, TLC output
bun run statecharts                                                          # redraw the charts after a model change
```

A pass covers the model at the bounds in its `.cfg`, not the code. The conform test is the link to the code: it shows that one recorded run is a behaviour of the spec.

## Configurations

| Configuration | Verdict CI expects | Why it exists |
| --- | --- | --- |
| `SetDownload.cfg` | pass | The Download moves keep every rule. |
| `SetDownloadBroken.cfg` | `ReadyHasAudio` breaks | Negative check: `finish` without its state check, so a finish after a release marks a Set ready with no file. |
| `SetDownloadReleaseGap.cfg` | `ReadyHasAudio` breaks | Known gap; see [Findings](#findings). |
| `PlaybackPosition.cfg` | pass | On a network that delivers every request, a resume finds the other device's pause. |
| `PlaybackPositionLossy.cfg` | `HandoffResumes` breaks | Known gap; see [Findings](#findings). |
| `PlaybackPositionDevice.cfg` | (chart only) | One device, so the chart shows one device's steps. |

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
- Each device sends one report at a time, in order (`AppModel.startReportingPosition`; `write` in the web `player.tsx`), and drops a report that fails.
- On resume, a device moves to the stored position only when it differs from the last one it heard (`AppModel.newerSavedPosition`).

Rule `HandoffResumes`: when every save has landed and the stored one is a pause from another device, a resume starts at that pause.

## Findings

Neither finding is reproduced on the running service. Each is a counterexample in the model, and CI keeps it visible: when the code closes the gap, the expected verdict must change.

1. `SetDownloadReleaseGap`: a Person who does not keep a Set asks for its Download (ADR 0010 allows it). The download finishes, and the node restarts before the release that follows the finish. The Group's inventory pass then sends `release` for the file, because nobody keeps the Set, while the row still reads `ready`. The next inventory pass moves it to `none` (`lose`). The same gap exists between `Library.remove` and its `release`.
2. `PlaybackPositionLossy`: a device pauses while offline. The settled report fails and is never sent again. The other device resumes from the older stored position and pauses there. When the first device resumes, the stored position equals the one it last heard, so it plays on from its own place and skips the other device's pause.

## Statecharts

`SetDownload.mmd` and `PlaybackPosition.mmd` are drawn from each model's full state graph (`everystate -dump dot`) by `src/models.ts`. Each chart state groups the model states that look the same to a reader. Steps that stay inside one chart state are not drawn.

Last confirmed against the code at the commit that added these models (PAL-3179).
