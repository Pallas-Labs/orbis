import { readFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import { decodePlaybackDiagnosticsBatch } from "../packages/contracts/dist/playback-diagnostics.js";

// A journey that needs a slow path to the audio launches the app with `<seed>/via` as its
// service address. Everything under `/via` goes on to the lane service, except two things the
// seed server answers itself: the Set audio a journey has faulted, and the app's playback
// diagnostics, which it keeps so the journey can read them back.
//
// A fault applies to whole player sessions. AVPlayer names each item's requests with
// `X-Playback-Session-Id`, so the first `sessions` items the app loads get the fault, and a
// reload, which is a new item, gets the file once that count is spent.
//
// `held-body` answers each request's headers and never sends a body byte, as a path that
// holds the bytes does: the item times out before it plays.
// `paused-body` sends the file up to a third of its length, and its tail (where the fixture
// keeps its `moov` box), then the bytes between at 16 bytes a second: the item plays its first
// ten seconds, then stalls until it is replaced. The trickle keeps the connection busy, as a
// slow path does, so the stall is not cut short by the loader's idle timeout (url -1001).

// Headers that belong to one connection, so the proxy sets its own. Bodies pass through
// still encoded (`decompress: false`), so `content-encoding` and `content-length` stay true.
const hopHeaders = new Set(["connection", "keep-alive", "transfer-encoding"]);
const TAIL_BYTES = 16 * 1024;
const TRICKLE_BYTES = 16;
const TRICKLE_INTERVAL_MS = 1000;
const MAX_KEPT_ENTRIES = 512;

const parseRange = (header, size) => {
  if (!header) {
    return { end: size - 1, ranged: false, start: 0 };
  }
  const groups = /^bytes=(?<start>\d*)-(?<end>\d*)$/u.exec(header)?.groups;
  if (!groups || (!groups.start && !groups.end)) {
    return null;
  }
  const start = groups.start
    ? Number(groups.start)
    : Math.max(0, size - Number(groups.end));
  const end =
    groups.start && groups.end
      ? Math.min(Number(groups.end), size - 1)
      : size - 1;
  return start < size && start <= end ? { end, ranged: true, start } : null;
};

/** The part of `[start, end]` a faulted session may receive before the body pauses. */
const allowedSpan = (fault, start, end, size) => {
  if (fault.kind === "held-body") {
    return null;
  }
  if (start >= size - TAIL_BYTES) {
    return { end, start };
  }
  const cutoff = Math.floor(size / 3);
  return start < cutoff ? { end: Math.min(end, cutoff - 1), start } : null;
};

export const makeAudioFaults = ({ audioDirectory, serviceAddress }) => {
  const faults = new Map();
  const diagnostics = [];

  const serveFaulted = (fault, setId, request, response) => {
    const bytes = readFileSync(path.join(audioDirectory, `${setId}.m4a`));
    const range = parseRange(request.headers.range, bytes.length);
    if (!range) {
      response.writeHead(416, { "content-range": `bytes */${bytes.length}` });
      response.end();
      return;
    }
    const session = request.headers["x-playback-session-id"] ?? "none";
    if (
      !fault.sessions.includes(session) &&
      fault.sessions.length < fault.limit
    ) {
      fault.sessions.push(session);
    }
    const faulted = fault.sessions.includes(session);
    const span = faulted
      ? allowedSpan(fault, range.start, range.end, bytes.length)
      : range;
    const log = {
      faulted,
      method: request.method,
      range: request.headers.range ?? null,
      sent: 0,
      session,
    };
    fault.requests.push(log);
    const headers = {
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-length": String(range.end - range.start + 1),
      "content-type": "audio/mp4",
    };
    if (range.ranged) {
      headers["content-range"] =
        `bytes ${range.start}-${range.end}/${bytes.length}`;
    }
    response.writeHead(range.ranged ? 206 : 200, headers);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    if (span) {
      const part = bytes.subarray(span.start, span.end + 1);
      log.sent = part.length;
      response.write(part);
    }
    if (span?.start === range.start && span.end === range.end) {
      response.end();
      return;
    }
    // The rest of the body never comes, or trickles; the client gives up, or the lane ends.
    response.flushHeaders();
    let next = span ? span.end + 1 : range.start;
    const trickle =
      fault.kind === "paused-body"
        ? setInterval(() => {
            const part = bytes.subarray(
              next,
              Math.min(next + TRICKLE_BYTES, range.end + 1)
            );
            next += part.length;
            log.sent += part.length;
            response.write(part);
            if (next > range.end) {
              clearInterval(trickle);
              response.end();
            }
          }, TRICKLE_INTERVAL_MS)
        : undefined;
    response.once("close", () => {
      clearInterval(trickle);
      log.closed = true;
    });
  };

  const keepDiagnostics = async (request, response) => {
    const batch = decodePlaybackDiagnosticsBatch(
      await new Response(Readable.toWeb(request)).json()
    );
    for (const entry of batch.entries) {
      diagnostics.push({
        event: entry.event,
        sequence: entry.sequence,
        setId: entry.snapshot.setId ?? null,
        state: entry.snapshot.state,
        wallTime: entry.wallTime,
      });
    }
    diagnostics.splice(0, Math.max(0, diagnostics.length - MAX_KEPT_ENTRIES));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ accepted: batch.entries.length, rejected: 0 })
    );
  };

  const forward = async (route, request, response) => {
    // Only the path and query come from the request, so a path such as `//host` cannot send the
    // request anywhere but the lane service.
    const target = new URL(serviceAddress);
    target.pathname = route.slice("/via".length) || "/";
    target.search = new URL(request.url, "http://seed").search;
    if (target.origin !== new URL(serviceAddress).origin) {
      response.writeHead(400).end();
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (!hopHeaders.has(name) && name !== "host" && value !== undefined) {
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
    }
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const answer = await fetch(target, {
      body: hasBody ? Readable.toWeb(request) : undefined,
      decompress: false,
      duplex: "half",
      headers,
      method: request.method,
      redirect: "manual",
      // Long enough for a journey's event stream; the lane ends before it runs out.
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    const outgoing = {};
    for (const [name, value] of answer.headers) {
      if (!hopHeaders.has(name)) {
        outgoing[name] = value;
      }
    }
    response.writeHead(answer.status, outgoing);
    if (!answer.body) {
      response.end();
      return;
    }
    const body = Readable.fromWeb(answer.body);
    response.once("close", () => {
      body.destroy();
    });
    body.on("error", () => {
      response.destroy();
    });
    body.pipe(response);
  };

  /** The seeds and read-backs a journey calls directly; false for any other request. */
  const control = (pathname, request, response) => {
    const url = new URL(request.url, "http://seed");
    const seed =
      /^\/(?<kind>held-body|paused-body)\/(?<setId>[a-zA-Z0-9-]+)$/u.exec(
        pathname
      )?.groups;
    if (seed && request.method === "POST") {
      faults.set(seed.setId, {
        kind: seed.kind,
        limit:
          url.searchParams.get("sessions") === "all"
            ? Number.POSITIVE_INFINITY
            : 1,
        requests: [],
        sessions: [],
      });
      response.writeHead(204).end();
      return true;
    }
    if (request.method !== "GET") {
      return false;
    }
    const state = /^\/audio-fault-state\/(?<setId>[a-zA-Z0-9-]+)$/u.exec(
      pathname
    )?.groups;
    if (state) {
      const fault = faults.get(state.setId);
      response.writeHead(fault ? 200 : 404, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(fault ? { ...fault, limit: undefined } : {}));
      return true;
    }
    if (pathname === "/via-diagnostics") {
      const setId = url.searchParams.get("setId");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          entries: diagnostics.filter((entry) => entry.setId === setId),
        })
      );
      return true;
    }
    return false;
  };

  /** Everything under `/via`: faulted audio, kept diagnostics, or the lane service. */
  const via = async (pathname, request, response) => {
    const audio = /^\/via\/sets\/(?<setId>[a-zA-Z0-9-]+)\/audio$/u.exec(
      pathname
    )?.groups;
    const fault = audio ? faults.get(audio.setId) : undefined;
    if (fault && (request.method === "GET" || request.method === "HEAD")) {
      serveFaulted(fault, audio.setId, request, response);
    } else if (
      pathname === "/via/diagnostics/playback" &&
      request.method === "POST"
    ) {
      await keepDiagnostics(request, response);
    } else {
      await forward(pathname, request, response);
    }
  };

  /** Answers a request this module owns; false for one it does not. */
  const route = async (pathname, request, response) => {
    if (control(pathname, request, response)) {
      return true;
    }
    if (pathname !== "/via" && !pathname.startsWith("/via/")) {
      return false;
    }
    try {
      await via(pathname, request, response);
    } catch {
      if (response.headersSent) {
        response.destroy();
      } else {
        response.writeHead(502).end();
      }
    }
    return true;
  };

  return { route };
};
