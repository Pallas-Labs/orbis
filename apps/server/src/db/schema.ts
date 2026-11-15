import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const sets = sqliteTable("sets", {
  // Null on a Set enriched before this column existed; a client falls back to artwork_url.
  artworkLargeUrl: text("artwork_large_url"),
  artworkUrl: text("artwork_url"),
  createdAt: text("created_at").notNull(),
  creator: text("creator"),
  /** The provider's stable id for the creator; a name can change or collide, an id does not. */
  creatorId: text("creator_id"),
  creatorUrl: text("creator_url"),
  /** The source's own description. Server-side only: it feeds grouping and tag suggestions. */
  description: text("description"),
  /** Whether the background yt-dlp read has filled the source details. Server-side only. */
  detailsState: text("details_state", {
    enum: ["pending", "filled", "failed"],
  })
    .notNull()
    .default("pending"),
  downloadState: text("download_state", {
    enum: ["none", "queued", "downloading", "ready", "failed", "canceled"],
  })
    .notNull()
    .default("none"),
  durationSeconds: integer("duration_seconds"),
  genre: text("genre"),
  hostRemoved: integer("host_removed", { mode: "boolean" })
    .notNull()
    .default(false),
  id: text("id").primaryKey(),
  metadataState: text("metadata_state", {
    enum: ["pending", "enriched", "failed"],
  })
    .notNull()
    .default("pending"),
  /** When the source published the Set. Filled by metadata enrichment when the provider names it. */
  releasedAt: text("released_at"),
  retainedAudioBytes: integer("retained_audio_bytes"),
  retainedAudioFormat: text("retained_audio_format"),
  source: text("source", {
    enum: ["youtube", "soundcloud", "apple-music"],
  }).notNull(),
  /** JSON array of `{ startSeconds, title }`; a DJ set's chapters are often its tracklist. */
  sourceChapters: text("source_chapters"),
  /** JSON array of the tags the source's own uploader chose. Not the person's Tags. */
  sourceTags: text("source_tags"),
  tags: text("tags").notNull(),
  title: text("title").notNull(),
  titleEditedByUser: integer("title_edited_by_user", {
    mode: "boolean",
  })
    .notNull()
    .default(true),
  tracklistRunId: text("tracklist_run_id"),
  tracklistRunStartedAt: text("tracklist_run_started_at"),
  tracklistState: text("tracklist_state", {
    enum: ["pending", "ready", "none", "failed"],
  })
    .notNull()
    .default("pending"),
  url: text("url").notNull().unique(),
});

export const setCues = sqliteTable(
  "set_cues",
  {
    appleMusicId: text("apple_music_id"),
    artist: text("artist").notNull(),
    artworkUrl: text("artwork_url"),
    position: integer("position").notNull(),
    setId: text("set_id")
      .notNull()
      .references(() => sets.id, { onDelete: "cascade" }),
    startSeconds: integer("start_seconds"),
    title: text("title").notNull(),
  },
  (table) => [primaryKey({ columns: [table.setId, table.position] })]
);

/**
 * A Set's tempo and loudness, measured by the audio node from its Retained Audio. Shared Set data,
 * like the Tracklist: one row per Set, the `SetAnalysis` contract as JSON.
 */
export const setAnalysis = sqliteTable("set_analysis", {
  analysis: text("analysis").notNull(),
  setId: text("set_id")
    .primaryKey()
    .references(() => sets.id, { onDelete: "cascade" }),
  updatedAt: text("updated_at").notNull(),
});

export const libraryEntries = sqliteTable(
  "library_entries",
  {
    personId: text("person_id").notNull(),
    savedAt: text("saved_at").notNull(),
    setId: text("set_id")
      .notNull()
      .references(() => sets.id),
    tags: text("tags").notNull(),
    titleOverride: text("title_override"),
  },
  (table) => [
    primaryKey({ columns: [table.personId, table.setId] }),
    index("library_entries_by_set").on(table.setId),
  ]
);
export const downloadRequesters = sqliteTable("download_requesters", {
  lastServed: integer("last_served").notNull().default(0),
  personId: text("person_id").primaryKey(),
});

export const downloadJobs = sqliteTable("download_jobs", {
  personId: text("person_id")
    .notNull()
    .references(() => downloadRequesters.personId),
  /** When the Download was queued; null for rows queued before the column existed. */
  queuedAt: text("queued_at"),
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  setId: text("set_id")
    .notNull()
    .unique()
    .references(() => sets.id, { onDelete: "cascade" }),
});

