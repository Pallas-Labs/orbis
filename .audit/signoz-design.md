# Playback delivery to SigNoz

## Problem and usage

The user requests automatic SigNoz delivery of the playback diagnostics added in PR #278. The earlier no-upload scope is superseded. Keep the clipboard report, privacy exclusions and player behavior. AppModel creates one PlaybackDiagnosticsSender for its authenticated client after either initializer and after sign-in. It cancels that sender before player stop/reset and clearing the client on sign-out.

AudioPlayer exposes a typed tail and bounded slice reader. Its playback callbacks keep their existing synchronous record operation. The sender reads immutable Sendable values from that ring, encodes on a separate actor or explicit concurrent function, and posts batches to the existing Orbis HTTPS API. The shared authenticated route validates them and forwards fresh OTLP records to the existing protected SigNoz endpoint. Collector Access credentials remain server-only Worker secrets.

## Synthesis decision

Both independent architect candidates converged on cursor reads from the existing 256-entry ring plus one frozen in-flight batch. The independent Claude Opus 5.5 cross-judge scored A 11/12 and B 7/12 for completeness and preferred A's lifecycle. The parent accepts that shape and the judge's smaller wire contract. Reuse the current Codable Entry, Event and Snapshot rather than creating a third Swift flattened model. The server mirrors and strictly validates their versioned synthesized enum shape. Renaming a case is a schema-version change. Upload JSON uses millisecondsSince1970, retaining sub-second Date precision; clipboard encoding stays unchanged. The two candidates and judge are preserved alongside this record.

The ring is the sole rolling store. One sender holds at most 32 copied entries, one encoded body up to 64 KiB and one active request. Read the earliest retained entries after the read cursor. If all retained entries fit, the slice watermark reaches the latest recorded sequence, including trailing sample holes. Otherwise it reaches the last selected entry. Halving for byte size must recalculate that watermark so unselected entries remain pending.

The wire envelope is schemaVersion 1, runId UUID, bounded metadata, afterSequence, throughSequence and entries. It wraps the existing entry types, with numeric millisecond wallTime. Event payloads remain fixed enums, finite nullable numbers and booleans. Buffer ranges stay capped at eight. The TS schema rejects excess keys at every level and derives the TypeScript type. Do not accept raw report strings, arbitrary JSON attributes or client-selected OTLP destinations.

The sender tracks a read watermark and an acknowledged watermark. afterSequence is the acknowledged watermark. After terminal failure the read watermark advances while acknowledgement stays put. On the next successful batch, throughSequence - afterSequence - entries.count reports entries absent from that acknowledged interval. Ambiguous delivery can mean those records were already received, so this indicates unacknowledged history, not proven collector loss. Only send when the read watermark has new progress; do not retry an empty loss-only batch forever. A fresh sign-in starts both watermarks at the current tail with a new run UUID. Sign-out is the current reset boundary; a defensive tail-regression check must end the old sender rather than mix reset sequence spaces.

## Delivery limits and outcomes

- Poll every five seconds without empty network requests or per-event Tasks.
- At most 32 entries and 64 KiB per request, including metadata.
- Ten-second wall deadline per Apple request, three attempts, and at most 60 seconds per frozen batch. Retry delays are about one and two seconds with bounded jitter.
- Honor Retry-After while the batch lifetime permits. If longer than 30 seconds, drop that batch and cool down for the requested delay up to 300 seconds. For longer instructions, stop this sender rather than retry early or retain an unbounded sleeping task.
- Retry only 429, 503 and transport failures at the Orbis relay boundary. Full or partial 200 advances without retry. 400, 413 and permanent 500 drop and advance the read cursor. 401, 403 and 404 stop the sender for its lifetime. An old server therefore receives one unsupported request per sender, not endless probes.
- No disk spool or background delivery guarantee. Execution can pause during suspension; app exit loses pending history. Timeouts can cause duplicates identifiable by runId and sequence.
- Delivery errors never change playback state or recursively generate upload events. No special reachability checks, new audio/session policy or general telemetry SDK.

The shared POST /diagnostics/playback endpoint uses the existing API prefix and SetAccess, accepting device callers only. It enforces a 64 KiB actual streaming body cap, 32-entry schema cap, increasing safe sequence values in the declared interval and bounded metadata. It holds at most two active exports per app instance with no waiting queue. The handler awaits one bounded exporter attempt and releases capacity on every exit.

The exporter builds one searchable OTLP log per entry, plus a playback.loss record for an unacknowledged sequence gap. Service name is orbis.apple.playback. Attributes include run ID, sequence, event kind, item generation, seek ID and fixed snapshot/event facts. Normal events are INFO; stalls, failed outcomes and normalized errors are WARN. Use decimal-string nanosecond timestamps derived from the numeric milliseconds. Do not include caller identity, bearer tokens, URLs, titles, Set IDs, SDK text or account/device names.

The exporter uses https://otlp.parthm.me/v1/logs, User-Agent Orbis-Playback-Relay/1, manual redirect handling and a five-second deadline. Parse bounded OTLP success including partialSuccess. Partial rejection is terminal and is reported as a numeric receipt; never replay the accepted portion. Retryable collector statuses 429, 502, 503, 504 or transport failure become relay 503 with safe retry guidance. Permanent collector refusal becomes a fixed relay 500 that the Apple sender does not retry. Missing configuration returns retryable 503. No collector response text or secrets reach logs or client responses.

