import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Schema } from "effect";
import { Miniflare } from "miniflare";

import { pollUntil } from "../../server/src/test-http.js";
import { workerModules } from "./worker-modules.js";

// Versos answers a Tracklist request in seconds, long after the Group has answered the retry
// that started it. A run that only lives as long as that request never stores its Cues.
const READY_AFTER_MS = 3000;
// The Group's SQLite binds at most 100 values in one statement. A real Set returned 43 Cues,
// 301 values in a single insert.
const CUES = Array.from({ length: 43 }, (_, position) => ({
  appleMusicId: null,
  artist: "Artist",
  artworkUrl: null,
  position,
  startSeconds: position * 120,
  title: `Track ${position + 1}`,
}));
// A refresh asks Versos to scan again, and the new scan finds one more Cue.
const REFRESHED_CUES = [
  ...CUES,
  { ...CUES[0], position: CUES.length, startSeconds: CUES.length * 120 },
];

const artifact = path.resolve(
  import.meta.dir,
  "../../../.cache/api-tracklists",
  crypto.randomUUID()
);
await mkdir(artifact, { recursive: true });
const TracklistRequest = Schema.Struct({
  force: Schema.optional(Schema.Literal(true)),
  url: Schema.String,
});
const decodeTracklistRequest = Schema.decodeUnknownSync(TracklistRequest);

const Tracklist = Schema.Struct({
  cues: Schema.Array(Schema.Unknown),
  state: Schema.String,
});
const decodeTracklist = Schema.decodeUnknownSync(Tracklist);

const requestedAt = new Map<string, number>();
const forced = new Set<string>();
const calls: string[] = [];
const versos = Bun.serve({
  fetch: async (request) => {
    const url = new URL(request.url);
    calls.push(`${Date.now()} ${request.method} ${url.pathname}`);
    if (request.method === "POST" && url.pathname === "/orbis/tracklists") {
      const body = decodeTracklistRequest(await request.json());
      requestedAt.set(body.url, Date.now());
      if (body.force) {
        forced.add(body.url);
      }
      return Response.json({ requestId: body.url });
    }
    const requestId = decodeURIComponent(
      url.pathname.replace("/orbis/tracklists/", "")
    );
    const started = requestedAt.get(requestId);
    if (started === undefined) {
      return new Response("unknown request", { status: 404 });
    }
    return Response.json(
      Date.now() - started < READY_AFTER_MS
        ? { state: "pending" }
        : {
            cues: forced.has(requestId) ? REFRESHED_CUES : CUES,
            state: "ready",
          }
    );
  },
  port: 0,
});
const bundle = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "tracklist-worker.ts")],
  external: ["cloudflare:workers", "node:*"],
  target: "browser",
});
assert.equal(bundle.success, true, String(bundle.logs));
const [output] = bundle.outputs;
assert.ok(output);
const runtime = new Miniflare({
  bindings: {
    AUDIO_NODE_URL: "https://audio.example",
    STREAM_GRANT_SECRET: "ef".repeat(32),
    VERSOS_API_KEY: "versos-key",
    VERSOS_URL: versos.url.toString(),
  },
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GROUP: { className: "Group", useSQLite: true } },
  durableObjectsPersist: path.join(artifact, "storage"),
  modules: workerModules(await output.text()),
});
const call = async (route: string, method = "GET") => {
  const response = await runtime.dispatchFetch(`http://orbis/api${route}`, {
    headers: {
      "CF-Connecting-IP": "192.0.2.1",
      authorization: "Bearer listener-token",
    },
    method,
  });
  return { status: response.status, text: await response.text() };
};
const waitForReady = (id: string) => {
  const deadline = Date.now() + READY_AFTER_MS + 20_000;
  let last = "";
  const ask = async () => {
    if (Date.now() >= deadline) {
      throw new Error(
        `${id} never became ready; last answer ${last}; Versos saw ${calls.join(", ")}`
      );
    }
    const tracklist = await call(`/sets/${id}/tracklist`);
    assert.equal(tracklist.status, 200, tracklist.text);
    last = tracklist.text;
    const answer = decodeTracklist(JSON.parse(last));
    return answer.state === "ready" ? answer : null;
  };
  return pollUntil(ask, { interval: 500 });
};
try {
  const seeded = await call("/__seed-tracklist");
  assert.equal(seeded.status, 200, seeded.text);
  const startedAt = Date.now();
  const retried = await call("/sets/slow-set/tracklist/retry", "POST");
  assert.equal(retried.status, 200, retried.text);
  const ready = await waitForReady("slow-set");
  assert.equal(ready.cues.length, CUES.length);
  // A second Set started after the first run finished proves the Group still takes new runs.
  const second = await call("/sets/second-set/tracklist/retry", "POST");
  assert.equal(second.status, 200, second.text);
  await waitForReady("second-set");
  // A ready Set keeps its Cues while Versos scans it again, then takes the new answer.
  const refreshStartedAt = Date.now();
  const refreshed = await call("/sets/slow-set/tracklist/retry", "POST");
  assert.equal(refreshed.status, 200, refreshed.text);
  const pending = decodeTracklist(JSON.parse(refreshed.text));
  assert.equal(pending.state, "pending");
  assert.equal(pending.cues.length, CUES.length);
  const again = await call("/sets/slow-set/tracklist/retry", "POST");
  assert.equal(again.status, 200, again.text);
  const refreshedReady = await waitForReady("slow-set");
  assert.equal(refreshedReady.cues.length, REFRESHED_CUES.length);
  assert.ok(forced.has("https://www.youtube.com/watch?v=slow-set"));
  assert.equal(
    calls.filter((entry) => entry.endsWith("POST /orbis/tracklists")).length,
    3
  );
  await writeFile(
    path.join(artifact, "result.json"),
    `${JSON.stringify(
      {
        readyAfterMs: refreshStartedAt - startedAt,
        refreshReadyAfterMs: Date.now() - refreshStartedAt,
        refreshedCues: refreshedReady.cues.length,
        setsReady: ["slow-set", "second-set"],
        versosAnsweredAfterMs: READY_AFTER_MS,
      },
      null,
      2
    )}\n`
  );
  console.log(
    `Tracklist journey passed. ${path.join(artifact, "result.json")}`
  );
} finally {
  await runtime.dispose();
  await versos.stop(true);
}
