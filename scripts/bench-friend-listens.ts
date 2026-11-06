/**
 * Times GET /people/:id/listens for a friend with 20 Sets and 36, 200, and 1,000 Listens,
 * through the real HTTP handler, and prints one JSON line per Listen count.
 *
 *   bun scripts/bench-friend-listens.ts
 */
import { Database as SqliteDatabase } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApp } from "../apps/server/src/app.js";
import { hashToken } from "../apps/server/src/identity.js";
import { request } from "../apps/server/src/test-http.js";

const distinctSets = 20;
const runs = 11;

const get = async (app: ReturnType<typeof createApp>, url: string) =>
  await request(app, {
    accessMode: "device",
    headers: { authorization: "Bearer a-token" },
    host: "vanta.example.ts.net",
    method: "GET",
    url,
  });

/**
 * Times `runs` requests one after another, so each reading covers one request
 * alone. Recursive rather than a loop, so each request is its own await.
 */
const timeRequests = async (
  app: ReturnType<typeof createApp>,
  times: number[],
  runsLeft: number
): Promise<void> => {
  if (runsLeft <= 0) {
    return;
  }
  const started = performance.now();
  await get(app, "/people/b/listens");
  times.push(performance.now() - started);
  await timeRequests(app, times, runsLeft - 1);
};

const measure = async (listenCount: number) => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-bench-listens-"));
  try {
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
    const open = () =>
      createApp({ databasePath, devicesPath, logging: { silent: true } });

    // The first request runs the migrations, so the seed below has tables to fill.
    const migrating = open();
    await get(migrating, "/sets");
    await migrating.dispose();

    const sqlite = new SqliteDatabase(databasePath);
    sqlite.transaction(() => {
      for (let index = 0; index < distinctSets; index += 1) {
        sqlite
          .query(
            "INSERT INTO sets (id, url, title, source, tags, created_at, title_edited_by_user, metadata_state, source_tags, details_state) VALUES (?, ?, 'Named', 'youtube', '[]', '2026-02-01T00:00:00.000Z', 0, 'enriched', '[]', 'filled')"
          )
          .run(`s${index}`, `https://www.youtube.com/watch?v=x${index}`);
        sqlite
          .query(
            "INSERT INTO library_entries (person_id, set_id, tags, saved_at) VALUES ('b', ?, '[]', '2026-02-01T00:00:00.000Z')"
          )
          .run(`s${index}`);
      }
      const insertListen = sqlite.query(
        "INSERT INTO listens (person_id, set_id, started_at, start_known, finished_at) VALUES ('b', ?, '2026-02-01T00:00:00.000Z', 1, NULL)"
      );
      for (let index = 0; index < listenCount; index += 1) {
        insertListen.run(`s${index % distinctSets}`);
      }
    })();
    sqlite.close();

    const app = open();
    try {
      const first = await get(app, "/people/b/listens");
      const payload = first.json();
      if (!Array.isArray(payload.listens)) {
        throw new TypeError(
          `The friend's Listens did not load: ${first.statusCode}`
        );
      }
      const times: number[] = [];
      await timeRequests(app, times, runs);
      times.sort((left, right) => left - right);
      return {
        bytes: JSON.stringify(payload).length,
        distinctSets,
        listens: listenCount,
        medianMs: Number(times[Math.floor(runs / 2)]?.toFixed(1)),
        returned: payload.listens.length,
        status: first.statusCode,
      };
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

const listenCounts = [36, 200, 1000];

const measureAll = async (index: number): Promise<void> => {
  const listenCount = listenCounts[index];
  if (listenCount === undefined) {
    return;
  }
  console.log(JSON.stringify(await measure(listenCount)));
  await measureAll(index + 1);
};

await measureAll(0);
