------------------------- MODULE PlaybackPosition --------------------------
(***************************************************************************)
(* One Person's Playback Position for one Set, shared by their devices.    *)
(*                                                                         *)
(* Server: Library.setPlaybackPosition stores the last save that arrives,  *)
(* clamped to the Set (apps/server/src/library.ts), and answers with it.   *)
(*                                                                         *)
(* Devices: each sends one report at a time, in order (Apple:              *)
(* AppModel.startReportingPosition, one loop; web: player.tsx `write`, a   *)
(* chain). A report that fails is dropped, not retried. Each device keeps  *)
(* the stored position its last answered save returned (`savedPosition`). *)
(* On resume it reads the Listening Queue and moves to the stored position *)
(* only when that differs from the one it knows (newerSavedPosition).      *)
(***************************************************************************)
EXTENDS Naturals, TLC

CONSTANTS
  Devices,   \* e.g. {phone, mac}
  MaxPos,    \* positions are 0..MaxPos (one step is one report interval)
  Lossy      \* TRUE: a device can go offline, so a report or its answer can be lost

None == MaxPos + 1
Pos == 0..MaxPos

VARIABLES
  server,      \* the stored Playback Position
  writer,      \* the device whose save the server holds last ("nobody" at first)
  settledSave, \* that save was a pause (a settled report)
  local,       \* [d -> the player's position]
  playing,     \* [d -> BOOLEAN]
  unsent,      \* [d -> the player moved or paused since its last report]
  known,       \* [d -> the stored position the device last heard (savedPosition)]
  outbox,      \* [d -> a report in flight, or None]
  outSettled,  \* [d -> the report in flight is a pause]
  reply,       \* [d -> an answer in flight, or None]
  online,      \* [d -> BOOLEAN]
  missed       \* a resume skipped past another device's saved pause (see HandoffResumes)

vars == <<server, writer, settledSave, local, playing, unsent, known, outbox,
          outSettled, reply, online, missed>>

Init ==
  /\ server = 0
  /\ writer = "nobody"
  /\ settledSave = FALSE
  /\ local = [d \in Devices |-> 0]
  /\ playing = [d \in Devices |-> FALSE]
  /\ unsent = [d \in Devices |-> FALSE]
  /\ known = [d \in Devices |-> 0]
  /\ outbox = [d \in Devices |-> None]
  /\ outSettled = [d \in Devices |-> FALSE]
  /\ reply = [d \in Devices |-> None]
  /\ online = [d \in Devices |-> TRUE]
  /\ missed = FALSE

Idle(d) == outbox[d] = None /\ reply[d] = None

\* The player plays one report interval further.
Listen(d) ==
  /\ playing[d] /\ local[d] < MaxPos
  /\ local' = [local EXCEPT ![d] = @ + 1]
  /\ unsent' = [unsent EXCEPT ![d] = TRUE]
  /\ UNCHANGED <<server, writer, settledSave, playing, known, outbox, outSettled, reply, online, missed>>

\* The Person pauses. The next report is a settled one.
Pause(d) ==
  /\ playing[d]
  /\ playing' = [playing EXCEPT ![d] = FALSE]
  /\ unsent' = [unsent EXCEPT ![d] = TRUE]
  /\ UNCHANGED <<server, writer, settledSave, local, known, outbox, outSettled, reply, online, missed>>

\* The reporter sends the player's position (PositionReporting). Offline, the request
\* fails and the report is dropped.
Report(d) ==
  /\ unsent[d] /\ Idle(d)
  /\ unsent' = [unsent EXCEPT ![d] = FALSE]
  /\ outbox' = [outbox EXCEPT ![d] = IF online[d] THEN local[d] ELSE None]
  /\ outSettled' = [outSettled EXCEPT ![d] = ~playing[d]]
  /\ UNCHANGED <<server, writer, settledSave, local, playing, known, reply, online, missed>>

\* Library.setPlaybackPosition stores the report and answers with what it stored.
Save(d) ==
  /\ outbox[d] # None
  /\ server' = outbox[d]
  /\ writer' = d
  /\ settledSave' = outSettled[d]
  /\ reply' = [reply EXCEPT ![d] = outbox[d]]
  /\ outbox' = [outbox EXCEPT ![d] = None]
  /\ UNCHANGED <<local, playing, unsent, known, outSettled, online, missed>>

\* The device reads the answer: the stored position becomes the known one.
Answer(d) ==
  /\ reply[d] # None /\ online[d]
  /\ known' = [known EXCEPT ![d] = reply[d]]
  /\ reply' = [reply EXCEPT ![d] = None]
  /\ UNCHANGED <<server, writer, settledSave, local, playing, unsent, outbox, outSettled, online, missed>>

\* The answer never arrives (`try?` gives nil): the known position stays as it was.
LoseAnswer(d) ==
  /\ reply[d] # None /\ ~online[d]
  /\ reply' = [reply EXCEPT ![d] = None]
  /\ UNCHANGED <<server, writer, settledSave, local, playing, unsent, known, outbox, outSettled, online, missed>>

GoOffline(d) ==
  /\ Lossy /\ online[d]
  /\ online' = [online EXCEPT ![d] = FALSE]
  /\ UNCHANGED <<server, writer, settledSave, local, playing, unsent, known, outbox, outSettled, reply, missed>>

GoOnline(d) ==
  /\ ~online[d]
  /\ online' = [online EXCEPT ![d] = TRUE]
  /\ UNCHANGED <<server, writer, settledSave, local, playing, unsent, known, outbox, outSettled, reply, missed>>

\* The Person resumes (newerSavedPosition). Online, the device reads the stored position and
\* moves there when it differs from the known one. Offline, the read fails and it plays on.
\* The resume misses a handoff when another device's pause is the save the server holds,
\* no save is in flight, and the player does not start there.
Resume(d) ==
  /\ ~playing[d]
  /\ LET moves == online[d] /\ server # known[d]
         start == IF moves THEN server ELSE local[d]
         quiet == \A e \in Devices : Idle(e) /\ ~unsent[e]
         handoff == online[d] /\ quiet /\ writer \notin {d, "nobody"} /\ settledSave
     IN /\ playing' = [playing EXCEPT ![d] = TRUE]
        /\ local' = [local EXCEPT ![d] = start]
        /\ known' = IF moves THEN [known EXCEPT ![d] = server] ELSE known
        /\ missed' = (missed \/ (handoff /\ start # server))
  /\ UNCHANGED <<server, writer, settledSave, unsent, outbox, outSettled, reply, online>>

Next ==
  \E d \in Devices :
    \/ Listen(d) \/ Pause(d) \/ Resume(d)
    \/ Report(d) \/ Save(d) \/ Answer(d) \/ LoseAnswer(d)
    \/ GoOffline(d) \/ GoOnline(d)

Spec == Init /\ [][Next]_vars

\* The devices act alike, so the check treats a swap of them as the same state.
DeviceSwaps == Permutations(Devices)

(* --- Rules ------------------------------------------------------------- *)

TypeOK ==
  /\ server \in Pos
  /\ writer \in Devices \cup {"nobody"}
  /\ settledSave \in BOOLEAN
  /\ local \in [Devices -> Pos]
  /\ playing \in [Devices -> BOOLEAN]
  /\ unsent \in [Devices -> BOOLEAN]
  /\ known \in [Devices -> Pos]
  /\ outbox \in [Devices -> Pos \cup {None}]
  /\ outSettled \in [Devices -> BOOLEAN]
  /\ reply \in [Devices -> Pos \cup {None}]
  /\ online \in [Devices -> BOOLEAN]
  /\ missed \in BOOLEAN

\* Handoff: when every save has landed and the stored one is a pause from another device,
\* resuming here starts at that pause.
HandoffResumes == ~missed
=============================================================================
