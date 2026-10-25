import type { PlaybackDiagnosticsPayload } from "@orbis/contracts/http-api";
import { Schema } from "effect";

export interface PlaybackDiagnosticsOptions {
  readonly url: string;
  readonly accessClientId: string;
  readonly accessClientSecret: string;
  readonly environment: string;
}

type AttributeValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };
interface Attribute {
  key: string;
  value: AttributeValue;
}
const text = (key: string, value: string): Attribute => ({
  key,
  value: { stringValue: value },
});
const integer = (key: string, value: number): Attribute => ({
  key,
  value: { intValue: String(value) },
});
const double = (key: string, value: number): Attribute => ({
  key,
  value: { doubleValue: value },
});
const bool = (key: string, value: boolean): Attribute => ({
  key,
  value: { boolValue: value },
});
const maybeDouble = (key: string, value: number | null): Attribute[] =>
  value === null ? [] : [double(key, value)];
const nanoTime = (milliseconds: number) =>
  String(
    BigInt(Math.trunc(milliseconds)) * 1_000_000n +
      BigInt(Math.round((milliseconds % 1) * 1_000_000))
  );

type Event = PlaybackDiagnosticsPayload["entries"][number]["event"];
type KeysOf<E> = E extends unknown ? keyof E : never;
type EventKind = KeysOf<Event>;
type ValueOf<E, K extends EventKind> = E extends { [P in K]: infer V }
  ? V
  : never;
type EventValue<K extends EventKind> = ValueOf<Event, K>;
type EventValues = { [K in EventKind]: EventValue<K> };
interface ErrorValue {
  code: number;
  domain: string;
}

const errorType = (error: ErrorValue) =>
  text("error.type", `${error.domain}:${error.code}`);
const none = (): Attribute[] => [];

type EventAttributes = {
  [K in EventKind]: (value: EventValue<K>) => Attribute[];
};

const eventAttributes: EventAttributes = {
  access: ({ _0: { metrics } }) => [
    integer("playback.access.stalls", metrics.stalls),
    ...maybeDouble("playback.access.observed_bitrate", metrics.observedBitrate),
    integer("playback.access.bytes_transferred", metrics.bytesTransferred),
  ],
  activation: ({ _0 }) => [
    text("playback.phase", _0.phase),
    ...maybeDouble("playback.activation.duration", _0.requestDuration),
  ],
  buffer: ({ _0 }) => [text("playback.reason", _0.reason)],
  command: ({ _0 }) => [
    text("playback.command.kind", _0.kind),
    text("playback.command.origin", _0.origin),
    ...maybeDouble("playback.command.target", _0.target),
  ],
  discontinuity: ({ _0 }) => maybeDouble("playback.discontinuity.gap", _0.gap),
  ended: ({ _0 }) => [bool("playback.ended.premature", _0.premature)],
  error: ({ _0 }) => [errorType(_0)],
  interruption: ({ _0 }) => [text("playback.phase", _0.phase)],
  item: ({ _0 }) => [
    text("playback.phase", _0.phase),
    ...(_0.error ? [errorType(_0.error)] : []),
  ],
  reset: none,
  route: ({ _0 }) => [text("playback.reason", _0.reason)],
  sample: none,
  seekResult: ({ _0 }) => [
    ...maybeDouble("playback.seek.duration", _0.duration),
    bool("playback.seek.finished", _0.finished),
    ...maybeDouble("playback.seek.target", _0.target),
    ...maybeDouble("playback.seek.actual", _0.actual),
  ],
  session: ({ _0 }) => [text("playback.phase", _0.phase)],
  stalled: none,
  state: ({ _0 }) => [text("playback.state.from", _0.from)],
  timeJumped: none,
  waiting: ({ _0 }) => [text("playback.reason", _0.reason)],
};

const attributesFor = (kind: EventKind, event: Event): Attribute[] => {
  // SAFETY: `kind` is the key of `event`, so the registry entry for `kind` takes that key's value.
  const attributes = eventAttributes[kind] as (
    value: EventValues[EventKind]
  ) => Attribute[];
  // SAFETY: `kind` is a key present on `event`.
  return attributes((event as EventValues)[kind]);
};

const logsFor = (batch: PlaybackDiagnosticsPayload, environment: string) => {
  const shared = [text("session.id", batch.runId)];
  const logs = batch.entries.map((entry) => {
    const { event } = entry;
    // SAFETY: the schema accepts only single-key events named by EventKind.
    const kind = Object.keys(event)[0] as EventKind;
    const warning =
      "stalled" in event ||
      "error" in event ||
      ("item" in event && event.item._0.phase === "failed") ||
      ("session" in event && event.session._0.phase === "failed") ||
      ("activation" in event && event.activation._0.phase === "failed") ||
      ("seekResult" in event && !event.seekResult._0.finished) ||
      ("ended" in event && event.ended._0.premature) ||
      ("state" in event && event.state._0.to === "failed");
    const facts: Attribute[] = [
      ...shared,
      integer("orbis.sequence", entry.sequence),
      text("event.name", `playback.${kind}`),
      integer("playback.generation", entry.snapshot.playbackGeneration),
      integer("playback.seek_id", entry.snapshot.seekID),
      text("playback.state", entry.snapshot.state),
      text("playback.item_state", entry.snapshot.itemState),
      text("playback.waiting_reason", entry.snapshot.waitingReason),
      bool("playback.session_ready", entry.snapshot.sessionReady),
      ...maybeDouble("playback.actual_time", entry.snapshot.actualTime),
      ...(entry.snapshot.setId
        ? [text("orbis.set_id", entry.snapshot.setId)]
        : []),
      ...attributesFor(kind, event),
    ];
    return {
      attributes: facts,
      body: {
        stringValue: JSON.stringify({
          event: entry.event,
          snapshot: entry.snapshot,
          uptime: entry.uptime,
        }),
      },
      severityNumber: warning ? 13 : 9,
      severityText: warning ? "WARN" : "INFO",
      timeUnixNano: nanoTime(entry.wallTime),
    };
  });
  const missing =
    batch.throughSequence - batch.afterSequence - batch.entries.length;
  if (missing > 0) {
    logs.push({
      attributes: [
        ...shared,
        text("event.name", "playback.loss"),
        integer("playback.unacknowledged_count", missing),
        integer("playback.after_sequence", batch.afterSequence),
        integer("playback.through_sequence", batch.throughSequence),
      ],
      body: { stringValue: "Unacknowledged playback history" },
      severityNumber: 13,
      severityText: "WARN",
      timeUnixNano: nanoTime(batch.entries.at(-1)?.wallTime ?? Date.now()),
    });
  }
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            text("service.namespace", "orbis"),
            text("service.name", "orbis-apple"),
            text("service.version", batch.metadata.appVersion),
            text("app.build_id", batch.metadata.appBuild),
            text("os.name", batch.metadata.osName),
            text("os.version", batch.metadata.osVersion),
            text("deployment.environment.name", environment),
          ],
        },
        scopeLogs: [
          { logRecords: logs, scope: { name: "orbis.playback", version: "1" } },
        ],
      },
    ],
  };
};

