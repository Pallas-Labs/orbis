// Heavy Rotation through `createApp` over HTTP with a real database.
//
// Ways it could fail:
// - Saving a Playback Position credits no Listening Time, so the shelf never
//   fills from real playback.
// - A seek forward, a jump back, or the reset when a Set finishes counts as
//   listening.
// - Listening Time from another Person, from a day outside the window, or for
//   a Set this Person removed reaches the shelf.
// - The shelf shows with fewer than three Sets, or in an order other than the
//   ranking rule's.
//
// The transcript prints the shelf after each step, so a change to these rules
// shows in its snapshot diff.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { LibraryResponseSchema } from "@orbis/contracts/http-api";
import { Schema } from "effect";

import { createTestApp as createApp } from "./test-app.js";
import { request, runInOrder, transcript } from "./test-http.js";
import { putPosition, ready, seedSets } from "./test-library.js";
import type { App } from "./test-library.js";

const decodeShelf = Schema.decodeUnknownSync(LibraryResponseSchema);

const shelf = async (app: App) => {
  const response = await request(app, {
    method: "GET",
    url: "/heavy-rotation",
  });
  const { sets } = decodeShelf(response.json());
  return `${response.statusCode} ${sets.length === 0 ? "(hidden)" : sets.map((set) => set.id).join(" ")}`;
};

/** Plays a Set from `from` to `to` seconds, saving the position each minute. */
const listen = (app: App, setId: string, from: number, to: number) =>
  runInOrder(
    Array.from(
      { length: Math.floor((to - from) / 60) + 1 },
      (_, step) => from + step * 60
    ),
    async (seconds) => {
      await putPosition(app, setId, seconds);
    }
  );

const listeningTime = (databasePath: string) => {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database
      .query<{ person_id: string; seconds: number; set_id: string }, []>(
        "SELECT person_id, set_id, seconds FROM listening_time ORDER BY set_id, person_id"
      )
      .all()
      .map((row) => `${row.person_id} ${row.set_id} ${row.seconds}`)
      .join(", ");
  } finally {
    database.close();
  }
};

test("transcript: listening fills the shelf, skims and seeks do not", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-rotation-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    await seedSets(databasePath, ready(["a", "b", "c", "d", "e", "f"]));
    const seed = new Database(databasePath);
    try {
      // The service credits the UTC day it runs on, so the seeds count days back from SQLite's
      // own clock rather than the test's.
      const insert = seed.query(
        "INSERT INTO listening_time (person_id, day, set_id, seconds) VALUES (?, date('now', ?), ?, ?)"
      );
      // An old binge outside the window, and another Person's listening today.
      insert.run("host", "-30 days", "e", 36_000);
      insert.run("someone-else", "+0 days", "f", 36_000);
      // Ten minutes of d three weeks ago, inside the window.
      insert.run("host", "-21 days", "d", 600);
    } finally {
      seed.close();
    }

    const app = createApp({ databasePath });
    try {
      const t = transcript();
      t.step("read the shelf", await shelf(app));

      await listen(app, "a", 0, 300);
      t.step("listen to a for 5 minutes", await shelf(app));

      await listen(app, "b", 0, 60);
      await putPosition(app, "b", 590);
      t.step("skim b for a minute, then seek near its end", await shelf(app));

      await listen(app, "c", 0, 180);
      t.step("listen to c for 3 minutes", await shelf(app));

      await putPosition(app, "a", 0);
      await listen(app, "a", 0, 240);
      t.step("jump back in a and hear 4 more minutes", await shelf(app));

      await listen(app, "b", 60, 240);
      t.step("hear 3 more minutes of b", await shelf(app));

      const removed = await request(app, {
        method: "DELETE",
        url: "/sets/c",
      });
      t.step(`remove c (${removed.statusCode})`, await shelf(app));

      t.step("listening time", listeningTime(databasePath));

      expect(t.text()).toMatchInlineSnapshot(`
        "
        read the shelf  -> 200 (hidden)
        listen to a for 5 minutes  -> 200 (hidden)
        skim b for a minute, then seek near its end  -> 200 (hidden)
        listen to c for 3 minutes  -> 200 d a c
        jump back in a and hear 4 more minutes  -> 200 a d c
        hear 3 more minutes of b  -> 200 a d b c
        remove c (200)  -> 200 a d b
        listening time  -> host a 540, host b 240, host c 180, host d 600, host e 36000, someone-else f 36000
        "
      `);
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
