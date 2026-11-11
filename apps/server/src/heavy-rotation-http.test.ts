// Heavy Rotation through `createApp` over HTTP with a real database.
//
// Ways it could fail:
// - Saving a Playback Position credits no Listening Time, so the shelf never
//   fills from real playback.
// - A seek forward, a jump back, or the reset when a Set finishes counts as
//   listening.
// - A skip forward while playing, a skip while paused, or two devices playing
//   the same Set credits time nobody heard.
// - Listening Time from another Person, from a day outside the window, or for
//   a Set this Person removed reaches the shelf.
// - The shelf shows with fewer than three Sets, or in an order other than the
//   ranking rule's.
// - 3 months or the past year reads the 30-day window, or an unknown range is
//   read as one.
// - Playing the collection queues Sets in another order, or Sets outside it.
//
// The transcript prints the shelf after each step, so a change to these rules
// shows in its snapshot diff.
import { Database } from "bun:sqlite";
import { expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  LibraryResponseSchema,
  ListeningQueueSchema,
} from "@orbis/contracts/http-api";
import { Schema } from "effect";

import { createTestApp as createApp } from "./test-app.js";
import { request, runInOrder, transcript } from "./test-http.js";
import { putPosition, ready, seedSets } from "./test-library.js";
import type { App } from "./test-library.js";

const decodeShelf = Schema.decodeUnknownSync(LibraryResponseSchema);
const decodeQueue = Schema.decodeUnknownSync(
  Schema.Struct({ queue: ListeningQueueSchema })
);

const shelf = async (app: App, range?: string) => {
  const response = await request(app, {
    method: "GET",
    url:
      range === undefined
        ? "/heavy-rotation"
        : `/heavy-rotation?range=${range}`,
  });
  const { sets } = decodeShelf(response.json());
  return `${response.statusCode} ${sets.length === 0 ? "(hidden)" : sets.map((set) => set.id).join(" ")}`;
};

// The service credits a step only when it matches the time since the last save, so the test
// sets the clock and moves it on. Noon keeps every step on one UTC day.
const TODAY = "2026-11-10";
let clock = Date.parse(`${TODAY}T12:00:00Z`);

/** Moves the clock on, then saves a position. */
const putPositionAfter = async (
  app: App,
  setId: string,
  seconds: number,
  afterSeconds: number
) => {
  clock += afterSeconds * 1000;
  setSystemTime(new Date(clock));
  await putPosition(app, setId, seconds);
};

/** Plays a Set from `from` to `to` seconds, saving the position each minute. */
const listen = (app: App, setId: string, from: number, to: number) =>
  runInOrder(
    Array.from(
      { length: Math.floor((to - from) / 60) + 1 },
      (_, step) => from + step * 60
    ),
    async (seconds) => {
      await putPositionAfter(app, setId, seconds, 60);
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
    await seedSets(
      databasePath,
      ready(["a", "b", "c", "d", "e", "f", "g", "h", "i"])
    );
    const seed = new Database(databasePath);
    try {
      // The seeds count days back from the test's clock, which the service reads.
      const insert = seed.query(
        "INSERT INTO listening_time (person_id, day, set_id, seconds) VALUES (?, date(?, ?), ?, ?)"
      );
      // An old binge outside the window, and another Person's listening today.
      insert.run("host", TODAY, "-30 days", "e", 36_000);
      insert.run("someone-else", TODAY, "+0 days", "f", 36_000);
      // Ten minutes of d three weeks ago, inside the window.
      insert.run("host", TODAY, "-21 days", "d", 600);
      // An hour of i seven months ago, inside the past year only.
      insert.run("host", TODAY, "-210 days", "i", 3600);
    } finally {
      seed.close();
    }

    setSystemTime(new Date(clock));
    const app = createApp({ databasePath });
    try {
      const t = transcript();
      t.step("read the shelf", await shelf(app));

      await listen(app, "a", 0, 300);
      t.step("listen to a for 5 minutes", await shelf(app));

      await listen(app, "b", 0, 60);
      await putPositionAfter(app, "b", 590, 5);
      t.step("skim b for a minute, then seek near its end", await shelf(app));

      await listen(app, "c", 0, 180);
      t.step("listen to c for 3 minutes", await shelf(app));

      await putPositionAfter(app, "a", 0, 5);
      await listen(app, "a", 0, 240);
      t.step("jump back in a and hear 4 more minutes", await shelf(app));

      await listen(app, "b", 60, 240);
      t.step("hear 3 more minutes of b", await shelf(app));

      const removed = await request(app, {
        method: "DELETE",
        url: "/sets/c",
      });
      t.step(`remove c (${removed.statusCode})`, await shelf(app));

      await listen(app, "g", 0, 60);
      await putPositionAfter(app, "g", 95, 5);
      await putPositionAfter(app, "g", 100, 5);
      t.step(
        "hear a minute of g, skip 30 s while playing, hear 5 s",
        await shelf(app)
      );

      await putPositionAfter(app, "h", 0, 5);
      await runInOrder([30, 60, 90, 120], async (seconds) => {
        await putPositionAfter(app, "h", seconds, 2);
      });
      await putPositionAfter(app, "h", 150, 600);
      t.step(
        "pause h, skip 30 s four times, wait 10 minutes, skip again",
        await shelf(app)
      );

      // Device A plays g at 100 s and device B at 130 s; each saves every 5 s, in turn.
      await runInOrder([130, 105, 135, 110, 140], async (seconds) => {
        await putPositionAfter(app, "g", seconds, 2.5);
      });
      t.step("two devices play g 30 s apart for 12.5 s", await shelf(app));

      t.step("read 3 months", await shelf(app, "quarter"));
      t.step("read the past year", await shelf(app, "year"));
      // A refused query has no JSON body, so this step reads the status alone.
      const unknown = await app.handler(
        new Request("http://127.0.0.1:4310/heavy-rotation?range=week", {
          headers: { "x-orbis-test-auth": "fixture" },
        }),
        "device"
      );
      t.step("read an unknown range", `${unknown.status}`);

      const played = await request(app, {
        method: "PUT",
        payload: { range: "year" },
        url: "/queue/heavy-rotation",
      });
      const { queue } = decodeQueue(played.json());
      t.step(
        "play the past year",
        `${played.statusCode} ${queue.entries.map((set) => set.id).join(" ")}, active ${queue.activeSetId}`
      );

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
        hear a minute of g, skip 30 s while playing, hear 5 s  -> 200 a d b
        pause h, skip 30 s four times, wait 10 minutes, skip again  -> 200 a d b
        two devices play g 30 s apart for 12.5 s  -> 200 a d b
        read 3 months  -> 200 e d a b
        read the past year  -> 200 e i d a b
        read an unknown range  -> 400
        play the past year  -> 200 e i d a b, active e
        listening time  -> host a 540, host b 240, host c 180, host d 600, host e 36000, someone-else f 36000, host g 65, host i 3600
        "
      `);
    } finally {
      await app.dispose();
    }
  } finally {
    setSystemTime();
    await rm(directory, { force: true, recursive: true });
  }
});
