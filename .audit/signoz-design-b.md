## Usage

The sender belongs to `AppModel`, which owns both the signed-in client and the shared `AudioPlayer`.

```swift
// Start once when a signed-in OrbisClient becomes active.
model.startPlaybackDiagnostics(using: client)

// AudioPlayer only records into its existing ring.
// The sender drains on its own schedule.

// Sign-out cancels delivery before the player and client are reset.
model.signOut()
```

The app posts sanitized batches to `POST /api/playback-diagnostics` using its existing Orbis bearer token. The Group authenticates the device, validates the batch, converts it to OTLP logs, and sends it to SigNoz. The app never receives the Cloudflare Access credentials.

## Grounding

`AudioPlayer` already records fixed playback events and numeric snapshots into a 256-entry ring. Its report encoder runs synchronously for Copy Playback Report, so automatic delivery should not call that encoder from player callbacks. `AppModel` owns sign-in, sign-out, the client, and the player; `OrbisSession` shares the model across app windows and CarPlay. Sign-out currently stops playback and resets diagnostics.

The public API Worker forwards `/api/*` requests to the Cloudflare Group. `Group` calls `createPortableApp`, which authenticates device bearer tokens before route dispatch. The Bun server and the Group share that handler. A dedicated route there reaches production and local HTTP tests; a Bun-only endpoint would not.

The grounding notes identify `https://otlp.parthm.me/v1/logs` as the existing OTLP HTTP endpoint. Cloudflare Access credentials must remain in Worker secrets. Do not read them into app configuration or include them in responses or logs.

## Options

| Shape | Benefits | Costs |
| --- | --- | --- |
| New entry queue plus sender queue | Separates delivery from the report ring and can retain entries while export stalls. | Duplicates state and eviction policy. Callbacks would need to append to two stores or notify the queue. More lifecycle and concurrency rules are needed. |
| Cursor snapshots from the existing ring | Reuses the player’s sole event store. Player callbacks stay synchronous and do no encoding or networking. | A stalled sender can fall behind the 256-entry ring. The sender must report cursor gaps and accept that overwritten entries are lost. |

**Recommend cursor snapshots.** They fit the existing ownership: the player owns recorded diagnostics, and `AppModel` owns delivery lifetime. The sender keeps only a cursor and one in-flight batch. It reads a bounded snapshot periodically, so a stalled export cannot grow a second queue without limit.

## Shape

Caller usage requires one lifecycle operation on `AppModel` and one bounded snapshot operation on `AudioPlayer`. The snapshot returns immutable `Sendable` values; JSON encoding happens off the main actor.

```swift
@MainActor
final class AppModel {
  private var playbackDiagnosticsSender: PlaybackDiagnosticsSender?

  func startPlaybackDiagnostics(using client: OrbisClient)
  func stopPlaybackDiagnostics()
  func signOut()
}

@MainActor
final class AudioPlayer {
  func diagnosticBatch(after sequence: Int, limit: Int) -> DiagnosticBatch
}

struct DiagnosticBatch: Sendable {
  let entries: [DiagnosticEntry]
  let nextSequence: Int
  let missedCount: Int
}

actor PlaybackDiagnosticsSender {
  func start(
    player: AudioPlayer,
    client: OrbisClient,
    generation: Int
  )

  func cancel()
}
```

`diagnosticBatch` copies entries after the cursor, up to the batch limit. It reports how many sequence values the ring has already evicted. It does not encode JSON. The sender has one loop, one pending batch, and one request at a time. The loop sleeps between drains; player callbacks do not start tasks or wake the sender per event.

`PlaybackDiagnosticsSender` encodes the copied entries in a detached task, then posts through the `OrbisClient`’s injected `URLSession`. Add a dedicated client method rather than exposing the bearer token or making generic `send` public. Give the request and session a finite timeout, such as 10 seconds. Keep one bounded retry for retryable server or transport failures, honoring `Retry-After` within a fixed maximum delay. Do not retry malformed batches, authorization failures, or OTLP partial success. A memory-only sender can lose data on app suspension or exit; ambiguous timeouts can duplicate a batch.

Give each sender run a fresh UUID and each entry its existing sequence number. Neither value persists across sign-in. On successful sign-in, start the sender after storing the key. Start it from both restored-client initialization paths. On sign-out, cancel the sender first, increment a sender generation, then stop the player and reset diagnostics. After every await, the sender checks cancellation and generation before taking another snapshot or retrying. A sender captures its own immutable client, so a late completion cannot send an old batch with a later sign-in’s token.

Use an explicit typed wire event with a fixed event kind and optional, type-specific numeric and enum fields. Do not serialize `PlaybackDiagnostics.Event` directly if that would expose synthesized enum encoding as the public protocol.

