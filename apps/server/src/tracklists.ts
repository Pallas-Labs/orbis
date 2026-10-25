import type { Cue, Tracklist } from "@orbis/contracts";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { Duration, Effect, Schedule } from "effect";

import { insertBatches } from "./db/batches.js";
import {
  libraryEntries,
  playlistSets,
  queueEntries,
  setCues,
  sets,
} from "./db/schema.js";
import { Database } from "./db/service.js";
import { LibraryError } from "./errors.js";
import { Versos } from "./versos.js";

// Waits 250 ms, doubling to a 4 s ceiling, for 8 waits: 19.75 s before the run times out.
const pollSchedule = Schedule.exponential("250 millis").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(4)))
  ),
  Schedule.upTo({ times: 8 })
);
const RUN_LEASE_MS = 5 * 60_000;

interface TracklistClaim {
  readonly description: string | null;
  readonly id: string;
  readonly source: (typeof sets.$inferSelect)["source"];
  readonly token: string;
  readonly url: string;
}

const hasReference = (db: typeof Database.Service, id: string) =>
  db.get<{ readonly present: number }>(sql`
    SELECT 1 AS present FROM ${libraryEntries} WHERE ${libraryEntries.setId} = ${id}
    UNION ALL SELECT 1 AS present FROM ${playlistSets} WHERE ${playlistSets.setId} = ${id}
    UNION ALL SELECT 1 AS present FROM ${queueEntries} WHERE ${queueEntries.setId} = ${id}
    LIMIT 1
  `);

/** Replaces a Set's Cues. Run it inside the transaction that sets the Tracklist state. */
export const replaceCues = Effect.fnUntraced(function* replaceCuesEffect(
  db: typeof Database.Service,
  id: string,
  cues: readonly Cue[]
) {
  yield* db.delete(setCues).where(eq(setCues.setId, id));
  const rows = cues.map((cue) => ({ ...cue, setId: id }));
  for (const batch of insertBatches(setCues, rows)) {
    yield* db.insert(setCues).values(batch);
  }
});

// An optional `H:MM:SS` or `MM:SS` start at the front of a line.
const PASTED_START =
  /^(?:(?<hours>\d+):)?(?<minutes>\d{1,2}):(?<seconds>[0-5]\d)\s/u;
// Searched, not matched with the rest of the line, so a long line cannot make it backtrack.
const ARTIST_TITLE_SEPARATOR = /\s-\s/u;

/** The Cues in pasted text, one per line. A line with no `Artist - Title`, such as a heading, is skipped. */
export const parsePastedTracklist = (text: string): Cue[] =>
  text
    .split(/\r?\n/u)
    .flatMap((raw) => {
      const line = raw.trim();
      const start = PASTED_START.exec(line);
      const rest = start ? line.slice(start[0].length) : line;
      const separator = rest.search(ARTIST_TITLE_SEPARATOR);
      const artist = rest.slice(0, Math.max(separator, 0)).trim();
      const title = rest.slice(separator + 3).trim();
      if (separator === -1 || artist === "" || title === "") {
        return [];
      }
      const { hours, minutes, seconds } = start?.groups ?? {};
      const startSeconds =
        minutes === undefined || seconds === undefined
          ? null
          : Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
      return [{ artist, startSeconds, title }];
    })
    .map((cue, position) => ({
      ...cue,
      appleMusicId: null,
      artworkUrl: null,
      position,
    }));

export const readTracklist = Effect.fn("Tracklists.read")((id: string) =>
  Effect.gen(function* readTracklistEffect() {
    const db = yield* Database;
    const [set] = yield* db
      .select({ state: sets.tracklistState })
      .from(sets)
      .where(eq(sets.id, id));
    if (!set) {
      return yield* Effect.fail(
        new LibraryError({ message: "Set not found.", statusCode: 404 })
      );
    }
    const cues = yield* db
      .select({
        appleMusicId: setCues.appleMusicId,
        artist: setCues.artist,
        artworkUrl: setCues.artworkUrl,
        position: setCues.position,
        startSeconds: setCues.startSeconds,
        title: setCues.title,
      })
      .from(setCues)
      .where(eq(setCues.setId, id))
      .orderBy(asc(setCues.position));
    return { cues, state: set.state } satisfies Tracklist;
  })
);

