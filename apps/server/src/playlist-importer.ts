import type { PlaylistImport } from "@orbis/contracts";
import type { SaveSetResultSchema } from "@orbis/contracts/http-api";
import { and, asc, count, eq, sql } from "drizzle-orm";
import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  Queue,
  Schedule,
  Stream,
} from "effect";

import type { AlarmSlot } from "./alarm-scheduler.js";
import { insertBatches } from "./db/batches.js";
import { playlistImports, playlistSets, playlists } from "./db/schema.js";
import { Database } from "./db/service.js";
import type { DatabaseClient } from "./db/service.js";
import { asLibraryError, LibraryError } from "./errors.js";
import {
  MAX_PLAYLISTS_PER_SET,
  MAX_SETS_PER_PLAYLIST,
} from "./library-limits.js";
import { MetadataError } from "./metadata-error.js";
import { Metadata } from "./metadata.js";
import type { PlaylistTrack, YouTubePlaylistPage } from "./metadata.js";

export type AutoDownloadResult =
  (typeof SaveSetResultSchema.Type)["autoDownloadResult"];

/** A track saved to the owner's Library, with what Auto Download did with it. */
export interface SavedTrack {
  readonly autoDownloadResult: AutoDownloadResult;
  readonly id: string;
}

export interface PlaylistImporterOptions {
  /** Saves one track to the owner's Library the way a single save does. */
  readonly saveTrack: (
    personId: string,
    track: PlaylistTrack
  ) => Effect.Effect<SavedTrack, LibraryError>;
  /** Tells the owner's devices where an import stands. */
  readonly publish: (
    personId: string,
    playlistImport: PlaylistImport
  ) => Effect.Effect<void>;
  /** Wakes an evicted Group while an import runs. Bun keeps running, so it passes none. */
  readonly heartbeat?: AlarmSlot | undefined;
  /** How a YouTube read that YouTube could not answer is retried. */
  readonly retry?: Schedule.Schedule<unknown, MetadataError> | undefined;
  readonly startWorker?: boolean | undefined;
}

/** Long enough for a page of saves, short enough that an evicted Group resumes soon. */
const HEARTBEAT_MS = 30_000;
/** Progress is sent at most this often; the end is always sent. */
const PUBLISH_INTERVAL_MS = 1000;

const defaultRetry: Schedule.Schedule<unknown, MetadataError> =
  Schedule.exponential("500 millis").pipe(
    Schedule.jittered,
    Schedule.upTo({ times: 4 })
  );

interface Counts {
  readonly added: number;
  readonly downloading: number;
  readonly overLimit: number;
  readonly unavailable: number;
  readonly waiting: number;
}

/** Where an import stands. Counts grow in every state, so a failed import keeps its tally. */
type ImportState = Data.TaggedEnum<{
  Running: {
    /** The next page to read. Null before the first page. */
    readonly pageToken: string | null;
    readonly processed: number;
    readonly total: number | null;
  };
  Done: Record<never, never>;
  Failed: { readonly message: string };
}>;
const State = Data.taggedEnum<ImportState>();

interface ImportJob {
  readonly counts: Counts;
  readonly id: string;
  readonly personId: string;
  readonly playlistId: string;
  readonly sourcePlaylistId: string;
  readonly state: ImportState;
}

type ImportRow = typeof playlistImports.$inferSelect;

const stateOf = (row: ImportRow): ImportState => {
  switch (row.state) {
    case "running": {
      return State.Running({
        pageToken: row.pageToken,
        processed: row.processed,
        total: row.total,
      });
    }
    case "done": {
      return State.Done();
    }
    default: {
      return State.Failed({ message: row.failure ?? "" });
    }
  }
};

const jobOf = (row: ImportRow): ImportJob => ({
  counts: {
    added: row.added,
    downloading: row.downloading,
    overLimit: row.overLimit,
    unavailable: row.unavailable,
    waiting: row.waiting,
  },
  id: row.id,
  personId: row.personId,
  playlistId: row.playlistId,
  sourcePlaylistId: row.sourcePlaylistId,
  state: stateOf(row),
});

const stateColumns = (state: ImportState) =>
  State.$match(state, {
    Done: () => ({ failure: null, state: "done" as const }),
    Failed: ({ message }) => ({ failure: message, state: "failed" as const }),
    Running: ({ pageToken, processed, total }) => ({
      failure: null,
      pageToken,
      processed,
      state: "running" as const,
      total,
    }),
  });

