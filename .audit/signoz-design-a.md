```swift
// AppModel. Call after restoring a client in either initializer,
// and immediately after successful sign-in, before other awaits.
diagnosticsSender = PlaybackDiagnosticsSender(player: audioPlayer, client: client)

// At the start of signOut(), before stop() and resetDiagnostics().
diagnosticsSender?.cancel()
diagnosticsSender = nil
```

Recommend **cursor-based reads from the existing ring, with one immutable batch held during upload and retry**. Keep Copy Playback Report unchanged.

I applied architect and poteto-mode sequentially using the current model substitution. No independent panel ran because you prohibited children. This is a source-grounded design at `3a39151`; no files, builds, tests, SSH, or posts were involved.

The current ownership fits this shape. [AudioPlayer.swift](~/.t3/worktrees/orbis/t3-9f35e2c6/apps/apple/Orbis/AudioPlayer.swift:174) captures typed events synchronously. [PlaybackDiagnostics.swift](~/.t3/worktrees/orbis/t3-9f35e2c6/apps/apple/Orbis/PlaybackDiagnostics.swift:289) owns the 256-entry ring and preferentially evicts samples. AppModel owns authentication and player lifetime; OrbisSession shares that model across windows and CarPlay. Production requests enter the Cloudflare Group, which calls the shared authenticated `createPortableApp` handler. A Bun-only route would miss production.

The two viable whole shapes are:

- **Incremental batches with a separate sender queue.** `record` synchronously offers the newly created typed entry into a bounded MainActor queue. One pump drains batches through an off-main transport. This hides delivery policy from the recorder and permits independent incident retention. It adds a second eviction policy, queue reset, drop counter, and session attachment boundary. Callbacks must never create a Task to enqueue.
- **Cursor reads from the existing ring.** A single sender periodically copies unsent entries, then uploads off-main. The ring remains the sole rolling history; only the current retry batch is copied. This has the smaller producer interface and leaves callbacks unchanged. It accepts that ring eviction can remove unsent entries.

Choose the second. Retain the first candidate’s immutable retry batch and explicit loss accounting. Do not add a second rolling queue.

Proposed signatures, with implementation bodies omitted:

```swift
struct DiagnosticsCursor: Sendable {
  let epoch: Int
  let sequence: Int
}

struct DiagnosticsSlice: Sendable {
  let entries: [PlaybackDiagnostics.Entry]
  let through: DiagnosticsCursor
  let missingCount: Int
}

enum DiagnosticsRead: Sendable {
  case slice(DiagnosticsSlice)
  case reset(DiagnosticsCursor)
}

@MainActor
extension AudioPlayer {
  func diagnosticsCursor() -> DiagnosticsCursor
  func diagnostics(after: DiagnosticsCursor, limit: Int) -> DiagnosticsRead
}

@MainActor
final class PlaybackDiagnosticsSender {
  init(player: AudioPlayer, client: OrbisClient)
  func cancel()
}

private actor PlaybackDiagnosticsTransport {
  // Maps typed entries, encodes JSON, and awaits authenticated HTTP.
  func upload(_ batch: DiagnosticsBatch) async throws -> DiagnosticsReceipt
}

extension OrbisClient {
  func uploadPlaybackDiagnostics(_ body: Data) async throws -> DiagnosticsReceipt
}
```

Add checked `Sendable` conformances to the existing diagnostic value types. The mutable ring and AVPlayer stay on MainActor. The transport actor performs synchronous encoding on its own executor; creating a MainActor Task alone would not move encoding off-main. The diagnostics client method must retain HTTP status and `Retry-After`, which the current generic `send` method hides.

The cursor algorithm needs an explicit watermark because sample eviction creates holes inside the ring. Select the oldest retained entries after the cursor, up to 32. If more retained entries remain, `through.sequence` is the last selected sequence. Otherwise it is the latest recorded sequence, including evicted trailing samples.

```text
missingCount = through.sequence - previous.sequence - entries.count
```

Advance only after terminal handling of that frozen batch. An empty slice with a positive missing count is a valid loss report. If byte limiting reduces the selected prefix, recompute its watermark and missing count; never advance past an entry omitted only to fit the request.

