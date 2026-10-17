import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { Metadata } from "./metadata.js";
import { createTestApp as createApp } from "./test-app.js";
import { request } from "./test-http.js";
import { Versos } from "./versos.js";

const evidence = path.resolve(import.meta.dir, "../../../.cache/apple-music");
const failures = [
  "a storefront or song link saves a second Set for the same album",
  "a save without album details leaves a Set with no Tracklist",
  "Cue start times drift from the sum of the song lengths",
  "the service asks a provider or Versos about an Apple Music Set",
  "a Download or Auto Download is queued for DRM audio",
  "a metadata or Tracklist retry wipes the album the app sent",
  "removing and saving the mix again loses its Tracklist",
];

const record = async <Result>(name: string, result: Result) => {
  await mkdir(evidence, { recursive: true });
  await writeFile(
    path.join(evidence, `${name}.json`),
    JSON.stringify({ failures, ...result }, null, 2)
  );
};

const ALBUM = {
  artworkLargeUrl: "https://is1-ssl.mzstatic.com/image/1200x1200bb.jpg",
  artworkUrl: "https://is1-ssl.mzstatic.com/image/300x300bb.jpg",
  creator: "Example DJ",
  releasedAt: "2026-05-01",
  songs: [
    {
      appleMusicId: "1001",
      artist: "First Artist",
      artworkUrl: null,
      durationSeconds: 241.6,
      title: "Opening (Mixed)",
    },
    {
      appleMusicId: "1002",
      artist: "Second Artist",
      artworkUrl: "https://is1-ssl.mzstatic.com/image/song.jpg",
      durationSeconds: 300.2,
      title: "Middle (Mixed)",
    },
    {
      appleMusicId: "1003",
      artist: "Third Artist",
      artworkUrl: null,
      durationSeconds: 180,
      title: "Closing (Mixed)",
    },
  ],
  title: "Example DJ: DJ Mix",
};

const ALBUM_URL = "https://music.apple.com/album/1700000000";

const start = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-apple-music-"));
  const asked: string[] = [];
  const app = createApp({
    databasePath: path.join(directory, "library.sqlite"),
    metadata: Metadata.layerOf({
      details: () => {
        asked.push("details");
        return Effect.die("Apple Music Sets have no provider");
      },
      enrich: () => {
        asked.push("enrich");
        return Effect.die("Apple Music Sets have no provider");
      },
    }),
    versos: Versos.layerOf({
      poll: () => {
        asked.push("versos poll");
        return Effect.die("Versos is not asked about Apple Music Sets");
      },
      request: () => {
        asked.push("versos request");
        return Effect.die("Versos is not asked about Apple Music Sets");
      },
    }),
  });
  return {
    app,
    asked,
    dispose: async () => {
      await app.dispose();
      await rm(directory, { force: true, recursive: true });
    },
  };
};

test("an Apple Music album saves once as a Set whose songs are its Tracklist, and is never downloaded", async () => {
  const server = await start();
  try {
    const refused = await request(server.app, {
      method: "POST",
      payload: {
        url: "https://music.apple.com/us/album/example-dj-mix/1700000000",
      },
      url: "/sets",
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toBe(
      "Save Apple Music mixes from the Orbis app on an iPhone or Mac."
    );
    const empty = await request(server.app, { method: "GET", url: "/sets" });
    expect(empty.json().sets).toEqual([]);

    const saved = await request(server.app, {
      method: "POST",
      payload: {
        appleMusicAlbum: ALBUM,
        url: "https://music.apple.com/gb/album/example-dj-mix/1700000000?i=1002",
      },
      url: "/sets",
    });
    expect(saved.statusCode).toBe(201);
    const set = saved.json();
    expect(set).toMatchObject({
      artworkLargeUrl: ALBUM.artworkLargeUrl,
      artworkUrl: ALBUM.artworkUrl,
      autoDownloadResult: "unavailable",
      creator: "Example DJ",
      downloadState: "none",
      durationSeconds: 722,
      metadataState: "enriched",
      releasedAt: "2026-05-01",
      source: "apple-music",
      title: "Example DJ: DJ Mix",
      titleEditedByUser: false,
      tracklistState: "ready",
      url: ALBUM_URL,
    });
    const id = String(set.id);

    const expectedCues = [
      {
        appleMusicId: "1001",
        artist: "First Artist",
        artworkUrl: null,
        position: 0,
        startSeconds: 0,
        title: "Opening (Mixed)",
      },
      {
        appleMusicId: "1002",
        artist: "Second Artist",
        artworkUrl: "https://is1-ssl.mzstatic.com/image/song.jpg",
        position: 1,
        startSeconds: 242,
        title: "Middle (Mixed)",
      },
      {
        appleMusicId: "1003",
        artist: "Third Artist",
        artworkUrl: null,
        position: 2,
        startSeconds: 542,
        title: "Closing (Mixed)",
      },
    ];
    const tracklist = await request(server.app, {
      method: "GET",
      url: `/sets/${id}/tracklist`,
    });
    expect(tracklist.json()).toEqual({ cues: expectedCues, state: "ready" });

    const again = await request(server.app, {
      method: "POST",
      payload: {
        appleMusicAlbum: ALBUM,
        url: "https://music.apple.com/us/album/1700000000",
      },
      url: "/sets",
    });
    expect(again.statusCode).toBe(409);

    const download = await request(server.app, {
      method: "POST",
      url: `/sets/${id}/audio/download`,
    });
    expect(download.statusCode).toBe(400);
    expect(download.json().message).toBe(
      "Apple Music audio plays through Apple Music and is never downloaded."
    );

    const retriedMetadata = await request(server.app, {
      method: "POST",
      url: `/sets/${id}/metadata`,
    });
    expect(retriedMetadata.json()).toMatchObject({
      metadataState: "enriched",
      title: "Example DJ: DJ Mix",
    });
    const retriedTracklist = await request(server.app, {
      method: "POST",
      url: `/sets/${id}/tracklist/retry`,
    });
    expect(retriedTracklist.json()).toEqual({
      cues: expectedCues,
      state: "ready",
    });

    const removed = await request(server.app, {
      method: "DELETE",
      url: `/sets/${id}`,
    });
    expect(removed.statusCode).toBe(200);
    const resaved = await request(server.app, {
      method: "POST",
      payload: { appleMusicAlbum: ALBUM, url: ALBUM_URL },
      url: "/sets",
    });
    expect(resaved.statusCode).toBe(201);
    expect(resaved.json()).toMatchObject({ id, tracklistState: "ready" });
    const restored = await request(server.app, {
      method: "GET",
      url: `/sets/${id}/tracklist`,
    });
    expect(restored.json()).toEqual({ cues: expectedCues, state: "ready" });

    expect(server.asked).toEqual([]);
    await record("save-and-play-rules", {
      download: download.json(),
      refused: refused.json(),
      saved: set,
      tracklist: tracklist.json(),
    });
  } finally {
    await server.dispose();
  }
});
