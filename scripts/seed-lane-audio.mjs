import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";

import {
  decodePlaybackDiagnosticsBatch,
  playbackLosses,
} from "../packages/contracts/dist/playback-diagnostics.js";
import { makeAudioFaults } from "./lane-audio-faults.mjs";

const [dataDirectory, fixture, port, serviceAddress] = process.argv.slice(2);
if (!dataDirectory || !fixture || !port) {
  throw new Error("Expected a lane data directory, audio fixture, and port");
}

const db = new Database(path.join(dataDirectory, "library.sqlite"));
// The lane service writes to the same file while journeys run in parallel. Without a wait, a seed
// that meets one of its writes fails with SQLITE_BUSY and takes this server down with it.
db.run("PRAGMA busy_timeout = 5000");
const audioDirectory = path.join(dataDirectory, "audio");
const audioFaults = makeAudioFaults({ audioDirectory, serviceAddress });
const slowSets = new Map();
const downloads = new Map();
const audio = readFileSync(fixture);
const streams = new Map();
let ogg;

const longOgg = () => {
  if (ogg) {
    return ogg;
  }
  const destination = path.join(dataDirectory, "streaming-fixture.ogg");
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    "600",
    "-c:a",
    "libopus",
    "-b:a",
    "96k",
    "-vbr",
    "off",
    destination,
  ]);
  ogg = readFileSync(destination);
  return ogg;
};

const streamState = (setId) => {
  if (!streams.has(setId)) {
    streams.set(setId, {
      bytesSent: 0,
      held: false,
      requests: 0,
      waiting: new Set(),
    });
  }
  return streams.get(setId);
};

const streamAudio = (setId, request, response) => {
  const bytes = longOgg();
  const range = /^bytes=(?<start>\d*)-(?<end>\d*)$/u.exec(
    request.headers.range ?? ""
  )?.groups;
  if (request.headers.range && (!range || (!range.start && !range.end))) {
    response.writeHead(416, { "content-range": `bytes */${bytes.length}` });
    return response.end();
  }
  let start = 0;
  if (range) {
    start = range.start
      ? Number(range.start)
      : Math.max(0, bytes.length - Number(range.end));
  }
  const end =
    range?.start && range.end
      ? Math.min(Number(range.end), bytes.length - 1)
      : bytes.length - 1;
  if (start >= bytes.length || start > end) {
    response.writeHead(416, { "content-range": `bytes */${bytes.length}` });
    return response.end();
  }
  const headers = {
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-length": String(end - start + 1),
    "content-type": "audio/ogg",
  };
  if (range) {
    headers["content-range"] = `bytes ${start}-${end}/${bytes.length}`;
  }
  response.writeHead(range ? 206 : 200, headers);
  response.flushHeaders();
  if (request.method === "HEAD") {
    return response.end();
  }
  const state = streamState(setId);
  state.requests += 1;
  const chunks = async function* chunks() {
    for (let offset = start; offset <= end; offset += 4096) {
      while (state.held && !response.destroyed) {
        const gate = Promise.withResolvers();
        state.waiting.add(gate);
        const closed = () => gate.resolve();
        response.once("close", closed);
        // oxlint-disable-next-line no-await-in-loop -- Explicit per-response body gate.
        await gate.promise;
        response.off("close", closed);
        state.waiting.delete(gate);
      }
      if (response.destroyed) {
        return;
      }
      const chunk = bytes.subarray(offset, Math.min(offset + 4096, end + 1));
      state.bytesSent += chunk.length;
      yield chunk;
      // oxlint-disable-next-line no-await-in-loop -- Keep the asset from completing before a hold.
      await Bun.sleep(50);
    }
  };
  Readable.from(chunks()).pipe(response);
};

