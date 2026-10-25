import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { hashToken } from "./identity.js";
import { Metadata } from "./metadata.js";
import { createTestApp as createApp } from "./test-app.js";
import { request } from "./test-http.js";
import { Versos } from "./versos.js";

const evidence = path.resolve(import.meta.dir, "../../../.cache/apple-music");
const failures = [
  "a storefront or song link saves a second Set for the same album",
  "the read asks Apple without a token signed by the Host's MusicKit key",
  "a music video in the album becomes a Cue",
  "Cue start times drift from the sum of the song lengths",
  "Versos, yt-dlp, or the title reviser is asked about an Apple Music Set",
  "a Download or Auto Download is queued for DRM audio",
  "the Listening Queue refuses a mix because it has no Retained Audio",
  "a refused or timed-out read fails the save instead of keeping a temporary title",
  "a metadata or Tracklist retry does not read the album again",
  "removing and saving the mix again loses its Tracklist",
  "a Group without the key calls Apple at all",
];

const record = async <Result>(name: string, result: Result) => {
  await mkdir(evidence, { recursive: true });
  await writeFile(
    path.join(evidence, `${name}.json`),
    JSON.stringify({ failures, ...result }, null, 2)
  );
};

/**
 * Shaped from Apple's documented `albums/{id}?include=tracks` response, with one music video
 * among the songs. Not a recorded response: the container that wrote it cannot reach Apple.
 */
const ALBUM_RESPONSE: unknown = JSON.parse(
  await readFile(new URL("fixtures/apple-music-album.json", import.meta.url), {
    encoding: "utf-8",
  })
);

const ALBUM_URL = "https://music.apple.com/album/1700000000";
const ARTWORK =
  "https://is1-ssl.mzstatic.com/image/thumb/Music/example/{w}x{h}bb.jpg";

const EXPECTED_CUES = [
  {
    appleMusicId: "1700000001",
    artist: "First Artist",
    artworkUrl: ARTWORK.replace("{w}x{h}", "300x300"),
    position: 0,
    startSeconds: 0,
    title: "Opening (Mixed)",
  },
  {
    appleMusicId: "1700000002",
    artist: "Second Artist",
    artworkUrl: null,
    position: 1,
    startSeconds: 242,
    title: "Middle (Mixed)",
  },
  {
    appleMusicId: "1700000003",
    artist: "Third Artist",
    artworkUrl: null,
    position: 2,
    startSeconds: 542,
    title: "Closing (Mixed)",
  },
];

const pem = (der: ArrayBuffer) =>
  `-----BEGIN PRIVATE KEY-----\n${btoa(
    String.fromCodePoint(...new Uint8Array(der))
  )}\n-----END PRIVATE KEY-----\n`;

const fromBase64Url = (value: string) =>
  Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.codePointAt(0) ?? 0
  );

/** A MusicKit-shaped key made for this run, and a check that a token was signed with it. */
const musicKitKey = async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const privateKey = pem(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey)
  );
  const verify = async (token: string) => {
    const [header = "", payload = "", signature = ""] = token.split(".");
    const valid = await crypto.subtle.verify(
      { hash: "SHA-256", name: "ECDSA" },
      pair.publicKey,
      fromBase64Url(signature),
      new TextEncoder().encode(`${header}.${payload}`)
    );
    return {
      claims: JSON.parse(new TextDecoder().decode(fromBase64Url(payload))),
      header: JSON.parse(new TextDecoder().decode(fromBase64Url(header))),
      valid,
    };
  };
  return { privateKey, verify };
};

type AppleAnswer = "album" | "refuse" | "hang";

