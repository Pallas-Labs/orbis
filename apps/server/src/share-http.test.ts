import { Database as SqliteDatabase } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";

import { Effect } from "effect";
import type { WideEvent } from "evlog";

import { createApp } from "./app.js";
import { hashToken } from "./identity.js";
import { Metadata } from "./metadata.js";
import { runInOrder, runTimesInOrder } from "./test-http.js";

const HOST_TOKEN = "share-host-key";
const FRIEND_TOKEN = "share-friend-key";
const FRIEND_ID = "friend-7f3c";
const ORIGIN = "http://127.0.0.1:4310";
const SOURCE_LINK = "https://www.youtube.com/watch?v=goodArtwork";
const PROVIDER_TITLE = "Peggy Gou & Friends | Boiler Room Seoul";
const CREATOR = "Boiler Room";
/** Everything a Library holds about the Set beyond its shared facts. */
const PRIVATE = {
  override: "Kept for the drive to Busan",
  playlist: "Sunday Drive Rotation",
  tags: ["warmup-pick", "rooftop"],
  usernames: ["marguerite", "theodora"],
};
const ARTWORK = await Bun.file(
  path.join(import.meta.dir, "fixtures/share-artwork.jpg")
).bytes();

/**
 * Serves Artwork by the video id in its path: `goodArtwork` and each id in `recovered`
 * answer with a JPEG and the others fail the ways a provider's image host can.
 */