const wireState = (job: ImportJob): PlaylistImport["state"] =>
  State.$match(job.state, {
    Done: () => ({ kind: "done" as const, ...job.counts }),
    Failed: ({ message }) => ({ kind: "failed" as const, message }),
    Running: ({ processed, total }) => ({
      kind: "running" as const,
      processed,
      total,
    }),
  });

/** What an import that could not start, or could not go on, says to the person. */
export const playlistImportRefusal = (error: MetadataError) => {
  switch (error.reason) {
    case "provider-rejected": {
      return new LibraryError({
        message:
          "YouTube can't share this playlist. Only public and unlisted playlists can be imported.",
        statusCode: 404,
      });
    }
    case "not-configured": {
      return new LibraryError({
        message: "Playlist import is not set up on this server.",
        statusCode: 503,
      });
    }
    default: {
      return new LibraryError({
        message: "YouTube is not answering. Try the import again.",
        statusCode: 503,
      });
    }
  }
};

const importNotFound = () =>
  new LibraryError({ message: "Import not found.", statusCode: 404 });

const playlistRemoved = "The Playlist was deleted during the import.";

/**
 * A re-import keeps the earlier Playlist, so the new one takes the next free name. Names are
 * unique without regard to case, so `taken` holds them lowercased.
 */
const freePlaylistName = (title: string, taken: ReadonlySet<string>) => {
  const base = title.slice(0, 90).trim() || "YouTube playlist";
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) {
    name = `${base} (${n})`;
  }
  return name;
};

const execute = asLibraryError("Could not complete the playlist import.");

