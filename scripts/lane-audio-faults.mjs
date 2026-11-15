import { copyFileSync, readFileSync } from "node:fs";
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
// Both faults answer AVPlayer's two-byte probe (`bytes=0-1`) in full, as the node did in the
// Sets that failed through the Funnel; holding the probe too makes AVFoundation fail the item
// after two minutes with its own error instead of a URL timeout.
//
// `held-body` answers each other request's headers and never sends a body byte, as a path that
// holds the bytes does: the item times out before it plays.
// `paused-body` swaps the Set's audio for the lane's five-minute 64 kbit/s AAC file, then sends
// it at 16 KB/s, twice its bitrate, for the first 8 s of the first item's session, and at 16
// bytes a second after that: the item starts, plays what arrived (about 15 s), then stalls
// until it is replaced. A later item of the same fault gets no fast start. The last 256 KB
// always come at the fast rate, for a file that keeps its `moov` box at the end.
// AVPlayer starts a short file on a slow path only once the whole rest of it has arrived, so
// the 30 s fixture never started and never stalled; the long file starts as a real Set does.
// With no trickle, the loader's idle timeout (url -1001) fails the item instead of a stall.

// Headers that belong to one connection, so the proxy sets its own. Bodies pass through
// still encoded (`decompress: false`), so `content-encoding` and `content-length` stay true.
const hopHeaders = new Set(["connection", "keep-alive", "transfer-encoding"]);
const TAIL_BYTES = 256 * 1024;
const PROBE_BYTES = 2;
const TICK_MS = 100;
const FAST_BYTES_PER_TICK = 1600;
const FAST_FOR_MS = 8000;
const TRICKLE_BYTES = 16;
const TICKS_PER_TRICKLE = 10;
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

/** Whether a paused body still sends `position` at the fast rate. */
const isFast = (position, size, sessionStartedAt) =>
  position >= size - TAIL_BYTES || Date.now() - sessionStartedAt < FAST_FOR_MS;

export const makeAudioFaults = ({
  audioDirectory,
  longAudio,
  serviceAddress,
}) => {
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
      // Only the first item gets the fast start, so a reload that meets the fault never plays.
      if (fault.sessions.length === 0) {
        fault.startedAt[session] = Date.now();
      }
      fault.sessions.push(session);
    }
    const faulted = fault.sessions.includes(session);
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
    if (!faulted || range.end - range.start + 1 <= PROBE_BYTES) {
      log.sent = range.end - range.start + 1;
      response.end(bytes.subarray(range.start, range.end + 1));
      return;
    }
    response.once("close", () => {
      log.closed = true;
    });
    // A held body never comes; the client gives up, or the lane ends.
    response.flushHeaders();
    if (fault.kind === "held-body") {
      return;
    }
    let next = range.start;
    let tick = 0;
    const pace = setInterval(() => {
      tick += 1;
      let through = next + FAST_BYTES_PER_TICK - 1;
      if (!isFast(next, bytes.length, fault.startedAt[session] ?? 0)) {
        through =
          tick % TICKS_PER_TRICKLE === 0 ? next + TRICKLE_BYTES - 1 : next - 1;
      }
      const part = bytes.subarray(next, Math.min(through, range.end) + 1);
      next += part.length;
      log.sent += part.length;
      response.write(part);
      if (next > range.end) {
        clearInterval(pace);
        response.end();
      }
    }, TICK_MS);
    response.once("close", () => {
      clearInterval(pace);
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
      if (seed.kind === "paused-body") {
        try {
          copyFileSync(
            longAudio(),
            path.join(audioDirectory, `${seed.setId}.m4a`)
          );
        } catch (error) {
          // A journey's seed call would otherwise wait out its timeout with no reason.
          console.error("paused-body could not build its long Set", error);
          response.writeHead(500).end(String(error));
          return true;
        }
      }
      faults.set(seed.setId, {
        kind: seed.kind,
        limit:
          url.searchParams.get("sessions") === "all"
            ? Number.POSITIVE_INFINITY
            : 1,
        requests: [],
        sessions: [],
        startedAt: {},
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
