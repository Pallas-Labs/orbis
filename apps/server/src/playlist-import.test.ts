import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PlaylistImport } from "@orbis/contracts";
import {
  PlaylistImportSchema,
  QueueEventSchema,
} from "@orbis/contracts/http-api";
import { Schedule, Schema } from "effect";

import { hashToken } from "./identity.js";
import { Metadata } from "./metadata.js";
import { createTestApp } from "./test-app.js";
import { eventStream, request, runInOrder } from "./test-http.js";

const evidence = path.resolve(
  import.meta.dir,
  "../../../.cache/playlist-import"
);
// Written before the job: each is a way it could fail that a test below rules out.
const failures = [
  "the request waits for every track to be saved instead of answering 202",
  "tracks land out of the playlist's order, or tracks after the first page are lost",
  "a video listed twice appears twice, or a deleted video fails the import",
  "a track already in the Library fails the import with a conflict",
  "a bad link, a private playlist, or a server without a key creates a Playlist or answers 500",
  "a second request while the import runs creates a second Playlist",
  "a restart mid-import loses the remaining pages",
  "a replayed page saves a Set twice or adds a member twice",
  "a YouTube failure is retried forever, or fails without a message, or loses the saved tracks",
  "Try Again after a failure makes a second Playlist instead of finishing the first",
  "another Person can read the import, or receives its events",
  "the import's progress never reaches the owner's event stream",
  "a playlist over the Playlist maximum fails instead of keeping the first 500",
];

const videoId = (n: number) => `imp${String(n).padStart(8, "0")}`;
const watchUrl = (n: number) => `https://www.youtube.com/watch?v=${videoId(n)}`;

interface FakePlaylist {
  readonly entries: readonly string[];
  readonly gone?: ReadonlySet<string>;
  readonly title: string;
}

interface DataApiAnswer {
  readonly items: readonly unknown[];
  readonly nextPageToken?: string | undefined;
}

/** One `playlistItems` read, named by its page token; the first page is `first`. */
type PageRead = string;

const json = (body: DataApiAnswer) => Response.json(body);

/**
 * The three Data API reads an import makes, answered from memory like Google would. `answer` can
 * hold or replace a `playlistItems` read, which is how a test stops the job between pages.
 */
const fakeYouTube = (
  playlists: Record<string, FakePlaylist>,
  answer?: (
    page: PageRead,
    call: number,
    signal: AbortSignal,
    normal: () => Promise<Response>
  ) => Promise<Response> | undefined
) => {
  const calls: string[] = [];
  const pageCalls = new Map<PageRead, number>();
  const fetch = (url: string, signal: AbortSignal) => {
    const parsed = new URL(url);
    const resource = parsed.pathname.split("/").at(-1) ?? "";
    calls.push(resource);
    if (parsed.searchParams.get("key") !== "test-key") {
      return Promise.resolve(new Response("forbidden", { status: 403 }));
    }
    if (resource === "playlists") {
      const playlist = playlists[parsed.searchParams.get("id") ?? ""];
      return Promise.resolve(
        json({
          items: playlist
            ? [
                {
                  contentDetails: { itemCount: playlist.entries.length },
                  snippet: { title: playlist.title },
                },
              ]
            : [],
        })
      );
    }
    if (resource === "playlistItems") {
      const page = parsed.searchParams.get("pageToken") ?? "first";
      const call = (pageCalls.get(page) ?? 0) + 1;
      pageCalls.set(page, call);
      const normal = () => {
        const playlist = playlists[parsed.searchParams.get("playlistId") ?? ""];
        if (!playlist) {
          return Promise.resolve(new Response("not found", { status: 404 }));
        }
        const start = page === "first" ? 0 : Number(page);
        const next = start + Number(parsed.searchParams.get("maxResults"));
        return Promise.resolve(
          json({
            items: playlist.entries
              .slice(start, next)
              .map((id) => ({ contentDetails: { videoId: id } })),
            // JSON leaves an undefined token out, as Google does on the last page.
            nextPageToken:
              next < playlist.entries.length ? String(next) : undefined,
          })
        );
      };
      return answer?.(page, call, signal, normal) ?? normal();
    }
    const gone = new Set(
      Object.values(playlists).flatMap((playlist) => [...(playlist.gone ?? [])])
    );
    const ids = (parsed.searchParams.get("id") ?? "").split(",");
    if (ids.length > 50) {
      return Promise.resolve(new Response("too many ids", { status: 400 }));
    }
    return Promise.resolve(
      json({
        items: ids
          .filter((id) => !gone.has(id))
          .map((id) => ({
            contentDetails: { duration: "PT3M25S" },
            id,
            snippet: {
              channelTitle: `Artist ${id}`,
              publishedAt: "2024-05-01T00:00:00Z",
              thumbnails: {
                maxres: { url: `https://i.ytimg.com/vi/${id}/maxres.jpg` },
                medium: { url: `https://i.ytimg.com/vi/${id}/medium.jpg` },
              },
              title: `Track ${id}`,
            },
          })),
      })
    );
  };
  return { calls, fetch, pageCalls };
};