/** The rows an import reads and writes. Each change commits in one transaction. */
const importStore = (db: DatabaseClient) => {
  const withPlaylist = Effect.fn("PlaylistImports.withPlaylist")(
    function* withPlaylist(client: DatabaseClient, job: ImportJob) {
      const [playlist] = yield* client
        .select({
          createdAt: playlists.createdAt,
          id: playlists.id,
          name: playlists.name,
          setCount: sql<number>`(
          SELECT COUNT(*) FROM ${playlistSets}
          WHERE ${playlistSets.playlistId} = ${playlists.id}
        )`,
        })
        .from(playlists)
        .where(eq(playlists.id, job.playlistId))
        .limit(1);
      return playlist ? { id: job.id, playlist, state: wireState(job) } : null;
    }
  );

  const write = (client: DatabaseClient, job: ImportJob, now: number) =>
    client
      .update(playlistImports)
      .set({ ...job.counts, ...stateColumns(job.state), updatedAt: now })
      .where(eq(playlistImports.id, job.id));

  /** The person's running import of this playlist, or a failed one to resume. */
  const reopen = Effect.fn("PlaylistImports.reopen")(
    (personId: string, sourcePlaylistId: string) =>
      execute(
        db.transaction((tx) =>
          Effect.gen(function* reopenImport() {
            const rows = yield* tx
              .select()
              .from(playlistImports)
              .where(
                and(
                  eq(playlistImports.personId, personId),
                  eq(playlistImports.sourcePlaylistId, sourcePlaylistId)
                )
              )
              .orderBy(sql`${playlistImports.updatedAt} DESC`);
            const running = rows.find((row) => row.state === "running");
            if (running) {
              return yield* withPlaylist(tx, jobOf(running));
            }
            const [latest] = rows;
            if (latest?.state !== "failed") {
              return null;
            }
            // Try Again after a failure continues the same Playlist from the page that failed.
            const job = jobOf(latest);
            const resumed = {
              ...job,
              state: State.Running({
                pageToken: latest.pageToken,
                processed: latest.processed,
                total: latest.total,
              }),
            };
            const shown = yield* withPlaylist(tx, resumed);
            if (!shown) {
              return null;
            }
            yield* write(tx, resumed, Date.now());
            return shown;
          })
        )
      )
  );

  const create = Effect.fn("PlaylistImports.create")(
    (input: {
      readonly personId: string;
      readonly sourcePlaylistId: string;
      readonly sourceUrl: string;
      readonly title: string;
      readonly total: number;
    }) =>
      execute(
        db.transaction((tx) =>
          Effect.gen(function* createImport() {
            const [running] = yield* tx
              .select()
              .from(playlistImports)
              .where(
                and(
                  eq(playlistImports.personId, input.personId),
                  eq(playlistImports.sourcePlaylistId, input.sourcePlaylistId),
                  eq(playlistImports.state, "running")
                )
              )
              .limit(1);
            if (running) {
              const shown = yield* withPlaylist(tx, jobOf(running));
              if (shown) {
                return shown;
              }
            }
            const taken = yield* tx
              .select({ name: playlists.name })
              .from(playlists)
              .where(eq(playlists.creatorId, input.personId));
            const playlist = {
              createdAt: new Date().toISOString(),
              id: crypto.randomUUID(),
              name: freePlaylistName(
                input.title,
                new Set(taken.map(({ name }) => name.toLowerCase()))
              ),
            };
            yield* tx
              .insert(playlists)
              .values({ ...playlist, creatorId: input.personId });
            const now = Date.now();
            const [row] = yield* tx
              .insert(playlistImports)
              .values({
                createdAt: now,
                id: crypto.randomUUID(),
                personId: input.personId,
                playlistId: playlist.id,
                sourcePlaylistId: input.sourcePlaylistId,
                sourceUrl: input.sourceUrl,
                state: "running",
                total: input.total,
                updatedAt: now,
              })
              .returning();
            if (!row) {
              return yield* Effect.fail(
                new LibraryError({
                  message: "Could not complete the playlist import.",
                  statusCode: 500,
                })
              );
            }
            return {
              id: row.id,
              playlist: { ...playlist, setCount: 0 },
              state: wireState(jobOf(row)),
            };
          })
        )
      )
  );

  const find = Effect.fn("PlaylistImports.find")(
    (personId: string, id: string) =>
      execute(
        Effect.gen(function* findImport() {
          const [row] = yield* db
            .select()
            .from(playlistImports)
            .where(
              and(
                eq(playlistImports.id, id),
                eq(playlistImports.personId, personId)
              )
            )
            .limit(1);
          const shown = row ? yield* withPlaylist(db, jobOf(row)) : null;
          if (!shown) {
            return yield* Effect.fail(importNotFound());
          }
          return shown;
        })
      )
  );

  /** The running import that waited longest, so imports take turns a page at a time. */
  const next = Effect.fn("PlaylistImports.next")(() =>
    execute(
      db
        .select()
        .from(playlistImports)
        .where(eq(playlistImports.state, "running"))
        .orderBy(asc(playlistImports.updatedAt))
        .limit(1)
        .pipe(Effect.map(([row]) => (row ? jobOf(row) : null)))
    )
  );

  const fail = Effect.fn("PlaylistImports.fail")(
    (job: ImportJob, message: string) =>
      execute(
        db.transaction((tx) =>
          Effect.gen(function* failImport() {
            const failed = { ...job, state: State.Failed({ message }) };
            yield* write(tx, failed, Date.now());
            return yield* withPlaylist(tx, failed);
          })
        )
      )
  );

  /**
   * Adds a page's saved tracks to the Playlist and moves the cursor, together. A page replayed
   * after a crash finds its Sets already in the Playlist and adds nothing twice.
   */
  const commitPage = Effect.fn("PlaylistImports.commitPage")(
    (job: ImportJob, page: YouTubePlaylistPage, saved: readonly SavedTrack[]) =>
      execute(
        db.transaction((tx) =>
          Effect.gen(function* commitImportPage() {
            if (job.state._tag !== "Running") {
              return null;
            }
            const [owned] = yield* tx
              .select({ id: playlists.id })
              .from(playlists)
              .where(eq(playlists.id, job.playlistId))
              .limit(1);
            if (!owned) {
              const failed = {
                ...job,
                state: State.Failed({ message: playlistRemoved }),
              };
              yield* write(tx, failed, Date.now());
              return failed;
            }
            const members = yield* tx
              .select({
                position: playlistSets.position,
                setId: playlistSets.setId,
              })
              .from(playlistSets)
              .where(eq(playlistSets.playlistId, job.playlistId));
            const present = new Set(members.map((member) => member.setId));
            let position = Math.max(
              -1,
              ...members.map((member) => member.position)
            );
            let memberCount = members.length;
            const counts = { ...job.counts };
            const rows: (typeof playlistSets.$inferInsert)[] = [];
            for (const track of saved) {
              if (present.has(track.id)) {
                continue;
              }
              present.add(track.id);
              const [memberships] = yield* tx
                .select({ total: count() })
                .from(playlistSets)
                .innerJoin(playlists, eq(playlistSets.playlistId, playlists.id))
                .where(
                  and(
                    eq(playlistSets.setId, track.id),
                    eq(playlists.creatorId, job.personId)
                  )
                );
              if (
                memberCount >= MAX_SETS_PER_PLAYLIST ||
                (memberships?.total ?? 0) >= MAX_PLAYLISTS_PER_SET
              ) {
                counts.overLimit += 1;
                continue;
              }
              memberCount += 1;
              position += 1;
              rows.push({
                playlistId: job.playlistId,
                position,
                setId: track.id,
              });
              counts.added += 1;
              if (
                ["queued", "inProgress", "ready"].includes(
                  track.autoDownloadResult
                )
              ) {
                counts.downloading += 1;
              } else if (track.autoDownloadResult === "queueFull") {
                counts.waiting += 1;
              }
            }
            for (const batch of insertBatches(playlistSets, rows)) {
              yield* tx.insert(playlistSets).values(batch);
            }
            counts.unavailable += page.unavailable;
            const { total } = job.state;
            const processed = job.state.processed + page.entries;
            const full = memberCount >= MAX_SETS_PER_PLAYLIST;
            if (page.nextPageToken && full) {
              // The entries left unread are past the maximum.
              counts.overLimit += Math.max(0, (total ?? processed) - processed);
            }
            const committed: ImportJob = {
              ...job,
              counts,
              state:
                page.nextPageToken && !full
                  ? State.Running({
                      pageToken: page.nextPageToken,
                      processed,
                      total,
                    })
                  : State.Done(),
            };
            yield* write(tx, committed, Date.now());
            return committed;
          })
        )
      )
  );

  return { commitPage, create, fail, find, next, reopen, withPlaylist };
};