Group injects the exporter through createPortableApp; Bun createApp accepts the same option for real HTTP tests and fixtures. Add the collector URL configuration and the two Access secret names to Group environment typing and the existing Alchemy secret/inherit mechanism. Keep credentials out of Website/Vite bindings. No Vanta service change, restart, route exposure or deploy is part of implementation.

## Throughput checkpoint

- Blocking first steps. Ground source and live ingress, obtain two designs and an independent cross-judge, then write the failure cases and probes before production code.
- Independent workstreams. One isolated implementation checkout owns the coupled Swift, HTTP schema, exporter, Group wiring and probes. Parent owns Linux/Mac execution, live collector verification and evidence only after that owner hands back commits.
- Shared mutable state. The recorder remains on MainActor. Immutable snapshots cross to the encoder. One sender owns delivery watermarks and one frozen request. Parent and writer use distinct worktrees, and Mac builds run serially with unique evidence paths.
- Smallest safe decomposition. One writer keeps the cross-language schema and lifetime contract coherent. Avoid a second retained queue, SDK, new ingestion service or infrastructure deployment.

## Verification and known limits

Failure cases and tests precede production code. Use real authenticated createApp HTTP with its database and a controlled HTTP collector. Cover strict privacy/schema, chunked byte cap, full/partial success, retry/permanent refusal, timeout and cancellation. Native probes must use real URLSession and playback while upload stalls, inspect a captured payload, exercise sign-out and retry cancellation, and cover internal/trailing sequence holes. Existing clipboard and playback probes remain. A real native-produced payload becomes a fixture for the existing HTTP replay test to catch Swift/TS drift.

A protocol preflight sent 20 existing native report events through the public protected endpoint and found all 20 in SigNoz, correlated by run ID. Evidence is /home/parth/.cache/orbis-playback-evidence/2026-10-18/signoz/preflight-result.json and preflight-query.json. The initial default-Python-User-Agent request returned 403; an explicit Orbis verification User-Agent succeeded. Cause is not established. This proves the current ingress, not the future Worker relay or installed iPhone build.

Parent verification must run matching-source HTTP, workerd and native lanes, send a real new app-produced batch through the same authenticated relay/exporter into SigNoz, and query its run ID. Live deployed Worker and physical iPhone delivery stay unverified unless that deployment/build is actually installed and exercised. No new deployment or merge has been requested. The audible-skip cause remains open.

## Implementation reconciliation

The parent accepts the cross-judge's reuse of existing Swift types, millisecond timestamp encoding, removal of a redundant reset epoch, explicit permanent error handling and instance-wide concurrency cap. It refines loss semantics with separate read/acknowledged watermarks and suppresses repeated empty loss-only sends. It stops rather than truncating Retry-After above the cooldown cap. Record any necessary deviations here before handoff.

The implementation keeps `service.name=orbis.apple.playback` and the existing `/api` prefix. Upload networking lives in `OrbisClient+PlaybackDiagnostics.swift`, so the Share extension's existing `OrbisClient.swift` source list needs no diagnostics dependency. Its URLSession transfer has an explicit ten-second task-group deadline, a 4 KiB receipt cap, and cancellation of the underlying transfer, including while reading a response.

The sender task captures the immutable client and a weak player, never AppModel or the sender. Sender deinitialization cancels that task. AppModel cancels and releases the sender before stop/reset. The loop releases each batch before its next sleep; Retry-After also delays the next batch when the current batch has exhausted its attempts or lifetime. A tail regression ends the task. The encoder uses its own actor and millisecond Date strategy; clipboard encoding is unchanged.

Effect rc.117's Web request `text` and `arrayBuffer` paths do not enforce `MaxBodySize`. Both request and collector reading therefore use an explicit fixed 64 KiB buffer and cancel after exceeding it. Cancellation is requested without awaiting the stream's cancellation promise, because that promise can wait for an unfinished HTTP body. The real unfinished chunked HTTP probe and Workerd open-ended stream probe both return 413 before EOF. Empty synthesized enum payloads use a string-to-never record because Effect's empty Struct accepts arbitrary objects even with excess-property errors.

The fixed sender limits remain unchanged. Tests can shorten only the poll interval and encoder byte budget. The lane's existing seed service exposes bounded diagnostic capture and controlled HTTP refusals or holds; it validates captured uploads with the same strict contract. `scripts/fixture.ts` accepts server-only `ORBIS_FIXTURE_SIGNOZ_OTLP_URL`, `ORBIS_FIXTURE_SIGNOZ_OTLP_ACCESS_CLIENT_ID`, and `ORBIS_FIXTURE_SIGNOZ_OTLP_ACCESS_CLIENT_SECRET` for parent-owned live relay verification. No credentials were read or provisioned during implementation.

The initial replay fixture retains the provenance recorded in `signoz-failures.md`. Linux HTTP, contracts/server/API typechecks, and the focused production Group Workerd probe pass. Native compilation, native runtime, actual new native fixture refresh, protected live collector queries, deployed Worker delivery, and physical iPhone delivery remain unverified here. No Mac, deployment, external post, or change to `.audit/playback.tsv` is part of this checkout.
