---------------------------- MODULE PlayNextQueue ---------------------------
(***************************************************************************)
(* One Person's Listening Queue and the Listen it keeps open.              *)
(*                                                                         *)
(* `queue` is the Person's `queue_entries` in order and `active` the entry *)
(* marked active. `Queue.change` (apps/server/src/queue.ts) is the one     *)
(* writer: each action below is one of its decisions (`played`,            *)
(* `inserted`, `replaced`, `completed`), and the step writes the entries,  *)
(* the Finish and the new Listen in one transaction.                       *)
(*                                                                         *)
(* Listens: `newest` is the Set of this Person's newest Listen, and        *)
(* `newestOpen` says it has no Finish yet. A Set that becomes active opens *)
(* a Listen; a completion closes the newest unfinished Listen of the Set   *)
(* that played to its end (`finishListen`). A Listen left behind when the  *)
(* Person plays another Set keeps no Finish: it is a Listen that did not   *)
(* reach the end, not one still playing.                                   *)
(*                                                                         *)
(* Not modelled: the playable check (every Set here has audio), the        *)
(* release of a Set that leaves the queue (after the commit), and the      *)
(* position reset before a completion.                                     *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
  Sets,          \* e.g. {a, b, c}
  None,          \* no Set
  GuardInsert,   \* TRUE as in the code: a queued action on the active Set changes nothing
  GuardComplete  \* TRUE as in the code: a completion of a Set that is not active changes nothing

VARIABLES
  queue,       \* queue_entries in position order
  active,      \* the entry marked active, or None
  newest,      \* the Set of the newest Listen, or None
  newestOpen,  \* the newest Listen has no Finish
  broken       \* a step that must change nothing changed something (see the Unchanged rules)

vars == <<queue, active, newest, newestOpen, broken>>

Range(s) == {s[i] : i \in DOMAIN s}
IndexOf(s, x) == CHOOSE i \in DOMAIN s : s[i] = x
Without(s, x) == SelectSeq(s, LAMBDA y : y # x)

\* Every order of every group of distinct Sets: what a Playlist, a Collection or Heavy Rotation
\* can hold.
Queues == UNION {{f \in [1..n -> Sets] : Cardinality(Range(f)) = n} : n \in 0..Cardinality(Sets)}

Init ==
  /\ queue = <<>>
  /\ active = None
  /\ newest = None
  /\ newestOpen = FALSE
  /\ broken = {}

\* Queue.change: store the decision's queue and active entry, close the finished Set's Listen,
\* and open one for a Set that becomes active. `noop` names the rule of a step that must change
\* nothing, or is "" when the step may change the queue.
Change(q, a, finished, noop) ==
  LET opens == a # None /\ a # active
      closes == finished # None /\ finished = newest
  IN /\ queue' = q
     /\ active' = a
     /\ newest' = IF opens THEN a ELSE newest
     /\ newestOpen' = IF opens THEN TRUE ELSE IF closes THEN FALSE ELSE newestOpen
     /\ broken' = IF noop # "" /\ <<q, a, newest', newestOpen'>> # <<queue, active, newest, newestOpen>>
                  THEN broken \cup {noop}
                  ELSE broken

\* A decision that returns null: the transaction writes nothing.
Keep == UNCHANGED vars

(* --- Decisions --------------------------------------------------------- *)

\* `played`: a queued Set takes the active place and the Sets before it leave (PAL-2128). Any
\* other Set takes the place of the active one, and what followed that Set still follows.
Play(s) ==
  IF s \in Range(queue)
  THEN Change(SubSeq(queue, IndexOf(queue, s), Len(queue)), s, None, "")
  ELSE LET ahead == IF active = None THEN queue
                    ELSE SubSeq(queue, IndexOf(queue, active) + 1, Len(queue))
       IN Change(<<s>> \o ahead, s, None, "")

\* `placedAfter`: behind the active entry, or at the end when nothing is active.
PlacedAfter(rest, s) ==
  IF active = None \/ active \notin Range(rest)
  THEN Append(rest, s)
  ELSE LET at == IndexOf(rest, active)
       IN SubSeq(rest, 1, at) \o <<s>> \o SubSeq(rest, at + 1, Len(rest))

\* `inserted`: Play Next ("next") or Add to Queue ("end"). The active entry stays active.
Insert(s, placement) ==
  IF GuardInsert /\ s = active
  THEN Keep
  ELSE LET rest == Without(queue, s)
           q == IF placement = "end" THEN Append(rest, s) ELSE PlacedAfter(rest, s)
       IN Change(q, active, None, IF s = active THEN "ActiveInsertUnchanged" ELSE "")

\* `replaced`: a Playlist, Collection or Heavy Rotation becomes the queue and its first Set starts.
Replace(q) ==
  IF q = <<>> THEN Change(q, None, None, "") ELSE Change(q, q[1], None, "")

\* `completed`: the active Set played to its end. It leaves, and the Set after it starts.
Complete(s) ==
  LET found == s \in Range(queue) /\ (s = active \/ ~GuardComplete)
  IN IF ~found
     THEN Keep
     ELSE LET at == IndexOf(queue, s)
              next == IF at < Len(queue) THEN queue[at + 1] ELSE None
          IN Change(Without(queue, s), next, s, IF s = active THEN "" ELSE "StaleCompletionUnchanged")

Next ==
  \/ \E s \in Sets : Play(s) \/ Complete(s) \/ \E p \in {"next", "end"} : Insert(s, p)
  \/ \E q \in Queues : Replace(q)

Spec == Init /\ [][Next]_vars

\* The Sets act alike, so the check treats a renaming of them as the same state.
SetSwaps == Permutations(Sets)

(* --- Rules ------------------------------------------------------------- *)

TypeOK ==
  /\ queue \in Queues
  /\ active \in Sets \cup {None}
  /\ newest \in Sets \cup {None}
  /\ newestOpen \in BOOLEAN
  /\ broken \subseteq {"ActiveInsertUnchanged", "StaleCompletionUnchanged"}

\* No Set is in the queue twice.
NoDuplicates == Cardinality(Range(queue)) = Len(queue)

\* The active Set is the first entry: the queue holds only what lies ahead (PAL-2128).
ActiveIsFirst == active # None => Len(queue) > 0 /\ queue[1] = active

\* No queue is stored without the Listen it stands for: the active Set has the newest Listen,
\* and that Listen has no Finish.
ActiveHasOpenListen == active # None => newest = active /\ newestOpen

\* Play Next or Add to Queue on the active Set changes nothing.
ActiveInsertUnchanged == "ActiveInsertUnchanged" \notin broken

\* A completion of a Set that is not active changes nothing, so a retried signal is safe.
StaleCompletionUnchanged == "StaleCompletionUnchanged" \notin broken
=============================================================================
