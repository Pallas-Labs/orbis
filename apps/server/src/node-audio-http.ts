import path from "node:path";

import type { LoggingOptions } from "./logging.js";
import {
  describeCause,
  finishRequestLog,
  outcomeForStatus,
  safeRequestPath,
  startRequestLog,
} from "./logging.js";
import type { StreamGrantVerdict } from "./stream-grant.js";
import { checkStreamGrant } from "./stream-grant.js";

/** A stored Set's audio file, or null when this Set has no file in that format. */
const audioFile = async (
  audioDir: string,
  id: string,
  contentType: string,
  extension: string
) => {
  const file = Bun.file(path.join(audioDir, `${id}.${extension}`));
  return (await file.exists()) ? { contentType, extension, file } : null;
};

type AudioRange =
  | { readonly kind: "full" }
  | { readonly kind: "range"; readonly start: number; readonly end: number }
  | { readonly kind: "unsatisfiable" };

const parseRange = (header: string | null, size: number): AudioRange => {
  if (header === null || header === "") {
    return { kind: "full" };
  }
  const match = /^bytes=(?<first>\d*)-(?<last>\d*)$/u.exec(header.trim());
  if (!match?.groups) {
    return { kind: "unsatisfiable" };
  }
  const { first = "", last = "" } = match.groups;
  if (first === "" && last === "") {
    return { kind: "unsatisfiable" };
  }
  const start = first === "" ? Math.max(0, size - Number(last)) : Number(first);
  const end =
    first === "" || last === "" ? size - 1 : Math.min(size - 1, Number(last));
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= size ||
    end < start
  ) {
    return { kind: "unsatisfiable" };
  }
  return { end, kind: "range", start };
};

/** What one audio request's wide event records; the grant itself never appears. */
interface AudioRequestFields {
  readonly set?: string;
  readonly grant?: StreamGrantVerdict["kind"];
  readonly person?: string;
  readonly file?: "found" | "missing";
  readonly format?: string;
  readonly range?: string | undefined;
  readonly size?: number;
  /** The response body length. A client that disconnects early receives fewer. */
  readonly bytes?: number;
  /** Body bytes the node handed to the connection before the body ended or the client left. */
  readonly sent?: number;
  /** Milliseconds from the request to the last byte handed over, or to the client leaving. */
  readonly lastByteMs?: number;
  /** True when the client left before the whole body was handed over. */
  readonly aborted?: boolean;
}

const MAX_RANGE_CHARACTERS = 64;

const serveAudio = async (
  request: Request,
  options: { readonly audioDir: string; readonly streamSecret: Buffer },
  record: (fields: AudioRequestFields) => void
): Promise<Response> => {
  const url = new URL(request.url);
  const match = /^\/(?:api\/)?sets\/(?<id>[a-zA-Z0-9_-]+)\/audio$/u.exec(
    url.pathname
  );
  const id = match?.groups?.id;
  if (id === undefined || id === "") {
    return new Response(null, { status: 404 });
  }
  record({ set: id });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      headers: { allow: "GET, HEAD" },
      status: 405,
    });
  }
  const verdict = checkStreamGrant(
    options.streamSecret,
    id,
    url.searchParams.get("grant")
  );
  record({ grant: verdict.kind });
  if (verdict.kind !== "valid") {
    return Response.json({ message: "Invalid stream grant." }, { status: 401 });
  }
  record({ person: verdict.personId });
  // The three audio formats Orbis stores, each named at the call so the count is visible.
  const files = await Promise.all([
    audioFile(options.audioDir, id, "audio/mp4", "m4a"),
    audioFile(options.audioDir, id, "audio/mpeg", "mp3"),
    audioFile(options.audioDir, id, "audio/ogg", "ogg"),
  ]);
  const ready = files.find((file) => file !== null);
  if (!ready) {
    record({ file: "missing" });
    return Response.json(
      { message: "This Set has no audio yet." },
      { status: 404 }
    );
  }
  const { file } = ready;
  const rangeHeader = request.headers.get("range");
  record({
    file: "found",
    format: ready.extension,
    range: rangeHeader?.slice(0, MAX_RANGE_CHARACTERS),
    size: file.size,
  });
  const range = parseRange(rangeHeader, file.size);
  const headers = new Headers({
    "accept-ranges": "bytes",
    "content-type": ready.contentType,
  });
  if (range.kind === "unsatisfiable") {
    headers.set("content-range", `bytes */${file.size}`);
    return new Response(null, { headers, status: 416 });
  }
  const length =
    range.kind === "range" ? range.end - range.start + 1 : file.size;
  record({ bytes: request.method === "HEAD" ? 0 : length });
  headers.set("content-length", String(length));
  if (range.kind === "range") {
    headers.set(
      "content-range",
      `bytes ${range.start}-${range.end}/${file.size}`
    );
    return new Response(
      request.method === "HEAD" ? null : file.slice(range.start, range.end + 1),
      { headers, status: 206 }
    );
  }
  return new Response(request.method === "HEAD" ? null : file, { headers });
};

