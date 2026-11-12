// The Listen the active queue entry holds, through `createApp` over HTTP with a
// real database and a real audio folder.
//
// Ways it could fail:
// - A queue change commits and the request then fails, so the Finish of the
//   Set that left and the Listen of the Set that took over are never written.
//   The retry cannot write them: the queue already moved, so the retry names a
//   Set that is no longer active.
// - A failed request leaves a Listen with no queue change, so a retry counts a
//   second one.
//
// The transcript prints the queue and the Listens after each step, so a change
// to these rules shows in its snapshot diff.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTestApp as createApp } from "./test-app.js";
import { request, transcript } from "./test-http.js";
import {
  addToQueue,
  complete,
  play,
  queueOf,
  ready,
  seedSets,
} from "./test-library.js";
import type { App } from "./test-library.js";

const queueLine = async (app: App) => {
  const queue = await queueOf(app);
  return queue.entries.length === 0
    ? "(empty)"
    : queue.entries
        .map((entry) =>
          entry.id === queue.activeSetId ? `[${entry.id}*]` : entry.id
        )
        .join(" ");
};

/** Every Listen in the order it opened: `a finished, b open`. */
const listensLine = (databasePath: string) => {
  const database = new Database(databasePath, { readonly: true });
  try {
    const rows = database
      .query<{ finished_at: string | null; set_id: string }, []>(
        "SELECT set_id, finished_at FROM listens ORDER BY id"
      )
      .all();
    return rows.length === 0
      ? "(none)"
      : rows
          .map(
            (row) =>
              `${row.set_id} ${row.finished_at === null ? "open" : "finished"}`
          )
          .join(", ");
  } finally {
    database.close();
  }
};

test("transcript: a completion that fails after the queue moved still records its Finish and the next Listen", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-queue-listen-"));
  const databasePath = path.join(directory, "library.sqlite");
  const audioDir = path.join(directory, "audio");
  try {
    await seedSets(databasePath, ready(["a", "b"]));
    // Removing Retained Audio deletes `<id>.ogg`. A folder with a file in it at that path
    // cannot be deleted that way, so the release of `a` fails after the queue commits.
    await mkdir(path.join(audioDir, "a.ogg"), { recursive: true });
    await writeFile(path.join(audioDir, "a.ogg", "keep"), "");
    const app = createApp({ audio: { audioDir }, databasePath });
    try {
      const t = transcript();
      const state = async () =>
        `${await queueLine(app)} | ${listensLine(databasePath)}`;

      await play(app, "a");
      await addToQueue(app, "b");
      t.step("play a, add b", await state());

      // The queue keeps its reference to `a`, so its audio stays until it leaves the queue.
      const removed = await request(app, { method: "DELETE", url: "/sets/a" });
      t.step(
        `remove a from the library (${removed.statusCode})`,
        await state()
      );

      const failed = await request(app, {
        method: "POST",
        payload: { setId: "a" },
        url: "/queue/completion",
      });
      t.step(
        `complete a, its audio cannot be removed (${failed.statusCode})`,
        await state()
      );

      const retried = await complete(app, "a");
      t.step(
        `complete a again (${retried.response.statusCode})`,
        await state()
      );

      expect(t.text()).toMatchInlineSnapshot(`
        "
        play a, add b  -> [a*] b | a open
        remove a from the library (200)  -> [a*] b | a open
        complete a, its audio cannot be removed (500)  -> [b*] | a finished, b open
        complete a again (200)  -> [b*] | a finished, b open
        "
      `);
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
