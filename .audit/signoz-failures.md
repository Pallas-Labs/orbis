# Playback delivery failure cases

Written before production changes at dd1468f. One writer owns this worktree. No child agents, Mac execution, secrets, deployment, or external posts are authorized.

## HTTP boundary and exporter

- A valid authenticated batch must reach the new route. Against the old implementation the valid replay must fail with HTTP 404, after successful database initialization and authentication.
- Missing credentials and token-free local callers must never export. Unknown envelope, entry, enum wrapper, event payload, snapshot, buffer, access, and metadata fields must fail without copying private text into logs or collector output.
- Reject nonfinite numbers, unsafe integers, unordered or duplicate sequences, entries outside the acknowledged interval, unsupported versions, oversized metadata, more than eight ranges, and more than 32 entries.
- Count actual streamed bytes without trusting Content-Length. Stop and cancel reading after 64 KiB. Exercise chunked transfer through a real HTTP listener with a higher listener limit, so the application enforces the cap.
- Export fresh fixed OTLP records with decimal nanoseconds, fixed service and attributes, WARN incidents, and a loss record for internal or trailing holes. Replay a committed native-shaped fixture to catch schema drift.
- Full and partial collector success return numeric receipts after exactly one attempt. Never replay accepted records. Invalid or oversized collector responses fail permanently without echoing response text.
- Collector 429/502/503/504 and transport errors return retryable 503. Preserve safe Retry-After guidance. Permanent refusal and redirects return fixed 500. Collector requests use manual redirects and the fixed User-Agent.
- Two active exports are the instance limit. A third returns promptly without a queue. Timeout, disconnect, malformed body, and every failure release capacity. The collector deadline includes response reading and is five seconds.

## Native capture, delivery, and lifetime

- The existing ring remains the only rolling history. A slice takes the earliest retained entries, at most 32, with a watermark including trailing evicted samples only when all retained entries fit.
- Byte-limit halving recalculates the watermark and leaves the unselected suffix pending. Encoded output stays within 64 KiB, uses millisecond Dates, and contains fixed Codable values only.
- Read and acknowledged watermarks differ after a dropped batch. The next successful batch reports the unacknowledged interval, including internal and trailing holes. Do not repeat an empty loss-only batch.
- One frozen batch and one HTTP request exist at once. Three attempts, ten seconds per request, and 60 seconds per batch bound work. Retry only transport, 429, and 503. Full and partial receipts never retry. 400/413/500 drop; 401/403/404 end the lifetime.
- Retry-After is honored, including long cooldowns and stopping above 300 seconds. Backoff and blocked requests cancel on sign-out before stop/reset. Old batches never acquire a new token. Tail regression ends the sender.
- Playback continues while upload is blocked. Failure creates no playback error or upload event. A task must not retain AppModel or sender/player indefinitely. Releasing the owner cancels in-flight work.
- Native probes retain the actual encoded upload as a JSON attachment. Parent refreshes the committed replay fixture from that attachment and records its new provenance before final acceptance.

## Fixture provenance and verification

`apps/server/src/fixtures/playback-upload.json` initially wraps entries from `/home/parth/.cache/orbis-playback-evidence/2026-10-18/logging/native-final/shots/playback-report.json`. Its Date strings were converted to numeric milliseconds. This is a prior clipboard report adapted to the accepted envelope, not evidence of a new sender upload. The replay test exists before implementation so the parent can replace only its fixture with actual native output.

The parent owns native runtime checks and authenticated relay-to-live-SigNoz verification. Linux checks retain results in `.cache/signoz`. The canonical `.audit/playback.tsv` stays untouched.

Parent integration replaced the replay fixture with `native-http-playback-upload.json` from the focused native run. Its raw SHA256 is `b72453320cf3e792ef7c6b791d9a74827405efc6b648027ef17b6d7d4f4ac8cc`. The committed JSON differs only in whitespace. `fixture-provenance.json` in the durable SigNoz evidence root records both digests and parsed equality. The Swift test constructs two typed events, encodes them, and sends them over real URLSession HTTP. They are serialization and transport evidence, not captured audible skips.

Parent HTTP validation reproduced acceptance of a timestamp beyond OTLP's unsigned 64-bit nanosecond range. The strict-schema probe expected 400 and received 200. Limiting milliseconds to 18,446,744,073,709 fixes that protocol mismatch. The whole-repository check also found that the new endpoint needed a response sample and an updated count in the existing OpenAPI HTTP test. That fixture now includes its numeric receipt.

Baseline reproduction: `bun test apps/server/src/playback-diagnostics.test.ts -t 'valid authenticated native'` initialized the real database successfully and received HTTP 404 instead of 200. Output is `.cache/signoz/expected-404.log`. No missing module or import caused the failure.