export class PlaylistImporter extends Context.Service<
  PlaylistImporter,
  {
    /**
     * Reads the playlist's name and first page, then creates the Playlist and the import and
     * starts it. A running import of the same playlist is returned instead, and a failed one
     * resumes.
     */
    readonly start: (input: {
      readonly personId: string;
      readonly sourcePlaylistId: string;
      readonly url: string;
    }) => Effect.Effect<PlaylistImport, LibraryError | MetadataError>;
    readonly read: (
      personId: string,
      id: string
    ) => Effect.Effect<PlaylistImport, LibraryError>;
    /** Runs any import an evicted Group left, and keeps the alarm set while one runs. */
    readonly resume: () => Effect.Effect<void>;
  }
>()("@orbis/PlaylistImporter") {
  static layer(
    options: PlaylistImporterOptions
  ): Layer.Layer<PlaylistImporter, never, Database | Metadata> {
    return Layer.effect(
      PlaylistImporter,
      Effect.gen(function* buildImporter() {
        const db = yield* Database;
        const metadata = yield* Metadata;
        const store = importStore(db);
        const retry = options.retry ?? defaultRetry;
        const wakeQueue = yield* Queue.unbounded<true>();
        const publishedAt = new Map<string, number>();

        const heartbeat = Effect.fn("PlaylistImporter.heartbeat")((
          running: boolean
        ) => {
          const slot = options.heartbeat;
          if (!slot) {
            return Effect.void;
          }
          return Effect.tryPromise(() =>
            running ? slot.set(Date.now() + HEARTBEAT_MS) : slot.cancel()
          ).pipe(
            // A missed write is retried by the next page, and a missed wake by the next request.
            Effect.ignore({
              log: "Warn",
              message: "playlist import alarm not set",
            })
          );
        });

        const publish = Effect.fn("PlaylistImporter.publish")(function* publish(
          job: ImportJob
        ) {
          const now = Date.now();
          const running = job.state._tag === "Running";
          if (
            running &&
            now - (publishedAt.get(job.id) ?? 0) < PUBLISH_INTERVAL_MS
          ) {
            return;
          }
          if (running) {
            publishedAt.set(job.id, now);
          } else {
            publishedAt.delete(job.id);
          }
          const shown = yield* store.withPlaylist(db, job);
          if (shown) {
            yield* options.publish(job.personId, shown);
          }
        });

        const readPage = (job: ImportJob, pageToken: string | null) =>
          metadata.playlistPage(job.sourcePlaylistId, pageToken).pipe(
            Effect.retry({
              schedule: retry,
              while: (error) => error.reason === "provider-unavailable",
            })
          );

        /** One page: read it, save its tracks, then commit them with the cursor. */
        const runPage = Effect.fn("PlaylistImporter.runPage")(function* runPage(
          job: ImportJob
        ) {
          if (job.state._tag !== "Running") {
            return job;
          }
          const page = yield* readPage(job, job.state.pageToken);
          const saved: SavedTrack[] = [];
          for (const track of page.tracks) {
            saved.push(yield* options.saveTrack(job.personId, track));
          }
          return (yield* store.commitPage(job, page, saved)) ?? job;
        });

        const failureMessage = (cause: Cause.Cause<unknown>) => {
          const error = Cause.squash(cause);
          if (error instanceof LibraryError) {
            return error.message;
          }
          if (error instanceof MetadataError) {
            return playlistImportRefusal(error).message;
          }
          return "The import stopped unexpectedly. Try it again.";
        };

        const processNext = Effect.fn("PlaylistImporter.processNext")(
          function* processNext() {
            const job = yield* store.next();
            if (!job) {
              yield* heartbeat(false);
              return false;
            }
            yield* heartbeat(true);
            const outcome = yield* Effect.exit(runPage(job));
            if (Exit.isSuccess(outcome)) {
              yield* publish(outcome.value);
              yield* Effect.logInfo("playlist import page").pipe(
                Effect.annotateLogs({
                  import: job.id,
                  state: outcome.value.state._tag,
                })
              );
              return true;
            }
            if (Cause.hasInterruptsOnly(outcome.cause)) {
              return yield* Effect.interrupt;
            }
            const message = failureMessage(outcome.cause);
            yield* Effect.logWarning("playlist import failed").pipe(
              Effect.annotateLogs({ import: job.id, reason: message })
            );
            yield* store.fail(job, message);
            yield* publish({ ...job, state: State.Failed({ message }) });
            return true;
          },
          (effect) =>
            effect.pipe(
              Effect.catchTag("LibraryError", (failure) =>
                Effect.logWarning("playlist import round failed").pipe(
                  Effect.annotateLogs({ reason: failure.message }),
                  Effect.as(false)
                )
              )
            )
        );

        const drain = Effect.fn("PlaylistImporter.drain")(function* drain() {
          while (yield* processNext()) {
            // SQLite is authoritative; keep taking pages until no import runs.
          }
        });
        const wake = () => Queue.offer(wakeQueue, true);

        if (options.startWorker !== false) {
          yield* wake();
          yield* Effect.forkScoped(
            Stream.fromQueue(wakeQueue).pipe(Stream.runForEach(() => drain()))
          );
        }

        const start = Effect.fn("PlaylistImporter.start")(
          function* start(input: {
            readonly personId: string;
            readonly sourcePlaylistId: string;
            readonly url: string;
          }) {
            const open = yield* store.reopen(
              input.personId,
              input.sourcePlaylistId
            );
            if (open) {
              yield* wake();
              return open;
            }
            const { itemCount, title } = yield* metadata.playlist(
              input.sourcePlaylistId
            );
            const first = yield* metadata.playlistPage(
              input.sourcePlaylistId,
              null
            );
            if (first.tracks.length === 0 && !first.nextPageToken) {
              return yield* Effect.fail(
                new LibraryError({
                  message: "This playlist has no tracks Orbis can play.",
                  statusCode: 404,
                })
              );
            }
            const created = yield* store.create({
              personId: input.personId,
              sourcePlaylistId: input.sourcePlaylistId,
              sourceUrl: input.url,
              title,
              total: itemCount,
            });
            yield* wake();
            return created;
          }
        );

        const resume = Effect.fn("PlaylistImporter.resume")(function* resume() {
          const job = yield* store
            .next()
            .pipe(Effect.orElseSucceed(() => null));
          yield* heartbeat(job !== null);
          yield* wake();
        });

        return PlaylistImporter.of({ read: store.find, resume, start });
      })
    );
  }
}
