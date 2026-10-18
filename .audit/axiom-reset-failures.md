# Media-services reset failure cases

Written before the new probes and player correction. Axiom media, networking and concurrency guidance plus Apple's mediaServicesWereResetNotification documentation establish the expected policy.

- A playing retained AVPlayer becomes invalid when system media services reset. It must stop, expose recovery and preserve the current Set and position.
- A paused Set must stay quiet after reset. A reset must not authorize playback.
- An in-flight session activation, seek completion or item callback must not restart the invalid player after reset.
- If another Set activation is pending, the reset must clear its sound intent until another explicit user action.
- Explicit Play must create a fresh AVPlayer/session through the existing model retry path, resume the saved exact position and advance.
- Reset notifications can be delivered from an SDK callback. The probe posts from outside MainActor and verifies the registered main-queue adapter.

The probes use a real HTTP fixture and AVPlayer but post the public reset notification themselves. They do not reset the Mac's shared media server or prove physical-device daemon recovery.

Coverage after implementation: the two probes cover playing and paused resets, retained position, explicit toggle recovery and timeline advancement. Reset during an in-flight session, seek or another Set activation remains unmeasured. Those requirements have source review only. Exact local resume applies to the toggle/remote Play path; row/detail Play can use the last server position.
