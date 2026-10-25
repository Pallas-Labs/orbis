import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SOURCE_URL_MESSAGE } from "@orbis/contracts";
import { REJECTED_SOURCE_URLS } from "@orbis/contracts/source-url-cases";
import { Effect } from "effect";

import { hashToken } from "./identity.js";
import { Metadata } from "./metadata.js";
import { createTestApp as createApp } from "./test-app.js";
import { request } from "./test-http.js";
import { messageIn, setsInLibrary } from "./test-library.js";
import { Versos } from "./versos.js";

const evidence = path.resolve(import.meta.dir, "../../../.cache/apple-music");
const failures = [
  "a storefront or song link saves a second Set for the same album",
  "a playlist, artist, station, or bare song link is saved, or asks Apple",
  "the read asks a storefront other than us, or asks without a token signed by the Host's MusicKit key",
  "an album missing from the US catalog makes a Set",
  "a music video in the album becomes a Cue",
  "Cue start times drift from the sum of the song lengths",
  "Versos, yt-dlp, or the title reviser is asked about an Apple Music Set",
  "a Download or Auto Download is queued for DRM audio, or the audio node claims one",
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

interface Recording {
  readonly body: {
    readonly data?: {
      readonly relationships: { readonly tracks: { readonly data: unknown[] } };
    }[];
  };
  readonly status: number;
  readonly url: string;
}

/** Apple's answers as `bun run record:apple-music` recorded them with the Host's MusicKit key. */
const recordingsDirectory = new URL("fixtures/apple-music/", import.meta.url);
const recordingNames = await readdir(recordingsDirectory);
const recordings = new Map(
  await Promise.all(
    recordingNames.map(async (name) => {
      const recording: Recording = JSON.parse(
        await readFile(new URL(name, recordingsDirectory), "utf-8")
      );
      return [recording.url, recording] as const;
    })
  )
);

const ALBUM_URL = "https://music.apple.com/album/1046502556";
const ALBUM_READ =
  "https://api.music.apple.com/v1/catalog/us/albums/1046502556?include=tracks";
const NOT_IN_US_READ =
  "https://api.music.apple.com/v1/catalog/us/albums/1016775152?include=tracks";
const ARTWORK =
  "https://is1-ssl.mzstatic.com/image/thumb/Music6/v4/cf/da/f3/cfdaf3eb-1944-e868-1feb-cedeef541eb6/0730003732423_1448.jpg/{w}x{h}bb.jpg";

/** Start times are the song lengths before each song, summed unrounded, then rounded. */
const EXPECTED_CUES = (
  [
    ["1046502558", 0, "Would It Be (Mixed)", "Niki Nakazawa"],
    [
      "1046502562",
      181,
      "Suddenly (Phil Parnell's Pianissimo Play Through) [Mixed]",
      "Matthew Herbert",
    ],
    ["1046502567", 375, "Bodenweich (Mixed)", "DJ Koze"],
    ["1046502568", 610, "Northern Lights (Mixed)", "Cobblestone Jazz"],
    [
      "1046502569",
      1042,
      "Melodia Del Viento (Ricardo Villalobos & Max Loderbauer Meloopdia Remix) [Mixed]",
      "Wolfgang Haffner",
    ],
    [
      "1046502844",
      1283,
      "De Natte Cel (DJ-Kicks) [Mixed]",
      "Seth Troxler, Tom Trago & T&T Music Factory",
    ],
    ["1046502893", 1631, "XK (Mixed)", "Hauke Freer"],
    ["1046502897", 1913, "Dope (Mixed)", "Butch"],
    ["1046502898", 2262, "Stick Together (Mixed)", "Session Victim"],
    [
      "1046502899",
      2517,
      'Sweet Chariot (Kerri "Kaoz 6:23" Chandler Dramatic Dub) [Mixed]',
      "Club Artists United",
    ],
    [
      "1046502900",
      2771,
      "Reach (Basement Sessions Main Vocal Mix) [Mixed]",
      "Jasper St Company",
    ],
    ["1046502902", 3128, "Sex-N-R-001 (Vocal Mixx) [Mixed]", "K-Alexi"],
    ["1046502903", 3267, "Ohh (Mixed) [feat. John Ciafone]", "Mood II Swing"],
    ["1046502904", 3554, "Dreaming Again (Mixed)", "Derrick L. Carter"],
    [
      "1046502965",
      3888,
      "Why Can't You Be Real (Danny's 12\" Version) [Mixed]",
      "Byron Stingily",
    ],
    ["1046502966", 4110, "Stay With Me (Kevin O Remix)", "Vanessa McMillian"],
    [
      "1046502967",
      4395,
      "The Credit Card (Original Tribe Mix) [feat. Sweet P***y Pauline]",
      "Dean Street Crew",
    ],
    [
      "1046502968",
      4642,
      "Enlightenment (Mixed)",
      "Sun Ra & Sun Ra and His Arkestra",
    ],
  ] as const
).map(([appleMusicId, startSeconds, title, artist], position) => ({
  appleMusicId,
  artist,
  artworkUrl: ARTWORK.replace("{w}x{h}", "300x300"),
  position,
  startSeconds,
  title,
}));

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

/** A music video placed second in the recorded album, as Apple lists one among the songs. */
const withMusicVideo = (recording: Recording) => {
  const body = structuredClone(recording.body);
  body.data?.[0]?.relationships.tracks.data.splice(1, 0, {
    attributes: {
      artistName: "Seth Troxler",
      durationInMillis: 200_000,
      name: "DJ-Kicks (Video)",
    },
    id: "1046509999",
    type: "music-videos",
  });
  return body;
};

type AppleAnswer = "recorded" | "music-video" | "refuse" | "hang";

const start = async (options: { configured?: boolean } = {}) => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-apple-music-"));
  const key = await musicKitKey();
  const asked: string[] = [];
  const reads: { readonly token: string | undefined; readonly url: string }[] =
    [];
  let answer: AppleAnswer = "recorded";
  let downloadJobs = 0;
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
    audio: {
      audioDir: path.join(directory, "audio"),
      cobaltApiKey: "test",
      cobaltUrl: "http://cobalt.test/",
      fetch: () => {
        downloadJobs += 1;
        return Promise.resolve(new Response(null, { status: 500 }));
      },
      startWorker: true,
    },
    databasePath: path.join(directory, "library.sqlite"),
    devicesPath,
    logging: { silent: true },
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
          return Promise.resolve(new Response("{}", { status: 401 }));
        }
        if (answer === "hang") {
          const silence = Promise.withResolvers<Response>();
          signal.addEventListener("abort", () => silence.reject(signal.reason));
          return silence.promise;
        }
        const recording = recordings.get(url);
        if (!recording) {
          return Promise.reject(
            new Error(`No recorded Apple Music answer for ${url}`)
          );
        }
        return Promise.resolve(
          Response.json(
            answer === "music-video"
              ? withMusicVideo(recording)
              : recording.body,
            { status: recording.status }
          )
        );
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
    downloadJobs: () => downloadJobs,
    friend: { authorization: `Bearer ${friendToken}` },
    reads,
    verify: key.verify,
  };
};

