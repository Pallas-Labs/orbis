/**
 * Times `GET /sets` against a seeded Library: `bun run --filter @orbis/server bench:sets`.
 *
 * Each size seeds that many Sets straight into SQLite. Half carry a Library entry with a
 * title override and a playback position, every Set has two listens, and one of them is
 * finished, so each part of a built Set is read. It prints one JSON line per size with the
 * median of 15 timed requests after one warm-up, and a SHA-256 of the first response body so
 * two runs can show they answered the same bytes.
 */
/* oxlint-disable no-await-in-loop -- Sizes and timed requests run one at a time so each time is its own. */
import { Database as Sqlite } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTestApp } from "./test-app.js";
import { request } from "./test-http.js";

const sizes = process.argv.slice(2).map(Number);
const runs = 15;

for (const size of sizes.length > 0 ? sizes : [50, 2000]) {
  const directory = mkdtempSync(path.join(tmpdir(), "orbis-bench-sets-"));
  const databasePath = path.join(directory, "library.sqlite");
  const migrate = createTestApp({ databasePath, logging: { silent: true } });
  await request(migrate, { method: "GET", url: "/sets" });
  await migrate.dispose();

  const sqlite = new Sqlite(databasePath);
  const insertSet = sqlite.query(
    `INSERT INTO sets (id, url, title, source, tags, created_at, title_edited_by_user,
      metadata_state, source_tags, details_state)
     VALUES (?, ?, 'Named', 'youtube', '["house"]', ?, 0, 'enriched', '[]', 'filled')`
  );
  const insertEntry = sqlite.query(
    `INSERT INTO library_entries (person_id, set_id, saved_at, tags, title_override)
     VALUES ('host', ?, ?, '["techno"]', 'Renamed')`
  );
  const insertPosition = sqlite.query(
    "INSERT INTO playback_positions (person_id, set_id, seconds) VALUES ('host', ?, 90)"
  );
  const insertListen = sqlite.query(
    `INSERT INTO listens (person_id, set_id, started_at, start_known, finished_at)
     VALUES ('host', ?, '2026-02-01T00:00:00.000Z', 1, ?)`
  );
  sqlite.transaction(() => {
    for (let index = 0; index < size; index += 1) {
      const id = `set-${index}`;
      const at = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
      insertSet.run(id, `https://www.youtube.com/watch?v=bench${index}`, at);
      if (index % 2 === 0) {
        insertEntry.run(id, at);
        insertPosition.run(id);
      }
      insertListen.run(id, null);
      insertListen.run(id, "2026-02-01T01:00:00.000Z");
    }
  })();
  sqlite.close();

  const app = createTestApp({ databasePath, logging: { silent: true } });
  const first = await request(app, { method: "GET", url: "/sets" });
  // SAFETY: `GET /sets` answers `{ sets: SavedSet[] }`; the hash covers the whole body anyway.
  const body = first.json() as { readonly sets: readonly unknown[] };
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(body))
    .digest("hex");
  const times: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    await request(app, { method: "GET", url: "/sets" });
    times.push(performance.now() - started);
  }
  await app.dispose();
  rmSync(directory, { force: true, recursive: true });

  times.sort((left, right) => left - right);
  const median = times[Math.floor(runs / 2)] ?? 0;
  console.log(
    JSON.stringify({
      medianMs: Number(median.toFixed(2)),
      minMs: Number((times[0] ?? 0).toFixed(2)),
      returned: body.sets.length,
      sets: size,
      sha256,
    })
  );
}