export const playlists = sqliteTable(
  "playlists",
  {
    collaborative: integer("collaborative", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: text("created_at").notNull(),
    creatorId: text("creator_id").notNull().default("host"),
    id: text("id").primaryKey(),
    name: text("name").notNull(),
  },
  (table) => [
    uniqueIndex("playlists_creator_name_unique").on(
      table.creatorId,
      sql`${table.name} COLLATE NOCASE`
    ),
  ]
);

export const playlistEditors = sqliteTable(
  "playlist_editors",
  {
    creatorId: text("creator_id").notNull(),
    editorId: text("editor_id").notNull(),
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.playlistId, table.editorId] }),
    index("playlist_editors_by_editor").on(table.editorId, table.playlistId),
  ]
);

export const playlistSets = sqliteTable(
  "playlist_sets",
  {
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlists.id),
    position: integer("position").notNull(),
    setId: text("set_id")
      .notNull()
      .references(() => sets.id),
  },
  (table) => [
    primaryKey({ columns: [table.playlistId, table.setId] }),
    uniqueIndex("playlist_sets_position_unique").on(
      table.playlistId,
      table.position
    ),
    index("playlist_sets_by_set").on(table.setId, table.playlistId),
  ]
);

export const queueEntries = sqliteTable(
  "queue_entries",
  {
    isActive: integer("is_active", { mode: "boolean" })
      .notNull()
      .default(false),
    personId: text("person_id").notNull(),
    position: integer("position").notNull(),
    setId: text("set_id")
      .notNull()
      .references(() => sets.id),
  },
  (table) => [
    primaryKey({ columns: [table.personId, table.setId] }),
    uniqueIndex("queue_entries_position_unique").on(
      table.personId,
      table.position
    ),
    index("queue_entries_by_set").on(table.setId),
    // Each Person's Listening Queue has at most one active Set.
    uniqueIndex("queue_entries_active_unique")
      .on(table.personId)
      .where(sql`${table.isActive} = 1`),
  ]
);

export const playbackPositions = sqliteTable(
  "playback_positions",
  {
    personId: text("person_id").notNull(),
    /** When the position was last saved, in Unix milliseconds; null on rows saved before it. */
    savedAt: integer("saved_at"),
    seconds: integer("seconds").notNull().default(0),
    setId: text("set_id")
      .notNull()
      .references(() => sets.id),
  },
  (table) => [
    primaryKey({ columns: [table.personId, table.setId] }),
    index("playback_positions_by_set").on(table.setId),
  ]
);

export const listens = sqliteTable(
  "listens",
  {
    finishedAt: text("finished_at"),
    id: integer("id").primaryKey({ autoIncrement: true }),
    personId: text("person_id").notNull(),
    setId: text("set_id")
      .notNull()
      .references(() => sets.id),
    startKnown: integer("start_known", { mode: "boolean" })
      .notNull()
      .default(true),
    startedAt: text("started_at").notNull(),
  },
  (table) => [
    index("listens_by_person_set").on(table.personId, table.setId, table.id),
    index("listens_by_set").on(table.setId),
  ]
);

// A Collection: one Person's saved filter over their Listening Time, ranked as Heavy Rotation is.
// A null filter column admits every Set; `creator` keeps the name the filter was saved with.
export const collections = sqliteTable(
  "collections",
  {
    createdAt: text("created_at").notNull(),
    creator: text("creator"),
    creatorId: text("creator_id"),
    id: text("id").primaryKey(),
    minimumMinutes: integer("minimum_minutes").notNull().default(0),
    name: text("name").notNull(),
    personId: text("person_id").notNull(),
    range: text("range", { enum: ["month", "quarter", "year"] })
      .notNull()
      .default("month"),
    source: text("source", { enum: ["youtube", "soundcloud", "apple-music"] }),
    tag: text("tag"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    // Names are unique whatever their case, so "Techno" and "techno" are one Collection.
    uniqueIndex("collections_person_name").on(
      table.personId,
      sql`${table.name} COLLATE NOCASE`
    ),
  ]
);

// One Person's Listening Time with one Set on one day in their time zone, credited where the
// Playback Position is saved. A day rather than a Listen, because resuming a Set the next day
// reopens no Listen. A day saved before PAL-2131 is the UTC day, and keeps it.
export const listeningTime = sqliteTable(
  "listening_time",
  {
    day: text("day").notNull(),
    personId: text("person_id").notNull(),
    seconds: integer("seconds").notNull().default(0),
    setId: text("set_id")
      .notNull()
      .references(() => sets.id),
  },
  (table) => [
    primaryKey({ columns: [table.personId, table.day, table.setId] }),
    index("listening_time_by_set").on(table.setId),
  ]
);

// The time zone a Person's client last sent with a Playback Position. It draws the day of their
// Listening Time; a Person with no row keeps the UTC day.
export const personTimeZones = sqliteTable("person_time_zones", {
  personId: text("person_id").primaryKey(),
  timeZone: text("time_zone").notNull(),
});

// `actionNumber` outlives result pruning so a pruned action can never reacquire ownership.
export const presenceSessions = sqliteTable(
  "presence_sessions",
  {
    actionNumber: integer("action_number").notNull(),
    keyId: text("key_id").notNull(),
    leaseExpiresAt: integer("lease_expires_at"),
    ownerGeneration: integer("owner_generation").notNull(),
    personId: text("person_id").notNull(),
    sessionId: text("session_id").notNull(),
    setId: text("set_id").notNull(),
    state: text("state", {
      enum: ["playing", "paused", "stopped", "superseded"],
    }).notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.keyId, table.sessionId] }),
    index("presence_sessions_by_person").on(table.personId, table.state),
    uniqueIndex("presence_sessions_owner_unique")
      .on(table.personId)
      .where(sql`${table.state} IN ('playing', 'paused')`),
  ]
);

