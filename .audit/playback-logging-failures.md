# Playback report failure cases

The playback report must remain useful when the symptom is a short jump, repeat, or delayed command and the affected phone is no longer attached to a Mac.

## Collection failures

- A report generated while SwiftUI evaluates `body` can be stale by the time the person taps Copy. The button must call `playbackReport()` in its action and copy that result.
- A second timer can sample a different state from the player's existing half-second observer and adds work during playback. Periodic diagnostic samples must use that observer and occur no more than once every five seconds, including while the player waits.
- AVPlayer KVO and completion callbacks can arrive on non-main threads or after a newer item replaced the old item. Each callback must enter the main actor through the existing documented boundary and reject stale generations before recording.
- A pending server activation can accept, fail, or lose to a newer request after Play, Pause, or Cue changes the pending intent. The report must record the activation generation, initial intent and target, later intent changes, and the accepted, superseded, or failed outcome with request duration.
- Remote next, previous, and interval skip commands delegate to seek. The report must retain the original remote command before delegation and must not claim that the derived seek came from an app button or a specific remote surface.
- A held seek or waiting stream can have no finite current media time. The current snapshot must still be present and encode unknown numeric values as JSON `null`, never NaN or Infinity.
- Buffer KVO and access events can flood the history. Periodic samples are throttled, buffer ranges are capped at eight, and the recorder retains at most 256 chronological entries.
- A large report can exceed clipboard or support-channel limits even with 256 entries. Rendering must remove the oldest retained entries until the complete UTF-8 JSON is at most 256 KiB and must include those removals in the reported eviction count.
- Stop is evidence and must stay in ordinary history. Sign out crosses an account boundary, so it should stop playback and then clear the in-memory diagnostics.

## Privacy failures

- Set ids, titles, service addresses, device tokens, URLs, SDK error comments, localized error descriptions, and `PlaybackState.failed` strings can carry private data. No report field may accept them.
- Public unified logs currently include `localizedDescription` and AVPlayer error comments. Error output must contain only a fixed normalized domain and numeric code.
- Metadata must contain only app version, build, OS name, and OS version. It must not contain device names, account data, or service data.
- Free-form event names or payload dictionaries can bypass schema review. Events, snapshots, origins, states, waiting reasons, activation phases, and errors must use fixed Codable types.

## Verification probes written before implementation

- A cheap isolated recorder test records more than 256 entries, includes NaN and Infinity inputs, exports JSON, verifies chronological newest history, eviction count, final UTF-8 size, and JSON validity.
- A privacy test seeds a private title, Set id, token, address, NSError localized description, and AVPlayer-style error comment, then verifies the report and normalized error description exclude every seed.
- A real HTTP/AVPlayer test waits for actual advancement, pauses, seeks, exports the report, and verifies command and seek-result order, current snapshot values, and one player generation.
- A controlled streaming test withholds response bytes, exports while the player waits, and verifies a waiting event plus a tap-time current snapshot.
- A delayed activation test changes pending playback intent before the HTTP response and verifies begin, intent-change, and accepted outcomes with the same model generation.
- A Settings UI journey taps Copy Playback Report, observes the Copied acknowledgement, and attaches a screenshot. Payload correctness comes from native report tests, not from the acknowledgement label.
