I reviewed HEAD `3145cb426ca903cf5dcd036cba14f57b0591629a` against `dd1468f`. This was a read-only source review. I did not build, test, use SSH, or touch secrets. No finding blocks the change. The two medium items concern battery use and the parent's plan to replace the fixture.

**Findings, most severe first**

1. **Medium. Playback sends one request about every five seconds.** `AudioPlayer.swift:1097-1101` records a `.sample` every 5 s. The sender polls every 5 s (`PlaybackDiagnosticsSender.swift:85-92`), so each poll has new entries and sends a POST. Example: a one-hour downloaded Set on cellular makes about 720 small POSTs. Axiom's `axiom-audit-energy` skill says each request keeps the cellular radio awake for 20 to 30 s, so the radio never sleeps during playback. This matches the accepted design, so it is a design choice, not a source defect. A send rule such as "16 or more entries, 30 s since the last send, or a WARN event" would cut the requests without a change to the wire format.

2. **Medium. Planned fixture replacement would weaken the Linux drift check.** Both native attachments come from synthetic rings with default snapshots:
   - `native-http-playback-upload.json` (`PlaybackDiagnosticsSenderTests.swift:101-116`) holds 2 entries, only `command` and `stalled`.
   - `playback-upload.json` holds 32 identical samples.

   The current adapted fixture holds 20 entries of 10 event types, 13 snapshots with `access`, non-null numbers and optional keys. If the 2-entry attachment replaces it, `playback-diagnostics.test.ts` and `apps/api/e2e/playback.ts` stop checking `access`, `bufferRanges`, `timeJumped.seekID`, `item`, `session` and `seekResult` against the TS schema. The seed lane strictly decodes a real AVPlayer upload in `testPlaybackAdvancesWhileOneUploadIsBlocked` (`:209-240`), but nothing attaches that body. Attach that real-playback body, or keep the adapted fixture next to the native one.

3. **Low, plausible. A deploy without the new secrets.** Both SigNoz secret names fall into `kept` (`apps/web/alchemy.run.ts:34-41`) and get `inherit` bindings (`:70-72`). Any deploy that does not set them uses this path. Nothing in this repo's history shows an inherit binding for a secret Cloudflare has never held, so the first such deploy may fail. If it succeeds instead, the relay returns retryable 503 with `retry-after: 1` (`apps/server/src/playback-diagnostics.ts:221-228`). Each playing device then makes 3 attempts per batch indefinitely and never stops (`PlaybackDiagnosticsSender.swift:123-138`). That is about 0.6 requests per second per device into the Group. The design chose this, but nobody has checked it on Cloudflare.

4. **Low. The tail-regression guard depends on timing.** `PlaybackDiagnosticsSender.swift:87` ends the sender only if it polls while `tail < readSequence`. Suppose a reset happens without cancelling the sender first, and `readSequence` or more new events arrive before the next poll. The sender would then skip new sequences `1...readSequence` and mix two sequence spaces under one `runId`. This cannot happen today: the only caller of `resetDiagnostics` is `signOut` (`AppModel.swift:481-484`), and it cancels the sender first. `diagnosticsEpoch` (`AudioPlayer.swift:184-186`) would make the guard exact if a second reset caller is ever added. `testDroppedHistoryRemainsUnacknowledgedAndResetEndsSender` relies on this timing with a 150 ms window.

5. **Low. Gaps in test coverage only.**
   - Only the reject side of the timestamp bound has a test (`playback-diagnostics.test.ts:206`). No test sends exactly `18_446_744_073_709`, which should export `"18446744073709000000"`. The arithmetic is correct: it is ≤ uint64 max, and doubles near the bound are about 0.004 ms apart, so a fraction cannot push past it.
   - No test sends an event with a second variant key or an extra sibling key, such as `{sample:{}, note:"x"}`. Excess-property rejection should cover it, but nothing proves it.

