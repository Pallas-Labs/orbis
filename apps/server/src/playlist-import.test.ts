/* oxlint-disable no-await-in-loop -- Imports run in order so a re-import sees the first. */
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Schema } from "effect";

import { Metadata } from "./metadata.js";
import { createTestApp } from "./test-app.js";
import { request } from "./test-http.js";

const evidence = path.resolve(
  import.meta.dir,
  "../../../.cache/playlist-import"
);
// Written before the import: each is a way it could fail that a test below rules out.
const failures = [
  "a link with no playlist is accepted, or a video link makes an empty Playlist",
  "tracks land out of the playlist's order",
  "a playlist longer than one Data API page loses tracks after the first page",
  "a deleted or private video fails the import or becomes a broken Set",
  "a track already in the Library fails the import with a conflict",
  "a video listed twice appears twice in the Playlist",
  "importing the same playlist again fails on the Playlist name",
  "imported Sets are missing from the Library or keep a temporary title",
  "the 20-Download cap fails the import instead of leaving the rest unqueued",
  "a playlist over the Playlist maximum fails instead of keeping the first 500",
  "a private playlist answers 500 instead of saying it can't be read",
  "a server without a YouTube key answers 500 instead of saying import is not set up",
];

const videoId = (n: number) => `imp${String(n).padStart(8, "0")}`;

interface FakePlaylist {
  readonly entries: readonly string[];
  readonly gone?: ReadonlySet<string>;
  readonly title: string;
}

interface DataApiAnswer {
  readonly items: readonly unknown[];
  readonly nextPageToken?: string | undefined;
}

const json = (body: DataApiAnswer) => Promise.resolve(Response.json(body));

/** The three Data API reads the importer makes, answered from memory like Google would. */
const fakeYouTube = (playlists: Record<string, FakePlaylist>) => {
  const calls: string[] = [];
  const fetch = (url: string) => {
    const parsed = new URL(url);
    const resource = parsed.pathname.split("/").at(-1) ?? "";
    calls.push(resource);
    if (parsed.searchParams.get("key") !== "test-key") {
      return Promise.resolve(new Response("forbidden", { status: 403 }));
    }
    if (resource === "playlists") {
      const playlist = playlists[parsed.searchParams.get("id") ?? ""];
      return json({
        items: playlist
          ? [
              {
                contentDetails: { itemCount: playlist.entries.length },
                snippet: { title: playlist.title },
              },
            ]
          : [],
      });
    }
    if (resource === "playlistItems") {
      const playlist = playlists[parsed.searchParams.get("playlistId") ?? ""];
      if (!playlist) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      const start = Number(parsed.searchParams.get("pageToken") ?? "0");
      const size = Number(parsed.searchParams.get("maxResults"));
      const next = start + size;
      return json({
        items: playlist.entries
          .slice(start, next)
          .map((id) => ({ contentDetails: { videoId: id } })),
        // JSON leaves an undefined token out, as Google does on the last page.
        nextPageToken:
          next < playlist.entries.length ? String(next) : undefined,
      });
    }
    const gone = new Set(
      Object.values(playlists).flatMap((playlist) => [...(playlist.gone ?? [])])
    );
    const ids = (parsed.searchParams.get("id") ?? "").split(",");
    if (ids.length > 50) {
      return Promise.resolve(new Response("too many ids", { status: 400 }));
    }
    return json({
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
    });
  };
  return { calls, fetch };
};

const Imported = Schema.Struct({
  overLimit: Schema.Number,
  playlist: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    setCount: Schema.Number,
  }),
  sets: Schema.Array(
    Schema.Struct({
      artworkLargeUrl: Schema.NullOr(Schema.String),
      artworkUrl: Schema.NullOr(Schema.String),
      autoDownloadResult: Schema.String,
      creator: Schema.NullOr(Schema.String),
      durationSeconds: Schema.NullOr(Schema.Number),
      id: Schema.String,
      metadataState: Schema.String,
      title: Schema.String,
      url: Schema.String,
    })
  ),
  unavailable: Schema.Number,
});
const imported = Schema.decodeUnknownSync(Imported);
const setUrls = Schema.decodeUnknownSync(
  Schema.Struct({ sets: Schema.Array(Schema.Struct({ url: Schema.String })) })
);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

const lane = async (
  youTube: ReturnType<typeof fakeYouTube>,
  youTubeApiKey: string | null = "test-key"
) => {
  const root = await mkdtemp(path.join(tmpdir(), "orbis-playlist-import-"));
  roots.push(root);
  return createTestApp({
    // Downloads are queued but never run, so the 20-Download cap is reached and held.
    audio: {
      audioDir: path.join(root, "audio"),
      cobaltApiKey: "test",
      cobaltUrl: "http://127.0.0.1:9",
      startWorker: false,
    },
    databasePath: path.join(root, "library.sqlite"),
    logging: { silent: true },
    metadata: Metadata.layer({
      fetch: youTube.fetch,
      youTubeApiKey: youTubeApiKey ?? undefined,
    }),
  });
};

const record = async <Result>(name: string, result: Result) => {
  await mkdir(evidence, { recursive: true });
  await writeFile(
    path.join(evidence, `${name}.json`),
    JSON.stringify({ failures, ...result }, null, 2)
  );
};

const importPlaylist = (app: ReturnType<typeof createTestApp>, url: string) =>
  request(app, { method: "POST", payload: { url }, url: "/playlists/import" });