const slowAudio = (setId, response) => {
  const completion = Promise.withResolvers();
  downloads.set(setId, completion);
  const aborted = () => completion.resolve();
  response.once("close", aborted);
  const chunks = async function* chunks() {
    try {
      for (let offset = 0; offset < audio.length; offset += 4096) {
        if (offset >= audio.length / 2) {
          // oxlint-disable-next-line no-await-in-loop -- Each attempt holds at partial progress until the journey releases it.
          await completion.promise;
        }
        // oxlint-disable-next-line no-await-in-loop -- Pace sequential audio chunks.
        await Bun.sleep(250);
        if (response.destroyed) {
          return;
        }
        yield audio.subarray(offset, offset + 4096);
      }
    } finally {
      response.off("close", aborted);
      if (downloads.get(setId) === completion) {
        downloads.delete(setId);
      }
    }
  };
  response.writeHead(200, {
    "content-length": String(audio.length),
    "content-type": "audio/mp4",
  });
  Readable.from(chunks()).pipe(response);
};

const respond = (response, status, body) => {
  response.writeHead(
    status,
    body ? { "content-type": "application/json" } : {}
  );
  response.end(body ? JSON.stringify(body) : undefined);
};

const handleStream = (route, request, response) => {
  // `ready-ogg-overstated` stores the audio with trailing bytes that hold no audio, so the player
  // estimates a longer duration from the byte count, and records 607 s, 4 s past the decoded
  // end. A retained Set in production ended 4.35 s before its service duration, while the
  // player's estimate ran 241 s past it.
  const ready =
    /^\/ready-ogg(?<overstated>-overstated)?\/(?<setId>[a-zA-Z0-9-]+)$/u.exec(
      route
    );
  if (ready?.groups && request.method === "POST") {
    const { overstated, setId } = ready.groups;
    if (!db.query("SELECT id FROM sets WHERE id = ?").get(setId)) {
      respond(response, 404);
      return true;
    }
    mkdirSync(audioDirectory, { recursive: true });
    const audioBytes = longOgg();
    const bytes = overstated
      ? Buffer.concat([
          audioBytes,
          Buffer.alloc(Math.round(audioBytes.length * 0.03)),
        ])
      : audioBytes;
    writeFileSync(path.join(audioDirectory, `${setId}.ogg`), bytes);
    db.query(
      "UPDATE sets SET download_state = 'ready', retained_audio_format = ?, retained_audio_bytes = ?, duration_seconds = ? WHERE id = ?"
    ).run("ogg", bytes.length, overstated ? 607 : 600, setId);
    respond(response, 204);
    return true;
  }
  const stream = /^\/stream\/sets\/(?<setId>[a-zA-Z0-9-]+)\/audio$/u.exec(
    route
  );
  if (
    stream?.groups &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
    const set = db
      .query("SELECT retained_audio_format FROM sets WHERE id = ?")
      .get(stream.groups.setId);
    if (!set || set.retained_audio_format !== "ogg") {
      respond(response, 404);
      return true;
    }
    streamAudio(stream.groups.setId, request, response);
    return true;
  }
  const control =
    /^\/(?<action>hold-stream|release-stream|stream-state)\/(?<setId>[a-zA-Z0-9-]+)$/u.exec(
      route
    );
  if (control?.groups) {
    const { action, setId } = control.groups;
    const state = streamState(setId);
    if (action === "stream-state" && request.method === "GET") {
      respond(response, 200, {
        bytesSent: state.bytesSent,
        held: state.held,
        requests: state.requests,
        waiting: state.waiting.size,
      });
      return true;
    }
    if (request.method !== "POST") {
      respond(response, 404);
      return true;
    }
    state.held = action === "hold-stream";
    if (!state.held) {
      for (const gate of state.waiting) {
        gate.resolve();
      }
    }
    respond(response, 204);
    return true;
  }
  return false;
};

// `fault` misbehaves the way a phone's connection can: `close-before-body` drops the socket
// before reading the batch, and `close-after-body` keeps the batch, as the collector would,
// then drops the socket without a response. `times` limits the fault, status, retry-after,
// and hold to the first requests; later requests get 200. `delivered` and `lost` are what
// the relay would write to SigNoz: every entry of a kept batch and its loss ranges.
const freshDiagnostics = (control = {}) => ({
  bodies: [],
  delivered: [],
  fault: control.fault ?? null,
  held: control.held ?? false,
  lost: [],
  requests: 0,
  retryAfter: control.retryAfter ?? null,
  status: control.status ?? 200,
  times: control.times ?? Number.POSITIVE_INFINITY,
  waiting: new Set(),
});
let diagnostics = freshDiagnostics();