```swift
struct PlaybackDiagnosticsBatch: Encodable, Sendable {
  let schemaVersion: Int
  let runID: UUID
  let metadata: PlaybackMetadata
  let cursor: Int
  let missedCount: Int
  let entries: [PlaybackDiagnosticWireEntry]
}

struct PlaybackDiagnosticWireEntry: Encodable, Sendable {
  let sequence: Int
  let timestamp: Date
  let uptimeSeconds: Double?
  let kind: PlaybackEventKind
  let snapshot: PlaybackSnapshotWire
  let fields: PlaybackEventFields
}
```

`PlaybackEventFields` should be a typed enum or fixed per-kind record. It must not contain `[String: Any]`, arbitrary dictionaries, event descriptions, or raw error text. Use the existing fixed event enums, finite numeric values, booleans, and normalized error domain plus numeric code. Bound the batch by both entry count and encoded byte size. Start with at most 32 entries and 64 KiB per request; reject an encoded batch above the cap rather than splitting it with unbounded work.

On the server, add a bounded payload schema to `packages/contracts/src/http-api.ts` and a `playback-diagnostics` group protected by `SetAccess`. The schema checks the schema version, UUID, metadata string lengths, enum values, integer ranges, finite numbers, entry count, and event-specific shape. Reject unknown keys. The route does not accept raw report JSON.

```ts
interface PlaybackDiagnosticsExporter {
  export(
    batch: PlaybackDiagnosticsBatch,
    signal: AbortSignal
  ): Promise<"sent" | "partial-success">;
}
```

Keep the exporter private to the server. The shared handler validates the payload, maps it to OTLP, and calls an injected exporter. The Cloudflare Group supplies an exporter configured from `SIGNOZ_OTLP_URL`, `SIGNOZ_OTLP_ACCESS_CLIENT_ID`, and `SIGNOZ_OTLP_ACCESS_CLIENT_SECRET` Worker bindings. Keep the fixed URL as a server default only if deployment conventions require it; credentials always come from secrets. Configure explicit fetch timeout and response-size limits. Do not include credentials, request payload, or full collector response in route logs.

The server maps each entry to an OTLP `logRecord` with a decimal-string nanosecond timestamp, a fixed event name, and fixed attributes. Group entries under `resourceLogs` and `scopeLogs`; use app version, build, OS name, and OS version as resource attributes. Use run ID and sequence for correlation, without device, account, set, or persistent identifiers. Serialize enums and values to OTLP `AnyValue` fields. The server owns this mapping so clients cannot submit arbitrary OTLP attributes.

Limit authenticated uploads per device key, for example to a small number of requests per minute, and cap payload bytes before full decode where the runtime permits. On collector success, return a small success response. Treat partial success as a non-retryable accepted result. Return bounded retry information for 429, 502, 503, and 504; do not echo collector response content.

## Failure cases to write first

Write these behavioral cases before implementation:

- The shared authenticated HTTP route accepts a valid batch and rejects missing or invalid bearer tokens.
- Unknown event kinds, unknown fields, invalid enum values, non-finite or out-of-range numbers, oversized metadata, too many entries, and oversized bodies are rejected before export.
- The exporter receives only validated typed fields; raw report strings and arbitrary dictionaries cannot reach OTLP attributes.
- OTLP mapping emits decimal-string nanosecond timestamps, fixed attribute keys, and the correct event count.
- Collector 2xx succeeds; 429, 502, 503, and 504 expose bounded retry guidance; partial success is not retried; other 4xx responses are not retried.
- Export timeout or cancellation ends within the configured bound and does not retain queued batches.
- The client sends at most one request at a time and bounds entry count, bytes, and retry delay during a stalled collector.
- Sign-out cancels an in-flight request, clears the ring, and prevents late completions from restarting the old sender or using a later sign-in’s client.
- Restored and newly signed-in clients each start one sender; repeated setup does not create duplicate loops.
- Cursor rollover reports missed entries and resumes from the newest retained entry.
- Copy Playback Report remains available and preserves its current local report behavior.

## Synthesis and tradeoffs

The cursor design is the base because it reuses the existing ring and keeps player callbacks synchronous. It takes the useful bounded-work property of the queue design through one in-flight batch and explicit byte and entry caps. The separate queue is rejected because it duplicates retained state and introduces a second writer or callback notification path.

The design accepts gaps when the app is suspended, exits, or the sender falls behind the ring. It accepts possible duplicate entries after ambiguous network failures. It sends only while signed in. It does not claim that an observed timeline discontinuity explains a physical audible skip; the skip cause remains open.

The shape keeps transport conversion in the existing client, validation in the shared HTTP boundary, and OTLP serialization in the server exporter. The app does not know SigNoz or Cloudflare Access details.

I followed **Model the Domain** by keeping the diagnostics ring as the only retained event store and making cursor loss explicit. I followed **Boundary Discipline** by requiring strict payload validation before OTLP mapping. I followed **Laziness Protocol** by preferring the existing ring over a second queue. Architect/arena diversity was reduced: this was a single-agent synthesis because the request explicitly prohibited spawning children. No files were changed, and no builds or tests were run.
