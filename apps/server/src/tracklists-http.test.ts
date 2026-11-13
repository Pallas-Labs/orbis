import { Database as Sqlite } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Layer, Logger, Redacted, References } from "effect";
import type { WideEvent } from "evlog";

import { backfillTracklists } from "./backfill-tracklists.js";
import { layer as databaseLayer } from "./db/database.js";
import { MetadataError } from "./metadata-error.js";
import { Metadata } from "./metadata.js";
import { createTestApp as createApp } from "./test-app.js";
import { request, transcript } from "./test-http.js";
import { runClaimedTracklist } from "./tracklists.js";
import { Versos, VersosError } from "./versos.js";
import type { TracklistPoll } from "./versos.js";
import type { SourceDetails } from "./ytdlp-metadata.js";

const DETAILS: SourceDetails = {
  chapters: [],
  creator: "DJ Example",
  creatorId: null,
  creatorUrl: null,
  description: "00:00 First song\n02:00 Second song",
  durationSeconds: 300,
  genre: null,
  releasedAt: null,
  tags: [],
  thumbnailUrl: null,
  title: "A mix",
};

const CUES = [
  {
    appleMusicId: "123",
    artist: "First Artist",
    artworkUrl: null,
    position: 0,
    startSeconds: 0,
    title: "First song",
  },
  {
    appleMusicId: null,
    artist: "Second Artist",
    artworkUrl: null,
    position: 1,
    startSeconds: null,
    title: "Second song",
  },
];

const start = async (
  versos: ReturnType<typeof Versos.layerOf>,
  onEvent?: (event: WideEvent) => void,
  details: () => SourceDetails = () => DETAILS
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-tracklists-"));
  const databasePath = path.join(directory, "library.sqlite");
  const app = createApp({
    databasePath,
    logging: { onEvent: (event) => onEvent?.(event), silent: true },
    metadata: Metadata.layerOf({
      details: () => Effect.sync(details),
      enrich: () => Effect.die("title supplied by caller"),
    }),
    versos,
  });
  return {
    app,
    databasePath,
    dispose: async () => {
      await app.dispose();
      await rm(directory, { force: true, recursive: true });
    },
  };
};

const save = (app: ReturnType<typeof createApp>) =>
  request(app, {
    method: "POST",
    payload: {
      title: "My mix",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    },
    url: "/sets",
  });

const read = (app: ReturnType<typeof createApp>, id: string) =>
  request(app, { method: "GET", url: `/sets/${id}/tracklist` });

const eventually = async <T>(
  check: () => Promise<T | null>,
  attempts = 100
): Promise<T> => {
  const value = await check();
  if (value !== null) {
    return value;
  }
  if (attempts === 0) {
    throw new Error("Expected background work to finish.");
  }
  await Bun.sleep(10);
  return await eventually(check, attempts - 1);
};

const waitForState = (
  app: ReturnType<typeof createApp>,
  id: string,
  state: string
) =>
  eventually(async () => {
    const result = await read(app, id);
    return result.json().state === state ? result : null;
  });