6. **Information. A batch passes or fails as a whole.** One value outside the contract drops all of its ≤32 entries with 400. Examples are a `NormalizedError.code` above 2^53 or a device clock before 1970 (`playback-diagnostics.ts:211`). A collector 200 with an unknown extra response key becomes a relay 500, and the client drops the batch. That batch may already be in SigNoz, but this produces no duplicate.

**Checked and correct**

- **Contract.** Every Swift Codable field matches the TS schema, including the `_0` wrappers, optional keys (`access`, `timeJumped.seekID`, `item.error`), null for non-finite values, and uppercase UUIDs with the `/i` regex.
  - `Schema.Int` uses `isSafeInteger`.
  - The `Record(String, Never)` empty payloads reject properties and arrays.
  - Access counts and durations stay unconstrained, so negative AVPlayer "unknown" values pass.
  - Counters (generation, seekID, requestID) are nonnegative at the source.
  - Buffer ranges are capped at 8 on both sides.
- **Wire limits.** Metadata is truncated by UTF-16 unit, which matches JS `length`. The 65,536-byte limit is inclusive on both sides.
- **Ring.** `slice` takes the earliest retained entries after the cursor. It extends through trailing evicted samples only when the last retained entry is selected, including when a new sample is evicted on arrival. When the encoder halves a batch, it recalculates `throughSequence`.
- **Watermarks.** The read and acknowledged watermarks behave as designed. A send happens only after new read progress. `through > after` always holds.
- **Retry policy.** It matches the design: 3 attempts, a 10 s wall per request, a 60 s budget per batch, retries only on transport/429/503, and Retry-After >30 s becomes a cooldown while >300 s stops. 200 never retries, 400/413/500 drop, and 401/403/404 stop.
- **Cancellation and lifetime.**
  - The task-group timeout cancels the loser, as in Axiom's concurrency timeout pattern. `withTaskCancellationHandler` cancels `bytes.task`.
  - The sender checks for cancellation after every await before it captures data or moves its watermarks.
  - The task holds only the client and a weak player. `deinit` cancels it.
  - Sign-out cancels the sender before `stop` and `resetDiagnostics`, and an old batch never gets a new token.
- **Server.** It enforces the 64 KiB cap on streamed bytes and cancels the stream without trusting Content-Length. A failure to read or decode gives 400, and an over-limit body gives 413. Only status and tag reach the logs, never the error text. A caller without a key gets 403.
- **Relay.**
  - The deadline is 5 s and covers the collector response read, which is capped at 64 KiB.
  - Redirects are not followed. It uses the fixed User-Agent and Access headers.
  - The concurrency cap is 2, with no queue, and every exit path releases a slot.
  - Collector 429/502/503/504 or a transport failure gives 503, with Retry-After sanitized. Any other status gives a fixed 500.
  - The OTLP attributes carry no identity, token, URL or title.
  - `nanoTime` stays within uint64.
- **Configuration.** The secrets reach only the Api Worker and never `Website.Vite`. The production app targets the Worker (`OrbisClient.swift:126`), so no Vanta wiring is needed.

**Open acceptance limits.** I did not verify any of these, and they are outside what source review can prove:
- native compilation and runtime of the sender
- replacement of the fixture with a real native upload
- a Workerd relay to the protected live collector, with a SigNoz query by `runId`
- whether the Worker's outbound request passes the zone's WAF and Access on `otlp.parthm.me`; the preflight saw a 403 tied to User-Agent
- the first deploy with the new secret names
- delivery from a physical iPhone, including background playback and energy cost
- SigNoz retention for timestamps from a wrong device clock

**Source verdict.** The source is correct for "send the logging to SigNoz" at `3145cb4`. Privacy, bounds, cancellation, retry and status mapping match the accepted design, and no finding blocks the change. The physical-playback and production gates stay open until the parent's native, Workerd and live-SigNoz evidence lands. Act on finding 2 before you swap the fixture.
