import type {
  LibraryFilters,
  Playlist,
  SavedSet,
  SaveSetInput,
  SetSource,
} from "@orbis/contracts";
import { and, asc, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { albumCues, appleMusicDownloadRefused } from "./apple-music.js";
import { releaseAudio } from "./audio-release.js";
import { boundBatches, insertBatches } from "./db/batches.js";
import {
  downloadJobs,
  downloadRequesters,
  libraryEntries,
  listens,
  playbackPositions,
  playlistSets,
  playlists,
  setCues,
  sets,
} from "./db/schema.js";
import { Database } from "./db/service.js";
import { asLibraryError, LibraryError } from "./errors.js";
import type { PersonRecord } from "./identity.js";
import {
  MAX_PLAYLISTS_PER_SET,
  MAX_SETS_PER_PLAYLIST,
} from "./library-limits.js";
import { LibraryPerson } from "./library-person.js";
import type { EnrichedMetadata, SourceExtras } from "./metadata.js";
import { normalizeSourceUrl } from "./source-url.js";
import { resolveVisibleSet, visibleSetIds } from "./visibility.js";
import type { SourceDetails } from "./ytdlp-metadata.js";

interface LibraryOptions {
  readonly releaseAudio?: (
    id: string
  ) => Effect.Effect<void, LibraryError, Database>;
  readonly people?: () => readonly PersonRecord[];
}

const LibrarySettings = Context.Reference<LibraryOptions>(
  "@orbis/LibrarySettings",
  { defaultValue: () => ({}) }
);

type SetRow = typeof sets.$inferSelect;

const extrasColumns = (extras: SourceExtras) => ({
  creatorId: extras.creatorId,
  creatorUrl: extras.creatorUrl,
  description: extras.description,
  detailsState: "filled" as const,
  genre: extras.genre,
  sourceChapters: JSON.stringify(extras.chapters),
  sourceTags: JSON.stringify(extras.tags),
});

const JsonStringArray = Schema.fromJsonString(
  Schema.mutable(Schema.Array(Schema.String))
);
const decodeJsonStringArrayEffect = Schema.decodeUnknownEffect(JsonStringArray);

const TEMPORARY_TITLES: Record<SetSource, string> = {
  "apple-music": "Apple Music mix",
  soundcloud: "SoundCloud track",
  youtube: "YouTube video",
};

const setNotFound = () =>
  new LibraryError({
    message: "Set not found.",
    statusCode: 404,
  });

const playlistNotFound = () =>
  new LibraryError({
    message: "Playlist not found.",
    statusCode: 404,
  });

const databaseError = () =>
  new LibraryError({
    message: "Could not complete the library request.",
    statusCode: 500,
  });

const playlistCapacityError = () =>
  new LibraryError({
    message: `A playlist can hold at most ${MAX_SETS_PER_PLAYLIST} sets.`,
    statusCode: 400,
  });

const setCapacityError = () =>
  new LibraryError({
    message: `A set can belong to at most ${MAX_PLAYLISTS_PER_SET} playlists.`,
    statusCode: 400,
  });

const toLibraryError = <E>(error: E) =>
  error instanceof LibraryError ? error : databaseError();

const execute = asLibraryError("Could not complete the library request.");

const decodeJsonArray = (value: string) => decodeJsonStringArrayEffect(value);

const normalizeUrl = (value: string) =>
  Effect.try({
    catch: toLibraryError,
    try: () => normalizeSourceUrl(value),
  });

const normalizeTags = (tags: readonly string[]) => [
  ...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)),
];

