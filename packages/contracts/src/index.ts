import type {
  AppleMusicAlbumSchema,
  AudioStateSchema,
  HealthResponseSchema,
  LibraryFiltersSchema,
  LibraryResponseSchema,
  ListeningQueueSchema,
  PlaylistImportSchema,
  PlaylistSchema,
  PresenceActionPayload,
  PresenceActionResultSchema,
  PresenceConflictSchema,
  PresenceSchema,
  PresenceSessionSchema,
  QueueEntryPayload,
  SaveSetPayload,
  SavedSetSchema,
  TracklistSchema,
  UpdateTitlePayload,
} from "./http-api.js";

export type HealthResponse = typeof HealthResponseSchema.Type;
export type AppleMusicAlbum = typeof AppleMusicAlbumSchema.Type;
export type AudioState = typeof AudioStateSchema.Type;
export type SavedSet = typeof SavedSetSchema.Type;
export type Tracklist = typeof TracklistSchema.Type;
export type Cue = Tracklist["cues"][number];
export type SetSource = SavedSet["source"];
export type MetadataState = SavedSet["metadataState"];
export type DownloadState = SavedSet["downloadState"];

export type SaveSetInput = Omit<typeof SaveSetPayload.Type, "tags"> & {
  tags: string[];
};

export type UpdateSetTitleInput = typeof UpdateTitlePayload.Type;

export type LibraryFilters = {
  -readonly [
    Key in keyof typeof LibraryFiltersSchema.Type
  ]: (typeof LibraryFiltersSchema.Type)[Key];
};

export type LibraryResponse = typeof LibraryResponseSchema.Type;

export type Playlist = typeof PlaylistSchema.Type;
export type PlaylistImport = typeof PlaylistImportSchema.Type;
export type Presence = typeof PresenceSchema.Type;
export type PresenceAction = typeof PresenceActionPayload.Type;
export type PresenceSession = typeof PresenceSessionSchema.Type;
export type PresenceActionResult = typeof PresenceActionResultSchema.Type;
export type PresenceConflict = typeof PresenceConflictSchema.Type;
export type ListeningQueue = typeof ListeningQueueSchema.Type;

/** Where a queued Set goes. `next` starts after the active Set; `end` goes last. */
export type QueuePlacement = (typeof QueueEntryPayload.Type)["placement"];

export {
  normalizeSourceUrl,
  SOURCE_URL_MESSAGE,
  UnsupportedSourceUrlError,
  youTubePlaylistId,
  youTubeVideoId,
  appleMusicAlbumUrl,
  youTubeWatchUrl,
} from "./source-url.js";
export {
  formatSignInCode,
  GROUP_PASSCODE_LENGTH,
  normalizeSignInCode,
  SIGN_IN_CODE_ALPHABET,
  SIGN_IN_CODE_LENGTH,
} from "./sign-in-code.js";

/**
 * Whether a Set can enter the Listening Queue and be played: it has Retained Audio, or it is
 * an Apple Music Set, which the Apple app plays through MusicKit (ADR 0021).
 */
export const isPlayableSet = (
  set: Pick<SavedSet, "downloadState" | "source">
): boolean => set.downloadState === "ready" || set.source === "apple-music";