const startArtworkHost = (recovered: ReadonlySet<string> = new Set()) =>
  Bun.serve({
    async fetch(request) {
      const [, video = ""] = new URL(request.url).pathname.split("/");
      if (video === "goodArtwork" || recovered.has(video)) {
        return new Response(ARTWORK, {
          headers: { "content-type": "image/jpeg" },
        });
      }
      if (video === "slowArtwork") {
        await Bun.sleep(10_000);
        return new Response(ARTWORK);
      }
      if (video === "hugeArtwork") {
        const huge = new Uint8Array(5 * 1024 * 1024);
        huge.set(ARTWORK);
        return new Response(huge);
      }
      if (video === "corruptJpeg") {
        return new Response(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3));
      }
      return new Response("missing", { status: 404 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });

const metaContent = (page: string, key: string) =>
  new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`, "u").exec(
    page
  )?.[1];

const startApp = async (artworkHost: string) => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-share-"));
  const devicesPath = path.join(directory, "devices.json");
  const databasePath = path.join(directory, "library.sqlite");
  await writeFile(
    devicesPath,
    JSON.stringify({
      keys: [
        ["host", HOST_TOKEN],
        [FRIEND_ID, FRIEND_TOKEN],
      ].map(([personId, token]) => ({
        addedAt: "2026-10-01T00:00:00.000Z",
        id: `${personId}-key`,
        label: "phone",
        lastUsedAt: null,
        personId,
        scope: "daily",
        tokenHash: hashToken(token ?? ""),
      })),
      people: [
        { id: "host", removed: false, username: PRIVATE.usernames[0] },
        { id: FRIEND_ID, removed: false, username: PRIVATE.usernames[1] },
      ],
      version: 2,
    })
  );
  const events: WideEvent[] = [];
  const app = createApp({
    databasePath,
    devicesPath,
    logging: {
      onEvent: (event) => {
        events.push(event);
      },
      silent: true,
    },
    metadata: Metadata.layerOf({
      enrich: ({ url }) => {
        const video = new URL(url).searchParams.get("v");
        return Effect.succeed({
          artworkLargeUrl:
            video === "localFileXX"
              ? "file:///etc/hostname"
              : `${artworkHost}/${video}/maxresdefault.jpg`,
          artworkUrl: `${artworkHost}/${video}/mqdefault.jpg`,
          creator: CREATOR,
          durationSeconds: 3600,
          releasedAt: null,
          title: PROVIDER_TITLE,
        });
      },
    }),
  });
  const call = async (
    token: string,
    method: string,
    url: string,
    payload?: Readonly<Record<string, string | readonly string[]>>
  ) => {
    const response = await app.handler(
      new Request(`${ORIGIN}${url}`, {
        body: payload === undefined ? null : JSON.stringify(payload),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method,
      }),
      "device",
      "198.51.100.7"
    );
    expect(response.status).toBeLessThan(300);
    return await response.json();
  };
  const open = (
    url: string,
    headers: Record<string, string> = {},
    method = "GET"
  ) =>
    app.handler(
      new Request(`${ORIGIN}${url}`, { headers, method }),
      "device",
      "198.51.100.7"
    );
  /** The Set's current preview image path, as its share page's og:image names it. */
  const imagePath = async (id: string) => {
    const response = await open(`/share/sets/${id}/page`);
    const page = await response.text();
    const image = metaContent(page, "og:image") ?? "";
    expect(image).toMatch(
      new RegExp(
        `^${ORIGIN}/share/sets/${id}/image\\.png\\?v=[0-9a-f]{16}$`,
        "u"
      )
    );
    return image.slice(ORIGIN.length);
  };
  /** How many image requests drew the image rather than reusing one. */
  const renders = () =>
    events.filter((event) =>
      Bun.deepMatch({ share: { image: "rendered" } }, event)
    ).length;
  return {
    call,
    databasePath,
    dispose: async () => {
      await app.dispose();
      await rm(directory, { force: true, recursive: true });
    },
    imagePath,
    open,
    renders,
  };
};

const paeth = (left: number, up: number, upLeft: number) => {
  const estimate = left + up - upLeft;
  const [toLeft = 0, toUp = 0, toUpLeft = 0] = [left, up, upLeft].map((value) =>
    Math.abs(estimate - value)
  );
  if (toLeft <= toUp && toLeft <= toUpLeft) {
    return left;
  }
  return toUp <= toUpLeft ? up : upLeft;
};

/** Width, height, and RGB pixels of an 8-bit RGB PNG with a single IDAT chunk. */
const readPng = (png: Uint8Array) => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect([...png.subarray(0, 8)]).toEqual([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  expect(new TextDecoder().decode(png.subarray(12, 16))).toBe("IHDR");
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  expect([png[24], png[25]]).toEqual([8, 2]);
  const raw = inflateSync(png.subarray(41, 41 + view.getUint32(33)));
  const stride = width * 3;
  const pixels = new Uint8Array(stride * height);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)];
    for (let index = 0; index < stride; index += 1) {
      const at = row * stride + index;
      const left = index >= 3 ? (pixels[at - 3] ?? 0) : 0;
      const up = row > 0 ? (pixels[at - stride] ?? 0) : 0;
      const upLeft = row > 0 && index >= 3 ? (pixels[at - stride - 3] ?? 0) : 0;
      const predicted = [
        0,
        left,
        up,
        Math.floor((left + up) / 2),
        paeth(left, up, upLeft),
      ][filter ?? 0];
      pixels[at] =
        ((raw[row * (stride + 1) + 1 + index] ?? 0) + (predicted ?? 0)) % 256;
    }
  }
  return { height, pixels, width };
};

test("an Orbis Link shows the Set's shared facts and nothing from any Library", async () => {
  const artworkHost = startArtworkHost();
  const server = await startApp(artworkHost.url.origin);
  try {
    const saved = await server.call(HOST_TOKEN, "POST", "/sets", {
      url: SOURCE_LINK,
    });
    const { id } = saved;
    await server.call(HOST_TOKEN, "PATCH", `/sets/${id}/title`, {
      title: PRIVATE.override,
    });
    await server.call(HOST_TOKEN, "PATCH", `/sets/${id}/tags`, {
      tags: PRIVATE.tags,
    });
    const playlist = await server.call(HOST_TOKEN, "POST", "/playlists", {
      name: PRIVATE.playlist,
    });
    await server.call(HOST_TOKEN, "PUT", `/playlists/${playlist.id}/sets`, {
      setIds: [id],
    });
    const friendSaved = await server.call(FRIEND_TOKEN, "POST", "/sets", {
      url: SOURCE_LINK,
    });
    expect(friendSaved.id).toBe(id);
    const sqlite = new SqliteDatabase(server.databasePath);
    sqlite
      .query(
        "UPDATE sets SET download_state = 'ready', retained_audio_format = 'm4a', retained_audio_bytes = 4096 WHERE id = ?"
      )
      .run(id);
    sqlite
      .query(
        "INSERT INTO listens (person_id, set_id, started_at, finished_at) VALUES (?, ?, '2026-10-02T00:00:00.000Z', '2026-10-02T01:00:00.000Z')"
      )
      .run(FRIEND_ID, id);
    sqlite.close();
    const hostView = await server.call(HOST_TOKEN, "GET", "/sets");
    expect(hostView.sets[0]).toMatchObject({
      tags: PRIVATE.tags,
      title: PRIVATE.override,
    });

    const json = await server.open(`/share/sets/${id}`);
    expect(json.status).toBe(200);
    const body = await json.text();
    expect(JSON.parse(body)).toEqual({
      artworkUrl: `${artworkHost.url.origin}/goodArtwork/maxresdefault.jpg`,
      creator: CREATOR,
      id,
      source: "youtube",
      title: PROVIDER_TITLE,
      url: SOURCE_LINK,
    });

    const pageResponse = await server.open(`/share/sets/${id}/page`);
    expect(pageResponse.status).toBe(200);
    expect(pageResponse.headers.get("content-type")).toBe(
      "text/html; charset=utf-8"
    );
    expect(pageResponse.headers.get("cache-control")).toBe(
      "public, max-age=3600"
    );
    expect(pageResponse.headers.get("content-security-policy")).toMatch(
      /default-src 'none'.*style-src 'sha256-[A-Za-z0-9+/=]+'/u
    );
    const page = await pageResponse.text();
    const escapedTitle = "Peggy Gou &amp; Friends | Boiler Room Seoul";
    expect(metaContent(page, "og:title")).toBe(escapedTitle);
    expect(metaContent(page, "twitter:title")).toBe(escapedTitle);
    expect(metaContent(page, "og:description")).toBe(CREATOR);
    expect(metaContent(page, "og:url")).toBe(`${ORIGIN}/s/${id}`);
    const image = `${ORIGIN}${await server.imagePath(id)}`;
    expect(metaContent(page, "og:image")).toBe(image);
    expect(metaContent(page, "twitter:image")).toBe(image);
    expect(metaContent(page, "og:image:width")).toBe("1200");
    expect(metaContent(page, "og:image:height")).toBe("630");
    expect(metaContent(page, "twitter:card")).toBe("summary_large_image");
    expect(page).toContain(`href="orbis://s/${id}">Open in Orbis</a>`);
    expect(page).toContain(
      `href="${SOURCE_LINK}" rel="noopener">Open on YouTube</a>`
    );
    expect(page).not.toContain("<script");
    expect(page).not.toContain(" style=");

    for (const secret of [
      PRIVATE.override,
      PRIVATE.playlist,
      ...PRIVATE.tags,
      ...PRIVATE.usernames,
      FRIEND_ID,
      "host",
      "download",
      "ready",
      "listen",
      "finish",
    ]) {
      expect({
        body: body.toLowerCase().includes(secret.toLowerCase()),
        secret,
      }).toEqual({
        body: false,
        secret,
      });
      expect({
        page: page.toLowerCase().includes(secret.toLowerCase()),
        secret,
      }).toEqual({
        page: false,
        secret,
      });
    }
  } finally {
    await server.dispose();
    await artworkHost.stop(true);
  }
});

test("an Orbis Link answers without a key, under any spelling the router accepts, and never counts as a failed key", async () => {
  const artworkHost = startArtworkHost();
  const server = await startApp(artworkHost.url.origin);
  try {
    const { id } = await server.call(HOST_TOKEN, "POST", "/sets", {
      url: SOURCE_LINK,
    });
    const spellings = [
      `/share/sets/${id}`,
      `/share/sets/${id}/`,
      `//share//sets/${id}`,
      `/SHARE/Sets/${id}`,
      `/share/%73ets/${id}`,
      `/share/sets/${id}/page/`,
      `/share/sets/${id}//PAGE`,
    ];
    const answers = await Promise.all(
      spellings.map(async (spelling) => {
        const response = await server.open(spelling);
        return [spelling, response.status] as const;
      })
    );
    expect(answers).toEqual(spellings.map((spelling) => [spelling, 200]));
    const unknown = crypto.randomUUID();
    const missing = await Promise.all(
      ["", "/page", "/image.png"].map(async (suffix) => {
        const response = await server.open(`/share/sets/${unknown}${suffix}`);
        return [suffix, response.status, await response.json()] as const;
      })
    );
    expect(missing).toEqual(
      ["", "/page", "/image.png"].map((suffix) => [
        suffix,
        404,
        { message: "Set not found." },
      ])
    );
    const attempts = await Promise.all(
      Array.from({ length: 30 }, () =>
        server.open(`/share/sets/${id}`, { authorization: "Bearer wrong" })
      )
    );
    expect(attempts.map((response) => response.status)).toEqual(
      Array.from({ length: 30 }, () => 200)
    );
    const guess = await server.open("/me", { authorization: "Bearer wrong" });
    expect(guess.status).toBe(401);
    const library = await server.open("/sets");
    expect(library.status).toBe(403);
    const write = await server.open(`/share/sets/${id}/../../sets`);
    expect(write.status).toBe(403);
  } finally {
    await server.dispose();
    await artworkHost.stop(true);
  }
});