export class Library extends Context.Service<
  Library,
  {
    readonly save: (
      input: SaveSetInput
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly find: (id: string) => Effect.Effect<SavedSet, LibraryError>;
    readonly findByUrl: (url: string) => Effect.Effect<SavedSet, LibraryError>;
    /** Which of these Source Links are in this Person's Library. */
    readonly savedUrls: (
      urls: readonly string[]
    ) => Effect.Effect<ReadonlySet<string>, LibraryError>;
    /** The Sets with these identifiers, in the order asked for. Missing ones are left out. */
    readonly byIds: (
      ids: readonly string[]
    ) => Effect.Effect<SavedSet[], LibraryError>;
    readonly setPlaybackPosition: (
      id: string,
      seconds: number
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly recordEnrichment: (
      id: string,
      metadata: EnrichedMetadata
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly recordDetails: (
      id: string,
      details: SourceDetails
    ) => Effect.Effect<void, LibraryError>;
    readonly recordDetailsFailure: (
      id: string
    ) => Effect.Effect<void, LibraryError>;
    readonly recordEnrichmentFailure: (
      id: string
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly list: (
      filters: LibraryFilters
    ) => Effect.Effect<SavedSet[], LibraryError>;
    readonly updateTags: (
      id: string,
      tags: readonly string[]
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly updateTitle: (
      id: string,
      title: string
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly release: (id: string) => Effect.Effect<void, LibraryError>;
    readonly remove: (id: string) => Effect.Effect<SavedSet, LibraryError>;
    readonly tags: Effect.Effect<string[], LibraryError>;
    readonly playlists: Effect.Effect<Playlist[], LibraryError>;
    readonly createPlaylist: (
      name: string
    ) => Effect.Effect<Playlist, LibraryError>;
    readonly renamePlaylist: (
      id: string,
      name: string
    ) => Effect.Effect<Playlist, LibraryError>;
    readonly deletePlaylist: (
      id: string
    ) => Effect.Effect<Playlist, LibraryError>;
    readonly setPlaylistMembers: (
      id: string,
      setIds: readonly string[]
    ) => Effect.Effect<SavedSet[], LibraryError>;
    readonly setPlaylistMemberships: (
      id: string,
      playlistIds: readonly string[]
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly queueDownload: (
      id: string
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly claimDownload: Effect.Effect<SavedSet | null, LibraryError>;
    readonly finishDownload: (
      id: string,
      audio: { bytes: number; format: string; durationSeconds: number }
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly failDownload: (
      id: string
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly cancelDownload: (
      id: string
    ) => Effect.Effect<SavedSet, LibraryError>;
    readonly resetStuckDownloads: Effect.Effect<number, LibraryError>;
  }
>()("@orbis/Library") {
  static readonly make = Effect.gen(function* layer() {
    const db = yield* Database;
    const options = yield* LibrarySettings;
    const personId = yield* LibraryPerson;
    const resolve = (id: string) =>
      resolveVisibleSet({
        id,
        people: options.people?.() ?? [],
        personId,
      }).pipe(Effect.provideService(Database, db));
    const release = Effect.fn("Library.release")((id: string) =>
      (options.releaseAudio ?? releaseAudio)(id).pipe(
        Effect.provideService(Database, db)
      )
    );

    const entryFor = (setId: string) =>
      db
        .select()
        .from(libraryEntries)
        .where(
          and(
            eq(libraryEntries.personId, personId),
            eq(libraryEntries.setId, setId)
          )
        )
        .limit(1);

    const listenStats = db
      .select({
        finishCount: sql<number>`COUNT(${listens.finishedAt})`.as(
          "finish_count"
        ),
        lastListenedAt: sql<
          string | null
        >`MAX(CASE WHEN ${listens.startKnown} = 1 THEN ${listens.startedAt} END)`.as(
          "last_listened_at"
        ),
        listenCount: sql<number>`COUNT(*)`.as("listen_count"),
        setId: listens.setId,
      })
      .from(listens)
      .where(eq(listens.personId, personId))
      .groupBy(listens.setId)
      .as("listen_stats");

    // Each Set with this Person's entry, position, listen totals and playlists, in one read.
    const builtSets = () =>
      db
        .select({
          entrySavedAt: libraryEntries.savedAt,
          entryTags: libraryEntries.tags,
          entryTitleOverride: libraryEntries.titleOverride,
          finishCount: listenStats.finishCount,
          lastListenedAt: listenStats.lastListenedAt,
          listenCount: listenStats.listenCount,
          playlistIds: sql<string>`(
              SELECT COALESCE(
                json_group_array(${playlistSets.playlistId} ORDER BY ${playlistSets.playlistId}),
                '[]'
              )
              FROM ${playlistSets}
              INNER JOIN ${playlists} ON ${playlists.id} = ${playlistSets.playlistId}
              WHERE ${playlistSets.setId} = ${sets.id} AND ${playlists.creatorId} = ${personId}
            )`,
          positionSeconds: playbackPositions.seconds,
          set: sets,
        })
        .from(sets)
        .leftJoin(
          libraryEntries,
          and(
            eq(libraryEntries.setId, sets.id),
            eq(libraryEntries.personId, personId)
          )
        )
        .leftJoin(
          playbackPositions,
          and(
            eq(playbackPositions.setId, sets.id),
            eq(playbackPositions.personId, personId)
          )
        )
        .leftJoin(listenStats, eq(listenStats.setId, sets.id))
        .$dynamic();

    type BuiltSet = Omit<
      Effect.Success<ReturnType<typeof builtSets>>[number],
      "set"
    >;

    const buildSavedSet = Effect.fn("Library.buildSavedSet")(function* build(
      row: SetRow,
      built: BuiltSet
    ) {
      const tags = yield* decodeJsonArray(
        built.entryTags ?? (personId === "host" ? row.tags : "[]")
      );
      // The source details stay on the server; the client contract does not carry them.
      const {
        creatorUrl: _creatorUrl,
        description: _description,
        detailsState: _detailsState,
        tracklistRunId: _tracklistRunId,
        tracklistRunStartedAt: _tracklistRunStartedAt,
        genre: _genre,
        hostRemoved: _hostRemoved,
        sourceChapters: _sourceChapters,
        sourceTags: _sourceTags,
        ...visible
      } = row;
      return {
        ...visible,
        createdAt: built.entrySavedAt ?? row.createdAt,
        finishCount: built.finishCount ?? 0,
        lastListenedAt: built.lastListenedAt,
        listenCount: built.listenCount ?? 0,
        playbackPositionSeconds: built.positionSeconds ?? 0,
        playlistIds: yield* decodeJsonArray(built.playlistIds),
        tags,
        title: built.entryTitleOverride ?? row.title,
        titleEditedByUser:
          built.entrySavedAt === null
            ? personId === "host" && row.titleEditedByUser
            : built.entryTitleOverride !== null,
      };
    });

    const buildAll = Effect.forEach((built: BuiltSet & { set: SetRow }) =>
      buildSavedSet(built.set, built)
    );

    const hydrateSet = Effect.fn("Library.hydrateSet")(function* hydrate(
      row: SetRow
    ) {
      const [built] = yield* builtSets().where(eq(sets.id, row.id)).limit(1);
      if (!built) {
        return yield* setNotFound();
      }
      return yield* buildSavedSet(row, built);
    });

    const findRow = (id: string) =>
      db.select().from(sets).where(eq(sets.id, id)).limit(1);

    const ensureEntry = Effect.fn("Library.ensureEntry")(
      function* ensureEntryEffect(id: string) {
        const [existing] = yield* entryFor(id);
        if (existing) {
          return existing;
        }
        if (personId !== "host") {
          return yield* Effect.fail(setNotFound());
        }
        const [row] = yield* findRow(id);
        if (!row || row.hostRemoved) {
          return yield* Effect.fail(setNotFound());
        }
        const [other] = yield* db
          .select({ personId: libraryEntries.personId })
          .from(libraryEntries)
          .where(eq(libraryEntries.setId, id))
          .limit(1);
        if (other) {
          return yield* Effect.fail(setNotFound());
        }
        const [entry] = yield* db
          .insert(libraryEntries)
          .values({
            personId,
            savedAt: row.createdAt,
            setId: id,
            tags: row.tags,
            titleOverride: row.titleEditedByUser ? row.title : null,
          })
          .onConflictDoNothing()
          .returning();
        if (!entry) {
          return yield* Effect.fail(databaseError());
        }
        return entry;
      }
    );

    const findSavedSet = Effect.fn("Library.findSavedSet")(
      function* findSavedSetEffect(id: string) {
        yield* ensureEntry(id);
        const [row] = yield* findRow(id);
        if (!row) {
          return yield* Effect.fail(setNotFound());
        }
        return yield* hydrateSet(row);
      }
    );

    const save = Effect.fn("Library.save")((input: SaveSetInput) =>
      execute(
        Effect.gen(function* saveSetEffect() {
          const { source, url } = yield* normalizeUrl(input.url);
          const title = input.title?.trim() ?? "";
          const tags = normalizeTags(input.tags);
          const savedRow = yield* db.transaction((tx) =>
            Effect.gen(function* saveEntryTransaction() {
              let [row] = yield* tx
                .select()
                .from(sets)
                .where(eq(sets.url, url))
                .limit(1);
              if (!row) {
                const [inserted] = yield* tx
                  .insert(sets)
                  .values({
                    createdAt: new Date().toISOString(),
                    hostRemoved: personId !== "host",
                    id: crypto.randomUUID(),
                    source,
                    tags: "[]",
                    title: TEMPORARY_TITLES[source],
                    titleEditedByUser: false,
                    url,
                  })
                  .onConflictDoNothing()
                  .returning();
                [row] = inserted
                  ? [inserted]
                  : yield* tx
                      .select()
                      .from(sets)
                      .where(eq(sets.url, url))
                      .limit(1);
              }
              if (!row) {
                return yield* Effect.fail(databaseError());
              }
              if (personId === "host" && row.hostRemoved) {
                yield* tx
                  .update(sets)
                  .set({ hostRemoved: false })
                  .where(eq(sets.id, row.id));
              }
              const [entry] = yield* tx
                .insert(libraryEntries)
                .values({
                  personId,
                  savedAt: new Date().toISOString(),
                  setId: row.id,
                  tags: JSON.stringify(tags),
                  titleOverride: title || null,
                })
                .onConflictDoNothing()
                .returning();
              if (!entry) {
                return yield* Effect.fail(
                  new LibraryError({
                    message: "This set is already in your library.",
                    statusCode: 409,
                  })
                );
              }
              return row;
            })
          );
          return yield* hydrateSet(savedRow);
        })
      )
    );

    const list = Effect.fn("Library.list")((filters: LibraryFilters) =>
      execute(
        Effect.gen(function* listSetsEffect() {
          const { playlistId } = filters;
          const conditions = playlistId
            ? []
            : [
                sql`(${libraryEntries.personId} IS NOT NULL OR (${personId} = 'host' AND ${sets.hostRemoved} = 0 AND NOT EXISTS (
                SELECT 1 FROM ${libraryEntries} AS held
                WHERE held.set_id = ${sets.id}
              )))`,
              ];
          const entryTitle = sql`coalesce(${libraryEntries.titleOverride}, ${sets.title})`;
          const entryTags = sql`coalesce(${libraryEntries.tags}, ${sets.tags})`;
          if (filters.q?.trim()) {
            const query = filters.q.trim();
            conditions.push(
              sql`(
                  instr(lower(${entryTitle}), lower(${query})) > 0
                  OR instr(lower(${sets.url}), lower(${query})) > 0
                  OR instr(lower(coalesce(${sets.creator}, '')), lower(${query})) > 0
                )`
            );
          }
          if (filters.creatorId) {
            conditions.push(eq(sets.creatorId, filters.creatorId));
          }
          if (filters.source) {
            conditions.push(eq(sets.source, filters.source));
          }
          for (const tag of filters.tags ?? []) {
            conditions.push(
              sql`EXISTS (
                  SELECT 1 FROM json_each(${entryTags})
                  WHERE value = ${tag.trim().toLowerCase()}
                )`
            );
          }

          if (playlistId) {
            const playlist = yield* db
              .select({ id: playlists.id })
              .from(playlists)
              .where(
                and(
                  eq(playlists.id, playlistId),
                  eq(playlists.creatorId, personId)
                )
              )
              .limit(1);
            if (!playlist[0]) {
              return yield* Effect.fail(playlistNotFound());
            }
            return yield* buildAll(
              yield* builtSets()
                .innerJoin(playlistSets, eq(playlistSets.setId, sets.id))
                .where(
                  and(...conditions, eq(playlistSets.playlistId, playlistId))
                )
                .orderBy(asc(playlistSets.position))
            );
          }

          return yield* buildAll(
            yield* builtSets()
              .where(and(...conditions))
              .orderBy(desc(sets.createdAt), desc(sql`${sets}.rowid`))
          );
        })
      )
    );

    const updateTags = Effect.fn("Library.updateTags")(
      (id: string, tags: readonly string[]) =>
        execute(
          Effect.gen(function* updateTagsEffect() {
            yield* ensureEntry(id);
            const [entry] = yield* db
              .update(libraryEntries)
              .set({ tags: JSON.stringify(normalizeTags(tags)) })
              .where(
                and(
                  eq(libraryEntries.personId, personId),
                  eq(libraryEntries.setId, id)
                )
              )
              .returning();
            if (!entry) {
              return yield* Effect.fail(setNotFound());
            }
            return yield* findSavedSet(id);
          })
        )
    );

    const updateTitle = Effect.fn("Library.updateTitle")(
      (id: string, title: string) =>
        execute(
          Effect.gen(function* updateTitleEffect() {
            yield* ensureEntry(id);
            const trimmedTitle = title.trim();
            if (!trimmedTitle) {
              return yield* Effect.fail(
                new LibraryError({
                  message: "Enter a title for this set.",
                  statusCode: 400,
                })
              );
            }
            const [entry] = yield* db
              .update(libraryEntries)
              .set({ titleOverride: trimmedTitle })
              .where(
                and(
                  eq(libraryEntries.personId, personId),
                  eq(libraryEntries.setId, id)
                )
              )
              .returning();
            if (!entry) {
              return yield* Effect.fail(setNotFound());
            }
            return yield* findSavedSet(id);
          })
        )
    );

    const find = Effect.fn("Library.find")((id: string) =>
      execute(resolve(id).pipe(Effect.flatMap((row) => hydrateSet(row))))
    );

    const findByUrl = Effect.fn("Library.findByUrl")((value: string) =>
      execute(
        Effect.gen(function* findByUrlEffect() {
          const { url } = yield* normalizeUrl(value);
          const [row] = yield* db
            .select({ id: sets.id })
            .from(sets)
            .where(eq(sets.url, url))
            .limit(1);
          if (!row) {
            return yield* Effect.fail(setNotFound());
          }
          return yield* find(row.id);
        })
      )
    );

    const savedUrls = Effect.fn("Library.savedUrls")(
      (urls: readonly string[]) =>
        execute(
          Effect.gen(function* savedUrlsEffect() {
            if (urls.length === 0) {
              return new Set<string>();
            }
            const rows = yield* db
              .select({ url: sets.url })
              .from(libraryEntries)
              .innerJoin(sets, eq(sets.id, libraryEntries.setId))
              .where(
                and(
                  eq(libraryEntries.personId, personId),
                  inArray(sets.url, [...urls])
                )
              );
            return new Set(rows.map((row) => row.url));
          })
        )
    );

    // Queue order comes from the caller; each Set must resolve for this Person.
    const byIds = Effect.fn("Library.byIds")((ids: readonly string[]) =>
      execute(
        Effect.gen(function* byIdsEffect() {
          if (ids.length === 0) {
            return [];
          }
          // `builtSets` binds the Person 4 times, then one value for each ID.
          const batches = yield* Effect.forEach(
            boundBatches([...new Set(ids)], { fixed: 4, perValue: 1 }),
            (batch) => builtSets().where(inArray(sets.id, batch))
          );
          const rows = batches.flat();
          const visible = yield* visibleSetIds({
            people: options.people?.() ?? [],
            personId,
            rows: rows.map((row) => row.set),
          }).pipe(Effect.provideService(Database, db));
          const found = new Map(
            rows
              .filter((row) => visible.has(row.set.id))
              .map((row) => [row.set.id, row])
          );
          return yield* Effect.forEach((id: string) =>
            Effect.gen(function* byIdEffect() {
              const built = found.get(id);
              if (!built) {
                return yield* setNotFound();
              }
              return yield* buildSavedSet(built.set, built);
            })
          )(ids);
        })
      )
    );

    // A position past the end of the Set is not a place to resume from, and a fraction of a
    // second is not a value the app can read back, so both are settled here rather than stored
    // and explained later.
    const setPlaybackPosition = Effect.fn("Library.setPlaybackPosition")(
      (id: string, seconds: number) =>
        execute(
          Effect.gen(function* setPlaybackPositionEffect() {
            const current = yield* resolve(id);
            const wanted = Math.max(seconds, 0);
            const bounded =
              current.durationSeconds === null
                ? wanted
                : Math.min(wanted, current.durationSeconds);
            yield* db
              .insert(playbackPositions)
              .values({ personId, seconds: Math.round(bounded), setId: id })
              .onConflictDoUpdate({
                set: { seconds: Math.round(bounded) },
                target: [playbackPositions.personId, playbackPositions.setId],
              });
            return yield* hydrateSet(current);
          })
        )
    );

    const recordEnrichment = Effect.fn("Library.recordEnrichment")(
      (id: string, metadata: EnrichedMetadata) =>
        execute(
          Effect.gen(function* recordEnrichmentEffect() {
            const { songs } = metadata;
            const row = yield* db.transaction((tx) =>
              Effect.gen(function* recordEnrichmentRows() {
                const [updated] = yield* tx
                  .update(sets)
                  .set({
                    artworkLargeUrl: metadata.artworkLargeUrl,
                    artworkUrl: metadata.artworkUrl,
                    creator: metadata.creator,
                    durationSeconds: metadata.durationSeconds,
                    // A retry that yt-dlp could not answer keeps the details an earlier run stored.
                    ...(metadata.extras && extrasColumns(metadata.extras)),
                    // An album's songs are its Tracklist, so the Set needs no later read.
                    ...(songs && {
                      detailsState: "filled" as const,
                      tracklistState: "ready" as const,
                    }),
                    metadataState: "enriched",
                    releasedAt: metadata.releasedAt,
                    title: metadata.title,
                  })
                  .where(eq(sets.id, id))
                  .returning();
                if (updated && songs) {
                  yield* tx.delete(setCues).where(eq(setCues.setId, id));
                  for (const batch of insertBatches(
                    setCues,
                    albumCues(id, songs)
                  )) {
                    yield* tx.insert(setCues).values(batch);
                  }
                }
                return updated;
              })
            );
            if (!row) {
              return yield* Effect.fail(setNotFound());
            }
            return yield* hydrateSet(row);
          })
        )
    );

    // The provider's own values stay: a Set is filled where it has a gap, never overwritten.
    const recordDetails = Effect.fn("Library.recordDetails")(
      (id: string, details: SourceDetails) =>
        execute(
          Effect.gen(function* recordDetailsEffect() {
            const rows = yield* db
              .update(sets)
              .set({
                ...extrasColumns(details),
                artworkLargeUrl: sql`coalesce(${sets.artworkLargeUrl}, ${details.thumbnailUrl})`,
                artworkUrl: sql`coalesce(${sets.artworkUrl}, ${details.thumbnailUrl})`,
                creator: sql`coalesce(${sets.creator}, ${details.creator})`,
                durationSeconds: sql`coalesce(${sets.durationSeconds}, ${details.durationSeconds})`,
                releasedAt: sql`coalesce(${sets.releasedAt}, ${details.releasedAt})`,
              })
              .where(eq(sets.id, id))
              .returning({ id: sets.id });
            if (rows.length === 0) {
              return yield* Effect.fail(setNotFound());
            }
          })
        )
    );

    const recordDetailsFailure = Effect.fn("Library.recordDetailsFailure")(
      (id: string) =>
        execute(
          db.update(sets).set({ detailsState: "failed" }).where(eq(sets.id, id))
        ).pipe(Effect.asVoid)
    );

    const recordEnrichmentFailure = Effect.fn(
      "Library.recordEnrichmentFailure"
    )((id: string) =>
      execute(
        Effect.gen(function* recordEnrichmentFailureEffect() {
          const rows = yield* db
            .update(sets)
            .set({ metadataState: "failed" })
            .where(eq(sets.id, id))
            .returning();
          const [row] = rows;
          if (!row) {
            return yield* Effect.fail(setNotFound());
          }
          return yield* hydrateSet(row);
        })
      )
    );

    const remove = Effect.fn("Library.remove")((id: string) =>
      execute(
        Effect.gen(function* removeEffect() {
          yield* ensureEntry(id);
          const saved = yield* findSavedSet(id);
          yield* db.transaction((tx) =>
            Effect.gen(function* removeTransaction() {
              yield* tx
                .delete(libraryEntries)
                .where(
                  and(
                    eq(libraryEntries.personId, personId),
                    eq(libraryEntries.setId, id)
                  )
                );
              if (personId === "host") {
                yield* tx
                  .update(sets)
                  .set({ hostRemoved: true })
                  .where(eq(sets.id, id));
              }
            })
          );
          yield* release(id);
          return saved;
        })
      )
    );

    const queueDownload = Effect.fn("Library.queueDownload")((id: string) =>
      execute(
        Effect.gen(function* queueDownloadEffect() {
          const row = yield* db.transaction((tx) =>
            Effect.gen(function* enqueue() {
              const [current] = yield* tx
                .select()
                .from(sets)
                .where(eq(sets.id, id));
              if (!current) {
                return yield* Effect.fail(setNotFound());
              }
              if (current.source === "apple-music") {
                return yield* Effect.fail(appleMusicDownloadRefused());
              }
              if (
                !["none", "failed", "canceled"].includes(current.downloadState)
              ) {
                return current;
              }
              const [waiting] = yield* tx
                .select({ value: count() })
                .from(downloadJobs)
                .innerJoin(sets, eq(sets.id, downloadJobs.setId))
                .where(
                  and(
                    eq(downloadJobs.personId, personId),
                    eq(sets.downloadState, "queued")
                  )
                );
              if (waiting && waiting.value >= 20) {
                return yield* Effect.fail(
                  new LibraryError({
                    message:
                      "You can have at most 20 Downloads waiting. Try again after one starts.",
                    statusCode: 429,
                  })
                );
              }
              yield* tx
                .insert(downloadRequesters)
                .values({ personId })
                .onConflictDoNothing();
              yield* tx.delete(downloadJobs).where(eq(downloadJobs.setId, id));
              yield* tx.insert(downloadJobs).values({
                personId,
                queuedAt: new Date().toISOString(),
                setId: id,
              });
              const [queued] = yield* tx
                .update(sets)
                .set({ downloadState: "queued" })
                .where(eq(sets.id, id))
                .returning();
              if (!queued) {
                return yield* Effect.fail(setNotFound());
              }
              return queued;
            })
          );
          return yield* hydrateSet(row);
        })
      )
    );
    const claimDownload = execute(
      Effect.gen(function* claimDownloadEffect() {
        const row = yield* db.transaction((tx) =>
          Effect.gen(function* claim() {
            const [next] = yield* tx
              .select({
                personId: downloadJobs.personId,
                setId: downloadJobs.setId,
              })
              .from(downloadJobs)
              .innerJoin(sets, eq(sets.id, downloadJobs.setId))
              .innerJoin(
                downloadRequesters,
                eq(downloadRequesters.personId, downloadJobs.personId)
              )
              .where(eq(sets.downloadState, "queued"))
              .orderBy(
                asc(downloadRequesters.lastServed),
                asc(downloadJobs.sequence)
              )
              .limit(1);
            if (!next) {
              return null;
            }
            yield* tx
              .update(downloadRequesters)
              .set({
                lastServed: sql`(SELECT COALESCE(MAX(last_served), 0) + 1 FROM download_requesters)`,
              })
              .where(eq(downloadRequesters.personId, next.personId));
            const [claimed] = yield* tx
              .update(sets)
              .set({ downloadState: "downloading" })
              .where(eq(sets.id, next.setId))
              .returning();
            return claimed ?? null;
          })
        );
        return row ? yield* hydrateSet(row) : null;
      })
    ).pipe(Effect.withSpan("Library.claimDownload"));
    const finishDownload = Effect.fn("Library.finishDownload")(
      (
        id: string,
        audio: { bytes: number; format: string; durationSeconds: number }
      ) =>
        execute(
          Effect.gen(function* finishDownloadEffect() {
            // Whole seconds: SQLite keeps the fraction under INTEGER affinity, and
            // the app decodes an integer, so a fraction would unreadable the library.
            const [row] = yield* db
              .update(sets)
              .set({
                downloadState: "ready",
                durationSeconds: Math.round(audio.durationSeconds),
                retainedAudioBytes: audio.bytes,
                retainedAudioFormat: audio.format,
              })
              .where(eq(sets.id, id))
              .returning();
            if (!row) {
              return yield* Effect.fail(setNotFound());
            }
            return yield* hydrateSet(row);
          })
        )
    );
    // Only a download still running can fail. A cancel that won the race already
    // moved the row to none, and a failure must not drag it back to failed.
    const failDownload = Effect.fn("Library.failDownload")((id: string) =>
      execute(
        Effect.gen(function* failDownloadEffect() {
          const [failed] = yield* db
            .update(sets)
            .set({ downloadState: "failed" })
            .where(and(eq(sets.id, id), eq(sets.downloadState, "downloading")))
            .returning();
          if (failed) {
            return yield* hydrateSet(failed);
          }
          return yield* findSavedSet(id);
        })
      )
    );
    // Finished downloads are kept: canceling a ready set is a conflict, not a delete.
    // The app reports a 409 as a duplicate library entry, so a finished download
    // that cannot be canceled answers 400 with its own sentence.
    const cancelDownload = Effect.fn("Library.cancelDownload")((id: string) =>
      execute(
        Effect.gen(function* cancelDownloadEffect() {
          const canceled = yield* db.transaction((tx) =>
            Effect.gen(function* cancel() {
              // Any Person who sees a Set may ask for its Download (ADR 0010);
              // only the one who asked, or the Host, may take it away from the
              // others while it is still in flight. A finished one answers the
              // 400 below.
              const [job] = yield* tx
                .select({
                  personId: downloadJobs.personId,
                  state: sets.downloadState,
                })
                .from(downloadJobs)
                .innerJoin(sets, eq(sets.id, downloadJobs.setId))
                .where(eq(downloadJobs.setId, id));
              if (
                job &&
                job.state !== "ready" &&
                job.personId !== personId &&
                personId !== "host"
              ) {
                return yield* Effect.fail(
                  new LibraryError({
                    message:
                      "Only the Person who asked for this Download, or the Host, can cancel it.",
                    statusCode: 403,
                  })
                );
              }
              const [row] = yield* tx
                .update(sets)
                .set({
                  downloadState: "none",
                  retainedAudioBytes: null,
                  retainedAudioFormat: null,
                })
                .where(and(eq(sets.id, id), ne(sets.downloadState, "ready")))
                .returning();
              return row ?? null;
            })
          );
          if (canceled) {
            return yield* hydrateSet(canceled);
          }
          yield* resolve(id);
          return yield* Effect.fail(
            new LibraryError({
              message: "This set is already downloaded.",
              statusCode: 400,
            })
          );
        })
      )
    );
    // A restart must not leave a download stuck mid-flight: whatever was running
    // when the process died goes back to queued and the worker picks it up again.
    const resetStuckDownloads = execute(
      Effect.gen(function* resetStuckDownloadsEffect() {
        yield* db
          .update(sets)
          .set({ downloadState: "queued" })
          .where(eq(sets.downloadState, "downloading"));
        yield* db.run(
          sql`INSERT OR IGNORE INTO download_requesters (person_id) VALUES ('host')`
        );
        yield* db.run(sql`INSERT INTO download_jobs (set_id, person_id)
              SELECT id, 'host' FROM sets
              WHERE download_state = 'queued' AND id NOT IN (SELECT set_id FROM download_jobs)
              ORDER BY created_at, id`);
        const queued = yield* db
          .select({ id: sets.id })
          .from(sets)
          .where(eq(sets.downloadState, "queued"));
        return queued.length;
      })
    ).pipe(Effect.withSpan("Library.resetStuckDownloads"));
    const tags = Effect.suspend(() =>
      execute(
        db
          .all<{ readonly tag: string }>(sql`
          SELECT DISTINCT value AS tag
          FROM ${libraryEntries}, json_each(${libraryEntries.tags})
          WHERE ${libraryEntries.personId} = ${personId}
          ORDER BY tag
        `)
          .pipe(Effect.map((rows) => rows.map((row) => row.tag)))
      )
    ).pipe(Effect.withSpan("Library.tags"));

    const playlistsList = Effect.suspend(() =>
      execute(
        db
          .select({
            createdAt: playlists.createdAt,
            id: playlists.id,
            name: playlists.name,
            setCount: sql<number>`(
                SELECT COUNT(*)
                FROM ${playlistSets}
                WHERE ${playlistSets.playlistId} = ${playlists.id}
              )`,
          })
          .from(playlists)
          .where(eq(playlists.creatorId, personId))
          .orderBy(asc(sql`${playlists.name} COLLATE NOCASE`))
      )
    ).pipe(Effect.withSpan("Library.playlists"));

    const createPlaylist = Effect.fn("Library.createPlaylist")((name: string) =>
      execute(
        Effect.gen(function* createPlaylistEffect() {
          const trimmedName = name.trim();
          if (!trimmedName) {
            return yield* Effect.fail(
              new LibraryError({
                message: "Enter a playlist name.",
                statusCode: 400,
              })
            );
          }
          const playlist = {
            createdAt: new Date().toISOString(),
            id: crypto.randomUUID(),
            name: trimmedName,
            setCount: 0,
          } satisfies Playlist;
          const inserted = yield* db
            .insert(playlists)
            .values({
              createdAt: playlist.createdAt,
              creatorId: personId,
              id: playlist.id,
              name: playlist.name,
            })
            .onConflictDoNothing()
            .returning();
          if (!inserted[0]) {
            return yield* Effect.fail(
              new LibraryError({
                message: "A playlist with this name already exists.",
                statusCode: 409,
              })
            );
          }
          return playlist;
        })
      )
    );

    const renamePlaylist = Effect.fn("Library.renamePlaylist")(
      (id: string, name: string) =>
        execute(
          Effect.gen(function* renamePlaylistEffect() {
            const trimmedName = name.trim();
            if (!trimmedName) {
              return yield* Effect.fail(
                new LibraryError({
                  message: "Enter a playlist name.",
                  statusCode: 400,
                })
              );
            }
            const playlist = yield* db
              .select({ id: playlists.id })
              .from(playlists)
              .where(
                and(eq(playlists.id, id), eq(playlists.creatorId, personId))
              )
              .limit(1);
            if (!playlist[0]) {
              return yield* Effect.fail(playlistNotFound());
            }
            const taken = yield* db
              .select({ id: playlists.id })
              .from(playlists)
              .where(
                and(
                  sql`lower(${playlists.name}) = ${trimmedName.toLowerCase()}`,
                  eq(playlists.creatorId, personId),
                  ne(playlists.id, id)
                )
              )
              .limit(1);
            if (taken[0]) {
              return yield* Effect.fail(
                new LibraryError({
                  message: "A playlist with this name already exists.",
                  statusCode: 409,
                })
              );
            }
            const [row] = yield* db
              .update(playlists)
              .set({ name: trimmedName })
              .where(
                and(eq(playlists.id, id), eq(playlists.creatorId, personId))
              )
              .returning({
                createdAt: playlists.createdAt,
                id: playlists.id,
                name: playlists.name,
              });
            if (!row) {
              return yield* Effect.fail(playlistNotFound());
            }
            const countRows = yield* db
              .select({ count: sql<number>`COUNT(*)` })
              .from(playlistSets)
              .where(eq(playlistSets.playlistId, id));
            return {
              createdAt: row.createdAt,
              id: row.id,
              name: row.name,
              setCount: countRows[0]?.count ?? 0,
            } satisfies Playlist;
          })
        )
    );

    const deletePlaylist = Effect.fn("Library.deletePlaylist")((id: string) =>
      execute(
        Effect.gen(function* deletePlaylistEffect() {
          const playlist = yield* db
            .select({
              createdAt: playlists.createdAt,
              id: playlists.id,
              name: playlists.name,
              setCount: sql<number>`(
                  SELECT COUNT(*)
                  FROM ${playlistSets}
                  WHERE ${playlistSets.playlistId} = ${playlists.id}
                )`,
            })
            .from(playlists)
            .where(and(eq(playlists.id, id), eq(playlists.creatorId, personId)))
            .limit(1);
          const [row] = playlist;
          if (!row) {
            return yield* Effect.fail(playlistNotFound());
          }
          const removed = yield* db.transaction((tx) =>
            Effect.gen(function* deletePlaylistTransaction() {
              const deleted = yield* tx
                .delete(playlistSets)
                .where(eq(playlistSets.playlistId, id))
                .returning({ setId: playlistSets.setId });
              yield* tx
                .delete(playlists)
                .where(
                  and(eq(playlists.id, id), eq(playlists.creatorId, personId))
                );
              return deleted;
            })
          );
          yield* Effect.forEach((set: { readonly setId: string }) =>
            release(set.setId)
          )(removed);
          return row;
        })
      )
    );

    const setPlaylistMembers = Effect.fn("Library.setPlaylistMembers")(
      (id: string, setIds: readonly string[]) =>
        execute(
          Effect.gen(function* setPlaylistMembersEffect() {
            const [owned] = yield* db
              .select({ id: playlists.id })
              .from(playlists)
              .where(
                and(eq(playlists.id, id), eq(playlists.creatorId, personId))
              )
              .limit(1);
            if (!owned) {
              return yield* Effect.fail(playlistNotFound());
            }
            yield* Effect.forEach(resolve)(setIds);
            const removed = yield* db.transaction((tx) =>
              Effect.gen(function* setPlaylistMembersTransaction() {
                const playlist = yield* tx
                  .select({ id: playlists.id })
                  .from(playlists)
                  .where(
                    and(eq(playlists.id, id), eq(playlists.creatorId, personId))
                  )
                  .limit(1);
                if (!playlist[0]) {
                  return yield* Effect.fail(playlistNotFound());
                }
                if (new Set(setIds).size !== setIds.length) {
                  return yield* Effect.fail(
                    new LibraryError({
                      message: "A set can only appear once in a playlist.",
                      statusCode: 400,
                    })
                  );
                }
                if (setIds.length > MAX_SETS_PER_PLAYLIST) {
                  return yield* Effect.fail(playlistCapacityError());
                }
                for (const setId of setIds) {
                  const set = yield* tx
                    .select({ id: sets.id })
                    .from(sets)
                    .where(eq(sets.id, setId))
                    .limit(1);
                  if (!set[0]) {
                    return yield* Effect.fail(setNotFound());
                  }
                }

                const currentRows = yield* tx
                  .select({ setId: playlistSets.setId })
                  .from(playlistSets)
                  .where(eq(playlistSets.playlistId, id));
                const currentSetIds = new Set(
                  currentRows.map((row) => row.setId)
                );
                for (const setId of setIds) {
                  if (currentSetIds.has(setId)) {
                    continue;
                  }
                  const countRows = yield* tx
                    .select({ count: sql<number>`COUNT(*)` })
                    .from(playlistSets)
                    .innerJoin(
                      playlists,
                      eq(playlistSets.playlistId, playlists.id)
                    )
                    .where(
                      and(
                        eq(playlistSets.setId, setId),
                        eq(playlists.creatorId, personId)
                      )
                    );
                  if ((countRows[0]?.count ?? 0) + 1 > MAX_PLAYLISTS_PER_SET) {
                    return yield* Effect.fail(setCapacityError());
                  }
                }

                yield* tx
                  .delete(playlistSets)
                  .where(eq(playlistSets.playlistId, id));
                const rows = setIds.map((setId, position) => ({
                  playlistId: id,
                  position,
                  setId,
                }));
                for (const batch of insertBatches(playlistSets, rows)) {
                  yield* tx.insert(playlistSets).values(batch);
                }
                return currentRows.filter((row) => !setIds.includes(row.setId));
              })
            );
            yield* Effect.forEach((set: { readonly setId: string }) =>
              release(set.setId)
            )(removed);
            return yield* list({ playlistId: id });
          })
        )
    );

    const setPlaylistMemberships = Effect.fn("Library.setPlaylistMemberships")(
      (setId: string, playlistIds: readonly string[]) =>
        execute(
          Effect.gen(function* setPlaylistMembershipsEffect() {
            for (const playlistId of playlistIds) {
              const [owned] = yield* db
                .select({ id: playlists.id })
                .from(playlists)
                .where(
                  and(
                    eq(playlists.id, playlistId),
                    eq(playlists.creatorId, personId)
                  )
                )
                .limit(1);
              if (!owned) {
                return yield* Effect.fail(playlistNotFound());
              }
            }
            yield* ensureEntry(setId);
            yield* db.transaction((tx) =>
              Effect.gen(function* setPlaylistMembershipsTransaction() {
                const set = yield* tx
                  .select({ id: sets.id })
                  .from(sets)
                  .where(eq(sets.id, setId))
                  .limit(1);
                if (!set[0]) {
                  return yield* Effect.fail(setNotFound());
                }
                if (new Set(playlistIds).size !== playlistIds.length) {
                  return yield* Effect.fail(
                    new LibraryError({
                      message: "A set can only appear once in a playlist.",
                      statusCode: 400,
                    })
                  );
                }
                if (playlistIds.length > MAX_PLAYLISTS_PER_SET) {
                  return yield* Effect.fail(setCapacityError());
                }
                for (const playlistId of playlistIds) {
                  const playlist = yield* tx
                    .select({ id: playlists.id })
                    .from(playlists)
                    .where(
                      and(
                        eq(playlists.id, playlistId),
                        eq(playlists.creatorId, personId)
                      )
                    )
                    .limit(1);
                  if (!playlist[0]) {
                    return yield* Effect.fail(playlistNotFound());
                  }
                }

                const currentRows = yield* tx
                  .select({ playlistId: playlistSets.playlistId })
                  .from(playlistSets)
                  .innerJoin(
                    playlists,
                    eq(playlistSets.playlistId, playlists.id)
                  )
                  .where(
                    and(
                      eq(playlistSets.setId, setId),
                      eq(playlists.creatorId, personId)
                    )
                  );
                const currentPlaylistIds = new Set(
                  currentRows.map((row) => row.playlistId)
                );
                for (const playlistId of playlistIds) {
                  if (currentPlaylistIds.has(playlistId)) {
                    continue;
                  }
                  const countRows = yield* tx
                    .select({ count: sql<number>`COUNT(*)` })
                    .from(playlistSets)
                    .where(eq(playlistSets.playlistId, playlistId));
                  if ((countRows[0]?.count ?? 0) + 1 > MAX_SETS_PER_PLAYLIST) {
                    return yield* Effect.fail(playlistCapacityError());
                  }
                }

                const removedIds = [...currentPlaylistIds].filter(
                  (id) => !playlistIds.includes(id)
                );
                if (removedIds.length > 0) {
                  yield* tx
                    .delete(playlistSets)
                    .where(
                      and(
                        eq(playlistSets.setId, setId),
                        inArray(playlistSets.playlistId, removedIds)
                      )
                    );
                }

                for (const playlistId of playlistIds) {
                  if (currentPlaylistIds.has(playlistId)) {
                    continue;
                  }
                  const positionRows = yield* tx
                    .select({
                      position: sql<number>`COALESCE(MAX(${playlistSets.position}) + 1, 0)`,
                    })
                    .from(playlistSets)
                    .where(eq(playlistSets.playlistId, playlistId));
                  yield* tx
                    .insert(playlistSets)
                    .values({
                      playlistId,
                      position: positionRows[0]?.position ?? 0,
                      setId,
                    })
                    .onConflictDoNothing();
                }
              })
            );
            yield* release(setId);
            return yield* findSavedSet(setId);
          })
        )
    );

    return Library.of({
      byIds,
      cancelDownload,
      claimDownload,
      createPlaylist,
      deletePlaylist,
      failDownload,
      find,
      findByUrl,
      finishDownload,
      list,
      playlists: playlistsList,
      queueDownload,
      recordDetails,
      recordDetailsFailure,
      recordEnrichment,
      recordEnrichmentFailure,
      release,
      remove,
      renamePlaylist,
      resetStuckDownloads,
      save,
      savedUrls,
      setPlaybackPosition,
      setPlaylistMembers,
      setPlaylistMemberships,
      tags,
      updateTags,
      updateTitle,
    });
  });

  static readonly scopedLayer = Layer.effect(Library, Library.make);

  static readonly layer = Library.scopedLayer.pipe(
    Layer.provide(Layer.succeed(LibraryPerson, "host"))
  );

  /** Builds one Person's Library for a request, which provides it with `Effect.provideService`. */
  static forPerson(personId: string, options: LibraryOptions = {}) {
    return Library.make.pipe(
      Effect.provideService(LibraryPerson, personId),
      Effect.provideService(LibrarySettings, options)
    );
  }

  static forPersonLayer(personId: string, options: LibraryOptions = {}) {
    return Layer.effect(Library, Library.forPerson(personId, options));
  }
}
