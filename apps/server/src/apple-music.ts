import type { AppleMusicAlbumPayload } from "@orbis/contracts";

import { LibraryError } from "./errors.js";

type AppleMusicAlbum = typeof AppleMusicAlbumPayload.Type;

/**
 * The service holds no Apple Music key (ADR 0021), so the album details arrive with the save
 * from the Apple app. A save from anywhere else carries none and is refused, so an Apple Music
 * Set never exists without its Tracklist.
 */
export const appleMusicSaveRefused = () =>
  new LibraryError({
    message: "Save Apple Music mixes from the Orbis app on an iPhone or Mac.",
    statusCode: 400,
  });

export const appleMusicDownloadRefused = () =>
  new LibraryError({
    message:
      "Apple Music audio plays through Apple Music and is never downloaded.",
    statusCode: 400,
  });

/**
 * Where each song starts in the mix, in whole seconds. The running total is kept unrounded and
 * each start is rounded on its own, so rounding never accumulates across a long mix.
 */
const songStarts = (album: AppleMusicAlbum): number[] => {
  let elapsed = 0;
  return album.songs.map((song) => {
    const startedAt = Math.round(elapsed);
    elapsed += song.durationSeconds;
    return startedAt;
  });
};

const mixLength = (album: AppleMusicAlbum): number =>
  Math.round(album.songs.reduce((total, song) => total + song.durationSeconds, 0));

/** The shared Set's columns for a new Apple Music Set: metadata, details, and Tracklist are complete. */
export const appleMusicSetColumns = (album: AppleMusicAlbum) => ({
  artworkLargeUrl: album.artworkLargeUrl,
  artworkUrl: album.artworkUrl,
  creator: album.creator?.trim() || null,
  detailsState: "filled" as const,
  durationSeconds: mixLength(album),
  metadataState: "enriched" as const,
  releasedAt: album.releasedAt,
  title: album.title.trim(),
  tracklistState: "ready" as const,
});

/** One Cue per song, in album order. */
export const appleMusicCues = (setId: string, album: AppleMusicAlbum) => {
  const starts = songStarts(album);
  return album.songs.map((song, position) => ({
    appleMusicId: song.appleMusicId,
    artist: song.artist.trim(),
    artworkUrl: song.artworkUrl,
    position,
    setId,
    startSeconds: starts[position] ?? null,
    title: song.title.trim(),
  }));
};
