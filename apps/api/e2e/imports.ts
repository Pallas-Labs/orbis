/* oxlint-disable no-await-in-loop -- Ordered HTTP requests define the journey. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { PlaylistImportSchema } from "@orbis/contracts/http-api";
import { Schema } from "effect";
import { Miniflare } from "miniflare";

const artifact = path.resolve(
  import.meta.dir,
  "../../../.cache/api-imports",
  crypto.randomUUID()
);
await mkdir(artifact, { recursive: true });
const bundle = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "imports-worker.ts")],
  external: ["cloudflare:workers", "node:*"],
  target: "browser",
});
assert.equal(bundle.success, true, String(bundle.logs));
const [output] = bundle.outputs;
const script = await output?.text();
assert.ok(output);

const PAGE = 50;
const videoIds = Array.from(
  { length: 60 },
  (_, n) => `e2e${String(n).padStart(8, "0")}`
);
const watchUrls = videoIds.map((id) => `https://www.youtube.com/watch?v=${id}`);

/** The Data API for one 60-track playlist. `holdSecondPage` leaves page two unanswered. */
const dataApi =
  (holdSecondPage: () => Promise<Response> | null) =>
  (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const resource = url.pathname.split("/").at(-1);
    if (resource === "playlists") {
      return Promise.resolve(
        Response.json({
          items: [
            {
              contentDetails: { itemCount: videoIds.length },
              snippet: { title: "Worker Mix" },
            },
          ],
        })
      );
    }
    if (resource === "playlistItems") {
      const start = Number(url.searchParams.get("pageToken") ?? "0");
      if (start > 0) {
        const held = holdSecondPage();
        if (held) {
          return held;
        }
      }
      const next = start + PAGE;
      return Promise.resolve(
        Response.json({
          items: videoIds
            .slice(start, next)
            .map((videoId) => ({ contentDetails: { videoId } })),
          // JSON leaves an undefined token out, as Google does on the last page.
          nextPageToken: next < videoIds.length ? String(next) : undefined,
        })
      );
    }
    const ids = url.searchParams.get("id")?.split(",") ?? [];
    return Promise.resolve(
      Response.json({
        items: ids.map((id) => ({
          contentDetails: { duration: "PT4M" },
          id,
          snippet: {
            channelTitle: "Worker Artist",
            publishedAt: "2026-06-01T00:00:00Z",
            thumbnails: {},
            title: `Track ${id}`,
          },
        })),
      })
    );
  };

const options = (outbound: (request: Request) => Promise<Response>) => ({
  bindings: {
    AUDIO_NODE_URL: "https://audio.example",
    STREAM_GRANT_SECRET: "cd".repeat(32),
    YOUTUBE_API_KEY: "worker-key",
  },
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GROUP: { className: "Group", useSQLite: true } },
  durableObjectsPersist: path.join(artifact, "storage"),
  modules: true,
  outboundService: outbound,
  script,
});

const Snapshot = Schema.Struct({
  alarm: Schema.NullOr(Schema.Number),
  alarmRuns: Schema.Array(Schema.Number),
  imports: Schema.Array(
    Schema.Struct({
      added: Schema.Number,
      failure: Schema.NullOr(Schema.String),
      id: Schema.String,
      page_token: Schema.NullOr(Schema.String),
      processed: Schema.Number,
      state: Schema.String,
      total: Schema.NullOr(Schema.Number),
      unavailable: Schema.Number,
      updated_at: Schema.Number,
    })
  ),
  members: Schema.Array(Schema.String),
  sets: Schema.Number,
});