export const claimTracklist = Effect.fn("Tracklists.claim")(
  (id: string, retry = false) =>
    Effect.gen(function* claimTracklistEffect() {
      const db = yield* Database;
      const token = crypto.randomUUID();
      const startedAt = new Date().toISOString();
      const expiredAt = new Date(Date.now() - RUN_LEASE_MS).toISOString();
      const [claimed] = yield* db
        .update(sets)
        .set({
          tracklistRunId: token,
          tracklistRunStartedAt: startedAt,
          tracklistState: "pending",
        })
        .where(
          and(
            eq(sets.id, id),
            retry
              ? undefined
              : inArray(sets.tracklistState, ["pending", "failed"]),
            or(
              isNull(sets.tracklistRunId),
              lt(sets.tracklistRunStartedAt, expiredAt)
            ),
            sql`EXISTS (
            SELECT 1 FROM ${libraryEntries} WHERE ${libraryEntries.setId} = ${sets.id}
            UNION ALL SELECT 1 FROM ${playlistSets} WHERE ${playlistSets.setId} = ${sets.id}
            UNION ALL SELECT 1 FROM ${queueEntries} WHERE ${queueEntries.setId} = ${sets.id}
          )`
          )
        )
        .returning({
          description: sets.description,
          id: sets.id,
          source: sets.source,
          url: sets.url,
        });
      return claimed ? ({ ...claimed, token } satisfies TracklistClaim) : null;
    })
);

const finishTracklist = Effect.fn("Tracklists.finishTracklist")(
  function* finishTracklistEffect(
    claim: TracklistClaim,
    result: { state: "none" } | { state: "ready"; cues: readonly Cue[] }
  ) {
    const db = yield* Database;
    return yield* db.transaction((tx) =>
      Effect.gen(function* finish() {
        const [owned] = yield* tx
          .update(sets)
          .set({
            tracklistRunId: null,
            tracklistRunStartedAt: null,
            tracklistState: result.state,
          })
          .where(
            and(eq(sets.id, claim.id), eq(sets.tracklistRunId, claim.token))
          )
          .returning({ id: sets.id });
        if (!owned) {
          return false;
        }
        if (!(yield* hasReference(tx, claim.id))) {
          yield* tx
            .update(sets)
            .set({ tracklistState: "pending" })
            .where(eq(sets.id, claim.id));
          yield* tx.delete(setCues).where(eq(setCues.setId, claim.id));
          return false;
        }
        yield* replaceCues(
          tx,
          claim.id,
          result.state === "ready" ? result.cues : []
        );
        return true;
      })
    );
  }
);

const releaseClaim = Effect.fn("Tracklists.releaseClaim")(
  function* releaseTracklistClaim(
    claim: TracklistClaim,
    state: "pending" | "failed"
  ) {
    const db = yield* Database;
    yield* db
      .update(sets)
      .set({
        tracklistRunId: null,
        tracklistRunStartedAt: null,
        tracklistState: state,
      })
      .where(and(eq(sets.id, claim.id), eq(sets.tracklistRunId, claim.token)));
  }
);

export const runClaimedTracklist = Effect.fn("Tracklists.runClaimed")(
  (claim: TracklistClaim) =>
    Effect.gen(function* runClaimedTracklistEffect() {
      const versos = yield* Versos;
      if (!claim.description?.trim()) {
        return (yield* finishTracklist(claim, { state: "none" }))
          ? "none"
          : "pending";
      }
      const requested = yield* Effect.result(
        versos.request({
          description: claim.description,
          source: claim.source,
          url: claim.url,
        })
      );
      if (requested._tag === "Failure") {
        if (requested.failure.reason === "not-configured") {
          yield* releaseClaim(claim, "pending");
          yield* Effect.logWarning(
            "set Tracklist skipped: Versos is not configured"
          ).pipe(Effect.annotateLogs({ set: claim.id }));
          return "pending" as const;
        }
        yield* releaseClaim(claim, "failed");
        yield* Effect.logWarning("set Tracklist request failed").pipe(
          Effect.annotateLogs({
            reason: requested.failure.reason,
            set: claim.id,
          })
        );
        return "failed" as const;
      }
      const answer = yield* Effect.result(
        Effect.suspend(() => versos.poll(requested.success.requestId)).pipe(
          Effect.repeat({
            schedule: pollSchedule,
            until: (poll): boolean => poll.state !== "pending",
          })
        )
      );
      if (answer._tag === "Failure") {
        yield* releaseClaim(claim, "failed");
        yield* Effect.logWarning("set Tracklist poll failed").pipe(
          Effect.annotateLogs({
            reason: answer.failure.reason,
            set: claim.id,
          })
        );
        return "failed" as const;
      }
      if (answer.success.state !== "pending") {
        return (yield* finishTracklist(claim, answer.success))
          ? answer.success.state
          : "pending";
      }
      yield* releaseClaim(claim, "failed");
      yield* Effect.logWarning("set Tracklist poll timed out").pipe(
        Effect.annotateLogs({ set: claim.id })
      );
      return "failed" as const;
    }).pipe(Effect.onInterrupt(() => releaseClaim(claim, "pending")))
);

export const runTracklist = Effect.fn("Tracklists.run")((id: string) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* runTracklistEffect() {
      const claim = yield* claimTracklist(id);
      return claim ? yield* restore(runClaimedTracklist(claim)) : "pending";
    })
  )
);
