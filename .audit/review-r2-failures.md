# Round 2 failure cases

Before the next player edit, the recovery probe now records onFinished calls and requires zero before and after recovery. The captured native log already proves didPlayToEndTime at 16.0535 of 603.86 seconds. Current production code forwards it unconditionally, so it would end the Listen. An early end must preserve paused intent or loading intent and must never advance the queue. A genuine end near the known duration must still finish. Unknown duration keeps the existing completion behavior.

Callback order can place timeControlStatus playing before seek completion. Once the seek barrier clears, reconcile current engine status so loading cannot remain while audio advances. An explicit Play while loading must retry the same guarded gate without bypassing the initial seek or session.