/** A read the test lets go when it chooses. It ends when the app is disposed. */
const gate = () => {
  const asked = Promise.withResolvers<boolean>();
  const released = Promise.withResolvers<boolean>();
  const hold = async (signal: AbortSignal, answer: () => Promise<Response>) => {
    asked.resolve(true);
    const stopped = Promise.withResolvers<boolean>();
    signal.addEventListener("abort", () => stopped.resolve(true));
    await Promise.race([released.promise, stopped.promise]);
    signal.throwIfAborted();
    return await answer();
  };
  return {
    asked: asked.promise,
    hold,
    release: () => released.resolve(true),
  };
};

const decodeImport = Schema.decodeUnknownSync(PlaylistImportSchema);
const decodeEvent = Schema.decodeUnknownSync(
  Schema.fromJsonString(QueueEventSchema)
);
const setUrls = Schema.decodeUnknownSync(
  Schema.Struct({
    sets: Schema.Array(
      Schema.Struct({ id: Schema.String, url: Schema.String })
    ),
  })
);
const playlistList = Schema.decodeUnknownSync(
  Schema.Struct({
    playlists: Schema.Array(
      Schema.Struct({ id: Schema.String, name: Schema.String })
    ),
  })
);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

const OTHER_TOKEN = "other-person-token";

/** A disposable root whose trust store also holds a second Person, `other`. */
const laneRoot = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-playlist-import-"));
  roots.push(root);
  await writeFile(
    path.join(root, "devices.json"),
    JSON.stringify({
      keys: [
        {
          addedAt: "2026-01-01T00:00:00.000Z",
          id: "other-key",
          label: "other",
          lastUsedAt: null,
          personId: "other",
          scope: "daily",
          tokenHash: hashToken(OTHER_TOKEN),
        },
      ],
      people: [
        { id: "host", removed: false, username: "host" },
        { id: "other", removed: false, username: "other" },
      ],
      version: 2,
    })
  );
  return root;
};

const lane = (
  root: string,
  youTube: ReturnType<typeof fakeYouTube>,
  youTubeApiKey: string | null = "test-key"
) =>
  createTestApp({
    // Downloads are queued but never run, so the 20-Download cap is reached and held.
    audio: {
      audioDir: path.join(root, "audio"),
      cobaltApiKey: "test",
      cobaltUrl: "http://127.0.0.1:9",
      startWorker: false,
    },
    databasePath: path.join(root, "library.sqlite"),
    devicesPath: path.join(root, "devices.json"),
    logging: { silent: true },
    metadata: Metadata.layer({
      fetch: youTube.fetch,
      youTubeApiKey: youTubeApiKey ?? undefined,
    }),
    // Retries without waiting, so a failure test needs no clock.
    playlistImports: { retry: Schedule.recurs(2) },
  });
type Lane = ReturnType<typeof lane>;

const record = async <Result>(name: string, result: Result) => {
  await mkdir(evidence, { recursive: true });
  await writeFile(
    path.join(evidence, `${name}.json`),
    JSON.stringify({ failures, ...result }, null, 2)
  );
};

const importPlaylist = (app: Lane, url: string) =>
  request(app, { method: "POST", payload: { url }, url: "/playlists/import" });

const startImport = async (app: Lane, url: string) => {
  const response = await importPlaylist(app, url);
  expect(response.statusCode).toBe(202);
  return decodeImport(response.json());
};

const getJson = async (app: Lane, url: string) => {
  const response = await request(app, { method: "GET", url });
  return response.json();
};

const readImport = async (app: Lane, id: string) => {
  const response = await request(app, {
    method: "GET",
    url: `/playlists/imports/${id}`,
  });
  expect(response.statusCode).toBe(200);
  return decodeImport(response.json());
};

const members = async (app: Lane, playlistId: string) =>
  setUrls(await getJson(app, `/playlists/${playlistId}`)).sets.map(
    (set) => set.url
  );

const library = async (app: Lane) => setUrls(await getJson(app, "/sets")).sets;