const keep = (state, body) => {
  for (const entry of body.entries) {
    state.delivered.push({
      event: Object.keys(entry.event)[0],
      sequence: entry.sequence,
    });
  }
  state.lost.push(...playbackLosses(body));
};

const diagnosticsRequest = async (route, request, response) => {
  if (route === "/diagnostics-state") {
    respond(response, 200, {
      bodies: diagnostics.bodies,
      delivered: diagnostics.delivered,
      lost: diagnostics.lost,
      requests: diagnostics.requests,
      waiting: diagnostics.waiting.size,
    });
    return true;
  }
  if (route === "/diagnostics-control" && request.method === "POST") {
    const control = await new Response(Readable.toWeb(request)).json();
    for (const pending of diagnostics.waiting) {
      pending.end();
    }
    diagnostics = freshDiagnostics(control);
    respond(response, 204);
    return true;
  }
  if (route !== "/diagnostics/playback" || request.method !== "POST") {
    return false;
  }
  if (request.headers.authorization !== "Bearer native-probe-token") {
    respond(response, 401);
    return true;
  }
  const state = diagnostics;
  const faulted = state.requests < state.times;
  if (faulted && state.fault === "close-before-body") {
    state.requests += 1;
    request.socket.destroy();
    return true;
  }
  const body = decodePlaybackDiagnosticsBatch(
    await new Response(Readable.toWeb(request)).json()
  );
  state.requests += 1;
  if (state.bodies.length < 32) {
    state.bodies.push(body);
  }
  if (faulted && state.fault === "close-after-body") {
    keep(state, body);
    request.socket.destroy();
    return true;
  }
  if (faulted && state.held) {
    state.waiting.add(response);
    response.once("close", () => state.waiting.delete(response));
    return true;
  }
  const status = faulted ? state.status : 200;
  if (faulted && state.retryAfter) {
    response.setHeader("Retry-After", state.retryAfter);
  }
  if (status === 200) {
    keep(state, body);
  }
  respond(response, status, {
    accepted: Math.max(0, body.entries.length - 1),
    rejected: Math.min(1, body.entries.length),
  });
  return true;
};

const routeDiagnostics = async (route, request, response) => {
  if (route === "/health") {
    respond(response, 204);
    return true;
  }
  if (!route.startsWith("/diagnostics")) {
    return false;
  }
  try {
    return await diagnosticsRequest(route, request, response);
  } catch {
    respond(response, 400);
    return true;
  }
};

