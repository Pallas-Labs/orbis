# Streaming test failure inventory

Written before the streaming tests or production changes.

- The short M4A fixture can hide Ogg/Opus timeline and late-seek failures.
- The displayed elapsed value can match a requested seek while AVPlayer still plays the old position.
- A pause during an HTTP body wait can be lost when the item becomes ready.
- A buffer underrun can advance the playhead or cause an unsolicited seek on recovery.
- A silent or unsupported fixture can appear stalled without testing buffering. Each streaming test must prove real media-time progress after release.
- A fully downloaded asset cannot prove buffer starvation. The server must report an active held response and the player must enter its waiting state before checking its position.
- A timeout must fail at the missing gate and retain raw media time, monotonic time, player state, buffer ranges, and stream counters.

The controlled endpoint uses real ranged HTTP bytes with AudioPlayer and AVPlayer. It bypasses the production audio route and authentication. The late Ogg seek test uses the production audio route separately.

## Controlled format comparison

Written before adding the equal-duration AAC fixture and comparison test.

- A comparison using short AAC and long Opus can confuse buffer exhaustion with codec behavior. Both fixtures must last 600 seconds and target 96 kbps.
- A stream route that always sends Ogg bytes can falsely label an AAC comparison. It must serve each Set's retained format and verify exact ranged bytes and content type.
- Raw AVPlayer can pause during starvation while AudioPlayer reports interrupted. Record both and require loading during the held-body interval rather than equating every non-playing state with buffering.
- Releasing HTTP bytes can leave the engine paused. Each format must prove actual media-time progress after release with the same hold, timeout, and timeline assertions.
