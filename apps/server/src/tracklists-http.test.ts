import { Database as Sqlite } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Layer, Logger, Redacted, References } from "effect";
import type { WideEvent } from "evlog";

import { backfillTracklists } from "./backfill-tracklists.js";
import { layer as databaseLayer } from "./db/database.js";
import { hashToken } from "./identity.js";
import { Metadata } from "./metadata.js";
import { createTestApp as createApp } from "./test-app.js";
import { request } from "./test-http.js";
import { runClaimedTracklist } from "./tracklists.js";
import { Versos, VersosError } from "./versos.js";
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
  onEvent?: (event: WideEvent) => void
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-tracklists-"));
  const databasePath = path.join(directory, "library.sqlite");
  const app = createApp({
    databasePath,
    logging: { onEvent: (event) => onEvent?.(event), silent: true },
    metadata: Metadata.layerOf({
      details: () => Effect.succeed(DETAILS),
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
  return eventually(check, attempts - 1);
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
        init?.signal?.addEventListener("abort", () =>
          pending.reject(new Error("aborted"))
        );
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
      if (!row?.tracklist_run_id) {
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
    logging: { onEvent: (event) => events.push(event), silent: true },
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

// The Tracklist PAL-1000 was written for: a heading line, a blank line, then 15 timed Cues.
const PASTED = await Bun.file(
  path.join(import.meta.dir, "fixtures/tracklists/skin-on-skin-ade-2026.txt")
).text();

const paste = (app: ReturnType<typeof createApp>, id: string, text: string) =>
  request(app, {
    method: "PUT",
    payload: { text },
    url: `/sets/${id}/tracklist`,
  });

test("a pasted Tracklist replaces the Versos Cues and Versos never sees it", async () => {
  let requests = 0;
  const server = await start(
    Versos.layerOf({
      poll: () => Effect.succeed({ cues: CUES, state: "ready" }),
      request: () => {
        requests += 1;
        return Effect.succeed({ requestId: "job-paste" });
      },
    })
  );
  try {
    const saved = await save(server.app);
    const id = String(saved.json().id);
    await waitForState(server.app, id, "ready");
    expect(requests).toBe(1);

    const pasted = await paste(server.app, id, PASTED);
    expect(pasted.statusCode).toBe(200);
    const { cues, state } = pasted.json();
    expect(state).toBe("ready");
    expect(cues).toHaveLength(15);
    expect(cues[0]).toEqual({
      appleMusicId: null,
      artist: "PLAX",
      artworkUrl: null,
      position: 0,
      startSeconds: 735,
      title: "Cursed",
    });
    expect(cues[1]).toMatchObject({
      artist: "X-Trance",
      title: "Friends 2000 (Fridge Remix)",
    });
    expect(cues[6]).toMatchObject({
      artist: "Jeno",
      startSeconds: 3725,
      title: "Oldskool",
    });
    expect(cues[14]).toMatchObject({
      artist: "Nia Archives",
      position: 14,
      startSeconds: 7915,
      title: "18 & Over",
    });
    const reread = await read(server.app, id);
    expect(reread.json()).toEqual({ cues, state });

    const untimed = await paste(
      server.app,
      id,
      "My notes\n\nFirst Artist - First song\n  0:30   Second Artist - Second - part two  \n"
    );
    expect(untimed.statusCode).toBe(200);
    const replaced = await read(server.app, id);
    expect(replaced.json()).toEqual({
      cues: [
        {
          appleMusicId: null,
          artist: "First Artist",
          artworkUrl: null,
          position: 0,
          startSeconds: null,
          title: "First song",
        },
        {
          appleMusicId: null,
          artist: "Second Artist",
          artworkUrl: null,
          position: 1,
          startSeconds: 30,
          title: "Second - part two",
        },
      ],
      state: "ready",
    });
    expect(requests).toBe(1);
  } finally {
    await server.dispose();
  }
});

test("pasting needs the Set in your own Library and at least one Cue", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbis-paste-"));
  const friendKey = "friend-paste-key";
  await writeFile(
    path.join(directory, "devices.json"),
    JSON.stringify({
      keys: [
        {
          addedAt: "2026-10-25T00:00:00.000Z",
          id: "friend-key",
          label: "phone",
          lastUsedAt: null,
          personId: "friend",
          scope: "daily",
          tokenHash: hashToken(friendKey),
        },
      ],
      people: [
        { id: "host", removed: false, username: "host" },
        { id: "friend", removed: false, username: "friend" },
      ],
      version: 2,
    })
  );
  const app = createApp({
    databasePath: path.join(directory, "library.sqlite"),
    logging: { silent: true },
    metadata: Metadata.layerOf({
      details: () => Effect.succeed(DETAILS),
      enrich: () => Effect.die("title supplied by caller"),
    }),
    versos: Versos.layerOf({
      poll: () => Effect.succeed({ cues: CUES, state: "ready" }),
      request: () => Effect.succeed({ requestId: "job-owner" }),
    }),
  });
  const asFriend = (
    method: string,
    url: string,
    payload?: { social: boolean } | { text: string }
  ) =>
    request(app, {
      headers: { authorization: `Bearer ${friendKey}` },
      method,
      payload,
      url,
    });
  try {
    const saved = await save(app);
    const id = String(saved.json().id);
    await waitForState(app, id, "ready");
    const hostSocial = await request(app, {
      method: "PATCH",
      payload: { social: true },
      url: "/me",
    });
    expect(hostSocial.statusCode).toBe(200);
    const friendSocial = await asFriend("PATCH", "/me", { social: true });
    expect(friendSocial.statusCode).toBe(200);
    // The friend can see this Set's Tracklist, yet cannot replace it.
    const seen = await asFriend("GET", `/sets/${id}/tracklist`);
    expect(seen.statusCode).toBe(200);
    const refused = await asFriend("PUT", `/sets/${id}/tracklist`, {
      text: PASTED,
    });
    expect(refused.statusCode).toBe(404);
    const missing = await paste(app, "no-such-set", PASTED);
    expect(missing.statusCode).toBe(404);

    const empty = await paste(app, id, "Skin On Skin | ADE 2026\n\n12:15\n");
    expect(empty.statusCode).toBe(400);
    expect(empty.json().message).toBe(
      "Paste one track per line, such as 12:15 Artist - Title."
    );
    // A long line of spaces once made the line pattern backtrack for minutes.
    const spaces = await paste(app, id, `00:00 ${" ".repeat(49_000)}x`);
    expect(spaces.statusCode).toBe(400);
    const kept = await read(app, id);
    expect(kept.json()).toEqual({ cues: CUES, state: "ready" });
  } finally {
    await app.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("a Versos run in flight when a Tracklist is pasted cannot replace it", async () => {
  const blocked = Promise.withResolvers<null>();
  const requested = Promise.withResolvers<null>();
  const settled = Promise.withResolvers<null>();
  const server = await start(
    Versos.layerOf({
      poll: () => Effect.succeed({ cues: CUES, state: "ready" }),
      request: () => {
        requested.resolve(null);
        return Effect.promise(() => blocked.promise).pipe(
          Effect.as({ requestId: "job-race" })
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
    const pasted = await paste(server.app, id, PASTED);
    expect(pasted.statusCode).toBe(200);
    blocked.resolve(null);
    await settled.promise;
    const after = await read(server.app, id);
    expect(after.json()).toEqual(pasted.json());
    expect(after.json().cues).toHaveLength(15);
  } finally {
    blocked.resolve(null);
    await server.dispose();
  }
});