const transcript: unknown[] = [];
const call = async (
  runtime: Miniflare,
  route: string,
  method = "GET",
  body?: { readonly url: string }
) => {
  const response = await runtime.dispatchFetch(`http://orbis/api${route}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      "CF-Connecting-IP": "192.0.2.1",
      authorization: "Bearer importer-token",
      "content-type": "application/json",
    },
    method,
  });
  const text = await response.text();
  transcript.push({
    at: Date.now(),
    method,
    route,
    status: response.status,
    text: text.slice(0, 1000),
  });
  return { status: response.status, text };
};
const snapshot = async (runtime: Miniflare) => {
  const response = await call(runtime, "/__imports");
  assert.equal(response.status, 200, response.text);
  return Schema.decodeUnknownSync(Snapshot)(JSON.parse(response.text));
};

const secondPageAsked = Promise.withResolvers<boolean>();
let runtime = new Miniflare(
  options(
    dataApi(() => {
      secondPageAsked.resolve(true);
      // Never answered: the Group is torn down while it waits.
      return Promise.withResolvers<Response>().promise;
    })
  )
);
try {
  const seeded = await call(runtime, "/__seed-imports");
  assert.equal(seeded.status, 200);
  const accepted = await call(runtime, "/playlists/import", "POST", {
    url: "https://music.youtube.com/playlist?list=PLworkerMix",
  });
  assert.equal(accepted.status, 202, accepted.text);
  const started = Schema.decodeUnknownSync(PlaylistImportSchema)(
    JSON.parse(accepted.text)
  );

  await secondPageAsked.promise;
  const mid = await snapshot(runtime);
  assert.equal(mid.imports[0]?.state, "running");
  assert.equal(mid.imports[0]?.processed, PAGE);
  assert.equal(mid.imports[0]?.page_token, String(PAGE));
  assert.deepEqual(mid.members, watchUrls.slice(0, PAGE));
  assert.ok(mid.alarm !== null, "a running import keeps the alarm set");
  const heartbeat = mid.alarm ?? 0;
  assert.ok(heartbeat - Date.now() <= 30_000 && heartbeat > Date.now());

  await runtime.dispose();
  const evictedAt = Date.now();
  runtime = new Miniflare(options(dataApi(() => null)));
  // Nothing calls the Group until after its alarm, so only the alarm can wake it.
  await Bun.sleep(Math.max(heartbeat - Date.now(), 0) + 5000);

  const resumed = await snapshot(runtime);
  const [row] = resumed.imports;
  assert.equal(row?.id, started.id);
  assert.equal(row?.state, "done", JSON.stringify(row));
  assert.equal(row?.added, 60);
  assert.deepEqual(resumed.members, watchUrls);
  assert.equal(resumed.sets, 60);
  const [alarmRun] = resumed.alarmRuns;
  assert.ok(alarmRun !== undefined, "the alarm ran after the restart");
  assert.ok(alarmRun >= heartbeat, "the alarm ran at the heartbeat");
  assert.ok(
    (row?.updated_at ?? 0) >= alarmRun,
    "the import finished after the alarm woke the Group"
  );
  assert.equal(resumed.alarm, null, "no alarm is left once nothing runs");

  const status = await call(runtime, `/playlists/imports/${started.id}`);
  assert.equal(status.status, 200, status.text);
  const done = Schema.decodeUnknownSync(PlaylistImportSchema)(
    JSON.parse(status.text)
  );
  assert.equal(done.state.kind, "done");

  await writeFile(
    path.join(artifact, "transcript.json"),
    `${JSON.stringify(transcript, null, 2)}\n`
  );
  await writeFile(
    path.join(artifact, "result.json"),
    `${JSON.stringify(
      {
        alarmRanAfterHeartbeatMs: alarmRun - heartbeat,
        alarmRanAt: new Date(alarmRun).toISOString(),
        beforeRestart: mid.imports[0],
        evictedBeforeHeartbeatMs: heartbeat - evictedAt,
        finished: row,
        heartbeat: new Date(heartbeat).toISOString(),
        membersInOrder: true,
        status: done,
      },
      null,
      2
    )}\n`
  );
  console.log(
    `Playlist import alarm journey passed. ${path.join(artifact, "result.json")}`
  );
} finally {
  await runtime.dispose();
}
