I've read both designs and the Swift types. Writing the verdict now.

## Verdict: build Design A's lifecycle with a smaller wire model

Both designs reached the same core shape on their own: read from the existing 256-entry ring with a cursor, and hold one frozen batch while it uploads. That shape is settled. The scores differ because of how complete each design is.

| Criterion (0–2) | A | B |
| --- | --- | --- |
| Useful, searchable, correlated facts | 2 | 1: it has `missedCount` but never sends a loss record |
| No secret or private text in the payload | 2 | 2 |
| Bounded CPU, memory, network and retry | 2 | 1: no fixed constants; a per-device rate map; an oversized batch has no defined outcome |
| Session and sign-out ownership | 2 | 1: the actor sender has to hop to MainActor for every read |
| Small interfaces that fit the Group/shared-handler split | 1 | 1 |
| Repeatable native-to-SigNoz evidence | 2 | 1: no plan to find the run ID in SigNoz |
| **Total** | **11** | **7** |

Both lose a point on interfaces because each adds a third parallel wire model in Swift.

## Objections

1. **Don't add a flattened Swift wire model.** `Entry`, `Event`, `Snapshot` and `Metadata` already use versioned Codable. The clipboard report already makes that encoding a `schemaVersion: 1` contract, and the canary just delivered 20 records in that shape. A's `{kind, …}` and B's optional `PlaybackEventFields` would each need a hand-written encoder. That is a second Swift model that can drift, and B's optional fields would sit mostly unused. Instead, wrap the existing `[Entry]` in a new upload envelope and mirror the synthesized enum shape exactly in the TS schema, for example `{"seekResult":{"_0":{…}}}` and `{"sample":{}}`. The server already flattens everything into OTLP attributes, so a flattened client format gains nothing. Synthesized enum keys have been stable since SE-0295. If a case is renamed, bump `schemaVersion`.
2. **Timestamps lose sub-second precision.** The existing encoder uses `.iso8601`, which drops fractional seconds. The upload encoder must use its own `JSONEncoder` with `.millisecondsSince1970`. The date strategy belongs to the encoder, not the types, so the types are reused unchanged.
3. **Drop A's epoch.** `reset()` is called in one place only, `AppModel.swift:473` during sign-out, and the sender is cancelled before that. Each sign-in gets a new sender that starts at the current tail. Keep only a cheap guard: if the latest sequence is below the cursor, move the cursor to the tail.
4. **A sends 502 for a permanent collector refusal, but the client treats 502 as retryable.** The relay must not return 502, 504 or a bare 5xx for errors that should not be retried. See the status table below.
5. **Replace A's two loss counters with one field.** Send `afterSequence`, the last sequence the server accepted, not the last sequence attempted. Then missing = `throughSequence − afterSequence − entries.count`. That one figure covers eviction holes inside the ring, trailing evicted samples, and batches dropped after failed retries. It stays correct when an ambiguous failure causes a duplicate delivery.
6. **Unexplained 403.** The canary got 403 with Python's default User-Agent and 200 with an explicit one; the cause is not known. The Worker exporter must set `User-Agent: Orbis-Playback-Relay/1`. Live verification must go through the deployed Worker; a Python run does not prove that path.
7. **B's per-device rate map is unnecessary.** `Group` is a single Durable Object (`apps/api/src/group.ts:20`). A cap of 2 in-flight exports for the whole instance, with no queue, is enough at this scale.

## Contract

**Swift interface:**

```swift
// PlaybackDiagnostics: existing Entry/Event/Snapshot gain `Sendable`.
struct PlaybackDiagnosticsSlice: Sendable {
  let entries: [PlaybackDiagnostics.Entry]   // ≤ 32, oldest first
  let throughSequence: Int                   // last selected, or latest recorded if nothing remains
}
@MainActor extension AudioPlayer {
  func diagnosticsTail() -> Int
  func diagnostics(after: Int, limit: Int) -> PlaybackDiagnosticsSlice
}
@MainActor final class PlaybackDiagnosticsSender {
  init(player: AudioPlayer, client: OrbisClient)   // fresh runId; cursor = tail
  func cancel()
}
extension OrbisClient {
  // Returns status + Retry-After; generic `send` hides both.
  func uploadPlaybackDiagnostics(_ body: Data) async throws -> DiagnosticsUploadResult
}
```