const seedTracklist = (action, setId) => {
  if (action === "no-tracklist") {
    // Versos looked and found nothing. The lane has no yt-dlp, so a new Set never gets there.
    db.query(
      "UPDATE sets SET tracklist_state = 'none', tracklist_run_id = NULL, tracklist_run_started_at = NULL WHERE id = ?"
    ).run(setId);
    return true;
  }
  if (action === "running-tracklist") {
    // A run that holds its lease, as one does while Versos scans, so a refresh starts
    // nothing and the Set stays pending with its Cues.
    db.query(
      "UPDATE sets SET tracklist_state = 'pending', tracklist_run_id = 'lane-run', tracklist_run_started_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), setId);
    return true;
  }
  if (action !== "tracklist" && action !== "late-tracklist") {
    return false;
  }
  db.transaction(() => {
    db.query(
      "UPDATE sets SET tracklist_state = 'ready', tracklist_run_id = NULL, tracklist_run_started_at = NULL WHERE id = ?"
    ).run(setId);
    const insert = db.query(
      "INSERT INTO set_cues (set_id, position, start_seconds, artist, title, apple_music_id, artwork_url) VALUES (?, ?, ?, ?, ?, NULL, NULL)"
    );
    insert.run(setId, 0, 0, "First Artist", "First Cue");
    insert.run(
      setId,
      1,
      action === "late-tracklist" ? 26 : 12,
      "Second Artist",
      "Second Cue"
    );
    insert.run(setId, 2, null, "Untimed Artist", "Untimed Cue");
  })();
  return true;
};

// The sections of a real 2 hr Set the node measured (PAL-2232), so About This Set reads as it
// does on a real Set. Each 30 s window holds its section's tempo, and its loudness rises and
// falls a little around -13.5 LUFS.
const laneSections = [
  { bpm: 140, endSeconds: 6090, name: "Locked in", startSeconds: 0 },
  { bpm: 143, endSeconds: 6270, name: "Lift", startSeconds: 6090 },
  { bpm: 160, endSeconds: 6690, name: "Peak", startSeconds: 6270 },
  { bpm: 145, endSeconds: 7065, name: "Come down", startSeconds: 6690 },
  { bpm: 130, endSeconds: 7200, name: "Close", startSeconds: 7065 },
];

const laneAnalysis = () => {
  const windows = Array.from({ length: 240 }, (_, i) => i * 30);
  return {
    bpmCurve: windows.map((seconds) => ({
      bpm: laneSections.findLast((s) => s.startSeconds <= seconds).bpm,
      seconds,
    })),
    durationSeconds: 7200,
    integratedLufs: -13.5,
    loudnessCurve: windows.map((seconds, i) => ({
      lufs:
        Math.round(
          (-13.5 + 1.5 * Math.sin(i / 3) - (i % 17 === 0 ? 4 : 0)) * 10
        ) / 10,
      seconds,
    })),
    medianBpm: 140,
    sections: laneSections,
  };
};

const seedAnalysis = (setId) => {
  db.query(
    "INSERT OR REPLACE INTO set_analysis (set_id, analysis, updated_at) VALUES (?, ?, ?)"
  ).run(setId, JSON.stringify(laneAnalysis()), new Date().toISOString());
};

const handle = async (request, response) => {
  const route = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
  if (await routeDiagnostics(route, request, response)) {
    return;
  }
  if (await audioFaults.route(route, request, response)) {
    return;
  }
  if (handleStream(route, request, response)) {
    return;
  }
  if (request.method === "POST" && route === "/cobalt") {
    const { url } = await new Response(Readable.toWeb(request)).json();
    const setId = slowSets.get(url);
    if (setId) {
      respond(response, 200, {
        status: "tunnel",
        url: `http://127.0.0.1:${port}/slow-audio/${setId}`,
      });
    } else {
      respond(response, 404);
    }
    return;
  }
  const match =
    /^\/(?<action>ready-audio|unavailable-audio|slow-download|slow-audio|finish-download|tracklist|late-tracklist|running-tracklist|no-tracklist|analysis)\/(?<setId>[a-zA-Z0-9-]+)$/u.exec(
      route
    );
  if (!match?.groups) {
    respond(response, 404);
    return;
  }
  const { action, setId } = match.groups;
  const set = db.query("SELECT url FROM sets WHERE id = ?").get(setId);
  if (!set) {
    respond(response, 404);
    return;
  }
  if (request.method === "GET" && action === "slow-audio") {
    if (slowSets.get(set.url) === setId) {
      slowAudio(setId, response);
    } else {
      respond(response, 404);
    }
    return;
  }
  if (request.method !== "POST") {
    respond(response, 404);
    return;
  }
  switch (action) {
    case "unavailable-audio": {
      rmSync(path.join(audioDirectory, `${setId}.m4a`), { force: true });
      break;
    }
    case "slow-download": {
      slowSets.set(set.url, setId);
      break;
    }
    case "finish-download": {
      const download = downloads.get(setId);
      if (!download) {
        respond(response, 409);
        return;
      }
      download.resolve();
      break;
    }
    case "ready-audio": {
      mkdirSync(audioDirectory, { recursive: true });
      copyFileSync(fixture, path.join(audioDirectory, `${setId}.m4a`));
      db.query(
        "UPDATE sets SET download_state = 'ready', retained_audio_format = 'm4a', retained_audio_bytes = ?, duration_seconds = 30 WHERE id = ?"
      ).run(statSync(fixture).size, setId);
      break;
    }
    case "analysis": {
      seedAnalysis(setId);
      break;
    }
    default: {
      if (!seedTracklist(action, setId)) {
        respond(response, 404);
        return;
      }
    }
  }
  respond(response, 204);
};
createServer((request, response) => {
  void handle(request, response);
}).listen(Number(port), "127.0.0.1");