test("save reads details, requests and polls Versos, then serves Cues including one with no start time", async () => {
  const asked: unknown[] = [];
  let polls = 0;
  const server = await start(
    Versos.layerOf({
      poll: () => {
        polls += 1;
        return Effect.succeed(
          polls === 1
            ? { state: "pending" as const }
            : { cues: CUES, state: "ready" as const }
        );
      },
      request: (input) => {
        asked.push(input);
        return Effect.succeed({ requestId: "job-1" });
      },
    })
  );
  try {
    const saved = await save(server.app);
    expect(saved.statusCode).toBe(201);
    const id = String(saved.json().id);
    const tracklist = await waitForState(server.app, id, "ready");
    expect(tracklist.json()).toEqual({ cues: CUES, state: "ready" });
    expect(asked).toEqual([
      {
        description: DETAILS.description,
        source: "youtube",
        url: "https://www.youtube.com/watch?v=abcdefghijk",
      },
    ]);
    expect(polls).toBe(2);
    const library = await request(server.app, { method: "GET", url: "/sets" });
    expect(library.json().sets[0].tracklistState).toBe("ready");
    const removed = await request(server.app, {
      method: "DELETE",
      url: `/sets/${id}`,
    });
    expect(removed.statusCode).toBe(200);
    const db = new Sqlite(server.databasePath);
    try {
      expect(
        db.query("SELECT * FROM set_cues WHERE set_id = ?").all(id)
      ).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    await server.dispose();
  }
});

test("metadata enrichment that already contains details still starts the Tracklist", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "orbis-tracklists-enrichment-")
  );
  const app = createApp({
    databasePath: path.join(directory, "library.sqlite"),
    metadata: Metadata.layerOf({
      enrich: () =>
        Effect.succeed({
          artworkLargeUrl: null,
          artworkUrl: null,
          creator: DETAILS.creator,
          durationSeconds: DETAILS.durationSeconds,
          extras: DETAILS,
          releasedAt: null,
          title: DETAILS.title,
        }),
    }),
    versos: Versos.layerOf({
      poll: () => Effect.succeed({ cues: CUES, state: "ready" }),
      request: () => Effect.succeed({ requestId: "enriched-job" }),
    }),
  });
  try {
    const saved = await request(app, {
      method: "POST",
      payload: { url: "https://www.youtube.com/watch?v=abcdefghijk" },
      url: "/sets",
    });
    expect(saved.statusCode).toBe(201);
    const ready = await waitForState(app, String(saved.json().id), "ready");
    expect(ready.json()).toEqual({ cues: CUES, state: "ready" });
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("provider failure preserves the Set and retry replaces failure with Cues", async () => {
  let fail = true;
  const server = await start(
    Versos.layerOf({
      poll: () => Effect.succeed({ cues: CUES, state: "ready" }),
      request: () =>
        fail
          ? Effect.fail(new VersosError({ reason: "unavailable" }))
          : Effect.succeed({ requestId: "job-2" }),
    })
  );
  try {
    const saved = await save(server.app);
    expect(saved.statusCode).toBe(201);
    const id = String(saved.json().id);
    const failed = await waitForState(server.app, id, "failed");
    expect(failed.json()).toEqual({
      cues: [],
      state: "failed",
    });
    fail = false;
    const retried = await request(server.app, {
      method: "POST",
      url: `/sets/${id}/tracklist/retry`,
    });
    expect(retried.statusCode).toBe(200);
    const ready = await waitForState(server.app, id, "ready");
    expect(ready.json()).toEqual({
      cues: CUES,
      state: "ready",
    });
  } finally {
    await server.dispose();
  }
});

test("a refresh reads the source again and asks Versos to scan the new description", async () => {
  const asked: unknown[] = [];
  let answer: TracklistPoll = { state: "none" };
  let details = DETAILS;
  const server = await start(
    Versos.layerOf({
      poll: () => Effect.succeed(answer),
      request: (input) => {
        asked.push(input);
        return Effect.succeed({ requestId: `job-${asked.length}` });
      },
    }),
    undefined,
    () => details
  );
  try {
    const saved = await save(server.app);
    const id = String(saved.json().id);
    await waitForState(server.app, id, "none");
    details = { ...DETAILS, description: "Tracklist\n00:00 New song" };
    answer = { cues: CUES, state: "ready" };
    const refreshed = await request(server.app, {
      method: "POST",
      url: `/sets/${id}/tracklist/retry`,
    });
    expect(refreshed.statusCode).toBe(200);
    const ready = await waitForState(server.app, id, "ready");
    expect(ready.json()).toEqual({ cues: CUES, state: "ready" });
    expect(asked).toEqual([
      {
        description: DETAILS.description,
        source: "youtube",
        url: "https://www.youtube.com/watch?v=abcdefghijk",
      },
      {
        description: "Tracklist\n00:00 New song",
        force: true,
        source: "youtube",
        url: "https://www.youtube.com/watch?v=abcdefghijk",
      },
    ]);
  } finally {
    await server.dispose();
  }
});

test("a refresh that finds no Cues or fails keeps the Set's Tracklist", async () => {
  let requests = 0;
  let runs = 0;
  let refresh: "none" | "fail" | null = null;
  const server = await start(
    Versos.layerOf({
      poll: () =>
        Effect.succeed(
          refresh === "none"
            ? { state: "none" as const }
            : { cues: CUES, state: "ready" as const }
        ),
      request: () => {
        requests += 1;
        return refresh === "fail"
          ? Effect.fail(new VersosError({ reason: "unavailable" }))
          : Effect.succeed({ requestId: `job-${requests}` });
      },
    }),
    (event) => {
      if (event.job === "tracklist") {
        runs += 1;
      }
    }
  );
  try {
    const saved = await save(server.app);
    const id = String(saved.json().id);
    await waitForState(server.app, id, "ready");
    await eventually(() => Promise.resolve(runs === 1 ? true : null));
    const refreshTo = async (outcome: "none" | "fail", runsAfter: number) => {
      refresh = outcome;
      const refreshed = await request(server.app, {
        method: "POST",
        url: `/sets/${id}/tracklist/retry`,
      });
      expect(refreshed.statusCode).toBe(200);
      await eventually(() => Promise.resolve(runs === runsAfter ? true : null));
      const kept = await read(server.app, id);
      expect(kept.json()).toEqual({ cues: CUES, state: "ready" });
    };
    await refreshTo("none", 2);
    await refreshTo("fail", 3);
    expect(requests).toBe(3);
  } finally {
    await server.dispose();
  }
});

test("a refresh while one is pending starts no second Versos request", async () => {
  let requests = 0;
  let blocked = Promise.withResolvers<null>();
  blocked.resolve(null);
  const server = await start(
    Versos.layerOf({
      poll: () => Effect.succeed({ cues: CUES, state: "ready" }),
      request: () => {
        requests += 1;
        return Effect.promise(() => blocked.promise).pipe(
          Effect.as({ requestId: `job-${requests}` })
        );
      },
    })
  );
  try {
    const saved = await save(server.app);
    const id = String(saved.json().id);
    await waitForState(server.app, id, "ready");
    blocked = Promise.withResolvers<null>();
    const first = await request(server.app, {
      method: "POST",
      url: `/sets/${id}/tracklist/retry`,
    });
    expect(first.json().state).toBe("pending");
    await eventually(() => Promise.resolve(requests === 2 ? true : null));
    const second = await request(server.app, {
      method: "POST",
      url: `/sets/${id}/tracklist/retry`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ cues: CUES, state: "pending" });
    await Bun.sleep(25);
    expect(requests).toBe(2);
    blocked.resolve(null);
    const ready = await waitForState(server.app, id, "ready");
    expect(ready.json()).toEqual({ cues: CUES, state: "ready" });
  } finally {
    blocked.resolve(null);
    await server.dispose();
  }
});

test("a Versos 401 leaves the Set saved and a retry succeeds after credentials recover", async () => {
  let refuse = true;
  const headers: string[] = [];
  const server = await start(
    Versos.layer({
      fetch: (_url, init) => {
        headers.push(new Headers(init?.headers).get("authorization") ?? "");
        if (refuse) {
          return Promise.resolve(new Response(null, { status: 401 }));
        }
        return Promise.resolve(
          init?.method === "POST"
            ? Response.json({ requestId: "job-recovered" })
            : Response.json({ cues: CUES, state: "ready" })
        );
      },
      key: Redacted.make("private-key"),
      url: "https://versos.example.test",
    })
  );
  try {
    const saved = await save(server.app);
    expect(saved.statusCode).toBe(201);
    const id = String(saved.json().id);
    const failed = await waitForState(server.app, id, "failed");
    expect(failed.json().cues).toEqual([]);
    refuse = false;
    const retry = await request(server.app, {
      method: "POST",
      url: `/sets/${id}/tracklist/retry`,
    });
    expect(retry.statusCode).toBe(200);
    const ready = await waitForState(server.app, id, "ready");
    expect(ready.json().cues).toEqual(CUES);
    expect(headers).toEqual([
      "Bearer private-key",
      "Bearer private-key",
      "Bearer private-key",
    ]);
  } finally {
    await server.dispose();
  }
});

test("a Versos timeout marks the Set failed without blocking the save", async () => {
  const server = await start(
    Versos.layer({
      fetch: (_url, init) => {
        const pending = Promise.withResolvers<Response>();
        init?.signal?.addEventListener("abort", () => {
          pending.reject(new Error("aborted"));
        });
        return pending.promise;
      },
      key: Redacted.make("private-key"),
      requestTimeoutMs: 20,
      url: "https://versos.example.test",
    })
  );
  try {
    const saved = await save(server.app);
    expect(saved.statusCode).toBe(201);
    const failed = await waitForState(
      server.app,
      String(saved.json().id),
      "failed"
    );
    expect(failed.json()).toEqual({
      cues: [],
      state: "failed",
    });
  } finally {
    await server.dispose();
  }
});

test("none stores no Cues and a concurrent retry does not start another run", async () => {
  let requests = 0;
  const blocked = Promise.withResolvers<null>();
  const server = await start(
    Versos.layerOf({
      poll: () => Effect.succeed({ state: "none" }),
      request: () => {
        requests += 1;
        return Effect.promise(() => blocked.promise).pipe(
          Effect.as({ requestId: "job-3" })
        );
      },
    })
  );
  try {
    const saved = await save(server.app);
    const id = String(saved.json().id);
    await eventually(() => Promise.resolve(requests > 0 ? true : null));
    const retried = await request(server.app, {
      method: "POST",
      url: `/sets/${id}/tracklist/retry`,
    });
    expect(retried.statusCode).toBe(200);
    expect(requests).toBe(1);
    blocked.resolve(null);
    const none = await waitForState(server.app, id, "none");
    expect(none.json()).toEqual({
      cues: [],
      state: "none",
    });
  } finally {
    blocked.resolve(null);
    await server.dispose();
  }
});

test.each(["request", "poll"] as const)(
  "disposing during a Tracklist %s releases its claim for immediate concurrent HTTP retries",
  async (stage) => {
    let requests = 0;
    let polls = 0;
    const server = await start(
      Versos.layerOf({
        poll: () => {
          polls += 1;
          return Effect.never;
        },
        request: () => {
          requests += 1;
          return stage === "request"
            ? Effect.never
            : Effect.succeed({ requestId: "interrupted-job" });
        },
      })
    );
    try {
      const saved = await save(server.app);
      expect(saved.statusCode).toBe(201);
      const id = String(saved.json().id);
      await eventually(() => Promise.resolve(requests === 1 ? true : null));
      if (stage === "poll") {
        await eventually(() => Promise.resolve(polls === 1 ? true : null));
      }
      await server.app.dispose();
      const db = new Sqlite(server.databasePath);
      try {
        expect(
          db
            .query(
              "SELECT tracklist_state, tracklist_run_id, tracklist_run_started_at FROM sets WHERE id = ?"
            )
            .get(id)
        ).toEqual({
          tracklist_run_id: null,
          tracklist_run_started_at: null,
          tracklist_state: "pending",
        });
      } finally {
        db.close();
      }
      let retryRequests = 0;
      const blocked = Promise.withResolvers<null>();
      const reloaded = createApp({
        databasePath: server.databasePath,
        versos: Versos.layerOf({
          poll: () => Effect.succeed({ cues: CUES, state: "ready" }),
          request: () => {
            retryRequests += 1;
            return Effect.promise(() => blocked.promise).pipe(
              Effect.as({ requestId: "restart-job" })
            );
          },
        }),
      });
      try {
        const retries = await Promise.all([
          request(reloaded, {
            method: "POST",
            url: `/sets/${id}/tracklist/retry`,
          }),
          request(reloaded, {
            method: "POST",
            url: `/sets/${id}/tracklist/retry`,
          }),
        ]);
        expect(retries.map((retry) => retry.statusCode)).toEqual([200, 200]);
        await eventually(() =>
          Promise.resolve(retryRequests === 1 ? true : null)
        );
        expect(retryRequests).toBe(1);
        blocked.resolve(null);
        const ready = await waitForState(reloaded, id, "ready");
        expect(ready.json()).toEqual({
          cues: CUES,
          state: "ready",
        });
      } finally {
        blocked.resolve(null);
        await reloaded.dispose();
      }
    } finally {
      await server.dispose();
    }
  }
);

test("shutting down a stale HTTP worker preserves a newer active claim and its Cues", async () => {
  let staleRequests = 0;
  const server = await start(
    Versos.layerOf({
      poll: () => Effect.die("stale request never completes"),
      request: () => {
        staleRequests += 1;
        return Effect.never;
      },
    })
  );
  const blocked = Promise.withResolvers<null>();
  let newerRequests = 0;
  const newerCues = CUES.map((cue) => ({ ...cue, artist: "Newer Artist" }));
  const saved = await save(server.app);
  expect(saved.statusCode).toBe(201);
  const id = String(saved.json().id);
  await eventually(() => Promise.resolve(staleRequests === 1 ? true : null));
  const newer = createApp({
    databasePath: server.databasePath,
    versos: Versos.layerOf({
      poll: () => Effect.succeed({ cues: newerCues, state: "ready" }),
      request: () => {
        newerRequests += 1;
        return Effect.promise(() => blocked.promise).pipe(
          Effect.as({ requestId: "newer-active-job" })
        );
      },
    }),
  });
  try {
    // Finish the second app's migrations before holding a SQLite inspection connection.
    const initial = await read(newer, id);
    expect(initial.statusCode).toBe(200);
    const db = new Sqlite(server.databasePath);
    try {
      const claim = () =>
        db
          .query<
            {
              tracklist_run_id: string | null;
              tracklist_run_started_at: string | null;
              tracklist_state: string;
            },
            [string]
          >(
            "SELECT tracklist_run_id, tracklist_run_started_at, tracklist_state FROM sets WHERE id = ?"
          )
          .get(id);
      const staleClaim = claim();
      expect(staleClaim?.tracklist_run_id).toBeString();
      db.query("UPDATE sets SET tracklist_run_started_at = ? WHERE id = ?").run(
        "2000-01-01T00:00:00.000Z",
        id
      );
      const retry = await request(newer, {
        method: "POST",
        url: `/sets/${id}/tracklist/retry`,
      });
      expect(retry.statusCode).toBe(200);
      await eventually(() =>
        Promise.resolve(newerRequests === 1 ? true : null)
      );
      const newerClaim = claim();
      expect(newerClaim?.tracklist_run_id).toBeString();
      expect(newerClaim?.tracklist_run_id).not.toBe(
        staleClaim?.tracklist_run_id
      );
      await server.app.dispose();
      expect(claim()).toEqual(newerClaim);
      const duplicate = await request(newer, {
        method: "POST",
        url: `/sets/${id}/tracklist/retry`,
      });
      expect(duplicate.statusCode).toBe(200);
      expect(newerRequests).toBe(1);
      blocked.resolve(null);
      const ready = await waitForState(newer, id, "ready");
      expect(ready.json()).toEqual({ cues: newerCues, state: "ready" });
      expect(claim()).toEqual({
        tracklist_run_id: null,
        tracklist_run_started_at: null,
        tracklist_state: "ready",
      });
    } finally {
      db.close();
    }
  } finally {
    blocked.resolve(null);
    await newer.dispose();
    await server.dispose();
  }
});

test("two HTTP retries arriving together start only one Versos run", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "orbis-tracklists-race-")
  );
  const databasePath = path.join(directory, "library.sqlite");
  const seedApp = createApp({
    databasePath,
    metadata: Metadata.layerOf({
      details: () => Effect.succeed(DETAILS),
      enrich: () => Effect.die("title supplied by caller"),
    }),
  });
  const saved = await save(seedApp);
  const id = String(saved.json().id);
  const seedDb = new Sqlite(databasePath);
  try {
    await eventually(() => {
      const row = seedDb
        .query<{ details_state: string }, [string]>(
          "SELECT details_state FROM sets WHERE id = ?"
        )
        .get(id);
      return Promise.resolve(row?.details_state === "filled" ? true : null);
    });
  } finally {
    seedDb.close();
    await seedApp.dispose();
  }
  const blocked = Promise.withResolvers<null>();
  let requests = 0;
  const app = createApp({
    databasePath,
    versos: Versos.layerOf({
      poll: () => Effect.succeed({ state: "none" }),
      request: () => {
        requests += 1;
        return Effect.promise(() => blocked.promise).pipe(
          Effect.as({ requestId: "race-job" })
        );
      },
    }),
  });
  try {
    const responses = await Promise.all([
      request(app, { method: "POST", url: `/sets/${id}/tracklist/retry` }),
      request(app, { method: "POST", url: `/sets/${id}/tracklist/retry` }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([
      200, 200,
    ]);
    await eventually(() => Promise.resolve(requests > 0 ? true : null));
    await Bun.sleep(25);
    expect(requests).toBe(1);
    blocked.resolve(null);
    const none = await waitForState(app, id, "none");
    expect(none.json()).toEqual({ cues: [], state: "none" });
  } finally {
    blocked.resolve(null);
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("backfill skips a live HTTP run and an expired run cannot replace newer Cues", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "orbis-tracklists-lease-")
  );
  const databasePath = path.join(directory, "library.sqlite");
  const seedApp = createApp({
    databasePath,
    metadata: Metadata.layerOf({
      details: () => Effect.succeed(DETAILS),
      enrich: () => Effect.die("title supplied by caller"),
    }),
  });
  const saved = await save(seedApp);
  const id = String(saved.json().id);
  const seedDb = new Sqlite(databasePath);
  try {
    await eventually(() => {
      const row = seedDb
        .query<{ details_state: string }, [string]>(
          "SELECT details_state FROM sets WHERE id = ?"
        )
        .get(id);
      return Promise.resolve(row?.details_state === "filled" ? true : null);
    });
  } finally {
    seedDb.close();
    await seedApp.dispose();
  }

  const blocked = Promise.withResolvers<null>();
  let liveRequests = 0;
  const app = createApp({
    databasePath,
    versos: Versos.layerOf({
      poll: () => Effect.die("the first request fails before polling"),
      request: () => {
        liveRequests += 1;
        return Effect.promise(() => blocked.promise).pipe(
          Effect.flatMap(() =>
            Effect.fail(new VersosError({ reason: "unavailable" }))
          )
        );
      },
    }),
  });
  const newerCues = CUES.map((cue) => ({ ...cue, artist: "Newer Artist" }));
  let backfillRequests = 0;
  const layers = Layer.mergeAll(
    databaseLayer({
      databasePath,
      migrationsFolder: path.resolve(import.meta.dir, "../drizzle"),
    }),
    Versos.layerOf({
      poll: () => Effect.succeed({ cues: newerCues, state: "ready" }),
      request: () => {
        backfillRequests += 1;
        return Effect.succeed({ requestId: "newer-run" });
      },
    })
  );
  try {
    const retry = await request(app, {
      method: "POST",
      url: `/sets/${id}/tracklist/retry`,
    });
    expect(retry.statusCode).toBe(200);
    await eventually(() => Promise.resolve(liveRequests === 1 ? true : null));

    const whileLive = await Effect.runPromise(
      backfillTracklists({ delayMillis: 0 }).pipe(Effect.provide(layers))
    );
    expect(whileLive).toEqual({ attempted: 1, completed: 0 });
    expect(backfillRequests).toBe(0);

    let staleToken: string;
    const db = new Sqlite(databasePath);
    try {
      const row = db
        .query<{ tracklist_run_id: string | null }, [string]>(
          "SELECT tracklist_run_id FROM sets WHERE id = ?"
        )
        .get(id);
      if (
        row === null ||
        row.tracklist_run_id === null ||
        row.tracklist_run_id === ""
      ) {
        throw new Error("The live run did not claim the Set.");
      }
      staleToken = row.tracklist_run_id;
      db.query("UPDATE sets SET tracklist_run_started_at = ? WHERE id = ?").run(
        "2000-01-01T00:00:00.000Z",
        id
      );
    } finally {
      db.close();
    }
    const afterExpiry = await Effect.runPromise(
      backfillTracklists({ delayMillis: 0 }).pipe(Effect.provide(layers))
    );
    expect(afterExpiry).toEqual({ attempted: 1, completed: 1 });
    expect(backfillRequests).toBe(1);

    const staleClaim = {
      description: DETAILS.description,
      id,
      source: "youtube" as const,
      token: staleToken,
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    };
    const database = databaseLayer({
      databasePath,
      migrationsFolder: path.resolve(import.meta.dir, "../drizzle"),
    });
    const staleReady = await Effect.runPromise(
      runClaimedTracklist(staleClaim).pipe(
        Effect.provide(
          Layer.mergeAll(
            database,
            Versos.layerOf({
              poll: () => Effect.succeed({ cues: CUES, state: "ready" }),
              request: () => Effect.succeed({ requestId: "stale-ready" }),
            })
          )
        )
      )
    );
    expect(staleReady).toBe("pending");
    const afterStaleReady = await read(app, id);
    expect(afterStaleReady.json()).toEqual({ cues: newerCues, state: "ready" });

    await Effect.runPromise(
      runClaimedTracklist(staleClaim).pipe(
        Effect.provide(
          Layer.mergeAll(
            database,
            Versos.layerOf({
              poll: () => Effect.die("request fails before polling"),
              request: () =>
                Effect.fail(new VersosError({ reason: "unavailable" })),
            })
          )
        )
      )
    );
    const afterStaleFailure = await read(app, id);
    expect(afterStaleFailure.json()).toEqual({
      cues: newerCues,
      state: "ready",
    });
  } finally {
    blocked.resolve(null);
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("a Set removed during a Versos run gets no Cues, and hidden Sets deny Tracklist reads", async () => {
  const blocked = Promise.withResolvers<null>();
  const requested = Promise.withResolvers<null>();
  const settled = Promise.withResolvers<null>();
  const server = await start(
    Versos.layerOf({
      poll: () => Effect.succeed({ cues: CUES, state: "ready" }),
      request: () => {
        requested.resolve(null);
        return Effect.promise(() => blocked.promise).pipe(
          Effect.as({ requestId: "job-4" })
        );
      },
    }),
    (event) => {
      if (event.job === "tracklist") {
        settled.resolve(null);
      }
    }
  );
  try {
    const saved = await save(server.app);
    const id = String(saved.json().id);
    await requested.promise;
    const removed = await request(server.app, {
      method: "DELETE",
      url: `/sets/${id}`,
    });
    expect(removed.statusCode).toBe(200);
    blocked.resolve(null);
    await settled.promise;
    const hidden = await read(server.app, id);
    expect(hidden.statusCode).toBe(404);
    const db = new Sqlite(server.databasePath);
    try {
      expect(
        db.query("SELECT * FROM set_cues WHERE set_id = ?").all(id)
      ).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    blocked.resolve(null);
    await server.dispose();
  }
});

test("backfill requests an existing pending Set and skips the ready result on the next run", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "orbis-tracklists-backfill-")
  );
  const databasePath = path.join(directory, "library.sqlite");
  const app = createApp({
    databasePath,
    metadata: Metadata.layerOf({
      details: () => Effect.succeed(DETAILS),
      enrich: () => Effect.die("title supplied by caller"),
    }),
  });
  try {
    const saved = await save(app);
    expect(saved.statusCode).toBe(201);
    const id = String(saved.json().id);
    const db = new Sqlite(databasePath);
    try {
      await eventually(() => {
        const row = db
          .query<{ details_state: string }, [string]>(
            "SELECT details_state FROM sets WHERE id = ?"
          )
          .get(id);
        return Promise.resolve(row?.details_state === "filled" ? true : null);
      });
    } finally {
      db.close();
    }
    await app.dispose();
    let requests = 0;
    const layers = Layer.mergeAll(
      databaseLayer({
        databasePath,
        migrationsFolder: path.resolve(import.meta.dir, "../drizzle"),
      }),
      Versos.layerOf({
        poll: () => Effect.succeed({ cues: CUES, state: "ready" }),
        request: () => {
          requests += 1;
          return Effect.succeed({ requestId: "backfill-job" });
        },
      })
    );
    const first = await Effect.runPromise(
      backfillTracklists({ delayMillis: 0 }).pipe(Effect.provide(layers))
    );
    const second = await Effect.runPromise(
      backfillTracklists({ delayMillis: 0 }).pipe(Effect.provide(layers))
    );
    expect(first).toEqual({ attempted: 1, completed: 1 });
    expect(second).toEqual({ attempted: 0, completed: 0 });
    expect(requests).toBe(1);
    const reloaded = createApp({ databasePath });
    try {
      const tracklist = await read(reloaded, id);
      expect(tracklist.json()).toEqual({
        cues: CUES,
        state: "ready",
      });
    } finally {
      await reloaded.dispose();
    }
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("a Versos failure after the save response is logged in its own event", async () => {
  const events: WideEvent[] = [];
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-tracklists-log-"));
  const app = createApp({
    databasePath: path.join(directory, "library.sqlite"),
    logging: {
      onEvent: (event) => {
        events.push(event);
      },
      silent: true,
    },
    metadata: Metadata.layerOf({
      details: () => Effect.succeed(DETAILS),
      enrich: () => Effect.die("title supplied by caller"),
    }),
    versos: Versos.layerOf({
      poll: () => Effect.die("the request fails first"),
      request: () => Effect.fail(new VersosError({ reason: "rejected" })),
    }),
  });
  try {
    const saved = await save(app);
    expect(saved.statusCode).toBe(201);
    const id = String(saved.json().id);
    await waitForState(app, id, "failed");
    const run = await eventually(() =>
      Promise.resolve(events.find((event) => event.job === "tracklist") ?? null)
    );
    expect(run.set).toBe(id);
    expect(run.logs).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "set Tracklist request failed",
        reason: "rejected",
        set: id,
      }),
    ]);
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("an unconfigured Versos leaves the Set pending and says why", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "orbis-tracklists-unconfigured-")
  );
  const databasePath = path.join(directory, "library.sqlite");
  const app = createApp({
    databasePath,
    metadata: Metadata.layerOf({
      details: () => Effect.succeed(DETAILS),
      enrich: () => Effect.die("title supplied by caller"),
    }),
  });
  try {
    const saved = await save(app);
    expect(saved.statusCode).toBe(201);
    const id = String(saved.json().id);
    const db = new Sqlite(databasePath);
    try {
      await eventually(() => {
        const row = db
          .query<{ details_state: string }, [string]>(
            "SELECT details_state FROM sets WHERE id = ?"
          )
          .get(id);
        return Promise.resolve(row?.details_state === "filled" ? true : null);
      });
    } finally {
      db.close();
    }
    await app.dispose();
    const warnings: { message: unknown; set: unknown }[] = [];
    const capture = Logger.make((options) => {
      if (options.logLevel === "Warn") {
        warnings.push({
          message: options.message,
          set: options.fiber.getRef(References.CurrentLogAnnotations).set,
        });
      }
    });
    const layers = Layer.mergeAll(
      databaseLayer({
        databasePath,
        migrationsFolder: path.resolve(import.meta.dir, "../drizzle"),
      }),
      Versos.unconfigured(),
      Logger.layer([capture])
    );
    const result = await Effect.runPromise(
      backfillTracklists({ delayMillis: 0 }).pipe(Effect.provide(layers))
    );
    expect(result).toEqual({ attempted: 1, completed: 0 });
    expect(warnings).toEqual([
      { message: ["set Tracklist skipped: Versos is not configured"], set: id },
    ]);
    const reloaded = createApp({ databasePath });
    try {
      const tracklist = await read(reloaded, id);
      expect(tracklist.json()).toEqual({ cues: [], state: "pending" });
    } finally {
      await reloaded.dispose();
    }
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

// A pending Tracklist is one of three things: a run is finding it, nothing has started, or its
// run was lost. Every client shows the first and offers no retry, so the third must end by
// itself.
//
// Ways it could fail:
// - A restart, or a worker that died with its claim, leaves the Tracklist pending for good.
// - A read starts a second run while another worker still holds a live claim.
// - A read starts a run before the Set's details are read, or for a Set with no Versos.
test("transcript: a pending Tracklist whose run was lost is found again when someone reads it", async () => {
  let requests = 0;
  const stopped = await start(
    Versos.layerOf({
      poll: () => Effect.never,
      request: () => {
        requests += 1;
        return Effect.never;
      },
    })
  );
  const row = (id: string) => {
    const db = new Sqlite(stopped.databasePath);
    try {
      const found = db
        .query<
          { state: string; run: string | null; cues: number },
          [string, string]
        >(
          "SELECT tracklist_state AS state, tracklist_run_id AS run, (SELECT count(*) FROM set_cues WHERE set_id = ?) AS cues FROM sets WHERE id = ?"
        )
        .get(id, id);
      return `${found?.state}, ${found?.run === null ? "no run" : "a run"}, ${found?.cues} Cues, ${requests} Versos requests`;
    } finally {
      db.close();
    }
  };
  const claim = (id: string, startedAt: string) => {
    const db = new Sqlite(stopped.databasePath);
    try {
      db.query(
        "UPDATE sets SET tracklist_state = 'pending', tracklist_run_id = 'another-worker', tracklist_run_started_at = ? WHERE id = ?"
      ).run(startedAt, id);
      db.query("DELETE FROM set_cues WHERE set_id = ?").run(id);
    } finally {
      db.close();
    }
  };
  try {
    const t = transcript();
    const saved = await save(stopped.app);
    const id = String(saved.json().id);
    await eventually(() => Promise.resolve(requests === 1 ? true : null));
    await stopped.app.dispose();
    t.step("save a Set, stop the service during its Versos request", row(id));

    const restarted = createApp({
      databasePath: stopped.databasePath,
      versos: Versos.layerOf({
        poll: () => Effect.succeed({ cues: CUES, state: "ready" }),
        request: () => {
          requests += 1;
          return Effect.succeed({ requestId: `job-${requests}` });
        },
      }),
    });
    try {
      const settled = async () => {
        await read(restarted, id);
        await Bun.sleep(50);
        const answer = await read(restarted, id);
        return `${answer.json().state} | ${row(id)}`;
      };
      t.step("restart, read the Tracklist twice", await settled());

      // A claim holds for five minutes from its start: one dated 2100 is live whenever this
      // runs, and one dated 2000 is past its lease.
      claim(id, "2100-01-01T00:00:00.000Z");
      t.step("another worker holds a live claim, read twice", await settled());

      claim(id, "2000-01-01T00:00:00.000Z");
      t.step("that claim is past its lease, read twice", await settled());
    } finally {
      await restarted.dispose();
    }

    expect(t.text()).toMatchInlineSnapshot(`
      "
      save a Set, stop the service during its Versos request  -> pending, no run, 0 Cues, 1 Versos requests
      restart, read the Tracklist twice  -> ready | ready, no run, 2 Cues, 2 Versos requests
      another worker holds a live claim, read twice  -> pending | pending, a run, 0 Cues, 2 Versos requests
      that claim is past its lease, read twice  -> ready | ready, no run, 2 Cues, 3 Versos requests
      "
    `);
  } finally {
    await stopped.dispose();
  }
});

// Versos scans a Set's description, so a Tracklist run starts only once the details are read.
//
// Ways it could fail:
// - The details read fails and the Tracklist stays pending, which every client shows as
//   "Finding tracklist…" with no retry.
// - Try again after that does not read the details again.
test("transcript: a Set whose details read failed shows a failed Tracklist, and a retry finds it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-tracklists-"));
  const databasePath = path.join(directory, "library.sqlite");
  let down = true;
  let detailsReads = 0;
  const app = createApp({
    databasePath,
    logging: { silent: true },
    metadata: Metadata.layerOf({
      details: () => {
        detailsReads += 1;
        return down
          ? Effect.fail(
              new MetadataError({
                message: "yt-dlp could not read the source.",
                reason: "provider-unavailable",
              })
            )
          : Effect.succeed(DETAILS);
      },
      enrich: () => Effect.die("title supplied by caller"),
    }),
    versos: Versos.layerOf({
      poll: () => Effect.succeed({ cues: CUES, state: "ready" }),
      request: () => Effect.succeed({ requestId: "job-1" }),
    }),
  });
  const detailsState = (id: string) => {
    const db = new Sqlite(databasePath);
    try {
      return db
        .query<{ details_state: string }, [string]>(
          "SELECT details_state FROM sets WHERE id = ?"
        )
        .get(id)?.details_state;
    } finally {
      db.close();
    }
  };
  try {
    const t = transcript();
    const line = async (id: string) => {
      const answer = await read(app, id);
      return `${answer.json().state}, ${answer.json().cues.length} Cues | details ${detailsState(id)}, ${detailsReads} reads`;
    };
    const saved = await save(app);
    const id = String(saved.json().id);
    await eventually(() =>
      Promise.resolve(detailsState(id) === "failed" ? true : null)
    );
    t.step("save a Set while its source cannot be read", await line(id));

    down = false;
    const retried = await request(app, {
      method: "POST",
      url: `/sets/${id}/tracklist/retry`,
    });
    await waitForState(app, id, "ready");
    t.step(
      `the source answers again, Try again (${retried.statusCode})`,
      await line(id)
    );

    expect(t.text()).toMatchInlineSnapshot(`
      "
      save a Set while its source cannot be read  -> failed, 0 Cues | details failed, 1 reads
      the source answers again, Try again (200)  -> ready, 2 Cues | details filled, 2 reads
      "
    `);
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

// A restart can stop a Set's details read before it records the details or the failure, which
// leaves the details and the Tracklist pending with nothing to move them.
//
// Ways it could fail:
// - A read of the Tracklist starts nothing, so it shows "Finding tracklist…" for good.
// - Reads or a Try again during a running details read start a second yt-dlp read.
// - A details read that fails leaves the Tracklist pending, or a later read reads again.
// - A read of a Set whose details failed reads the source again.
test("transcript: a Set whose details read was lost to a restart reads its details again when someone reads its Tracklist", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-tracklists-"));
  const databasePath = path.join(directory, "library.sqlite");
  const urls = {
    answers: "https://www.youtube.com/watch?v=answersaaaa",
    fails: "https://www.youtube.com/watch?v=failsbbbbbb",
    held: "https://www.youtube.com/watch?v=heldccccccc",
  };
  const kinds = ["answers", "fails", "held"] as const;
  const reads = { answers: 0, fails: 0, held: 0 };
  const kindOf = (url: string) =>
    kinds.find((kind) => urls[kind] === url) ?? "answers";
  const versos = Versos.layerOf({
    poll: () => Effect.succeed({ cues: CUES, state: "ready" }),
    request: () => Effect.succeed({ requestId: "job-1" }),
  });
  const row = (id: string) => {
    const db = new Sqlite(databasePath);
    try {
      const found = db
        .query<{ details: string; tracklist: string }, [string]>(
          "SELECT details_state AS details, tracklist_state AS tracklist FROM sets WHERE id = ?"
        )
        .get(id);
      return `details ${found?.details}, Tracklist ${found?.tracklist}`;
    } finally {
      db.close();
    }
  };

  const stopped = createApp({
    databasePath,
    logging: { silent: true },
    metadata: Metadata.layerOf({
      details: () => Effect.never,
      enrich: () => Effect.die("title supplied by caller"),
    }),
    versos,
  });
  const [answersSet, failsSet, heldSet] = await Promise.all(
    kinds.map((kind) =>
      request(stopped, {
        method: "POST",
        payload: { title: `The ${kind} mix`, url: urls[kind] },
        url: "/sets",
      })
    )
  );
  const ids = {
    answers: String(answersSet?.json().id),
    fails: String(failsSet?.json().id),
    held: String(heldSet?.json().id),
  };
  await stopped.dispose();

  const answers = {
    answers: Promise.withResolvers<null>(),
    held: Promise.withResolvers<null>(),
  };
  const app = createApp({
    databasePath,
    logging: { silent: true },
    metadata: Metadata.layerOf({
      details: ({ url }) => {
        const kind = kindOf(url);
        reads[kind] += 1;
        if (kind === "fails") {
          return Effect.fail(
            new MetadataError({
              message: "yt-dlp could not read the source.",
              reason: "provider-unavailable",
            })
          );
        }
        return Effect.promise(() => answers[kind].promise).pipe(
          Effect.as(DETAILS)
        );
      },
      enrich: () => Effect.die("title supplied by caller"),
    }),
    versos,
  });
  try {
    const t = transcript();
    // Each read waits for the first details read to start, so the count it shows is settled.
    const line = async (kind: keyof typeof urls) => {
      const answer = await read(app, ids[kind]);
      await eventually(() => Promise.resolve(reads[kind] > 0 ? true : null));
      return `${answer.json().state} | ${row(ids[kind])}, ${reads[kind]} reads`;
    };
    t.step(
      "save three Sets, stop the service during their details reads",
      kinds.map((kind) => row(ids[kind])).join(" | ")
    );

    t.step("restart, read the Tracklist", await line("answers"));
    answers.answers.resolve(null);
    await waitForState(app, ids.answers, "ready");
    t.step("the source answers, read again", await line("answers"));

    t.step("read a Set whose source holds the read open", await line("held"));
    t.step("read again", await line("held"));
    const retried = await request(app, {
      method: "POST",
      url: `/sets/${ids.held}/tracklist/retry`,
    });
    t.step(`Try again (${retried.statusCode}), read again`, await line("held"));
    answers.held.resolve(null);
    await waitForState(app, ids.held, "ready");
    t.step("the source answers, read again", await line("held"));

    await read(app, ids.fails);
    await waitForState(app, ids.fails, "failed");
    t.step("read a Set whose source fails, read again", await line("fails"));
    await Bun.sleep(50);
    t.step("wait, read again", await line("fails"));

    expect(t.text()).toMatchInlineSnapshot(`
      "
      save three Sets, stop the service during their details reads  -> details pending, Tracklist pending | details pending, Tracklist pending | details pending, Tracklist pending
      restart, read the Tracklist  -> pending | details pending, Tracklist pending, 1 reads
      the source answers, read again  -> ready | details filled, Tracklist ready, 1 reads
      read a Set whose source holds the read open  -> pending | details pending, Tracklist pending, 1 reads
      read again  -> pending | details pending, Tracklist pending, 1 reads
      Try again (200), read again  -> pending | details pending, Tracklist pending, 1 reads
      the source answers, read again  -> ready | details filled, Tracklist ready, 1 reads
      read a Set whose source fails, read again  -> failed | details failed, Tracklist failed, 1 reads
      wait, read again  -> failed | details failed, Tracklist failed, 1 reads
      "
    `);
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});