test("an Apple Music album link saves once, read from the US catalog with the Host's key, with its songs as the Tracklist", async () => {
  const server = await start();
  try {
    const autoDownload = await request(server.app, {
      method: "PATCH",
      payload: { autoDownload: true },
      url: "/me",
    });
    expect(autoDownload.statusCode).toBe(200);

    const refusedLinks = REJECTED_SOURCE_URLS.filter((url) =>
      url.startsWith("https://music.apple.com/")
    );
    expect(refusedLinks.some((url) => url.includes("/playlist/"))).toBe(true);
    expect(refusedLinks.some((url) => url.includes("/artist/"))).toBe(true);
    expect(refusedLinks.some((url) => url.includes("/station/"))).toBe(true);
    expect(refusedLinks.some((url) => url.includes("/song/"))).toBe(true);
    for (const url of refusedLinks) {
      // oxlint-disable-next-line no-await-in-loop -- Each refusal is one save, in order.
      const refused = await request(server.app, {
        method: "POST",
        payload: { url },
        url: "/sets",
      });
      expect(refused.statusCode).toBe(400);
      expect(messageIn(refused)).toBe(SOURCE_URL_MESSAGE);
    }
    expect(server.reads).toEqual([]);

    const saved = await request(server.app, {
      method: "POST",
      payload: {
        url: "https://music.apple.com/gb/album/dj-kicks-dj-mix/1046502556?i=1046502562",
      },
      url: "/sets",
    });
    expect(saved.statusCode).toBe(201);
    const set = saved.json();
    expect(set).toMatchObject({
      artworkLargeUrl: ARTWORK.replace("{w}x{h}", "1200x1200"),
      artworkUrl: ARTWORK.replace("{w}x{h}", "300x300"),
      autoDownloadResult: "unavailable",
      creator: "Seth Troxler",
      downloadState: "none",
      durationSeconds: 4778,
      metadataState: "enriched",
      releasedAt: "2015-10-16",
      source: "apple-music",
      title: "DJ-Kicks (DJ Mix)",
      titleEditedByUser: false,
      tracklistState: "ready",
      url: ALBUM_URL,
    });
    const id = String(set.id);

    expect(server.reads.map((read) => read.url)).toEqual([ALBUM_READ]);
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
      payload: { url: "https://music.apple.com/us/album/1046502556" },
      url: "/sets",
    });
    expect(again.statusCode).toBe(409);

    const friend = await request(server.app, {
      headers: server.friend,
      method: "POST",
      payload: { url: "https://music.apple.com/album/dj-kicks/1046502556" },
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
    expect(messageIn(download)).toBe(
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

    const audio = await request(server.app, {
      method: "GET",
      url: `/sets/${id}/audio/state`,
    });
    expect(audio.json().state).toBe("none");
    expect(server.downloadJobs()).toBe(0);
    expect(server.asked).toEqual([]);
    await record("save-read-and-play-rules", {
      appleReads: server.reads.map((entry) => entry.url),
      download: download.json(),
      downloadJobs: server.downloadJobs(),
      refusedLinks,
      saved: set,
      tokenClaims: token.claims,
      tracklist: tracklist.json(),
    });
  } finally {
    await server.dispose();
  }
});

test("an album missing from the US catalog is refused and makes no Set", async () => {
  const server = await start();
  try {
    const link =
      "https://music.apple.com/jp/album/exit-trance-01-mixed-by-dj-uto/1016775152";
    const refused = await request(server.app, {
      method: "POST",
      payload: { url: link },
      url: "/sets",
    });
    expect(refused.statusCode).toBe(400);
    expect(messageIn(refused)).toBe(
      "This album is not in the US Apple Music catalog."
    );
    const library = await setsInLibrary(server.app);
    expect(library).toEqual([]);
    const friendLibrary = await request(server.app, {
      headers: server.friend,
      method: "GET",
      url: "/sets",
    });
    expect(friendLibrary.json().sets).toEqual([]);

    // No Set holds the refusal, so a later save asks Apple again.
    const again = await request(server.app, {
      headers: server.friend,
      method: "POST",
      payload: { url: link },
      url: "/sets",
    });
    expect(again.statusCode).toBe(400);
    expect(server.reads.map((read) => read.url)).toEqual([
      NOT_IN_US_READ,
      NOT_IN_US_READ,
    ]);
    await record("not-in-us-catalog", {
      appleAnswer: recordings.get(NOT_IN_US_READ),
      library,
      refused: refused.json(),
    });
  } finally {
    await server.dispose();
  }
});

test("a music video in the album is not a Cue and adds nothing to the length", async () => {
  const server = await start();
  try {
    server.answer("music-video");
    const saved = await request(server.app, {
      method: "POST",
      payload: { url: ALBUM_URL },
      url: "/sets",
    });
    expect(saved.json()).toMatchObject({
      durationSeconds: 4778,
      tracklistState: "ready",
    });
    const tracklist = await request(server.app, {
      method: "GET",
      url: `/sets/${String(saved.json().id)}/tracklist`,
    });
    expect(tracklist.json()).toEqual({ cues: EXPECTED_CUES, state: "ready" });
  } finally {
    await server.dispose();
  }
});

test("a refused or silent Apple Music read keeps the save, and both retries read the album again", async () => {
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

    server.answer("recorded");
    const retried = await request(server.app, {
      method: "POST",
      url: `/sets/${id}/tracklist/retry`,
    });
    expect(retried.json()).toEqual({ cues: EXPECTED_CUES, state: "ready" });
    const [afterRetry] = await setsInLibrary(server.app);
    expect(afterRetry).toMatchObject({
      metadataState: "enriched",
      title: "DJ-Kicks (DJ Mix)",
    });

    const metadataRetry = await request(server.app, {
      method: "POST",
      url: `/sets/${id}/metadata`,
    });
    expect(metadataRetry.json()).toMatchObject({
      metadataState: "enriched",
      title: "DJ-Kicks (DJ Mix)",
      tracklistState: "ready",
    });
    expect(server.reads.map((read) => read.url)).toEqual([
      ALBUM_READ,
      ALBUM_READ,
      ALBUM_READ,
      ALBUM_READ,
    ]);
    expect(server.asked).toEqual([]);
    await record("failed-read-and-retry", {
      afterRetry,
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
