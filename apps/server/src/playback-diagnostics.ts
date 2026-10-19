import type { PlaybackDiagnosticsPayload } from "@orbis/contracts/http-api";
import { Schema } from "effect";

export interface PlaybackDiagnosticsOptions {
  readonly url: string;
  readonly accessClientId: string;
  readonly accessClientSecret: string;
}

type AttributeValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };
const text = (key: string, value: string) => ({
  key,
  value: { stringValue: value },
});
const integer = (key: string, value: number) => ({
  key,
  value: { intValue: String(value) },
});
const nanoTime = (milliseconds: number) =>
  String(
    BigInt(Math.trunc(milliseconds)) * 1_000_000n +
      BigInt(Math.round((milliseconds % 1) * 1_000_000))
  );

const logsFor = (batch: PlaybackDiagnosticsPayload) => {
  const attributes = [
    text("orbis.run_id", batch.runId),
    text("app.version", batch.metadata.appVersion),
    text("app.build", batch.metadata.appBuild),
    text("os.name", batch.metadata.osName),
    text("os.version", batch.metadata.osVersion),
  ];
  const logs = batch.entries.map((entry) => {
    const { event } = entry;
    const kind = Object.keys(event)[0] ?? "unknown";
    const warning =
      "stalled" in event ||
      "error" in event ||
      ("item" in event && event.item._0.phase === "failed") ||
      ("session" in event && event.session._0.phase === "failed") ||
      ("activation" in event && event.activation._0.phase === "failed") ||
      ("seekResult" in event && !event.seekResult._0.finished) ||
      ("ended" in event && event.ended._0.premature) ||
      ("state" in event && event.state._0.to === "failed");
    const facts: { key: string; value: AttributeValue }[] = [
      ...attributes,
      integer("orbis.sequence", entry.sequence),
      text("event.name", `playback.${kind}`),
      integer("playback.generation", entry.snapshot.playbackGeneration),
      integer("playback.seek_id", entry.snapshot.seekID),
      text("playback.state", entry.snapshot.state),
      text("playback.item_state", entry.snapshot.itemState),
      text("playback.waiting_reason", entry.snapshot.waitingReason),
      {
        key: "playback.session_ready",
        value: { boolValue: entry.snapshot.sessionReady },
      },
    ];
    if (entry.snapshot.actualTime !== null) {
      facts.push({
        key: "playback.actual_time",
        value: { doubleValue: entry.snapshot.actualTime },
      });
    }
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
        ...attributes,
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
          attributes: [text("service.name", "orbis.apple.playback")],
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
        body: JSON.stringify(logsFor(batch)),
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
        const receipt = Schema.decodeUnknownSync(CollectorReceipt)(
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
