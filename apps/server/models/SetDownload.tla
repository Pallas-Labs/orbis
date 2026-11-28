---------------------------- MODULE SetDownload ----------------------------
(***************************************************************************)
(* One Set's Download and its Retained Audio on the audio node.            *)
(*                                                                         *)
(* `state` is `sets.download_state`. Every write of it is a move in        *)
(* `DownloadMoves` (apps/server/src/download-state.ts), which              *)
(* `moveDownload` applies as a compare-and-set. Each action that writes    *)
(* it has the move's name, so `everystate conform` can check a log of the  *)
(* real moves against this spec (apps/server/src/download-trace.test.ts).  *)
(*                                                                         *)
(* `stored` is the retained file on the node. `worker` is the one download *)
(* the node runs at a time (DownloadWorker.processNext, or the Group's one *)
(* active request per node). `kept` says whether any Person keeps the Set  *)
(* in a library, a playlist or a queue.                                    *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  MaxRestarts,       \* how often the node process may die
  FinishChecksState, \* TRUE as in the code: `finish` moves only a running Download
  ReleaseAtOnce      \* TRUE: no other step runs between a step and the release that follows it

VARIABLES
  state,      \* sets.download_state
  stored,     \* the node holds the retained file
  worker,     \* "idle", "fetching" (backends run), "stored" (file moved in, not settled)
  kept,       \* some Person keeps the Set
  releaseDue, \* a removal or a finish committed, and the release that follows has not run
  removing,   \* a release committed, and its removeFiles has not run
  booting,    \* the node restarted, and resetStuckDownloads has not run
  linked,     \* the node sent its inventory to the Group since it last restarted
  restarts

vars == <<state, stored, worker, kept, releaseDue, removing, booting, linked, restarts>>

States == {"none", "queued", "downloading", "ready", "failed"}
NotReady == {"none", "queued", "downloading", "failed"}

Init ==
  /\ state = "none"
  /\ stored = FALSE
  /\ worker = "idle"
  /\ kept = TRUE
  /\ releaseDue = FALSE
  /\ removing = FALSE
  /\ booting = FALSE
  /\ linked = TRUE
  /\ restarts = 0

\* Library.remove commits the removal, then calls release. The worker's finish (and the
\* Group's settle) commits, then calls release. Each is two transactions. With ReleaseAtOnce
\* the model lets nothing run between them; without it, any step may.
Free == ~(ReleaseAtOnce /\ releaseDue)

(* --- People ------------------------------------------------------------ *)

\* A Person saves the Set again (a library entry, a playlist or a queue).
Keep ==
  /\ Free
  /\ ~kept /\ kept' = TRUE
  /\ UNCHANGED <<state, stored, worker, releaseDue, removing, booting, linked, restarts>>

\* The last Person who kept the Set removes it (Library.remove).
Unkeep ==
  /\ Free
  /\ kept /\ kept' = FALSE
  /\ releaseDue' = TRUE
  /\ UNCHANGED <<state, stored, worker, removing, booting, linked, restarts>>

\* DownloadMoves.queue: a Person asks for the Download, or Auto Download asks on save.
\* Any Person who sees the Set may ask (ADR 0010), so the Set need not be kept. Asking
\* again while the Download waits or runs changes no row.
Queue ==
  /\ Free
  /\ state \in {"none", "failed"}
  /\ state' = "queued"
  /\ UNCHANGED <<stored, worker, kept, releaseDue, removing, booting, linked, restarts>>

\* DownloadMoves.cancel: the requester or the Host cancels. A ready Download is kept.
Cancel ==
  /\ Free
  /\ state \in NotReady
  /\ state' = "none"
  /\ UNCHANGED <<stored, worker, kept, releaseDue, removing, booting, linked, restarts>>

\* DownloadMoves.drop: the Host removes the Person who asked (app-core.ts).
Drop ==
  /\ Free
  /\ state \in {"queued", "downloading"}
  /\ state' = "none"
  /\ UNCHANGED <<stored, worker, kept, releaseDue, removing, booting, linked, restarts>>

\* DownloadMoves.release (audio-release.ts): no Person keeps the Set, so its audio goes.
\* The transaction commits first. The files go in RemoveFiles: the Group sends the node
\* `release`, which a node that is not linked never gets. Its next inventory pass settles it.
Release ==
  /\ ~kept
  /\ state' = "none"
  /\ releaseDue' = FALSE
  /\ removing' = linked
  /\ UNCHANGED <<stored, worker, kept, booting, linked, restarts>>

\* The release that follows finds the Set kept again: no row changes.
ReleaseKept ==
  /\ releaseDue /\ kept
  /\ releaseDue' = FALSE
  /\ UNCHANGED <<state, stored, worker, kept, removing, booting, linked, restarts>>

\* releaseAudio's removeFiles, after the transaction.
RemoveFiles ==
  /\ Free
  /\ removing
  /\ stored' = FALSE
  /\ removing' = FALSE
  /\ UNCHANGED <<state, worker, kept, releaseDue, booting, linked, restarts>>

(* --- The worker on the node -------------------------------------------- *)

\* DownloadMoves.claim. Assumption: a release's file removal reaches the node before the
\* node starts the next download of the same Set (one fiber, or one Group socket).
Claim ==
  /\ Free
  /\ worker = "idle" /\ ~booting /\ ~removing
  /\ state = "queued"
  /\ state' = "downloading"
  /\ worker' = "fetching"
  /\ UNCHANGED <<stored, kept, releaseDue, removing, booting, linked, restarts>>

\* media.storeDownloaded: the fetched file moves into place. Not a move.
Store ==
  /\ Free
  /\ worker = "fetching"
  /\ worker' = "stored"
  /\ stored' = TRUE
  /\ UNCHANGED <<state, kept, releaseDue, removing, booting, linked, restarts>>

\* DownloadMoves.fail: every backend failed, or a cancel aborted the fetch.
Fail ==
  /\ Free
  /\ worker = "fetching"
  /\ state = "downloading"
  /\ state' = "failed"
  /\ worker' = "idle"
  /\ UNCHANGED <<stored, kept, releaseDue, removing, booting, linked, restarts>>

\* The fetch ends after a cancel, a drop or a release won: `fail` changes no row.
FailLate ==
  /\ Free
  /\ worker = "fetching"
  /\ state # "downloading"
  /\ worker' = "idle"
  /\ UNCHANGED <<state, stored, kept, releaseDue, removing, booting, linked, restarts>>

\* DownloadMoves.finish: the checkpoint after the file move. The worker calls release next.
Finish ==
  /\ Free
  /\ worker = "stored"
  /\ (state = "downloading" \/ ~FinishChecksState)
  /\ state' = "ready"
  /\ worker' = "idle"
  /\ releaseDue' = ~kept
  /\ UNCHANGED <<stored, kept, removing, booting, linked, restarts>>

\* `finish` changed no row: a cancel or a release landed while the file was stored, so the
\* worker removes the file ("audio download discarded").
Discard ==
  /\ Free
  /\ worker = "stored"
  /\ FinishChecksState
  /\ state # "downloading"
  /\ worker' = "idle"
  /\ stored' = FALSE
  /\ UNCHANGED <<state, kept, releaseDue, removing, booting, linked, restarts>>

(* --- Restarts and the Group's inventory pass --------------------------- *)

\* The node process dies. The running download and a removeFiles that has not run are lost.
Restart ==
  /\ Free
  /\ restarts < MaxRestarts
  /\ restarts' = restarts + 1
  /\ worker' = "idle"
  /\ removing' = FALSE
  /\ booting' = TRUE
  /\ linked' = FALSE
  /\ UNCHANGED <<state, stored, kept, releaseDue>>

\* DownloadMoves.requeue (resetStuckDownloads): a Download that was running waits again.
Requeue ==
  /\ Free
  /\ booting
  /\ state = "downloading"
  /\ state' = "queued"
  /\ booting' = FALSE
  /\ UNCHANGED <<stored, worker, kept, releaseDue, removing, linked, restarts>>

\* resetStuckDownloads with nothing running: no row changes.
Boot ==
  /\ Free
  /\ booting
  /\ state # "downloading"
  /\ booting' = FALSE
  /\ UNCHANGED <<state, stored, worker, kept, releaseDue, removing, linked, restarts>>

\* The Group reconciles the node's inventory (apps/api/src/node.ts `reconcile`).
Inventory == Free /\ ~linked /\ worker = "idle"
Unwanted == stored /\ (~kept \/ state \notin {"ready", "downloading", "queued"})
Adoptable == stored /\ kept /\ state \in {"queued", "downloading"}

\* DownloadMoves.lose: the node no longer holds the file of a ready Download.
Lose ==
  /\ Inventory
  /\ ~stored /\ state = "ready"
  /\ state' = "none"
  /\ linked' = TRUE
  /\ UNCHANGED <<stored, worker, kept, releaseDue, removing, booting, restarts>>

\* DownloadMoves.adopt: the node holds a file for a Download that waits or runs.
Adopt ==
  /\ Inventory
  /\ Adoptable
  /\ state' = "ready"
  /\ linked' = TRUE
  /\ UNCHANGED <<stored, worker, kept, releaseDue, removing, booting, restarts>>

\* The Group sends `release` for a file that nobody keeps or no Download wants. Not a move.
\* For a ready row that nobody keeps, the pass runs `Release` on the row first, so the
\* command never goes out while the row reads ready.
NodeRelease ==
  /\ Inventory
  /\ Unwanted
  /\ state # "ready"
  /\ stored' = FALSE
  /\ linked' = TRUE
  /\ UNCHANGED <<state, worker, kept, releaseDue, removing, booting, restarts>>

\* The inventory agrees with the Group: nothing changes.
Reconciled ==
  /\ Inventory
  /\ ~(~stored /\ state = "ready") /\ ~Adoptable /\ ~Unwanted
  /\ linked' = TRUE
  /\ UNCHANGED <<state, stored, worker, kept, releaseDue, removing, booting, restarts>>

Next ==
  \/ Keep \/ Unkeep \/ Queue \/ Cancel \/ Drop
  \/ Release \/ ReleaseKept \/ RemoveFiles
  \/ Claim \/ Store \/ Fail \/ FailLate \/ Finish \/ Discard
  \/ Restart \/ Requeue \/ Boot
  \/ Lose \/ Adopt \/ NodeRelease \/ Reconciled

Spec == Init /\ [][Next]_vars

(* --- Rules ------------------------------------------------------------- *)

TypeOK ==
  /\ state \in States
  /\ stored \in BOOLEAN
  /\ worker \in {"idle", "fetching", "stored"}
  /\ kept \in BOOLEAN
  /\ releaseDue \in BOOLEAN
  /\ removing \in BOOLEAN
  /\ booting \in BOOLEAN
  /\ linked \in BOOLEAN
  /\ restarts \in 0..MaxRestarts

\* The Group and the node agree: a Set the Group calls ready has its file on the node.
ReadyHasAudio == state = "ready" => stored

\* No orphaned audio. A file without a ready Download exists only while a step that settles
\* it is still to come: the worker's finish or discard, the release's removeFiles, or the
\* Group's next inventory pass after a restart.
NoOrphanAudio ==
  (stored /\ state # "ready") => (worker = "stored" \/ removing \/ ~linked)

\* A retry is idempotent: the node never fetches a ready Download again.
ReadyIsNeverFetched == worker # "idle" => state # "ready"
=============================================================================