const CollectorReceipt = Schema.Struct({
  partialSuccess: Schema.optionalKey(
    Schema.Struct({
      errorMessage: Schema.optionalKey(Schema.String),
      rejectedLogRecords: Schema.optionalKey(
        Schema.Union([Schema.NumberFromString, Schema.Int]).check(
          Schema.isInt(),
          Schema.isGreaterThanOrEqualTo(0)
        )
      ),
    })
  ),
});
const decodeCollectorReceipt = Schema.decodeUnknownSync(CollectorReceipt);

export class PlaybackBodyLimitError extends Error {
  override readonly name = "PlaybackBodyLimitError";
}

const cancelBodyReader = async (
  reader: ReadableStreamDefaultReader<Uint8Array>
) => {
  try {
    await reader.cancel();
  } catch {
    return false;
  }
};

export const readBoundedBody = async (
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal
): Promise<string> => {
  if (!body) {
    return "";
  }
  const reader = body.getReader();
  const cancel = () => {
    void cancelBodyReader(reader);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const bytes = new Uint8Array(limit);
  let length = 0;
  const chunks = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        signal.throwIfAborted();
        const chunk = await reader.read();
        signal.throwIfAborted();
        return chunk.done
          ? { done: true, value: undefined }
          : { done: false, value: chunk.value };
      },
    }),
  };
  try {
    for await (const chunk of chunks) {
      if (chunk.byteLength > limit - length) {
        throw new PlaybackBodyLimitError();
      }
      bytes.set(chunk, length);
      length += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes.subarray(0, length));
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
};

const retryHeaders = (value: string | null) => {
  if (!value || value.length > 128) {
    return { "retry-after": "1" };
  }
  if (/^\d+$/u.test(value)) {
    const seconds = Number(value);
    return {
      "retry-after": String(Number.isSafeInteger(seconds) ? seconds : 301),
    };
  }
  const date = Date.parse(value);
  return {
    "retry-after": Number.isFinite(date)
      ? String(Math.max(0, Math.ceil((date - Date.now()) / 1000)))
      : "1",
  };
};
const unavailable = (retryAfter: string | null = null) =>
  Response.json(
    { message: "Playback collector unavailable." },
    { headers: retryHeaders(retryAfter), status: 503 }
  );
const refused = () =>
  Response.json(
    { message: "Playback collector refused the batch." },
    { status: 500 }
  );

export const makePlaybackDiagnosticsRelay = (
  options?: PlaybackDiagnosticsOptions
) => {
  let active = 0;
  return async (
    batch: PlaybackDiagnosticsPayload,
    signal: AbortSignal
  ): Promise<Response> => {
    if (
      !options?.url ||
      !options.accessClientId ||
      !options.accessClientSecret ||
      active >= 2
    ) {
      return unavailable();
    }
    active += 1;
    const timeout = AbortSignal.timeout(5000);
    const abort = AbortSignal.any([timeout, signal]);
    try {
      const response = await fetch(options.url, {
        body: JSON.stringify(logsFor(batch, options.environment)),
        headers: {
          "CF-Access-Client-Id": options.accessClientId,
          "CF-Access-Client-Secret": options.accessClientSecret,
          "content-type": "application/json",
          "user-agent": "Orbis-Playback-Relay/1",
        },
        method: "POST",
        redirect: "manual",
        signal: abort,
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        return [429, 502, 503, 504].includes(response.status)
          ? unavailable(response.headers.get("retry-after"))
          : refused();
      }
      const receiptText = await readBoundedBody(response.body, 65_536, abort);
      let rejected: number;
      try {
        const receipt = decodeCollectorReceipt(
          JSON.parse(receiptText || "{}"),
          { onExcessProperty: "error" }
        );
        rejected = receipt.partialSuccess?.rejectedLogRecords ?? 0;
      } catch {
        return refused();
      }
      const total =
        batch.entries.length +
        (batch.throughSequence - batch.afterSequence > batch.entries.length
          ? 1
          : 0);
      if (!Number.isSafeInteger(rejected) || rejected < 0 || rejected > total) {
        return refused();
      }
      return Response.json({ accepted: total - rejected, rejected });
    } catch (error) {
      return error instanceof PlaybackBodyLimitError
        ? refused()
        : unavailable();
    } finally {
      active -= 1;
    }
  };
};