The new Orbis wire format should be independent of the clipboard report and Swift’s synthesized enum encoding:

```json
{
  "schemaVersion": 1,
  "runId": "a5632040-a77d-47e9-a902-59b206081760",
  "metadata": {
    "appVersion": "0.1.0",
    "appBuild": "1",
    "osName": "iOS",
    "osVersion": "26.1.0"
  },
  "fromSequenceExclusive": 40,
  "throughSequence": 43,
  "missingCount": 1,
  "transportDroppedCount": 0,
  "entries": [
    {
      "sequence": 41,
      "wallTimeMs": 1792300000000,
      "uptime": 231.5,
      "event": { "kind": "sample" },
      "snapshot": {}
    },
    {
      "sequence": 43,
      "wallTimeMs": 1792300000100,
      "uptime": 231.6,
      "event": {
        "kind": "seekResult",
        "seekID": 7,
        "target": 120,
        "actual": 120.04,
        "finished": true,
        "duration": 0.1
      },
      "snapshot": {}
    }
  ]
}
```

The empty snapshots above abbreviate the sketch. The real schema requires the fixed existing snapshot fields, including at most eight buffer ranges and optional numeric access metrics. Each event is a closed discriminated union matching the existing event cases and payloads.

Validation must enforce:

- At most 32 entries and 64 KiB of actual request bytes, including chunked bodies.
- Strictly increasing safe-integer sequences within the declared interval, with consistent missing counts.
- Fixed enums, booleans, finite nullable numbers, bounded integer counters, and bounded timestamps.
- Canonical UUID run IDs. Restrict version metadata to short numeric version strings or `"unknown"`; construct OS version from numeric components rather than the existing descriptive OS string.
- Rejection of excess properties at every object level. No arbitrary attributes, raw report text, descriptions, URLs, names, Set identifiers, or SDK error messages.

The exporter constructs fresh OTLP records from the decoded values. It must never forward the original parsed object. **Boundary Discipline** places privacy enforcement at this HTTP boundary. **Type System Discipline** derives the TypeScript batch type from the schema and requires exhaustive event mapping.

Use the following proposed sender limits:

- One sender per authenticated AppModel, one loop, one pending batch, and one upload at a time.
- Poll every five seconds while runnable. No empty network requests. Start from the current ring tail so attachment cannot upload earlier signed-out history.
- Retain the existing 256-entry ring plus at most 32 copied entries and a 64 KiB encoded request.
- Give each upload a ten-second wall deadline, including connectivity waiting. Cancel its URLSession operation at the deadline.
- Try each frozen batch at most three times and for at most 60 seconds. Use jittered exponential delay and honor longer `Retry-After` values by dropping the expired batch and cooling down, rather than retrying early.
- Advance and count loss after retry exhaustion or permanent rejection. Preserve identical run ID, sequences, and payload across retries.
- Pause naturally during suspension. No disk spool or background delivery guarantee.

Sign-out synchronously marks the sender stopped, cancels its loop and active upload, and invalidates its ownership before player stop/reset. Every continuation checks cancellation and sender identity before another upload or cursor update. The sender captures one immutable OrbisClient; it never reads a replacement token from AppModel. A new sign-in gets a fresh sender and run UUID.

Include the diagnostics epoch in every local cursor. Reset invalidates any frozen batch and starts a new run before further reads. Existing player generation guards continue to reject stale AVPlayer callbacks. Cancellation cannot retract a batch already accepted by the server; the guarantee is no further retries, publication, or reuse under a new credential. **Model the Domain** makes these session transitions explicit instead of relying on a collection of unrelated flags.

The server contract can stay small:

```ts
type PlaybackDiagnosticsBatch = typeof PlaybackDiagnosticsBatchSchema.Type;

type DiagnosticsReceipt =
  | { readonly outcome: "accepted" }
  | { readonly outcome: "partial"; readonly rejectedLogRecords: number };

type ExportPlaybackDiagnostics = (
  batch: PlaybackDiagnosticsBatch,
  signal: AbortSignal
) => Promise<DiagnosticsReceipt>;
```