const start = async (options: { configured?: boolean } = {}) => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-apple-music-"));
  const key = await musicKitKey();
  const asked: string[] = [];
  const reads: { readonly token: string | undefined; readonly url: string }[] =
    [];
  let answer: AppleAnswer = "album";
  const devicesPath = path.join(directory, "devices.json");
  const friendToken = "apple-music-friend-token";
  await writeFile(
    devicesPath,
    JSON.stringify({
      keys: [
        {
          addedAt: "2026-01-01T00:00:00.000Z",
          id: "friend",
          label: "friend",
          lastUsedAt: null,
          personId: "friend",
          scope: "daily",
          tokenHash: hashToken(friendToken),
        },
      ],
      people: [
        { id: "host", removed: false, username: "host" },
        { id: "friend", removed: false, username: "friend" },
      ],
      version: 2,
    })
  );
  const app = createApp({
    databasePath: path.join(directory, "library.sqlite"),
    devicesPath,
    metadata: Metadata.layer({
      appleMusic:
        options.configured === false
          ? undefined
          : {
              keyId: "TESTKEY123",
              privateKey: key.privateKey,
              teamId: "TEAM123",
            },
      fetch: (url, signal, headers) => {
        reads.push({ token: headers?.authorization, url });
        if (answer === "refuse") {
          return Promise.resolve(new Response("{}", { status: 404 }));
        }
        if (answer === "hang") {
          const silence = Promise.withResolvers<Response>();
          signal.addEventListener("abort", () => silence.reject(signal.reason));
          return silence.promise;
        }
        return Promise.resolve(Response.json(ALBUM_RESPONSE));
      },
      ytDlp: {
        read: () => {
          asked.push("yt-dlp");
          return Effect.die("yt-dlp is not asked about Apple Music Sets");
        },
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
    answer: (next: AppleAnswer) => {
      answer = next;
    },
    app,
    asked,
    dispose: async () => {
      await app.dispose();
      await rm(directory, { force: true, recursive: true });
    },
    friend: { authorization: `Bearer ${friendToken}` },
    reads,
    verify: key.verify,
  };
};

test("an Apple Music album link saves once, read from Apple with the Host's key, with its songs as the Tracklist", async () => {
  const server = await start();
  try {
    const saved = await request(server.app, {
      method: "POST",
      payload: {
        url: "https://music.apple.com/gb/album/example-sessions-dj-mix/1700000000?i=1700000002",
      },
      url: "/sets",
    });
    expect(saved.statusCode).toBe(201);
    const set = saved.json();
    expect(set).toMatchObject({
      artworkLargeUrl: ARTWORK.replace("{w}x{h}", "1200x1200"),
      artworkUrl: ARTWORK.replace("{w}x{h}", "300x300"),
      autoDownloadResult: "unavailable",
      creator: "Example DJ",
      downloadState: "none",
      durationSeconds: 722,
      metadataState: "enriched",
      releasedAt: "2026-05-01",
      source: "apple-music",
      title: "Example Sessions (DJ Mix)",
      titleEditedByUser: false,
      tracklistState: "ready",
      url: ALBUM_URL,
    });
    const id = String(set.id);

    expect(server.reads.map((read) => read.url)).toEqual([
      "https://api.music.apple.com/v1/catalog/us/albums/1700000000?include=tracks",
    ]);
    const [read] = server.reads;
    const token = await server.verify(
      read?.token?.replace("Bearer ", "") ?? ""
    );
    expect(token.valid).toBe(true);
    expect(token.header).toEqual({ alg: "ES256", kid: "TESTKEY123" });
    expect(token.claims.iss).toBe("TEAM123");
    expect(token.claims.exp - token.claims.iat).toBe(3600);

    const tracklist = await request(server.app, {
      method: "GET",
      url: `/sets/${id}/tracklist`,
    });
    expect(tracklist.json()).toEqual({ cues: EXPECTED_CUES, state: "ready" });

    const again = await request(server.app, {
      method: "POST",
      payload: { url: "https://music.apple.com/us/album/1700000000" },
      url: "/sets",
    });
    expect(again.statusCode).toBe(409);

    const friend = await request(server.app, {
      headers: server.friend,
      method: "POST",
      payload: { url: "https://music.apple.com/album/example/1700000000" },
      url: "/sets",
    });
    expect(friend.statusCode).toBe(201);
    expect(friend.json()).toMatchObject({ id, tracklistState: "ready" });
    expect(server.reads).toHaveLength(1);

    const download = await request(server.app, {
      method: "POST",
      url: `/sets/${id}/audio/download`,
    });
    expect(download.statusCode).toBe(400);
    expect(download.json().message).toBe(
      "Apple Music audio plays through Apple Music and is never downloaded."
    );

    const queued = await request(server.app, {
      method: "PUT",
      payload: { setId: id },
      url: "/queue/active",
    });
    expect(queued.statusCode).toBe(200);
    expect(queued.json().queue.activeSetId).toBe(id);

    const filtered = await request(server.app, {
      method: "GET",
      url: "/sets?source=apple-music",
    });
    expect(
      filtered.json().sets.map((entry: { id: string }) => entry.id)
    ).toEqual([id]);

    const finished = await request(server.app, {
      method: "POST",
      payload: { setId: id },
      url: "/queue/completion",
    });
    expect(finished.json().queue.entries).toEqual([]);
    const removed = await request(server.app, {
      method: "DELETE",
      url: `/sets/${id}`,
    });
    expect(removed.statusCode).toBe(200);
    const friendRemoved = await request(server.app, {
      headers: server.friend,
      method: "DELETE",
      url: `/sets/${id}`,
    });
    expect(friendRemoved.statusCode).toBe(200);
    const resaved = await request(server.app, {
      method: "POST",
      payload: { url: ALBUM_URL },
      url: "/sets",
    });
    expect(resaved.statusCode).toBe(201);
    expect(resaved.json()).toMatchObject({ id, tracklistState: "ready" });
    // The last saver's removal let the Cues go, so the save read the album again.
    expect(server.reads).toHaveLength(2);
    const restored = await request(server.app, {
      method: "GET",
      url: `/sets/${id}/tracklist`,
    });
    expect(restored.json()).toEqual({ cues: EXPECTED_CUES, state: "ready" });

    expect(server.asked).toEqual([]);
    await record("save-read-and-play-rules", {
      appleReads: server.reads.map((entry) => entry.url),
      download: download.json(),
      saved: set,
      tokenClaims: token.claims,
      tracklist: tracklist.json(),
    });
  } finally {
    await server.dispose();
  }
});

test("a refused or silent Apple Music read keeps the save, and a retry reads the album again", async () => {
  const server = await start();
  try {
    server.answer("refuse");
    const refused = await request(server.app, {
      method: "POST",
      payload: { url: ALBUM_URL },
      url: "/sets",
    });
    expect(refused.statusCode).toBe(201);
    expect(refused.json()).toMatchObject({
      metadataState: "failed",
      title: "Apple Music mix",
      tracklistState: "pending",
    });
    const id = String(refused.json().id);

    server.answer("hang");
    const silent = await request(server.app, {
      method: "POST",
      url: `/sets/${id}/metadata`,
    });
    expect(silent.statusCode).toBe(200);
    expect(silent.json()).toMatchObject({
      metadataState: "failed",
      title: "Apple Music mix",
    });

    server.answer("album");
    const retried = await request(server.app, {
      method: "POST",
      url: `/sets/${id}/tracklist/retry`,
    });
    expect(retried.json()).toEqual({ cues: EXPECTED_CUES, state: "ready" });
    const library = await request(server.app, { method: "GET", url: "/sets" });
    expect(library.json().sets[0]).toMatchObject({
      metadataState: "enriched",
      title: "Example Sessions (DJ Mix)",
    });
    expect(server.reads).toHaveLength(3);
    expect(server.asked).toEqual([]);
    await record("failed-read-and-retry", {
      afterRetry: library.json().sets[0],
      refused: refused.json(),
    });
  } finally {
    await server.dispose();
  }
});

test("a Group without the MusicKit key saves the Set with failed metadata and never calls Apple", async () => {
  const server = await start({ configured: false });
  try {
    const saved = await request(server.app, {
      method: "POST",
      payload: { url: ALBUM_URL },
      url: "/sets",
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({
      metadataState: "failed",
      source: "apple-music",
      title: "Apple Music mix",
    });
    expect(server.reads).toEqual([]);
    expect(server.asked).toEqual([]);
  } finally {
    await server.dispose();
  }
});
