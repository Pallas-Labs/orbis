import { Database as SqliteDatabase } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { createApp } from "./app.js";
import { hashToken } from "./identity.js";
import { Metadata } from "./metadata.js";

const HOST_TOKEN = "share-host-key";
const FRIEND_TOKEN = "share-friend-key";
const FRIEND_ID = "friend-7f3c";
const SOURCE_LINK = "https://www.youtube.com/watch?v=Zx9QpLm2Rt0";
const PROVIDER_TITLE = "Peggy Gou | Boiler Room Seoul";
const CREATOR = "Boiler Room";
const ARTWORK = "https://i.ytimg.com/vi/Zx9QpLm2Rt0/maxresdefault.jpg";
/** Everything a Library holds about the Set beyond its shared facts. */
const PRIVATE = {
  override: "Kept for the drive to Busan",
  playlist: "Sunday Drive Rotation",
  tags: ["warmup-pick", "rooftop"],
  usernames: ["marguerite", "theodora"],
};

const startApp = async () => {
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
  const app = createApp({
    databasePath,
    devicesPath,
    metadata: Metadata.layerOf({
      enrich: () =>
        Effect.succeed({
          artworkLargeUrl: ARTWORK,
          artworkUrl: "https://i.ytimg.com/vi/Zx9QpLm2Rt0/mqdefault.jpg",
          creator: CREATOR,
          durationSeconds: 3600,
          releasedAt: null,
          title: PROVIDER_TITLE,
        }),
    }),
  });
  const call = async (
    token: string,
    method: string,
    url: string,
    payload?: Readonly<Record<string, string | readonly string[]>>
  ) => {
    const response = await app.handler(
      new Request(`http://127.0.0.1:4310${url}`, {
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
    return response.json();
  };
  const open = (url: string, headers: Record<string, string> = {}) =>
    app.handler(
      new Request(`http://127.0.0.1:4310${url}`, { headers }),
      "device",
      "198.51.100.7"
    );
  return {
    app,
    call,
    databasePath,
    dispose: async () => {
      await app.dispose();
      await rm(directory, { force: true, recursive: true });
    },
    open,
  };
};

test("an Orbis Link shows the Set's shared facts and nothing from any Library", async () => {
  const server = await startApp();
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
      listenCount: 0,
      tags: PRIVATE.tags,
      title: PRIVATE.override,
    });

    const response = await server.open(`/share/sets/${id}`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      artworkUrl: ARTWORK,
      creator: CREATOR,
      id,
      source: "youtube",
      title: PROVIDER_TITLE,
      url: SOURCE_LINK,
    });
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
      expect(body.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  } finally {
    await server.dispose();
  }
});

test("an Orbis Link answers without a key, under any spelling the router accepts, and never counts as a failed key", async () => {
  const server = await startApp();
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
    ];
    const answers = await Promise.all(
      spellings.map(async (spelling) => {
        const response = await server.open(spelling);
        return [spelling, response.status] as const;
      })
    );
    expect(answers).toEqual(spellings.map((spelling) => [spelling, 200]));
    const unknown = await server.open(`/share/sets/${crypto.randomUUID()}`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ message: "Set not found." });
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
  } finally {
    await server.dispose();
  }
});