Add `POST /diagnostics/playback` to [http-api.ts](~/.t3/worktrees/orbis/t3-9f35e2c6/packages/contracts/src/http-api.ts) with `SetAccess`. Register it in [app-core.ts](~/.t3/worktrees/orbis/t3-9f35e2c6/apps/server/src/app-core.ts:330), and require a device caller with a non-null key ID. Inject the exporter through `createPortableApp` and the Bun `createApp` options.

The route authenticates, admits bounded work, reads and validates the bounded body, then awaits one export attempt. Proposed server bounds are two active diagnostics requests per app instance, no waiting queue, a five-second route deadline, and a small instance-wide request-rate bucket. Excess work returns 429. This bounds stalled exports without an unbounded per-device map.

Return JSON 200 for full or partial collector acceptance, 503 for retryable export failure, and 502 for permanent collector refusal. Missing configuration returns 503 with a longer cooldown. Use fixed error messages. Never return or log collector response text or credentials. Ordinary request logs record only bounded outcome/count fields.

Export one searchable OTLP log per entry, plus a loss-summary record when needed. Use fixed attribute names for run ID, sequence, event kind, generations, seek ID, snapshot values, and event payload. Resource metadata includes `service.name = "orbis-playback"` and validated versions. Do not add Person or device identity.

POST OTLP JSON to `https://otlp.parthm.me/v1/logs`, using decimal-string nanosecond timestamps and numeric enums. Parse partial success and never retry it. Only transport failures and OTLP statuses 429, 502, 503, and 504 become retryable relay failures. Keep retries exclusively in the Apple sender. These rules follow the [OTLP specification](https://opentelemetry.io/docs/specs/otlp/).

Wire the exporter in [group.ts](~/.t3/worktrees/orbis/t3-9f35e2c6/apps/api/src/group.ts), add environment types in `apps/api/src/index.ts`, and update [alchemy.run.ts](~/.t3/worktrees/orbis/t3-9f35e2c6/apps/web/alchemy.run.ts). Add Worker secrets `SIGNOZ_OTLP_ACCESS_CLIENT_ID` and `SIGNOZ_OTLP_ACCESS_CLIENT_SECRET` through the existing secret/inherit mechanism. Set the collector endpoint as server configuration. Send the credentials only as Cloudflare Access headers, disable redirects, and keep them out of Website/Vite bindings. No Vanta infrastructure change is required.

Write these failure cases before implementation:

1. Real authenticated HTTP rejects missing/revoked credentials, node credentials, private extra fields, invalid enums, nonfinite values, inconsistent sequences, oversized chunked bodies, and excess ranges without contacting the collector.
2. An app-produced batch traverses `createApp` with a real database and bounded local collector. Verify exact sanitized OTLP output, headers, timestamps, and searchable correlation fields.
3. A blocked collector exhausts the deadline. Concurrent requests never exceed the cap; unrelated API routes remain responsive; cancellation releases capacity.
4. Native playback continues while export stalls. Exercise sample-first eviction, internal and trailing sequence gaps, byte trimming, retry exhaustion, and partial success. Verify bounded storage and no callback encoding or added per-event Tasks.
5. Sign out during encoding, upload, and backoff, then sign in with another token. Release the old response and callbacks. Verify no old retry or state update and no old batch under the new token.
6. Cover both restored-client initializers, successful sign-in, shared-window lifetime, reset, and unchanged Copy Playback Report behavior.

One isolated implementation owner can complete the contracts, relay, sender, and native wiring together. The parent can verify through the existing HTTP, workerd, and Mac native lanes, then send an actual app-produced run through the deployed authenticated relay and locate that run in SigNoz. Retain source hashes, sanitized payloads, assertions, and native artifacts.

We accept unsent ring eviction and loss on exit in exchange for one rolling buffer and no persistence. Ambiguous network failures may create duplicates, identifiable by run ID and sequence. These diagnostics can distinguish requested seeks from observed timeline movement; the physical cause of an audible skip remains open.