Encoding runs in a `nonisolated` (`@concurrent` if the target defaults to MainActor isolation) static function that receives the immutable slice. Playback callbacks stay as they are and create no Task per event.

**Wire shape** (`POST` on the existing API prefix, `SetAccess`, device caller with a non-null key ID):

```json
{"schemaVersion":1,"runId":"<uuid>",
 "metadata":{"appVersion":"…","appBuild":"…","osName":"iOS","osVersion":"…"},
 "afterSequence":40,"throughSequence":43,
 "entries":[{"sequence":41,"wallTime":1792300000000.5,"uptime":231.5,
             "event":{"sample":{}},"snapshot":{…existing fields…}}]}
```

The TS schema mirrors the Swift types:

- Excess properties are errors at every level.
- Numbers are finite or null.
- Integers are safe integers.
- There are at most 8 `bufferRanges`.
- Metadata strings are at most 64 characters.
- The body is at most 64 KiB, enforced while reading.

To catch drift between the languages, the native lane captures one real payload the app produces and commits it as a fixture. The server HTTP E2E test replays that fixture.

**Constants:**

| Setting | Value |
| --- | --- |
| Poll interval | 5 s, no empty requests |
| Batch size | 32 entries / 64 KiB; halve the count and re-encode until it fits |
| Request timeout | 10 s |
| Attempts per batch | 3 |
| Backoff | 1 s, then 2 s, ±20% jitter |
| Total time per batch | 60 s |
| `Retry-After` | Honor up to 30 s. Above that, drop the batch and pause the sender for `min(Retry-After, 300 s)` |

There is no disk spool. Data is lost on suspension or exit, and duplicates are possible; `runId` + `sequence` identify them.

**Status handling:**

| Relay response | Client action |
| --- | --- |
| 200 `{"accepted":n,"rejected":m}` (full or partial OTLP success) | Advance. Never retry. The server logs `m` as loss. |
| 429 / 503 + `Retry-After` (collector 429/502/503/504, network failure, missing config) | Retry within the limits above |
| 400 / 413 | Drop the batch and advance; the next batch's missing count covers it |
| 401 / 403 | Stop the sender. Normal auth handling owns the session. |
| 404 (old server) | Disable the sender for its lifetime and stop polling |
| 500 (permanent collector refusal) | Drop the batch and advance; no retry |

**Relay to SigNoz:**

- Sends to `https://otlp.parthm.me/v1/logs`.
- Sends Access headers from the Worker secrets `SIGNOZ_OTLP_ACCESS_CLIENT_ID` and `SIGNOZ_OTLP_ACCESS_CLIENT_SECRET`. These stay out of Website/Vite bindings.
- Uses `redirect: "manual"` and a 5 s timeout.
- Never echoes the collector's response text.
- Writes one log record per entry, with `service.name=orbis-playback`, `orbis.run_id` and `orbis.sequence`. Severity is WARN for stalls, failures and errors, INFO otherwise.
- Writes one `playback.loss` record when the missing count is above 0.

**Sign-out order:**

1. `sender.cancel()`: set stopped and cancel the Task, which cancels the URLSession request.
2. `sender = nil`
3. Player `stop()`
4. `resetDiagnostics()`
5. Clear the token.

After every await, the loop checks `Task.isCancelled` before it moves the cursor or retries. The sender captures one immutable client, so an old batch can never go out under a new token. A request the server already accepted cannot be withdrawn.

**Start points:** successful sign-in and both restored-client initializers. Each assigns a new sender to the same `AppModel` property, so only one sender exists at a time.

## Next steps

- One writer owns the contracts, relay, sender and wiring, using A's failure-case list (items 1–6).
- The parent then runs the server HTTP, workerd and Mac native lanes. After that, it sends a real app-produced run through the deployed Worker and finds that `runId` in `signoz_logs.distributed_logs_v2`.
- The evidence must not claim to explain the cause of the audible skip.