/** Opens `/events?changes=1` for the host, or for `other`, and reads it frame by frame. */
const openEvents = async (app: Lane, token?: string) => {
  const response = await app.handler(
    new Request("http://127.0.0.1:4310/events?changes=1", {
      headers: token
        ? { authorization: `Bearer ${token}` }
        : { "x-orbis-test-auth": "fixture" },
    }),
    "device"
  );
  expect(response.status).toBe(200);
  const stream = eventStream(response);
  const nextEvent = async () => {
    const raw = await stream.next();
    if (raw === null) {
      throw new Error("The event stream closed");
    }
    return decodeEvent(raw);
  };
  // The first frame proves the stream runs, so no change published after it is missed.
  await nextEvent();
  const imports: PlaylistImport[] = [];
  return {
    close: () => stream.close(),
    imports,
    nextEvent,
    /** Reads until this import ends, keeping every import frame it passes. */
    untilEnded: (id: string): Promise<PlaylistImport> => {
      const attempt = async (): Promise<PlaylistImport> => {
        const event = await nextEvent();
        if (event.kind === "playlistImport") {
          imports.push(event.playlistImport);
          if (
            event.playlistImport.id === id &&
            event.playlistImport.state.kind !== "running"
          ) {
            return event.playlistImport;
          }
        }
        return await attempt();
      };
      return attempt();
    },
  };
};

const mix = (): FakePlaylist => {
  // 61 entries span two Data API pages. One video is listed twice and two are gone.
  const entries = Array.from({ length: 58 }, (_, n) => videoId(n));
  entries.splice(10, 0, videoId(4));
  entries.push(videoId(900), videoId(901));
  return {
    entries,
    gone: new Set([videoId(900), videoId(901)]),
    title: "Late Night Drive",
  };
};
const expectedMix = Array.from({ length: 58 }, (_, n) => watchUrl(n));

test("the import answers 202 before any track is saved, then fills an ordered Playlist", async () => {
  const worker = gate();
  const youTube = fakeYouTube({ PLmix: mix() }, (page, call, signal, normal) =>
    // The request reads the first page itself; the job's own read of it waits here.
    page === "first" && call === 2 ? worker.hold(signal, normal) : undefined
  );
  const root = await laneRoot();
  const app = lane(root, youTube);
  try {
    const existing = await request(app, {
      method: "POST",
      payload: {
        title: "My own name",
        url: `https://music.youtube.com/watch?v=${videoId(2)}`,
      },
      url: "/sets",
    });
    expect(existing.statusCode).toBe(201);
    const host = await openEvents(app);
    const other = await openEvents(app, OTHER_TOKEN);

    const response = await importPlaylist(
      app,
      "https://music.youtube.com/playlist?list=PLmix"
    );
    expect(response.statusCode).toBe(202);
    const started = decodeImport(response.json());
    expect(started).toMatchObject({
      playlist: { name: "Late Night Drive", setCount: 0 },
      state: { kind: "running", processed: 0, total: 61 },
    });
    await worker.asked;
    expect(await members(app, started.playlist.id)).toEqual([]);

    worker.release();
    const done = await host.untilEnded(started.id);
    expect(done.state).toEqual({
      added: 58,
      downloading: 20,
      kind: "done",
      overLimit: 0,
      unavailable: 2,
      waiting: 38,
    });
    expect(done.playlist.setCount).toBe(58);
    expect(host.imports.map((frame) => frame.state.kind)).toEqual([
      "running",
      "done",
    ]);
    expect(await members(app, started.playlist.id)).toEqual(expectedMix);
    const saved = await library(app);
    expect(saved).toHaveLength(58);
    expect(new Set(saved.map((set) => set.url))).toEqual(new Set(expectedMix));
    expect(await readImport(app, started.id)).toEqual(done);

    // `other` sees its own change next: no frame of the host's import reached it.
    await request(app, {
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
      method: "POST",
      payload: { name: "Mine" },
      url: "/playlists",
    });
    const nextOwnFrame = async (): Promise<
      Awaited<ReturnType<typeof other.nextEvent>>
    > => {
      const frame = await other.nextEvent();
      return frame.kind === "changed" || frame.kind === "playlistImport"
        ? frame
        : await nextOwnFrame();
    };
    const otherFrame = await nextOwnFrame();
    expect(otherFrame).toEqual({ kind: "changed", topic: "playlist" });
    const foreign = await request(app, {
      headers: { authorization: `Bearer ${OTHER_TOKEN}` },
      method: "GET",
      url: `/playlists/imports/${started.id}`,
    });
    expect(foreign.statusCode).toBe(404);
    await host.close();
    await other.close();
    await record("ordered-import", {
      accepted: started,
      dataApiCalls: youTube.calls,
      events: host.imports,
      foreignRead: foreign.statusCode,
      otherStreamFirstFrame: otherFrame,
    });
  } finally {
    await app.dispose();
  }
});

