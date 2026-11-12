// A friend's Listen History through `createApp` over HTTP with a real database.
//
// Ways it could fail:
// - The answer holds every Listen the friend ever made, each with a whole Set,
//   so it grows without end.
// - The bound keeps the oldest Listens, or orders them by anything but newest
//   first.
import { Database as SqliteDatabase } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "./app.js";
import { hashToken } from "./identity.js";
import { request, transcript } from "./test-http.js";

const get = async (app: ReturnType<typeof createApp>, url: string) =>
  await request(app, {
    accessMode: "device",
    headers: { authorization: "Bearer a-token" },
    host: "orbis.example.test",
    method: "GET",
    url,
  });

/** The time of day a Listen started, as `04:09`. */
const clock = (listen: { startedAt: string } | undefined) =>
  listen?.startedAt.slice(11, 16) ?? "none";

test("transcript: a friend's Listen History is the newest 200 Listens", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-listens-"));
  const devicesPath = path.join(directory, "devices.json");
  const databasePath = path.join(directory, "library.sqlite");
  await writeFile(
    devicesPath,
    JSON.stringify({
      keys: ["a", "b"].map((personId) => ({
        addedAt: "2026-09-29T00:00:00.000Z",
        id: `${personId}-key`,
        label: "phone",
        lastUsedAt: null,
        personId,
        scope: "daily",
        tokenHash: hashToken(`${personId}-token`),
      })),
      people: [
        { id: "host", removed: false, username: "host" },
        { id: "a", removed: false, social: true, username: "alice" },
        { id: "b", removed: false, social: true, username: "bob" },
      ],
      version: 2,
    })
  );
  const app = createApp({ databasePath, devicesPath });
  try {
    // The first request runs the migrations, so the seed below has tables to fill.
    await get(app, "/sets");
    const seed = (listenCount: number) => {
      const sqlite = new SqliteDatabase(databasePath);
      try {
        sqlite.run("DELETE FROM listens");
        sqlite.run(
          "INSERT OR IGNORE INTO sets (id, url, title, source, tags, created_at) VALUES ('s', 'https://www.youtube.com/watch?v=abcdefghijk', 'Named', 'youtube', '[]', '2026-02-01T00:00:00.000Z')"
        );
        sqlite.run(
          "INSERT OR IGNORE INTO library_entries (person_id, set_id, tags, saved_at) VALUES ('b', 's', '[]', '2026-02-01T00:00:00.000Z')"
        );
        // One Listen a minute from midnight, so a Listen's time names its place in the order.
        const insert = sqlite.query(
          "INSERT INTO listens (person_id, set_id, started_at) VALUES ('b', 's', ?)"
        );
        const start = Date.parse("2026-02-01T00:00:00.000Z");
        sqlite.transaction(() => {
          for (let minute = 0; minute < listenCount; minute += 1) {
            insert.run(new Date(start + minute * 60_000).toISOString());
          }
        })();
      } finally {
        sqlite.close();
      }
    };
    const history = async () => {
      const response = await get(app, "/people/b/listens");
      const listens: { startedAt: string }[] = response.json().listens;
      return `${response.statusCode} ${listens.length} Listens, ${clock(listens[0])} to ${clock(listens.at(-1))}`;
    };

    const t = transcript();
    seed(30);
    t.step("a friend with 30 Listens, one a minute", await history());
    seed(250);
    t.step("a friend with 250 Listens, one a minute", await history());

    expect(t.text()).toMatchInlineSnapshot(`
      "
      a friend with 30 Listens, one a minute  -> 200 30 Listens, 00:29 to 00:00
      a friend with 250 Listens, one a minute  -> 200 200 Listens, 04:09 to 00:50
      "
    `);
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});
