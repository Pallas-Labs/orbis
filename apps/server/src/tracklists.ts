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

export interface TracklistClaim {
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

const hasCues = (db: typeof Database.Service, id: string) =>
  db.get<{ readonly present: number }>(sql`
    SELECT 1 AS present FROM ${setCues} WHERE ${setCues.setId} = ${id} LIMIT 1
  `);

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
            retry === true
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
        // Only an answer with Cues replaces a Set's Cues, so a refresh that finds nothing
        // leaves the Tracklist the Set already had.
        const kept =
          (result.state === "none" || result.cues.length === 0) &&
          Boolean(yield* hasCues(tx, claim.id));
        const [owned] = yield* tx
          .update(sets)
          .set({
            tracklistRunId: null,
            tracklistRunStartedAt: null,
            tracklistState: kept ? "ready" : result.state,
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
        if (kept) {
          return true;
        }
        yield* tx.delete(setCues).where(eq(setCues.setId, claim.id));
        if (result.state === "ready") {
          const rows = result.cues.map((cue) => ({ ...cue, setId: claim.id }));
          for (const batch of insertBatches(setCues, rows)) {
            yield* tx.insert(setCues).values(batch);
          }
        }
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
        // A run that ends without an answer leaves a Set's existing Cues ready.
        tracklistState: sql`CASE WHEN EXISTS (
          SELECT 1 FROM ${setCues} WHERE ${setCues.setId} = ${claim.id}
        ) THEN 'ready' ELSE ${state} END`,
      })
      .where(and(eq(sets.id, claim.id), eq(sets.tracklistRunId, claim.token)));
  }
);

/**
 * Asks Versos for the claimed Set's Tracklist. A refresh passes `reread`, which reads the
 * source's description again, and Versos scans the Set again instead of returning its stored
 * answer.
 */
export const runClaimedTracklist = Effect.fn("Tracklists.runClaimed")(
  (claim: TracklistClaim, reread?: Effect.Effect<string | null>) =>
    Effect.gen(function* runClaimedTracklistEffect() {
      const versos = yield* Versos;
      const description = reread ? yield* reread : claim.description;
      if (description === null || description.trim() === "") {
        return (yield* finishTracklist(claim, { state: "none" }))
          ? "none"
          : "pending";
      }
      const requested = yield* Effect.result(
        versos.request({
          description,
          ...(reread && { force: true }),
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