export const presenceActionResults = sqliteTable(
  "presence_action_results",
  {
    actionId: text("action_id").notNull(),
    input: text("input").notNull(),
    keyId: text("key_id").notNull(),
    recordedAt: integer("recorded_at").notNull(),
    result: text("result").notNull(),
    sessionId: text("session_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.keyId, table.sessionId, table.actionId] }),
    index("presence_action_results_by_age").on(table.keyId, table.recordedAt),
  ]
);

export const presenceKeys = sqliteTable("presence_keys", {
  keyId: text("key_id").primaryKey(),
  optedInAt: integer("opted_in_at").notNull(),
  personId: text("person_id").notNull(),
});

export const presenceLegacyReports = sqliteTable(
  "presence_legacy_reports",
  {
    keyId: text("key_id").primaryKey(),
    personId: text("person_id").notNull(),
    reportedAt: integer("reported_at").notNull(),
    setId: text("set_id").notNull(),
  },
  (table) => [
    index("presence_legacy_reports_by_person").on(
      table.personId,
      table.reportedAt
    ),
  ]
);

export const playlistImports = sqliteTable(
  "playlist_imports",
  {
    added: integer("added").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    downloading: integer("downloading").notNull().default(0),
    failure: text("failure"),
    id: text("id").primaryKey(),
    overLimit: integer("over_limit").notNull().default(0),
    /** The next page to read. Null before the first page is read. */
    pageToken: text("page_token"),
    personId: text("person_id").notNull(),
    playlistId: text("playlist_id").notNull(),
    processed: integer("processed").notNull().default(0),
    sourcePlaylistId: text("source_playlist_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    state: text("state", { enum: ["running", "done", "failed"] }).notNull(),
    total: integer("total"),
    unavailable: integer("unavailable").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
    waiting: integer("waiting").notNull().default(0),
  },
  (table) => [
    uniqueIndex("playlist_imports_running_unique")
      .on(table.personId, table.sourcePlaylistId)
      .where(sql`${table.state} = 'running'`),
    index("playlist_imports_by_state").on(table.state, table.updatedAt),
  ]
);

export const schema = {
  collections,
  downloadJobs,
  downloadRequesters,
  libraryEntries,
  listeningTime,
  listens,
  personTimeZones,
  playbackPositions,
  playlistEditors,
  playlistImports,
  playlistSets,
  playlists,
  presenceActionResults,
  presenceKeys,
  presenceLegacyReports,
  presenceSessions,
  queueEntries,
  setAnalysis,
  setCues,
  sets,
};

export const people = sqliteTable("people", {
  autoDownload: integer("auto_download", { mode: "boolean" })
    .notNull()
    .default(true),
  filters: text("filters").notNull().default("[]"),
  id: text("id").primaryKey(),
  removed: integer("removed", { mode: "boolean" }).notNull(),
  social: integer("social", { mode: "boolean" }).notNull().default(false),
  username: text("username").notNull(),
});

export const apiKeys = sqliteTable("api_keys", {
  addedAt: text("added_at").notNull(),
  digest: text("digest").notNull().unique(),
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  lastUsedAt: text("last_used_at"),
  personId: text("person_id")
    .notNull()
    .references(() => people.id),
  scope: text("scope", { enum: ["daily", "node"] }).notNull(),
});

export const groupSettings = sqliteTable("group_settings", {
  id: integer("id").primaryKey(),
  passcode: text("passcode"),
});

export const signInCodes = sqliteTable("sign_in_codes", {
  code: text("code").primaryKey(),
  expiresAt: text("expires_at").notNull(),
  personId: text("person_id")
    .notNull()
    .references(() => people.id),
});

export const trustMigrations = sqliteTable("trust_migrations", {
  id: integer("id").primaryKey(),
});