test("links and playlists that can't be imported say why at once and create nothing", async () => {
  const root = await laneRoot();
  const app = lane(
    root,
    fakeYouTube({
      PLempty: {
        entries: [videoId(1)],
        gone: new Set([videoId(1)]),
        title: "Gone",
      },
    })
  );
  const unconfigured = lane(await laneRoot(), fakeYouTube({}), null);
  try {
    const video = await importPlaylist(
      app,
      `https://music.youtube.com/watch?v=${videoId(1)}`
    );
    const soundCloud = await importPlaylist(
      app,
      "https://soundcloud.com/someone/sets/mix?list=PLx"
    );
    const hidden = await importPlaylist(
      app,
      "https://music.youtube.com/playlist?list=PLprivate"
    );
    const empty = await importPlaylist(
      app,
      "https://music.youtube.com/playlist?list=PLempty"
    );
    const noKey = await importPlaylist(
      unconfigured,
      "https://music.youtube.com/playlist?list=PLmix"
    );
    expect(video.statusCode).toBe(400);
    expect(video.json()).toEqual({
      message: "Use a YouTube or YouTube Music playlist link.",
    });
    expect(soundCloud.statusCode).toBe(400);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({
      message:
        "YouTube can't share this playlist. Only public and unlisted playlists can be imported.",
    });
    expect(empty.statusCode).toBe(404);
    expect(empty.json()).toEqual({
      message: "This playlist has no tracks Orbis can play.",
    });
    expect(noKey.statusCode).toBe(503);
    expect(noKey.json()).toEqual({
      message: "Playlist import is not set up on this server.",
    });
    const playlists = await request(app, { method: "GET", url: "/playlists" });
    expect(playlists.json()).toEqual({ playlists: [] });
    await record("refusals", {
      empty: { body: empty.json(), status: empty.statusCode },
      hidden: { body: hidden.json(), status: hidden.statusCode },
      noKey: { body: noKey.json(), status: noKey.statusCode },
      soundCloud: soundCloud.statusCode,
      video: { body: video.json(), status: video.statusCode },
    });
  } finally {
    await app.dispose();
    await unconfigured.dispose();
  }
});

test("asking again while the import runs answers the same import and makes no second Playlist", async () => {
  const worker = gate();
  const youTube = fakeYouTube({ PLmix: mix() }, (page, call, signal) =>
    page === "first" && call === 2
      ? worker.hold(signal, () =>
          Promise.resolve(new Response("held", { status: 500 }))
        )
      : undefined
  );
  const app = lane(await laneRoot(), youTube);
  try {
    const first = await startImport(
      app,
      "https://music.youtube.com/playlist?list=PLmix"
    );
    await worker.asked;
    const callsBefore = youTube.calls.length;
    const again = await importPlaylist(
      app,
      "https://www.youtube.com/watch?v=abc&list=PLmix"
    );
    expect(again.statusCode).toBe(202);
    expect(decodeImport(again.json())).toEqual(first);
    expect(youTube.calls).toHaveLength(callsBefore);
    const listed = playlistList(await getJson(app, "/playlists"));
    expect(listed.playlists.map((playlist) => playlist.name)).toEqual([
      "Late Night Drive",
    ]);
    await record("idempotent-start", {
      first,
      playlists: listed.playlists,
      second: again.json(),
    });
  } finally {
    await app.dispose();
  }
});

