// The Listening Queue through `createApp` over HTTP with a real database.
//
// Ways it could fail:
// - Playing a Set drops the queue behind it, or moves a Set that is already
//   queued.
// - Play Next puts the Set at the end, or before the active Set, instead of
//   directly after the active Set.
// - Add to Queue puts the Set anywhere but the end, or a queued action starts
//   playback.
// - A Set without Retained Audio enters the queue, or its refusal changes the
//   queue.
// - Shuffling a Playlist keeps Sets from the old queue, drops a playable
//   member, or starts something other than the first entry it shows.
// - Completion leaves the finished Set in the queue, keeps its Playback
//   Position, or does not start the next Set.
// - The queue loses its order or its active Set across a restart.
//
// The transcript test prints the queue after each step as one line, with the
// active Set in brackets, so a change to these rules shows in its snapshot
// diff.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTestApp as createApp } from "./test-app.js";
import {
  request,
  runTimesInOrder,
  statusLine,
  transcript,
} from "./test-http.js";
import {
  addToQueue,
  complete,
  messageIn,
  order,
  play,
  playNext,
  putPosition,
  queueIn,
  queueOf,
  ready,
  savedSet,
  seedSets,
  SET_SECONDS,
  withSeededApp,
} from "./test-library.js";
import type { Queue, Response } from "./test-library.js";

/** The queue as one line: `[a*] b c`, the active Set starred in brackets. */
const queueLine = (queue: Queue) =>
  queue.entries.length === 0
    ? "(empty)"
    : queue.entries
        .map((entry) =>
          entry.id === queue.activeSetId ? `[${entry.id}*]` : entry.id
        )
        .join(" ");

test("transcript: play, Play Next, Add to Queue, a refusal, and completion", async () => {
  await withSeededApp(
    [...ready(["a", "b", "c"]), { downloadState: "none", id: "d" }],
    async (app) => {
      const t = transcript();
      const queued = async (
        step: string,
        settled: Promise<{ queue: Queue; response: Response }>
      ) => {
        const { queue, response } = await settled;
        t.step(step, `${response.statusCode} ${queueLine(queue)}`);
      };
      const refused = async (step: string, response: Promise<Response>) => {
        const settled = await response;
        t.step(step, `${statusLine(settled)} ${queueLine(await queueOf(app))}`);
      };

      await queued("play a", play(app, "a"));
      await queued("add c to the queue", addToQueue(app, "c"));
      await queued("play next b", playNext(app, "b"));
      await queued("play next c", playNext(app, "c"));
      await refused(
        "play d, which has no Retained Audio",
        request(app, {
          method: "PUT",
          payload: { setId: "d" },
          url: "/queue/active",
        })
      );
      await refused(
        "add d to the queue",
        request(app, {
          method: "POST",
          payload: { placement: "end", setId: "d" },
          url: "/queue/entries",
        })
      );
      const position = await putPosition(app, "a", 120);
      t.step(
        "a reaches 120s",
        `${position.response.statusCode}, a at ${position.set.playbackPositionSeconds}s`
      );
      await queued("complete a", complete(app, "a"));
      const finished = await savedSet(app, "a");
      t.step("read a", `a at ${finished.playbackPositionSeconds}s`);
      await queued("complete b, which is not active", complete(app, "b"));
      await queued("complete c", complete(app, "c"));
      await queued("complete b", complete(app, "b"));

      expect(t.text()).toMatchInlineSnapshot(`
        "
        play a  -> 200 [a*]
        add c to the queue  -> 201 [a*] c
        play next b  -> 201 [a*] b c
        play next c  -> 201 [a*] c b
        play d, which has no Retained Audio  -> 400 "Only sets with audio can be added to the queue." [a*] c b
        add d to the queue  -> 400 "Only sets with audio can be added to the queue." [a*] c b
        a reaches 120s  -> 200, a at 120s
        complete a  -> 200 [c*] b
        read a  -> a at 0s
        complete b, which is not active  -> 200 [c*] b
        complete c  -> 200 [b*]
        complete b  -> 200 (empty)
        "
      `);
    }
  );
});