test("the preview image is a 1200x630 PNG that draws the Artwork, and draws without it when the Artwork cannot load", async () => {
  const artworkHost = startArtworkHost();
  const server = await startApp(artworkHost.url.origin);
  try {
    const videos = [
      "goodArtwork",
      "brokenImage",
      "slowArtwork",
      "hugeArtwork",
      "corruptJpeg",
      "localFileXX",
    ];
    const ids: string[] = [];
    await runInOrder(videos, async (video) => {
      const saved = await server.call(HOST_TOKEN, "POST", "/sets", {
        url: `https://www.youtube.com/watch?v=${video}`,
      });
      ids.push(saved.id);
    });
    const images = await Promise.all(
      ids.map(async (id, index) => {
        const response = await server.open(await server.imagePath(id));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/png");
        // A preview drawn without its Artwork may only be a provider's passing failure,
        // so only the drawn one is kept for good.
        expect(response.headers.get("cache-control")).toBe(
          index === 0
            ? "public, max-age=31536000, immutable"
            : "public, max-age=3600"
        );
        return readPng(await response.bytes());
      })
    );
    for (const image of images) {
      expect([image.width, image.height]).toEqual([1200, 630]);
    }
    const [drawn, ...fallbacks] = images.map((image) =>
      Buffer.from(image.pixels).toString("base64")
    );
    // The slow host answers with good Artwork after 10 seconds, so it joins the fallbacks
    // only because the image stops waiting for it.
    expect(new Set(fallbacks).size).toBe(1);
    expect(fallbacks[0]).not.toBe(drawn);
  } finally {
    await server.dispose();
    await artworkHost.stop(true);
  }
});