test("a restart between pages resumes at the next page with no Set or member twice", async () => {
  const root = await laneRoot();
  const secondPage = gate();
  const first = fakeYouTube({ PLmix: mix() }, (page, _call, signal) =>
    page === "50"
      ? secondPage.hold(signal, () =>
          Promise.resolve(new Response("held", { status: 500 }))
        )
      : undefined
  );
  let app = lane(root, first);
  let accepted: PlaylistImport;
  let beforeRestart: PlaylistImport;
  try {
    accepted = await startImport(
      app,
      "https://music.youtube.com/playlist?list=PLmix"
    );
    await secondPage.asked;
    beforeRestart = await readImport(app, accepted.id);
    expect(beforeRestart.state).toEqual({
      kind: "running",
      processed: 50,
      total: 61,
    });
    expect(await members(app, accepted.playlist.id)).toEqual(
      expectedMix.slice(0, 49)
    );
    // The crash comes after page two's Sets are saved but before they join the Playlist.
    await runInOrder([49, 50, 51], async (n) => {
      await request(app, {
        method: "POST",
        payload: { url: watchUrl(n) },
        url: "/sets",
      });
    });
  } finally {
    await app.dispose();
  }

  const second = fakeYouTube({ PLmix: mix() });
  app = lane(root, second);
  try {
    const events = await openEvents(app);
    const current = await readImport(app, accepted.id);
    const done =
      current.state.kind === "running"
        ? await events.untilEnded(accepted.id)
        : current;
    await events.close();
    expect(done.state).toMatchObject({
      added: 58,
      kind: "done",
      unavailable: 2,
    });
    expect(second.calls).toEqual(["playlistItems", "videos"]);
    expect(await members(app, accepted.playlist.id)).toEqual(expectedMix);
    const saved = await library(app);
    expect(saved).toHaveLength(58);
    const sqlite = new Database(path.join(root, "library.sqlite"));
    const counts = sqlite
      .query<
        { members: number; distinctMembers: number; sets: number },
        [string]
      >(
        `SELECT
           (SELECT COUNT(*) FROM playlist_sets WHERE playlist_id = ?1) AS members,
           (SELECT COUNT(DISTINCT set_id) FROM playlist_sets WHERE playlist_id = ?1) AS distinctMembers,
           (SELECT COUNT(*) FROM sets) AS sets`
      )
      .get(accepted.playlist.id);
    sqlite.close();
    expect(counts).toEqual({ distinctMembers: 58, members: 58, sets: 58 });
    await record("restart", {
      afterRestartCalls: second.calls,
      beforeRestart,
      done,
      rows: counts,
    });
  } finally {
    await app.dispose();
  }
});

test("YouTube failing past the retries fails the import with a message, keeps its Sets, and Try Again finishes it", async () => {
  let youTubeDown = true;
  const youTube = fakeYouTube({ PLmix: mix() }, (page) =>
    page === "50" && youTubeDown
      ? Promise.resolve(new Response("unavailable", { status: 503 }))
      : undefined
  );
  const app = lane(await laneRoot(), youTube);
  try {
    const events = await openEvents(app);
    const accepted = await startImport(
      app,
      "https://music.youtube.com/playlist?list=PLmix"
    );
    const failed = await events.untilEnded(accepted.id);
    expect(failed.state).toEqual({
      kind: "failed",
      message: "YouTube is not answering. Try the import again.",
    });
    expect(youTube.pageCalls.get("50")).toBe(3);
    expect(await members(app, accepted.playlist.id)).toEqual(
      expectedMix.slice(0, 49)
    );
    expect(await library(app)).toHaveLength(49);

    youTubeDown = false;
    const retried = await importPlaylist(
      app,
      "https://music.youtube.com/playlist?list=PLmix"
    );
    expect(retried.statusCode).toBe(202);
    expect(decodeImport(retried.json())).toMatchObject({
      id: accepted.id,
      playlist: { id: accepted.playlist.id },
      state: { kind: "running", processed: 50 },
    });
    const done = await events.untilEnded(accepted.id);
    await events.close();
    expect(done.state).toMatchObject({ added: 58, kind: "done" });
    expect(await members(app, accepted.playlist.id)).toEqual(expectedMix);
    const listed = playlistList(await getJson(app, "/playlists"));
    expect(listed.playlists).toHaveLength(1);
    await record("failure-and-retry", {
      done,
      failed,
      secondPageAttempts: youTube.pageCalls.get("50"),
    });
  } finally {
    await app.dispose();
  }
});

test("a playlist over the Playlist maximum keeps its first 500 tracks", async () => {
  const youTube = fakeYouTube({
    PLlong: {
      entries: Array.from({ length: 530 }, (_, n) => videoId(n)),
      title: "Everything",
    },
  });
  const app = lane(await laneRoot(), youTube);
  try {
    const events = await openEvents(app);
    const accepted = await startImport(
      app,
      "https://music.youtube.com/playlist?list=PLlong"
    );
    const done = await events.untilEnded(accepted.id);
    await events.close();
    expect(done.state).toMatchObject({
      added: 500,
      kind: "done",
      overLimit: 30,
    });
    expect(done.playlist.setCount).toBe(500);
    const stored = await members(app, accepted.playlist.id);
    expect(stored).toHaveLength(500);
    expect(stored.at(-1)).toBe(watchUrl(499));
    await record("over-limit", {
      done,
      pages: youTube.calls.filter((call) => call === "playlistItems").length,
    });
  } finally {
    await app.dispose();
  }
});
