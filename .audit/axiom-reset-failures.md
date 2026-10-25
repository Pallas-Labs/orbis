# Media-services reset failure cases

Written before the new probes and player correction. Apple's mediaServicesWereResetNotification documentation establishes the reset policy. Axiom supplied the concurrency, isolation and networking review guidance, not this reset policy.

- A playing retained AVPlayer becomes invalid when system media services reset. It must stop, expose recovery and preserve the current Set and position.
- A paused Set must stay quiet after reset. A reset must not authorize playback.
- An in-flight session activation, seek completion or item callback must not restart the invalid player after reset.
- If another Set activation is pending, the reset must clear its sound intent until another explicit user action.
- Explicit Play must create a fresh AVPlayer/session through the existing model retry path, resume the saved exact position and advance.
- Reset notifications can be delivered from an SDK callback. The probe posts from outside MainActor and verifies the registered main-queue adapter.

The probes use a real HTTP fixture and AVPlayer but post the public reset notification themselves. They do not reset the Mac's shared media server or prove physical-device daemon recovery.

Coverage after implementation: the two probes cover playing and paused resets, Set retention, explicit toggle recovery and timeline advancement. Both reset at the initial 12-second timestamp. They do not prove preservation of a position reached after playback advances. Position capture and reset during an in-flight session, seek or another Set activation have source review only. The toggle/remote Play path uses local elapsed time by source reading; row/detail Play can use the last server position.