interface BodyEnd {
  readonly sent: number;
  readonly aborted: boolean;
  readonly error?: unknown;
}

const cancelQuietly = async (
  reader: ReadableStreamDefaultReader<Uint8Array>
) => {
  try {
    await reader.cancel();
  } catch {
    // The file read already ended; there is nothing left to stop.
  }
};

/**
 * Passes the body through one chunk at a time, counting what the server takes, and calls
 * `ended` once: when the last chunk is taken, when the client leaves, or when the file read
 * fails. The server pulls only as the connection drains, so the count trails the socket by
 * at most one chunk and the file is never read whole into memory.
 */
const meteredBody = (
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  ended: (end: BodyEnd) => void
): ReadableStream<Uint8Array> => {
  const reader = body.getReader();
  const progress = { done: false, sent: 0 };
  const end = (outcome: Omit<BodyEnd, "sent">) => {
    if (progress.done) {
      return;
    }
    progress.done = true;
    ended({ ...outcome, sent: progress.sent });
  };
  signal.addEventListener(
    "abort",
    () => {
      end({ aborted: true });
      void cancelQuietly(reader);
    },
    { once: true }
  );
  return new ReadableStream<Uint8Array>(
    {
      cancel: async (reason) => {
        end({ aborted: true });
        await reader.cancel(reason);
      },
      pull: async (controller) => {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            end({ aborted: false });
            return;
          }
          progress.sent += chunk.value.byteLength;
          controller.enqueue(chunk.value);
        } catch (error) {
          end({ aborted: signal.aborted, error });
          controller.error(error);
        }
      },
    },
    { highWaterMark: 0 }
  );
};

/**
 * Serves granted audio from the node's disk and emits one wide event per request,
 * marked `ingress: "funnel-audio"`. A response with a body is logged when the body ends
 * or the client leaves, with what was handed over and when, so the line tells a slow
 * path to the client from a slow node. The path is logged without its query string, so
 * the grant never reaches a line.
 */
export const makeNodeAudioHandler =
  (options: {
    readonly audioDir: string;
    readonly logging?: LoggingOptions | undefined;
    readonly streamSecret: Buffer;
  }): ((request: Request) => Promise<Response>) =>
  async (request) => {
    const started = performance.now();
    const logger = startRequestLog({
      method: request.method,
      path: safeRequestPath(request.url),
      requestId: crypto.randomUUID(),
    });
    logger.set({ ingress: "funnel-audio" });
    try {
      const response = await serveAudio(request, options, (fields) => {
        logger.set({ audio: fields });
      });
      const { status } = response;
      if (response.body === null) {
        finishRequestLog(
          logger,
          { outcome: outcomeForStatus(status), status },
          options.logging
        );
        return response;
      }
      const body = meteredBody(response.body, request.signal, (end) => {
        const audio: AudioRequestFields = {
          aborted: end.aborted,
          lastByteMs: Math.round(performance.now() - started),
          sent: end.sent,
        };
        logger.set({ audio });
        if (end.error !== undefined) {
          logger.set({ cause: describeCause(end.error) });
          finishRequestLog(
            logger,
            { outcome: "failure", status },
            options.logging
          );
          return;
        }
        finishRequestLog(
          logger,
          {
            outcome: end.aborted ? "cancelled" : outcomeForStatus(status),
            status,
          },
          options.logging
        );
      });
      return new Response(body, { headers: response.headers, status });
    } catch (error) {
      logger.set({ cause: describeCause(error) });
      finishRequestLog(
        logger,
        { outcome: "failure", status: 500 },
        options.logging
      );
      throw error;
    }
  };