test("tapping a playable Set makes it active and keeps the queue behind it", async () => {
  await withSeededApp(ready(["a", "b", "c"]), async (app) => {
    await play(app, "b");
    await addToQueue(app, "c");

    const { queue, response } = await play(app, "a");

    expect(response.statusCode).toBe(200);
    expect(queue.activeSetId).toBe("a");
    expect(queue.entries.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });
});

test("a Set already in the queue takes the active place without moving", async () => {
  await withSeededApp(ready(["a", "b", "c"]), async (app) => {
    await play(app, "a");
    await addToQueue(app, "b");
    await addToQueue(app, "c");

    const { queue } = await play(app, "c");

    expect(queue.activeSetId).toBe("c");
    expect(queue.entries.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });
});

test("a queued action with nothing playing queues the Set and starts nothing", async () => {
  await withSeededApp(ready(["a", "b"]), async (app) => {
    await playNext(app, "a");
    await addToQueue(app, "b");

    const queue = await queueOf(app);
    expect(queue.activeSetId).toBeNull();
    expect(queue.entries.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

test("Play Next inserts directly after the active Set", async () => {
  await withSeededApp(ready(["a", "b", "c"]), async (app) => {
    await play(app, "a");
    await playNext(app, "c");
    await playNext(app, "b");

    expect(await order(app)).toEqual(["a", "b", "c"]);
    const queue = await queueOf(app);
    expect(queue.activeSetId).toBe("a");
  });
});

test("Play Next moves a Set that is already queued", async () => {
  await withSeededApp(ready(["a", "b", "c"]), async (app) => {
    await play(app, "a");
    await addToQueue(app, "b");
    await addToQueue(app, "c");
    await playNext(app, "c");

    expect(await order(app)).toEqual(["a", "c", "b"]);
  });
});

test("a queued action on the active Set leaves the queue alone", async () => {
  await withSeededApp(ready(["a", "b"]), async (app) => {
    await play(app, "a");
    await addToQueue(app, "b");
    await addToQueue(app, "a");
    await playNext(app, "a");

    const queue = await queueOf(app);
    expect(queue.activeSetId).toBe("a");
    expect(queue.entries.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

test("playing a Playlist replaces the queue in Playlist order, with its playable members only", async () => {
  await withSeededApp(
    [...ready(["a", "b", "c"]), { downloadState: "none", id: "d" }],
    async (app) => {
      const created = await request(app, {
        method: "POST",
        payload: { name: "Closing sets" },
        url: "/playlists",
      });
      expect(created.statusCode).toBe(201);
      const { id: playlistId } = created.json();
      const members = await request(app, {
        method: "PUT",
        payload: { setIds: ["c", "a", "d", "b"] },
        url: `/playlists/${playlistId}/sets`,
      });
      expect(members.statusCode).toBe(200);
      await play(app, "b");

      const replaced = await request(app, {
        method: "PUT",
        payload: { playlistId },
        url: "/queue/playlist",
      });

      expect(replaced.statusCode).toBe(200);
      // The route answers with the whole queue, which is asserted by field here.
      const queue = queueIn(replaced);
      expect(queue.entries.map((entry) => entry.id)).toEqual(["c", "a", "b"]);
      expect(queue.activeSetId).toBe("c");
    }
  );
});

test("shuffling a Playlist replaces the whole queue with its playable members in a random order", async () => {
  await withSeededApp(
    [
      ...ready(["a", "b", "c", "e", "f", "g", "x", "y"]),
      { downloadState: "none", id: "d" },
    ],
    async (app) => {
      const created = await request(app, {
        method: "POST",
        payload: { name: "Late sets" },
        url: "/playlists",
      });
      const { id: playlistId } = created.json();
      await request(app, {
        method: "PUT",
        payload: { setIds: ["a", "b", "c", "d", "e", "f", "g"] },
        url: `/playlists/${playlistId}/sets`,
      });
      // A queue from before the shuffle, holding Sets outside the Playlist and one inside it.
      await play(app, "x");
      await addToQueue(app, "y");
      await addToQueue(app, "c");

      const orders = new Set<string>();
      // Each shuffle replaces the same queue, so they run one at a time.
      await runTimesInOrder(8, async () => {
        const shuffled = await request(app, {
          method: "PUT",
          payload: { order: "shuffled", playlistId },
          url: "/queue/playlist",
        });
        expect(shuffled.statusCode).toBe(200);
        const queue = queueIn(shuffled);
        const ids = queue.entries.map((entry) => entry.id);
        expect(ids).toHaveLength(6);
        expect(new Set(ids)).toEqual(new Set(["a", "b", "c", "e", "f", "g"]));
        expect(queue.activeSetId).toBe(ids[0] ?? null);
        expect(await order(app)).toEqual(ids);
        orders.add(ids.join(" "));
      });
      // Six members have 720 orders; eight shuffles that all agree would mean no shuffle.
      expect(orders.size).toBeGreaterThan(1);
    }
  );
});

test("a Set without Retained Audio cannot enter the queue", async () => {
  await withSeededApp([{ downloadState: "none", id: "d" }], async (app) => {
    const activated = await request(app, {
      method: "PUT",
      payload: { setId: "d" },
      url: "/queue/active",
    });
    expect(activated.statusCode).toBe(400);
    expect(messageIn(activated)).toBe(
      "Only sets with audio can be added to the queue."
    );
    const queued = await request(app, {
      method: "POST",
      payload: { placement: "end", setId: "d" },
      url: "/queue/entries",
    });
    expect(queued.statusCode).toBe(400);
    expect(await queueOf(app)).toEqual({ activeSetId: null, entries: [] });
  });
});

test("a Download state other than ready cannot enter the queue", async () => {
  await withSeededApp(
    [
      { downloadState: "downloading", id: "a" },
      { downloadState: "failed", id: "b" },
      { downloadState: "queued", id: "c" },
    ],
    async (app) => {
      const attempts = await Promise.all(
        ["a", "b", "c"].map((id) =>
          request(app, {
            method: "PUT",
            payload: { setId: id },
            url: "/queue/active",
          })
        )
      );

      for (const attempt of attempts) {
        expect(attempt.statusCode).toBe(400);
      }
    }
  );
});

test("completion removes the finished Set, resets its position, and starts the next", async () => {
  await withSeededApp(ready(["a", "b"]), async (app) => {
    await play(app, "a");
    await addToQueue(app, "b");
    await putPosition(app, "a", 120);

    const { queue, response } = await complete(app, "a");

    expect(response.statusCode).toBe(200);
    expect(queue.entries.map((entry) => entry.id)).toEqual(["b"]);
    expect(queue.activeSetId).toBe("b");
    const sets = await request(app, { method: "GET", url: "/sets" });
    const finished = sets
      .json()
      .sets.find((set: { id: string }) => set.id === "a");
    expect(finished.playbackPositionSeconds).toBe(0);
  });
});

test("an empty queue stops with nothing active", async () => {
  await withSeededApp(ready(["a"]), async (app) => {
    await play(app, "a");
    await complete(app, "a");

    expect(await queueOf(app)).toEqual({ activeSetId: null, entries: [] });
  });
});

test("a completion for a Set that is not active leaves the queue alone", async () => {
  await withSeededApp(ready(["a", "b"]), async (app) => {
    await play(app, "a");
    await addToQueue(app, "b");
    await putPosition(app, "b", 60);

    const { queue, response } = await complete(app, "b");

    expect(response.statusCode).toBe(200);
    expect(queue.activeSetId).toBe("a");
    expect(queue.entries.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

test("removing a Library Entry keeps its queue reference", async () => {
  await withSeededApp(ready(["a", "b"]), async (app) => {
    await play(app, "a");
    await addToQueue(app, "b");

    const removed = await request(app, { method: "DELETE", url: "/sets/a" });

    expect(removed.statusCode).toBe(200);
    expect(await order(app)).toEqual(["a", "b"]);
  });
});

test("a Playback Position is stored as whole seconds", async () => {
  await withSeededApp(ready(["a"]), async (app) => {
    const reported = await putPosition(app, "a", 62.6);

    expect(reported.response.statusCode).toBe(200);
    expect(reported.set.playbackPositionSeconds).toBe(63);
  });
});

test("a Playback Position past the end of the Set is stored as the end", async () => {
  await withSeededApp(ready(["a"]), async (app) => {
    const reported = await putPosition(app, "a", SET_SECONDS + 500);

    expect(reported.response.statusCode).toBe(200);
    expect(reported.set.playbackPositionSeconds).toBe(SET_SECONDS);
  });
});

test("a negative Playback Position is refused", async () => {
  await withSeededApp(ready(["a"]), async (app) => {
    const reported = await request(app, {
      method: "PUT",
      payload: { seconds: -1 },
      url: "/sets/a/position",
    });

    expect(reported.statusCode).toBe(400);
  });
});

test("the queue keeps its order and its active Set across a restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-queue-"));
  const databasePath = path.join(directory, "library.sqlite");
  try {
    await seedSets(databasePath, ready(["a", "b", "c"]));
    const first = createApp({ databasePath });
    await play(first, "b");
    await playNext(first, "c");
    await first.dispose();

    const second = createApp({ databasePath });
    try {
      const queue = await queueOf(second);
      expect(queue.activeSetId).toBe("b");
      expect(queue.entries.map((entry) => entry.id)).toEqual(["b", "c"]);
    } finally {
      await second.dispose();
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
