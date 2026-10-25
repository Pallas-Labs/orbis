# Playback reliability failure cases

Written before the playback tests and production changes.

- A cold explicit Cue in the final five seconds can be mistaken for a completed saved position and start at zero.
- An initial seek can leave the player audible before it reaches the requested position.
- A seek completion can resume playback after the person paused.
- An older seek completion can move the playhead away from the latest requested position.
- A delayed request to play another Set can replace a newer Cue selection on the current Set.
- A failed AVPlayerItem can remain in the player after Retry, so playback never recovers.
- The seek bar can show the requested position while the actual AVPlayer timeline remains elsewhere.
- Test setup can silently use a missing fixture, expired token, or unavailable service. The integration tests require lane environment variables and real HTTP responses.

The tests read the actual AVPlayer timeline and retain JSON attachments. The cold Cue journey also retains screenshots and checks the stored position after pausing.