test("a YouTube Music playlist becomes an ordered Playlist of saved Sets", async () => {
  // 60 entries span two Data API pages and two video batches. One video is listed
  // twice, two are gone, and the third is already in the Library.
  const entries = Array.from({ length: 58 }, (_, n) => videoId(n));
  entries.splice(10, 0, videoId(4));
  entries.push(videoId(900), videoId(901));
  const youTube = fakeYouTube({
    PLmix: {
      entries,
      gone: new Set([videoId(900), videoId(901)]),
      title: "Late Night Drive",
    },
  });
  const app = await lane(youTube);
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

    const response = await importPlaylist(
      app,
      "https://music.youtube.com/playlist?list=PLmix"
    );
    expect(response.statusCode).toBe(201);
    const body = imported(response.json());
    const expected = Array.from(
      { length: 58 },
      (_, n) => `https://www.youtube.com/watch?v=${videoId(n)}`
    );
    expect(body.sets.map((set) => set.url)).toEqual(expected);
    expect(body).toMatchObject({
      overLimit: 0,
      playlist: { name: "Late Night Drive", setCount: 58 },
      unavailable: 2,
    });
    expect(body.sets[2]?.title).toBe("My own name");
    expect(body.sets[0]).toMatchObject({
      artworkLargeUrl: `https://i.ytimg.com/vi/${videoId(0)}/maxres.jpg`,
      artworkUrl: `https://i.ytimg.com/vi/${videoId(0)}/medium.jpg`,
      creator: `Artist ${videoId(0)}`,
      durationSeconds: 205,
      metadataState: "enriched",
      title: `Track ${videoId(0)}`,
    });
    // The Set saved by hand took one Download place before the import began.
    expect(body.sets[2]?.autoDownloadResult).toBe("inProgress");
    const autoDownload = new Map<string, number>();
    for (const { autoDownloadResult } of body.sets) {
      autoDownload.set(
        autoDownloadResult,
        (autoDownload.get(autoDownloadResult) ?? 0) + 1
      );
    }
    expect(Object.fromEntries(autoDownload)).toEqual({
      inProgress: 1,
      queueFull: 38,
      queued: 19,
    });
    expect(youTube.calls).toEqual([
      "playlists",
      "playlistItems",
      "playlistItems",
      "videos",
      "videos",
    ]);

    const library = await request(app, { method: "GET", url: "/sets" });
    const saved = setUrls(library.json()).sets.map((set) => set.url);
    expect(saved).toHaveLength(58);
    expect(new Set(saved)).toEqual(new Set(expected));

    const playlist = await request(app, {
      method: "GET",
      url: `/playlists/${body.playlist.id}`,
    });
    expect(setUrls(playlist.json()).sets.map((set) => set.url)).toEqual(
      expected
    );

    const again = await importPlaylist(
      app,
      `https://www.youtube.com/watch?v=${videoId(0)}&list=PLmix`
    );
    expect(again.statusCode).toBe(201);
    const second = imported(again.json());
    expect(second.playlist.name).toBe("Late Night Drive (2)");
    expect(second.sets.map((set) => set.id)).toEqual(
      body.sets.map((set) => set.id)
    );
    await record("ordered-import", {
      autoDownload: Object.fromEntries(autoDownload),
      dataApiCalls: youTube.calls,
      firstSet: body.sets[0],
      playlist: body.playlist,
      reimportedAs: second.playlist.name,
      unavailable: body.unavailable,
    });
  } finally {
    await app.dispose();
  }
}, 30_000);

test("a playlist over the Playlist maximum keeps its first 500 tracks", async () => {
  const youTube = fakeYouTube({
    PLlong: {
      entries: Array.from({ length: 530 }, (_, n) => videoId(n)),
      title: "Everything",
    },
  });
  const app = await lane(youTube);
  try {
    const response = await importPlaylist(
      app,
      "https://music.youtube.com/playlist?list=PLlong"
    );
    expect(response.statusCode).toBe(201);
    const body = imported(response.json());
    expect(body.sets).toHaveLength(500);
    expect(body.sets.at(-1)?.url).toBe(
      `https://www.youtube.com/watch?v=${videoId(499)}`
    );
    expect(body.overLimit).toBe(30);
    expect(body.playlist.setCount).toBe(500);
    await record("over-limit", {
      overLimit: body.overLimit,
      pages: youTube.calls.filter((call) => call === "playlistItems").length,
      saved: body.sets.length,
    });
  } finally {
    await app.dispose();
  }
}, 60_000);

test("links and playlists that can't be imported say why and create nothing", async () => {
  const youTube = fakeYouTube({});
  const app = await lane(youTube);
  const unconfigured = await lane(fakeYouTube({}), null);
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
    const noKey = await importPlaylist(
      unconfigured,
      "https://music.youtube.com/playlist?list=PLmix"
    );
    expect(video.statusCode).toBe(400);
    expect(soundCloud.statusCode).toBe(400);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({
      message:
        "YouTube can't share this playlist. Only public and unlisted playlists can be imported.",
    });
    expect(noKey.statusCode).toBe(503);
    expect(noKey.json()).toEqual({
      message: "Playlist import is not set up on this server.",
    });
    const playlists = await request(app, { method: "GET", url: "/playlists" });
    expect(playlists.json()).toEqual({ playlists: [] });
    await record("refusals", {
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