test("the preview image draws once per Set content version, however often and however it is asked for", async () => {
  const artworkHost = startArtworkHost();
  const server = await startApp(artworkHost.url.origin);
  try {
    const { id } = await server.call(HOST_TOKEN, "POST", "/sets", {
      url: SOURCE_LINK,
    });
    const current = await server.imagePath(id);
    const unversioned = await server.open(`/share/sets/${id}/image.png`);
    const guessed = await server.open(
      `/share/sets/${id}/image.png?v=${crypto.randomUUID().slice(0, 16)}`
    );
    for (const stale of [unversioned, guessed]) {
      expect(stale.status).toBe(302);
      expect(stale.headers.get("location")).toBe(`${ORIGIN}${current}`);
      expect(stale.headers.get("cache-control")).toBe("no-store");
    }
    expect(server.renders()).toBe(0);

    const cold = await Promise.all(
      Array.from({ length: 5 }, () => server.open(current))
    );
    expect(cold.map((response) => response.status)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    const bodies = await Promise.all(cold.map((response) => response.bytes()));
    expect(
      new Set(bodies.map((body) => Buffer.from(body).toString("base64"))).size
    ).toBe(1);
    expect(cold[0]?.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(server.renders()).toBe(1);

    const head = await server.open(current, {}, "HEAD");
    expect(head.status).toBe(200);
    const again = await server.open(`${current}&x=1`);
    expect(again.status).toBe(200);
    expect(server.renders()).toBe(1);

    const sqlite = new SqliteDatabase(server.databasePath);
    sqlite
      .query("UPDATE sets SET title = ? WHERE id = ?")
      .run("Peggy Gou | Boiler Room Seoul (Extended)", id);
    sqlite.close();
    const retitled = await server.imagePath(id);
    expect(retitled).not.toBe(current);
    const old = await server.open(current);
    expect(old.status).toBe(302);
    expect(old.headers.get("location")).toBe(`${ORIGIN}${retitled}`);
    const fresh = await server.open(retitled);
    expect(fresh.status).toBe(200);
    expect(Buffer.from(await fresh.bytes()).toString("base64")).not.toBe(
      Buffer.from(bodies[0] ?? new Uint8Array()).toString("base64")
    );
    expect(server.renders()).toBe(2);

    const reart = new SqliteDatabase(server.databasePath);
    reart
      .query("UPDATE sets SET artwork_large_url = ? WHERE id = ?")
      .run(`${artworkHost.url.origin}/brokenImage/maxresdefault.jpg`, id);
    reart.close();
    const rearted = await server.imagePath(id);
    expect(rearted).not.toBe(retitled);
    const redrawn = await server.open(rearted);
    expect(redrawn.status).toBe(200);
    expect(server.renders()).toBe(3);
  } finally {
    await server.dispose();
    await artworkHost.stop(true);
  }
});

test("the preview image asks the Artwork host again for a version it drew without the Artwork", async () => {
  const recovered = new Set<string>();
  const artworkHost = startArtworkHost(recovered);
  const server = await startApp(artworkHost.url.origin);
  try {
    const { id } = await server.call(HOST_TOKEN, "POST", "/sets", {
      url: "https://www.youtube.com/watch?v=flakyArtwrk",
    });
    const current = await server.imagePath(id);
    const failed = await server.open(current);
    expect(failed.status).toBe(200);
    expect(failed.headers.get("cache-control")).toBe("public, max-age=3600");
    const without = Buffer.from(await failed.bytes()).toString("base64");
    expect(server.renders()).toBe(1);

    recovered.add("flakyArtwrk");
    expect(await server.imagePath(id)).toBe(current);
    const retried = await server.open(current);
    expect(retried.status).toBe(200);
    expect(retried.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(Buffer.from(await retried.bytes()).toString("base64")).not.toBe(
      without
    );
    expect(server.renders()).toBe(2);

    const kept = await server.open(current);
    expect(kept.status).toBe(200);
    expect(server.renders()).toBe(2);
  } finally {
    await server.dispose();
    await artworkHost.stop(true);
  }
});

test("the preview image of a Set with no Artwork draws once", async () => {
  const artworkHost = startArtworkHost();
  const server = await startApp(artworkHost.url.origin);
  try {
    const { id } = await server.call(HOST_TOKEN, "POST", "/sets", {
      url: SOURCE_LINK,
    });
    const sqlite = new SqliteDatabase(server.databasePath);
    sqlite
      .query(
        "UPDATE sets SET artwork_large_url = NULL, artwork_url = NULL WHERE id = ?"
      )
      .run(id);
    sqlite.close();
    const current = await server.imagePath(id);
    await runTimesInOrder(3, async () => {
      const response = await server.open(current);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable"
      );
    });
    expect(server.renders()).toBe(1);
  } finally {
    await server.dispose();
    await artworkHost.stop(true);
  }
});
